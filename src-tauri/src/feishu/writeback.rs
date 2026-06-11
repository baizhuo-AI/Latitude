//! 飞书 / Lark 日历**回写**核心（Phase 4 的 P4-3 + P4-4）。
//!
//! 这是 Phase 4 的命门：把本地编辑（拖拽改时段 / 删除 / 新建）推回飞书，并在「本地与远端都改了
//! 同一事件」时正确处理冲突，绝不静默丢用户的改动。所以本文件强 TDD——三态冲突的判定与落库结果
//! 先钉成测试，再谈实现。
//!
//! ## 职责边界
//! - 前端（plugin-sql）负责把本地变更**写进** `calendar_change_queue`（乐观更新 + 入队，见计划 P4-2/P4-3）。
//! - 本模块负责**读队列、执行写回、按结果更新本地**：逐条 create POST / update PATCH / delete DELETE，
//!   每条带入队时的 `base_etag` 做三态冲突判定，成功更新 `calendar_events` + 队列置 done，冲突置 conflict。
//! - HTTP / token 全在 Rust 侧（[`WriteApi`]），与「前端写队列」职责清晰分离。
//!
//! ## 三态冲突（P4-4 的核心）——update（PATCH）前必做
//! 入队时本地持有一个 `base_etag`（编辑那一刻的远端版本）。推送前先 `get_event` 取远端**当前** etag：
//!  - **远端 etag == base_etag**（远端没变，只有本地改）→ 直接 PATCH → 成功更新本地 + done。
//!  - **远端 etag != base_etag**（两边都改）→ **真冲突**：默认「远端为准」——
//!    · 用远端版**覆盖主记录**（local_draft=0）；
//!    · 另存一条**本地草稿**行（local_draft=1）不丢用户的改动；
//!    · 队列置 state='conflict'，**不推送本地**（等用户在前端决断「保留我的 / 用远端」，见 P4-4）。
//!
//! ## 幂等（create 重放安全）—— 命门是「remote_event_id 与 done 同事务回写队列行」
//! create 入队时队列行 `remote_event_id` 为空。推送成功后，[`apply_pushed_create`] 在**同一事务**里做
//! 三件事并一起 commit：① 把 remote_id+etag 落进 `calendar_events`；② 把 remote_id 回写进**队列行**；
//! ③ 队列行置 `state='done'`。这是幂等真生效的关键——幂等闸门判的是
//! [`list_pending_changes`](crate::feishu::db::list_pending_changes) **重新读出来的队列行**
//! `remote_event_id`，而非入队时的内存快照；远端已建的事实必须落进队列行，重放才拦得住。
//!
//! 崩溃重放的两种终局（因 ①②③ 原子，不存在「队列有 remote_id 却没 done」或反之的中间态）：
//!  - 事务已提交：队列行 done，`list_pending_changes` 根本不再捞出 → 不会重处理。
//!  - 事务回滚（远端已建但本地未落）：队列行仍 pending 且 remote_id 仍空 → 下轮会再 create。这是
//!    at-least-once 下 create 唯一残留的双建窗口（POST 本身不幂等，无法靠重放消除），靠「POST 成功后
//!    立即原子落库、落库失败才 mark_failed」把窗口压到最小（≈ 写本地库失败的概率）。彻底消除需飞书侧
//!    支持内容指纹去重，属后续增强。
//!
//! 当 change 已带 remote_event_id（update/delete 入队即有；create 已成功回写过）→ 视为已建，**转
//! update 路径**按已建 id 走三态更新，绝不再 create。
//!
//! ## 状态机与 at-least-once（无 'sending' 在途态）
//! 队列状态流转：`pending` → `done` / `conflict` / `failed` / `dead`。**本实现不设 'sending' 在途态**
//! （处理前不占位）。被杀进程后正在处理的那条仍是 pending/failed，下轮重放——重放安全由各 op 自身保证：
//! create 靠上面的队列 remote_id 幂等、update 的 get+PATCH 重放等价、delete 的远端 404 当成功。失败有
//! 重试上限（[`MAX_RETRY_COUNT`](crate::feishu::db::MAX_RETRY_COUNT)），确定性失败（payload 非法 / 未知
//! op）直接置终态 'dead' 不再重试。即「靠 create 幂等 + update/delete 重放安全保证 at-least-once 无副作用」。
//!
//! ## 可测性（不联网）
//! 把出站写能力抽成 [`WriteApi`]（见 client.rs），生产由 `FeishuClient` 实现，单测注入 mock（可编程
//! 返回 create/get/patch/delete 的响应或注入错误）。于是 create 回写、update 无冲突、真冲突三件套、
//! delete 软删、幂等、失败计数全部能在 `:memory:` sqlite 上覆盖。

use serde_json::Value;
use sqlx::SqlitePool;

use crate::feishu::client::{FeishuError, WriteApi};
use crate::feishu::db::{
    apply_pushed_create, apply_pushed_update, overwrite_event_with_remote, save_local_draft,
    soft_delete_by_local_id, update_change_state, update_change_state_tx, DraftSnapshot, ChangeRow,
};
use crate::feishu::normalize::map_event;
use crate::feishu::sync::event_freshness;
use crate::feishu::Region;

/// 一轮 [`flush_pending`] 的产出统计（给前端 `feishu_flush_queue` 回显 / 决定是否重 hydrate）。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct FlushResult {
    /// 成功推送（create/update/delete 成功并置 done）的条数。
    pub pushed: usize,
    /// 判为真冲突（置 conflict、留草稿、未推送本地）的条数。
    pub conflicted: usize,
    /// 推送失败（置 failed + last_error，下轮重试）的条数。
    pub failed: usize,
}

/// 单条变更回写的内部结果（仅本模块用，flush_pending 据此累加 FlushResult）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OneOutcome {
    Pushed,
    Conflicted,
    Failed,
}

/// 远端「不存在」类飞书业务错误码（delete 时视为已删 = 成功）。
///
/// TODO（联调补全）：以真实接口返回为准。公开文档/社区常见：
///   - 1254404：事件不存在（calendar event not found）
///
/// 联调时把真实出现的「事件不存在」码加进来即可，逻辑不用改。
fn is_not_found_code(code: i64) -> bool {
    matches!(code, 1254404)
}

/// 从飞书事件接口响应里抽「事件对象」。create/get 的响应壳是 `{code,msg,data:{event:{...}}}`，
/// 这里把 `data.event` 取出来（取不到则退回 `data`，再退回整个 body，兜不同接口形态）。
fn extract_event(body: &Value) -> Value {
    if let Some(ev) = body.get("data").and_then(|d| d.get("event")) {
        return ev.clone();
    }
    if let Some(d) = body.get("data") {
        return d.clone();
    }
    body.clone()
}

/// 从一条飞书事件 JSON 里抽 `event_id`（新建后拿远端 id）。取不到返回 None。
fn event_id_of(ev: &Value) -> Option<String> {
    ev.get("event_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 从一条飞书事件 JSON 里抽 `etag`（远端版本号字符串）。取不到返回 None。
fn etag_of(ev: &Value) -> Option<String> {
    ev.get("etag")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 回写一条变更。返回该条的处置结果；落库（事件行 + 队列状态）在内部完成。
///
/// `region` 仅用于把远端事件 map 成本地字段（冲突覆盖主记录时）。三态冲突判定见模块级文档。
pub async fn flush_one<A: WriteApi>(
    api: &A,
    pool: &SqlitePool,
    token: &str,
    region: Region,
    change: &ChangeRow,
) -> Result<OneOutcomePub, FeishuError> {
    let outcome = match change.op.as_str() {
        "create" => flush_create(api, pool, token, region, change).await,
        "update" => flush_update(api, pool, token, region, change).await,
        "delete" => flush_delete(api, pool, token, change).await,
        other => {
            // 未知 op：**确定性失败**，直接置死信（不 panic、不卡队列、不无限重试），等人工排查（评审 HIGH-3）。
            let msg = format!("未知的变更类型 op='{other}'");
            mark_dead(pool, change, &msg).await;
            OneOutcome::Failed
        }
    };
    Ok(OneOutcomePub(outcome))
}

/// 回写整个 pending 队列：逐条 [`flush_one`]，累加成 [`FlushResult`]。
///
/// 串行处理（一条一条来）：飞书有接口限流（client 层已退避），低频串行最稳，也避免并发把限流打满。
/// 单条失败不中断整轮——它被标 failed 后继续下一条（与同步引擎「单点失败继续」同原则）。
/// 读队列失败（DB 层）才整体 Err 上抛（连库都不行，没法继续）。
pub async fn flush_pending<A: WriteApi>(
    api: &A,
    pool: &SqlitePool,
    token: &str,
    region: Region,
) -> Result<FlushResult, FeishuError> {
    let changes = crate::feishu::db::list_pending_changes(pool)
        .await
        .map_err(db_to_feishu)?;

    let mut result = FlushResult::default();
    for change in &changes {
        // flush_one 内部已兜住「该条」的所有落库；它只在 DB 层彻底失败时返回 Err。
        // 为「单条失败不中断整轮」，这里把该条的 Err 也降级成 Failed 计数 + 留痕，继续下一条。
        match flush_one(api, pool, token, region, change).await {
            Ok(o) => match o.0 {
                OneOutcome::Pushed => result.pushed += 1,
                OneOutcome::Conflicted => result.conflicted += 1,
                OneOutcome::Failed => result.failed += 1,
            },
            Err(e) => {
                mark_failed(pool, change, &e.to_string()).await;
                result.failed += 1;
            }
        }
    }
    Ok(result)
}

/* ===================== 各 op 的回写 ===================== */

/// create：把本地草稿推成远端事件。
///
/// 幂等（评审 HIGH-1）：change 已带 remote_event_id → 上一轮 create 已成功并把 remote_id 回写进队列行
/// （由 [`apply_pushed_create`] 与置 done 同事务落地，故能从重读的队列行看到它）→ 转 update 路径按已建
/// id 走三态更新，绝不再 create 一次（避免飞书端双建）。
async fn flush_create<A: WriteApi>(
    api: &A,
    pool: &SqlitePool,
    token: &str,
    region: Region,
    change: &ChangeRow,
) -> OneOutcome {
    // —— 幂等闸门：已建过就别再建。 ——
    if change
        .remote_event_id
        .as_deref()
        .is_some_and(|s| !s.is_empty())
    {
        // 转 update：按已建 id 做三态更新（远端可能在两轮之间又被改过）。
        return flush_update(api, pool, token, region, change).await;
    }

    // payload_json 是前端组好的飞书事件体（本模块原样转发，不掺合其字段语义）。
    // 非法 JSON 是**确定性失败**（重试多少次都一样）→ 直接置死信，不浪费重试名额打飞书（评审 HIGH-3）。
    let body = match parse_payload(&change.payload_json) {
        Ok(v) => v,
        Err(msg) => {
            mark_dead(pool, change, &msg).await;
            return OneOutcome::Failed;
        }
    };

    match api.create_event(token, &change.calendar_id, &body).await {
        Ok(resp) => {
            let ev = extract_event(&resp);
            let Some(remote_id) = event_id_of(&ev) else {
                // 建成功却没拿到 event_id（异常响应）→ 标失败留痕，下轮幂等闸门会因仍无 remote_id 再建一次。
                mark_failed(pool, change, "新建响应缺少 event_id").await;
                return OneOutcome::Failed;
            };
            let etag = etag_of(&ev);
            // 回写本地行（补 remote_id + etag + 清草稿）+ 队列行补 remote_id + 置 done，包进**同一事务**
            // 原子落地（评审 HIGH-1）：消灭「远端已建、队列没 done」中间态，崩溃重放靠队列行 remote_id 不双建。
            let rows = async {
                let mut tx = pool.begin().await?;
                let n =
                    apply_pushed_create(&mut tx, &change.id, &change.local_id, &remote_id, etag.as_deref())
                        .await?;
                tx.commit().await?;
                Ok::<u64, sqlx::Error>(n)
            }
            .await;
            match rows {
                // 本地事件行已被并发删（rows_affected==0）：远端已建、队列也已在同事务里置 done + 落了
                // remote_id（排查/对账用），但本地没有承接行——标 failed 留痕，别假装一切正常（评审 LOW-8）。
                Ok(0) => {
                    mark_failed(
                        pool,
                        change,
                        "远端已新建并落 remote_id，但本地事件行已不存在（可能被并发删除），无行承接",
                    )
                    .await;
                    OneOutcome::Failed
                }
                Ok(_) => OneOutcome::Pushed,
                Err(e) => {
                    mark_failed(pool, change, &format!("回写本地失败：{e}")).await;
                    OneOutcome::Failed
                }
            }
        }
        Err(e) => {
            mark_failed(pool, change, &e.to_string()).await;
            OneOutcome::Failed
        }
    }
}

/// update（PATCH）：**三态冲突判定**后再决定推 / 不推（见模块级文档）。
async fn flush_update<A: WriteApi>(
    api: &A,
    pool: &SqlitePool,
    token: &str,
    region: Region,
    change: &ChangeRow,
) -> OneOutcome {
    // update 必须有远端事件 id（指向要改的远端事件）。缺失 = 入队数据异常（确定性失败）→ 置死信。
    let Some(remote_id) = change.remote_event_id.as_deref().filter(|s| !s.is_empty()) else {
        mark_dead(pool, change, "更新缺少 remote_event_id").await;
        return OneOutcome::Failed;
    };

    // payload 先于 get 解析：非法 JSON 是确定性失败，先置死信、连远端 get 都不必发（评审 HIGH-3）。
    let body = match parse_payload(&change.payload_json) {
        Ok(v) => v,
        Err(msg) => {
            mark_dead(pool, change, &msg).await;
            return OneOutcome::Failed;
        }
    };

    // 1) 取远端当前事件 + etag（三态判定的基准）。
    //    注意（评审 LOW-10）：get 与下方 patch 之间不夹任何无关 await，把 TOCTOU 窗口压到最小。
    let remote_body = match api.get_event(token, &change.calendar_id, remote_id).await {
        Ok(v) => v,
        Err(e) => {
            mark_failed(pool, change, &e.to_string()).await;
            return OneOutcome::Failed;
        }
    };
    let remote_ev = extract_event(&remote_body);
    let remote_etag = etag_of(&remote_ev);

    // 2) 比对：远端 etag 是否仍等于入队时的 base_etag。
    //    **base_etag 为空 → 直接推送**：飞书日程列表响应不带 etag，同步时拿不到版本基线（base 恒为
    //    None）。此时无从做版本冲突检测，退化为 last-writer-wins 直接 PATCH——否则每次写回都因「base 为
    //    None」被保守误判成冲突、永远推不出去。只有「确实拿到过 base_etag、且与远端现值不一致」才算真冲突。
    let base_etag = change.base_etag.as_deref();
    if base_etag.is_none() || etag_matches(base_etag, remote_etag.as_deref()) {
        // —— 无冲突：远端没变（只有本地改）→ 直接 PATCH。 ——
        // TOCTOU 已知窗口（评审 LOW-10）：飞书日历 PATCH 不支持 If-Match/乐观锁条件头，get 判无冲突
        // 到 patch 推送之间，若有「其它飞书客户端」改了同一事件，本地 PATCH 会无条件覆盖那次远端改动
        // —— 跨客户端并发为 **last-writer-wins**。全局串行锁只挡本 App 自己的 sync/flush，挡不住外部。
        // 缓解：get 与 patch 紧邻、中间不夹其它 await，窗口已最小化；本 App 内并发安全。
        match api.patch_event(token, &change.calendar_id, remote_id, &body).await {
            Ok(resp) => {
                // PATCH 成功后用响应里的新 etag（取不到则沿用刚读到的远端 etag）回写本地。
                let new_etag = etag_of(&extract_event(&resp)).or(remote_etag);
                let rows = async {
                    let mut tx = pool.begin().await?;
                    let n = apply_pushed_update(
                        &mut tx,
                        &change.id,
                        &change.local_id,
                        new_etag.as_deref(),
                    )
                    .await?;
                    tx.commit().await?;
                    Ok::<u64, sqlx::Error>(n)
                }
                .await;
                match rows {
                    // 本地行已被并发删（评审 LOW-8）：远端已 PATCH、队列已在同事务置 done，但本地无行承接 → 留痕。
                    Ok(0) => {
                        mark_failed(
                            pool,
                            change,
                            "远端已更新，但本地事件行已不存在（可能被并发删除），无行承接",
                        )
                        .await;
                        OneOutcome::Failed
                    }
                    Ok(_) => OneOutcome::Pushed,
                    Err(e) => {
                        mark_failed(pool, change, &format!("回写本地失败：{e}")).await;
                        OneOutcome::Failed
                    }
                }
            }
            Err(e) => {
                mark_failed(pool, change, &e.to_string()).await;
                OneOutcome::Failed
            }
        }
    } else {
        // —— 真冲突：两边都改了 → 默认远端为准 + 保留本地草稿 + 队列 conflict，不推送本地。 ——
        resolve_conflict_remote_wins(pool, region, change, &remote_ev, remote_etag.as_deref()).await
    }
}

/// delete：删远端事件 → 成功软删本地 + done；远端已不存在（404 类）也按成功处理。
async fn flush_delete<A: WriteApi>(
    api: &A,
    pool: &SqlitePool,
    token: &str,
    change: &ChangeRow,
) -> OneOutcome {
    let remote_id = match change.remote_event_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => id,
        None => {
            // 没远端 id：本地草稿还没推送就被删 → 本地直接软删、队列 done，无需打飞书。
            // 软删失败时 mark_failed 重试，**不要** `let _` 吞错+硬置 done——否则前端会残留一条用户以为
            // 已删的 ghost 行、且队列 done 不再处理（评审 MED-6，对齐有 remote_id 的 finish_delete 写法）。
            return match soft_delete_local(pool, &change.local_id).await {
                Ok(_) => {
                    mark_done(pool, change).await;
                    OneOutcome::Pushed
                }
                Err(e) => {
                    mark_failed(pool, change, &format!("本地软删失败（无远端 id 草稿）：{e}")).await;
                    OneOutcome::Failed
                }
            };
        }
    };

    match api.delete_event(token, &change.calendar_id, remote_id).await {
        // 删成功，或远端本就不存在（视为已达成「远端没有这条」的目标）→ 软删本地 + done。
        Ok(_) => {
            finish_delete(pool, change).await;
            OneOutcome::Pushed
        }
        Err(FeishuError::Api { code, .. }) if is_not_found_code(code) => {
            finish_delete(pool, change).await;
            OneOutcome::Pushed
        }
        Err(e) => {
            mark_failed(pool, change, &e.to_string()).await;
            OneOutcome::Failed
        }
    }
}

/// 软删本地（按 local_id）+ 队列置 done（delete 成功收尾的公共动作）。
async fn finish_delete(pool: &SqlitePool, change: &ChangeRow) {
    if let Err(e) = soft_delete_local(pool, &change.local_id).await {
        // 远端已删成功，本地软删却失败：标失败留痕，但远端目标已达成（重放 delete 幂等：远端 404 仍算成功）。
        mark_failed(pool, change, &format!("远端已删，本地软删失败：{e}")).await;
        return;
    }
    mark_done(pool, change).await;
}

/// 真冲突处置：远端为准覆盖主记录 + 另存本地草稿 + 队列置 conflict（不推送本地）。
///
/// **落库四步包进同一事务原子提交（评审 MED-4）**：① 先把当前主记录快照成本地草稿（local_draft=1，
/// 幂等：已有草稿则跳过）；② 再用远端版覆盖主记录（local_draft=0）；③ 队列状态在**同一事务**里置
/// 'conflict'；④ 一起 commit。顺序关键：先存草稿、后覆盖主记录，否则草稿会拷到已被远端覆盖的内容。
///
/// 为什么 ③ 也要进同一事务（而非旧版的事务外旁路写）：旧版在 tx 提交后、置 conflict 前若崩溃，队列
/// 行仍是 pending/failed 且 base_etag 没变 → 下轮 flush 重判真冲突 → 又存一条新草稿（重复）。纳入同一
/// 事务后，崩溃要么全回滚（队列仍 pending，但 save_local_draft 的幂等守卫保证重放不堆草稿），要么全
/// 提交（队列已是 'conflict'，根本不再被 list_pending_changes 捞出）。
///
/// 边界（评审 MED-5）：主记录在「自己这条 update 的冲突处理」时已不存在（被并发删）→ save_local_draft
/// 返回 NoMaster：没有本地版可保留、也没有主记录可覆盖，**不静默置 conflict 丢编辑**，改 mark_failed 留痕。
async fn resolve_conflict_remote_wins(
    pool: &SqlitePool,
    region: Region,
    change: &ChangeRow,
    remote_ev: &Value,
    remote_etag: Option<&str>,
) -> OneOutcome {
    // 把远端事件归一成本地字段（拿不到 event_id 的脏数据 → map 失败，无法覆盖，标失败留痕）。
    let Some(mapped) = map_event(region, &change.calendar_id, false, remote_ev) else {
        mark_failed(pool, change, "冲突处理失败：远端事件无法解析（缺 event_id）").await;
        return OneOutcome::Failed;
    };

    // 冲突覆盖主记录的 freshness 与 sync 增量乱序守卫严格同源：用 event_freshness(remote_ev) 算
    // （评审 LOW-9），而非只 parse etag——否则非数字 etag 塌成 0，与后续增量拉回的新鲜度口径不一。
    let freshness = event_freshness(remote_ev);

    // 把整段「存草稿 + 覆盖主记录 + 置 conflict」放进同一事务；用枚举把事务里的判定结果带出来，
    // 据此决定最终 outcome（NoMaster → Failed 留痕；其余 → Conflicted）。
    enum TxResult {
        Done,
        NoMaster,
    }
    let write = async {
        let mut tx = pool.begin().await?;
        // ① 先快照本地版本成草稿（必须在覆盖主记录之前；幂等：已有草稿跳过）。
        match save_local_draft(&mut tx, &change.local_id).await? {
            DraftSnapshot::NoMaster => {
                // 主记录不存在：没本地版可存、没主记录可覆盖。回滚（什么都不改），让上层 mark_failed 留痕。
                tx.rollback().await?;
                return Ok::<TxResult, sqlx::Error>(TxResult::NoMaster);
            }
            DraftSnapshot::Created(_) | DraftSnapshot::AlreadyExists => { /* 继续覆盖主记录 */ }
        }
        // ② 用远端版覆盖主记录（local_draft=0）。
        overwrite_event_with_remote(
            &mut tx,
            &change.local_id,
            &mapped.title,
            &mapped.status,
            mapped.time.is_all_day,
            mapped.time.start_ts,
            mapped.time.end_ts,
            mapped.time.scheduled_date.as_deref(),
            mapped.time.scheduled_time.as_deref(),
            // etag 用远端响应的 etag（mapped.etag 在单事件 get 里通常也有，二者优先用传入的 remote_etag）。
            remote_etag.or(mapped.etag.as_deref()),
            freshness,
        )
        .await?;
        // ③ 队列置 conflict（同一事务，崩溃重放因 state='conflict' 不再被 list 捞）。
        update_change_state_tx(
            &mut tx,
            &change.id,
            "conflict",
            Some("远端已变更，已保留本地草稿待决断"),
        )
        .await?;
        // ④ 一起提交。
        tx.commit().await?;
        Ok::<TxResult, sqlx::Error>(TxResult::Done)
    };

    match write.await {
        Ok(TxResult::Done) => OneOutcome::Conflicted,
        Ok(TxResult::NoMaster) => {
            // 主记录已被并发删：本地无版可保留，别静默置 conflict 丢编辑（评审 MED-5）。
            mark_failed(
                pool,
                change,
                "冲突处理时主记录已不存在（可能被并发删除），无本地版可保留",
            )
            .await;
            OneOutcome::Failed
        }
        Err(e) => {
            mark_failed(pool, change, &format!("冲突落库失败：{e}")).await;
            OneOutcome::Failed
        }
    }
}

/* ===================== 小工具 ===================== */

/// 软删本地行（按 local_id，自开一个最小事务）。
async fn soft_delete_local(pool: &SqlitePool, local_id: &str) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    soft_delete_by_local_id(&mut tx, local_id).await?;
    tx.commit().await
}

/// 解析队列里的 payload_json 成 JSON 对象（飞书事件请求体）。非合法 JSON → 可读错误串。
fn parse_payload(s: &str) -> Result<Value, String> {
    serde_json::from_str::<Value>(s).map_err(|e| format!("payload_json 不是合法 JSON：{e}"))
}

/// 比较两个 etag 是否「相等」（三态判定用）。
///
/// 规则：两者都为 Some 且字符串相等 → true（远端没变）；其余 → false。
/// 注意：`base_etag` 为 None 的情形**不在这里决策**——flush_update 在调用本函数前就已短路成「直接推送」
/// （飞书日程列表不返回 etag，base 恒为 None，无版本基线可比，退化为 last-writer-wins）。因此本函数只在
/// 「确实持有 base_etag」时才被用来判断远端是否变过；remote 为 None 时仍保守判不等（走冲突）。
fn etag_matches(base: Option<&str>, remote: Option<&str>) -> bool {
    match (base, remote) {
        (Some(b), Some(r)) => b == r,
        _ => false,
    }
}

/// 把 sqlx 错误并入 FeishuError（与 sync.rs 的 db_to_feishu 同款，统一错误通道）。
fn db_to_feishu(e: sqlx::Error) -> FeishuError {
    FeishuError::Http(format!("本地数据库读取失败：{e}"))
}

/// 置队列某条为 done（成功收尾）。状态写失败只吞掉（旁路写，不影响已落地的事件数据）。
async fn mark_done(pool: &SqlitePool, change: &ChangeRow) {
    let _ = update_change_state(pool, &change.id, "done", None).await;
}

/// 置队列某条为 failed + 写错误（自增 retry_count 由 db 层完成）。状态写失败只吞掉。
async fn mark_failed(pool: &SqlitePool, change: &ChangeRow, err: &str) {
    let _ = update_change_state(pool, &change.id, "failed", Some(err)).await;
}

/// 置队列某条为 **dead**（死信终态）+ 写错误。状态写失败只吞掉。
///
/// 用于「确定性失败」（payload_json 非法 / 未知 op / 缺必要 id）——这类失败重试多少次都一样，直接
/// 置终态不再被 [`list_pending_changes`](crate::feishu::db::list_pending_changes) 捞出，避免无限重试打
/// 飞书（评审 HIGH-3）。dead 与 failed 的区别：failed 还会重试到 [`MAX_RETRY_COUNT`]
/// (crate::feishu::db::MAX_RETRY_COUNT) 上限，dead 一次到位、等人工处理。
async fn mark_dead(pool: &SqlitePool, change: &ChangeRow, err: &str) {
    let _ = update_change_state(pool, &change.id, "dead", Some(err)).await;
}

/// `OneOutcome` 的对外薄包装：让 [`flush_one`] 能返回它而不把内部枚举设为 pub。
/// 单测里用 `.0` 取内部值断言。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OneOutcomePub(OneOutcome);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::Row;
    use std::sync::Mutex;

    /* ---------- 测试库（:memory: + 手建表，max_connections(1)），与 sync.rs/db.rs 同构 ---------- */

    const TEST_DDL: &str = "
        CREATE TABLE calendar_events (
          id TEXT PRIMARY KEY, region TEXT NOT NULL, calendar_id TEXT NOT NULL,
          remote_event_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
          description TEXT, location TEXT, is_all_day INTEGER NOT NULL DEFAULT 0,
          start_ts INTEGER, end_ts INTEGER, timezone TEXT,
          scheduled_date TEXT, scheduled_time TEXT,
          status TEXT NOT NULL DEFAULT 'confirmed',
          is_recurring_instance INTEGER NOT NULL DEFAULT 0,
          recurrence_master_id TEXT, instance_start_iso TEXT, calendar_name TEXT,
          is_writable INTEGER NOT NULL DEFAULT 0, local_draft INTEGER NOT NULL DEFAULT 0,
          etag TEXT, freshness INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE event_map (
          id TEXT PRIMARY KEY, region TEXT NOT NULL, calendar_id TEXT NOT NULL,
          remote_event_id TEXT NOT NULL, dedup_key TEXT NOT NULL, local_id TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX uq_event_map_dedup ON event_map(region, calendar_id, dedup_key);
        CREATE UNIQUE INDEX uq_event_map_local ON event_map(local_id);
        CREATE TABLE calendar_change_queue (
          id TEXT PRIMARY KEY, op TEXT NOT NULL, local_id TEXT NOT NULL, calendar_id TEXT NOT NULL,
          remote_event_id TEXT, payload_json TEXT NOT NULL, base_etag TEXT,
          state TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_change_queue_state ON calendar_change_queue(state);
    ";

    async fn test_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        for stmt in TEST_DDL.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            sqlx::query(stmt).execute(&pool).await.unwrap();
        }
        pool
    }

    /* ---------- 测试辅助：插事件行 / 队列行；读回 ---------- */

    /// 插一条本地事件行（confirmed 定时；可指定 local_draft / remote_event_id / etag）。
    #[allow(clippy::too_many_arguments)]
    async fn put_event(
        pool: &SqlitePool,
        id: &str,
        remote_event_id: &str,
        title: &str,
        etag: Option<&str>,
        local_draft: i64,
    ) {
        let now = crate::util::now_iso();
        sqlx::query(
            "INSERT INTO calendar_events (id, region, calendar_id, remote_event_id, title, \
             status, is_writable, local_draft, etag, freshness, scheduled_date, scheduled_time, \
             created_at, updated_at) \
             VALUES (?1,'feishu','cal_1',?2,?3,'confirmed',1,?4,?5,0,'2026-05-30','09:00-10:00',?6,?6)",
        )
        .bind(id)
        .bind(remote_event_id)
        .bind(title)
        .bind(local_draft)
        .bind(etag)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();
    }

    /// 入队一条变更行。
    #[allow(clippy::too_many_arguments)]
    async fn enqueue(
        pool: &SqlitePool,
        id: &str,
        op: &str,
        local_id: &str,
        remote_event_id: Option<&str>,
        base_etag: Option<&str>,
        payload: Value,
    ) -> ChangeRow {
        let now = crate::util::now_iso();
        sqlx::query(
            "INSERT INTO calendar_change_queue \
             (id, op, local_id, calendar_id, remote_event_id, payload_json, base_etag, \
              state, retry_count, last_error, created_at, updated_at) \
             VALUES (?1,?2,?3,'cal_1',?4,?5,?6,'pending',0,NULL,?7,?7)",
        )
        .bind(id)
        .bind(op)
        .bind(local_id)
        .bind(remote_event_id)
        .bind(payload.to_string())
        .bind(base_etag)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();

        ChangeRow {
            id: id.into(),
            op: op.into(),
            local_id: local_id.into(),
            calendar_id: "cal_1".into(),
            remote_event_id: remote_event_id.map(str::to_string),
            payload_json: payload.to_string(),
            base_etag: base_etag.map(str::to_string),
            state: "pending".into(),
            retry_count: 0,
        }
    }

    async fn change_state(pool: &SqlitePool, id: &str) -> (String, i64, Option<String>) {
        let row = sqlx::query(
            "SELECT state, retry_count, last_error FROM calendar_change_queue WHERE id=?1",
        )
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
        (
            row.get::<String, _>("state"),
            row.get::<i64, _>("retry_count"),
            row.get::<Option<String>, _>("last_error"),
        )
    }

    async fn count(pool: &SqlitePool, sql: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(sql).fetch_one(pool).await.unwrap()
    }

    /* ---------- mock WriteApi ---------- */

    /// 一次接口调用的返回：一页 JSON（Ok）或一个错误（Err）。
    enum Reply {
        Ok(Value),
        Err(FeishuError),
    }

    /// 可编程 mock：每个方法一组 Reply 序列（按调用顺序消费），并记录各方法被调次数。
    struct MockWrite {
        create: Mutex<Vec<Reply>>,
        patch: Mutex<Vec<Reply>>,
        delete: Mutex<Vec<Reply>>,
        get: Mutex<Vec<Reply>>,
        create_calls: Mutex<usize>,
        patch_calls: Mutex<usize>,
        delete_calls: Mutex<usize>,
        get_calls: Mutex<usize>,
    }

    impl MockWrite {
        fn new() -> Self {
            MockWrite {
                create: Mutex::new(Vec::new()),
                patch: Mutex::new(Vec::new()),
                delete: Mutex::new(Vec::new()),
                get: Mutex::new(Vec::new()),
                create_calls: Mutex::new(0),
                patch_calls: Mutex::new(0),
                delete_calls: Mutex::new(0),
                get_calls: Mutex::new(0),
            }
        }
        fn with_create(self, r: Vec<Reply>) -> Self { *self.create.lock().unwrap() = r; self }
        fn with_patch(self, r: Vec<Reply>) -> Self { *self.patch.lock().unwrap() = r; self }
        fn with_delete(self, r: Vec<Reply>) -> Self { *self.delete.lock().unwrap() = r; self }
        fn with_get(self, r: Vec<Reply>) -> Self { *self.get.lock().unwrap() = r; self }

        fn pop(q: &Mutex<Vec<Reply>>, calls: &Mutex<usize>) -> Result<Value, FeishuError> {
            *calls.lock().unwrap() += 1;
            let mut g = q.lock().unwrap();
            if g.is_empty() {
                // 序列耗尽：默认返回空成功（测试若没配则视为「调了但没在乎返回」）。
                return Ok(json!({ "code": 0, "data": {} }));
            }
            match g.remove(0) {
                Reply::Ok(v) => Ok(v),
                Reply::Err(e) => Err(e),
            }
        }
    }

    impl WriteApi for MockWrite {
        async fn create_event(&self, _t: &str, _c: &str, _b: &Value) -> Result<Value, FeishuError> {
            MockWrite::pop(&self.create, &self.create_calls)
        }
        async fn patch_event(&self, _t: &str, _c: &str, _e: &str, _b: &Value) -> Result<Value, FeishuError> {
            MockWrite::pop(&self.patch, &self.patch_calls)
        }
        async fn delete_event(&self, _t: &str, _c: &str, _e: &str) -> Result<Value, FeishuError> {
            MockWrite::pop(&self.delete, &self.delete_calls)
        }
        async fn get_event(&self, _t: &str, _c: &str, _e: &str) -> Result<Value, FeishuError> {
            MockWrite::pop(&self.get, &self.get_calls)
        }
    }

    /// 造一条飞书事件响应壳 `{code,data:{event:{...}}}`（带 event_id + etag）。
    fn resp_event(event_id: &str, etag: &str) -> Value {
        json!({
            "code": 0,
            "data": { "event": {
                "event_id": event_id,
                "summary": format!("远端 {event_id}"),
                "status": "confirmed",
                "etag": etag,
                "start_time": { "timestamp": "1767225600", "timezone": "Asia/Shanghai" },
                "end_time":   { "timestamp": "1767229200", "timezone": "Asia/Shanghai" }
            }}
        })
    }

    /* ================= create：成功回写 id + etag + done ================= */

    #[tokio::test]
    async fn create_success_writes_back_id_etag_and_done() {
        let pool = test_pool().await;
        // 本地草稿行：remote_event_id 占位空串、local_draft=1。
        put_event(&pool, "ce_1", "", "我的新事件", None, 1).await;
        let change = enqueue(
            &pool, "q1", "create", "ce_1", None, None,
            json!({ "summary": "我的新事件" }),
        ).await;

        let api = MockWrite::new().with_create(vec![Reply::Ok(resp_event("ev_remote", "7"))]);

        let out = flush_one(&api, &pool, "tok", Region::Feishu, &change).await.unwrap();
        assert_eq!(out.0, OneOutcome::Pushed);

        // 本地行：remote_event_id 补上、etag 写入、草稿转正式。
        let row = sqlx::query("SELECT remote_event_id, etag, local_draft FROM calendar_events WHERE id='ce_1'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(row.get::<String, _>("remote_event_id"), "ev_remote");
        assert_eq!(row.get::<Option<String>, _>("etag").as_deref(), Some("7"));
        assert_eq!(row.get::<i64, _>("local_draft"), 0);

        // 队列：done。
        assert_eq!(change_state(&pool, "q1").await.0, "done");
        assert_eq!(*api.create_calls.lock().unwrap(), 1);
    }

    /* ===== create 幂等（评审 HIGH-1）：真实路径驱动——入队 remote_id=None，两次 flush 只建一次 ===== */

    /// 第一次 flush 让 create 成功（队列行在同一事务里补 remote_id + 置 done）；第二次 flush 走
    /// list_pending_changes 已不再捞出该条（done），create_calls 仍 ==1。**不靠入队预置 remote_id 假绿。**
    #[tokio::test]
    async fn create_idempotent_real_path_done_blocks_replay() {
        let pool = test_pool().await;
        // 入队时 remote_event_id=None（真实草稿态），本地草稿行也无 remote_id。
        put_event(&pool, "ce_1", "", "我的新事件", None, 1).await;
        enqueue(&pool, "q1", "create", "ce_1", None, None, json!({ "summary": "我的新事件" })).await;

        let api = MockWrite::new().with_create(vec![Reply::Ok(resp_event("ev_remote", "7"))]);

        // 第一次 flush：真实走 list_pending_changes → create → 队列行补 remote_id + done（同一事务）。
        let r1 = flush_pending(&api, &pool, "tok", Region::Feishu).await.unwrap();
        assert_eq!(r1.pushed, 1);
        assert_eq!(*api.create_calls.lock().unwrap(), 1, "第一次建一次");

        // 队列行：done + remote_event_id 已落（幂等命门：DB 里那行带 remote_id）。
        let (state, _, _) = change_state(&pool, "q1").await;
        assert_eq!(state, "done");
        let q_remote: Option<String> =
            sqlx::query_scalar("SELECT remote_event_id FROM calendar_change_queue WHERE id='q1'")
                .fetch_one(&pool).await.unwrap();
        assert_eq!(q_remote.as_deref(), Some("ev_remote"), "队列行补上 remote_id");

        // 第二次 flush：队列行已 done，list_pending_changes 根本不捞 → create 不再被调。
        let r2 = flush_pending(&api, &pool, "tok", Region::Feishu).await.unwrap();
        assert_eq!(r2.pushed, 0);
        assert_eq!(*api.create_calls.lock().unwrap(), 1, "重放绝不再 create（done 已收口）");
    }

    /// 模拟「create 成功、队列行已落 remote_id，但 state 被回退/重放成 pending」的崩溃残留：
    /// 第二次 flush 时幂等闸门必须从**队列行重读的 remote_id**判出「已建」→ 转 update 路径，
    /// **绝不再 create**。直击评审 HIGH-1：闸门读的是 list 出来的新行、不是入队内存快照。
    #[tokio::test]
    async fn create_idempotent_real_path_gate_blocks_when_state_regressed() {
        let pool = test_pool().await;
        put_event(&pool, "ce_1", "", "我的新事件", None, 1).await;
        enqueue(&pool, "q1", "create", "ce_1", None, None, json!({ "summary": "我的新事件" })).await;

        // 第一次：create 成功（队列行补 ev_remote + done）。
        let api1 = MockWrite::new().with_create(vec![Reply::Ok(resp_event("ev_remote", "7"))]);
        flush_pending(&api1, &pool, "tok", Region::Feishu).await.unwrap();
        assert_eq!(*api1.create_calls.lock().unwrap(), 1);

        // 人为把 state 回退到 pending（remote_event_id 仍是 ev_remote）——模拟「远端已建 + remote_id 已持久化，
        // 但 done 没生效/被重放」的中间态。注意：现实里 remote_id 与 done 同事务原子，这一步是手工制造残留。
        sqlx::query("UPDATE calendar_change_queue SET state='pending' WHERE id='q1'")
            .execute(&pool).await.unwrap();

        // 第二次 flush：闸门从队列行读到 remote_id=ev_remote → 转 update（get etag==base 5? 这里 get 返回 7,
        // base 为 None → 走冲突分支也行；关键只验证 create_calls 不增）。备好 get/patch 让 update 路径能跑完。
        let api2 = MockWrite::new()
            .with_get(vec![Reply::Ok(resp_event("ev_remote", "7"))])
            .with_patch(vec![Reply::Ok(resp_event("ev_remote", "8"))]);
        let r2 = flush_pending(&api2, &pool, "tok", Region::Feishu).await.unwrap();

        assert_eq!(*api2.create_calls.lock().unwrap(), 0, "已建过的条目绝不再 create（闸门读队列行 remote_id）");
        // base_etag 为 None → update 走冲突分支（保守），pushed=0/conflicted=1；无论哪条都没 create。
        assert_eq!(r2.pushed + r2.conflicted, 1, "走了 update 路径（PATCH 或冲突），而非 create");
    }

    /* ================= update 无冲突（远端 etag == base）→ PATCH 成功 ================= */

    #[tokio::test]
    async fn update_no_conflict_patches_and_done() {
        let pool = test_pool().await;
        put_event(&pool, "ce_1", "ev_1", "本地改过的标题", Some("5"), 1).await;
        let change = enqueue(
            &pool, "q1", "update", "ce_1", Some("ev_1"), Some("5"),
            json!({ "summary": "本地改过的标题" }),
        ).await;

        // 远端当前 etag 仍是 5（== base）→ 无冲突 → PATCH。
        let api = MockWrite::new()
            .with_get(vec![Reply::Ok(resp_event("ev_1", "5"))])
            .with_patch(vec![Reply::Ok(resp_event("ev_1", "6"))]);

        let out = flush_one(&api, &pool, "tok", Region::Feishu, &change).await.unwrap();
        assert_eq!(out.0, OneOutcome::Pushed);

        // 没起草冲突草稿：仍只有 1 行；etag 推进到 6；草稿转正式。
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 1);
        let row = sqlx::query("SELECT etag, local_draft FROM calendar_events WHERE id='ce_1'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(row.get::<Option<String>, _>("etag").as_deref(), Some("6"));
        assert_eq!(row.get::<i64, _>("local_draft"), 0);
        assert_eq!(change_state(&pool, "q1").await.0, "done");
        assert_eq!(*api.patch_calls.lock().unwrap(), 1);
    }

    /* ================= 真冲突（远端 etag != base）→ 远端覆盖主 + 草稿保留 + conflict + 未推送 ================= */

    #[tokio::test]
    async fn update_true_conflict_remote_wins_keeps_draft_and_not_pushed() {
        let pool = test_pool().await;
        // 本地把标题改成「本地版」，入队时 base_etag=5。
        put_event(&pool, "ce_1", "ev_1", "本地版标题", Some("5"), 1).await;
        let change = enqueue(
            &pool, "q1", "update", "ce_1", Some("ev_1"), Some("5"),
            json!({ "summary": "本地版标题" }),
        ).await;

        // 远端当前 etag=9（!= base 5），远端标题是「远端版」→ 真冲突。
        let api = MockWrite::new()
            .with_get(vec![Reply::Ok(json!({
                "code": 0,
                "data": { "event": {
                    "event_id": "ev_1",
                    "summary": "远端版标题",
                    "status": "confirmed",
                    "etag": "9",
                    "start_time": { "timestamp": "1767225600", "timezone": "Asia/Shanghai" },
                    "end_time":   { "timestamp": "1767229200", "timezone": "Asia/Shanghai" }
                }}
            }))])
            .with_patch(vec![Reply::Ok(resp_event("ev_1", "10"))]); // 备好但不该被调

        let out = flush_one(&api, &pool, "tok", Region::Feishu, &change).await.unwrap();
        assert_eq!(out.0, OneOutcome::Conflicted);

        // 关键①：绝不推送本地 → PATCH 一次都没调。
        assert_eq!(*api.patch_calls.lock().unwrap(), 0, "真冲突不推送本地");

        // 关键②：两行并存 —— 主记录(local_draft=0)被远端覆盖、草稿行(local_draft=1)保留本地版。
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 2, "主记录 + 草稿 = 2 行");

        // 主记录(ce_1)：标题=远端版、etag=9、local_draft=0。
        let main = sqlx::query("SELECT title, etag, local_draft FROM calendar_events WHERE id='ce_1'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(main.get::<String, _>("title"), "远端版标题", "主记录被远端覆盖");
        assert_eq!(main.get::<Option<String>, _>("etag").as_deref(), Some("9"));
        assert_eq!(main.get::<i64, _>("local_draft"), 0);

        // 草稿行：标题=本地版、local_draft=1（另一行，不是 ce_1）。
        let draft = sqlx::query(
            "SELECT title FROM calendar_events WHERE local_draft=1 AND id != 'ce_1'",
        ).fetch_one(&pool).await.unwrap();
        assert_eq!(draft.get::<String, _>("title"), "本地版标题", "本地草稿保留不丢");

        // 关键③：队列置 conflict。
        assert_eq!(change_state(&pool, "q1").await.0, "conflict");
    }

    /* ===== 飞书现实：日程列表/详情都不返回 etag → base_etag 恒为 None → 必须直接推送（不得误判冲突） =====
       这正是端到端联调里「拖动写回每次都被当成冲突挡下、PATCH 一次都发不出去」的命门。修复前 base=None
       会走 etag_matches→false→conflict 分支；修复后 flush_update 先用 base_etag.is_none() 短路成推送。
       本测试用「get 返回的事件体里压根没有 etag 字段」精确复刻飞书真实响应。 */
    #[tokio::test]
    async fn update_with_no_base_etag_pushes_not_conflict() {
        let pool = test_pool().await;
        // 飞书同步进来的事件本就没 etag → 本地 etag=None；本地拖动改了时段，入队 base_etag=None。
        put_event(&pool, "ce_1", "ev_1", "拖动改时段", None, 1).await;
        let change = enqueue(
            &pool, "q1", "update", "ce_1", Some("ev_1"), None,
            json!({ "summary": "拖动改时段" }),
        ).await;

        // 远端事件体同样没有 etag 字段（精确复刻飞书日程响应壳）。
        let api = MockWrite::new()
            .with_get(vec![Reply::Ok(json!({
                "code": 0,
                "data": { "event": {
                    "event_id": "ev_1",
                    "summary": "远端标题",
                    "status": "confirmed",
                    "start_time": { "timestamp": "1767225600", "timezone": "Asia/Shanghai" },
                    "end_time":   { "timestamp": "1767229200", "timezone": "Asia/Shanghai" }
                }}
            }))])
            .with_patch(vec![Reply::Ok(resp_event("ev_1", "n1"))]);

        let out = flush_one(&api, &pool, "tok", Region::Feishu, &change).await.unwrap();

        // 命门①：无 base_etag 必须推送（PATCH 真的发了一次），绝不能误判冲突。
        assert_eq!(out.0, OneOutcome::Pushed, "无 base_etag 应直接推送，而非冲突");
        assert_eq!(*api.patch_calls.lock().unwrap(), 1, "必须真的 PATCH 出去");

        // 命门②：不产生冲突草稿 —— 仍只有 1 行、草稿转正式、队列 done。
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 1, "不应起冲突草稿");
        let row = sqlx::query("SELECT local_draft FROM calendar_events WHERE id='ce_1'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(row.get::<i64, _>("local_draft"), 0, "草稿应转正式");
        assert_eq!(change_state(&pool, "q1").await.0, "done");
    }

    /* ================= delete：成功软删 + done ================= */

    #[tokio::test]
    async fn delete_success_soft_deletes_and_done() {
        let pool = test_pool().await;
        put_event(&pool, "ce_1", "ev_1", "待删", Some("2"), 0).await;
        let change = enqueue(&pool, "q1", "delete", "ce_1", Some("ev_1"), Some("2"), json!({})).await;

        let api = MockWrite::new().with_delete(vec![Reply::Ok(json!({ "code": 0 }))]);

        let out = flush_one(&api, &pool, "tok", Region::Feishu, &change).await.unwrap();
        assert_eq!(out.0, OneOutcome::Pushed);

        // 本地软删（status=cancelled，行还在）。
        let status: String = sqlx::query_scalar("SELECT status FROM calendar_events WHERE id='ce_1'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(status, "cancelled");
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events").await, 1, "软删不删行");
        assert_eq!(change_state(&pool, "q1").await.0, "done");
    }

    /// delete：远端已不存在（404 类业务码）也按成功软删 + done。
    #[tokio::test]
    async fn delete_remote_already_gone_treated_as_success() {
        let pool = test_pool().await;
        put_event(&pool, "ce_1", "ev_1", "待删", Some("2"), 0).await;
        let change = enqueue(&pool, "q1", "delete", "ce_1", Some("ev_1"), Some("2"), json!({})).await;

        // 飞书返回 1254404（事件不存在）。
        let api = MockWrite::new().with_delete(vec![Reply::Err(FeishuError::Api {
            code: 1254404,
            msg: "event not found".into(),
        })]);

        let out = flush_one(&api, &pool, "tok", Region::Feishu, &change).await.unwrap();
        assert_eq!(out.0, OneOutcome::Pushed, "远端已删 = 成功");
        let status: String = sqlx::query_scalar("SELECT status FROM calendar_events WHERE id='ce_1'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(status, "cancelled");
        assert_eq!(change_state(&pool, "q1").await.0, "done");
    }

    /* ================= 失败：retry_count+1 + state=failed + last_error ================= */

    #[tokio::test]
    async fn create_failure_increments_retry_and_marks_failed() {
        let pool = test_pool().await;
        put_event(&pool, "ce_1", "", "新事件", None, 1).await;
        let change = enqueue(&pool, "q1", "create", "ce_1", None, None, json!({ "summary": "新事件" })).await;

        // 飞书返回业务错误（非 not-found）。
        let api = MockWrite::new().with_create(vec![Reply::Err(FeishuError::Api {
            code: 1254005,
            msg: "boom".into(),
        })]);

        let out = flush_one(&api, &pool, "tok", Region::Feishu, &change).await.unwrap();
        assert_eq!(out.0, OneOutcome::Failed);

        let (state, retry, err) = change_state(&pool, "q1").await;
        assert_eq!(state, "failed");
        assert_eq!(retry, 1, "失败应自增 retry_count");
        assert!(err.unwrap().contains("boom"), "应落 last_error");

        // 本地行没被回写（仍是草稿、无 remote_id）。
        let row = sqlx::query("SELECT remote_event_id, local_draft FROM calendar_events WHERE id='ce_1'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(row.get::<String, _>("remote_event_id"), "");
        assert_eq!(row.get::<i64, _>("local_draft"), 1);
    }

    /* ===== 确定性失败 → 死信终态（评审 HIGH-3）：不重试、不打飞书 ===== */

    /// payload_json 非法 → create 直接置 'dead'（确定性失败），create_event 一次都不调。
    #[tokio::test]
    async fn create_invalid_payload_goes_dead_without_calling_api() {
        let pool = test_pool().await;
        put_event(&pool, "ce_1", "", "坏 payload", None, 1).await;
        // payload_json 存非法 JSON。
        let now = crate::util::now_iso();
        sqlx::query(
            "INSERT INTO calendar_change_queue (id, op, local_id, calendar_id, remote_event_id, \
             payload_json, base_etag, state, retry_count, last_error, created_at, updated_at) \
             VALUES ('q1','create','ce_1','cal_1',NULL,'{ 不是 JSON ',NULL,'pending',0,NULL,?1,?1)",
        )
        .bind(&now).execute(&pool).await.unwrap();
        let change = ChangeRow {
            id: "q1".into(), op: "create".into(), local_id: "ce_1".into(),
            calendar_id: "cal_1".into(), remote_event_id: None,
            payload_json: "{ 不是 JSON ".into(), base_etag: None,
            state: "pending".into(), retry_count: 0,
        };

        let api = MockWrite::new();
        let out = flush_one(&api, &pool, "tok", Region::Feishu, &change).await.unwrap();
        assert_eq!(out.0, OneOutcome::Failed);
        assert_eq!(*api.create_calls.lock().unwrap(), 0, "确定性失败不该打飞书");
        assert_eq!(change_state(&pool, "q1").await.0, "dead", "非法 payload → 死信终态");
    }

    /// 未知 op → 直接置 'dead'，不卡队列、不无限重试。
    #[tokio::test]
    async fn unknown_op_goes_dead() {
        let pool = test_pool().await;
        let change = enqueue(&pool, "q1", "frobnicate", "ce_1", None, None, json!({})).await;
        let api = MockWrite::new();
        let out = flush_one(&api, &pool, "tok", Region::Feishu, &change).await.unwrap();
        assert_eq!(out.0, OneOutcome::Failed);
        assert_eq!(change_state(&pool, "q1").await.0, "dead");
    }

    /// 死信(dead)与达到重试上限的 failed 都不再被 list_pending_changes 捞出（评审 HIGH-3 端到端）。
    /// 一条永久失败的 create 反复 flush，到上限后不再被处理、create_calls 封顶。
    #[tokio::test]
    async fn permanently_failing_change_stops_after_retry_cap() {
        use crate::feishu::db::MAX_RETRY_COUNT;
        let pool = test_pool().await;
        put_event(&pool, "ce_1", "", "总是失败", None, 1).await;
        enqueue(&pool, "q1", "create", "ce_1", None, None, json!({ "summary": "x" })).await;

        // create 永远返回业务错误（非 404，会进 failed 而非 dead）。每轮都备一个错误。
        let api = MockWrite::new().with_create(
            (0..(MAX_RETRY_COUNT as usize + 5))
                .map(|_| Reply::Err(FeishuError::Api { code: 1254005, msg: "always boom".into() }))
                .collect(),
        );

        // 反复 flush 远超上限次数：list_pending_changes 只在 retry_count < MAX 时捞，到上限自动停。
        for _ in 0..(MAX_RETRY_COUNT + 5) {
            flush_pending(&api, &pool, "tok", Region::Feishu).await.unwrap();
        }

        // create 被调次数 == MAX_RETRY_COUNT（达到上限后不再被捞出、不再打飞书）。
        let calls = *api.create_calls.lock().unwrap();
        assert_eq!(
            calls, MAX_RETRY_COUNT as usize,
            "失败项到重试上限后不再被 list 捞出，create_calls 封顶在 {MAX_RETRY_COUNT}"
        );
        let (state, retry, _) = change_state(&pool, "q1").await;
        assert_eq!(state, "failed");
        assert_eq!(retry, MAX_RETRY_COUNT, "retry_count 停在上限");
    }

    /* ===== flush_delete 无 remote_id 分支：软删失败 mark_failed 重试（评审 MED-6） ===== */

    /// 无 remote_id 的草稿删除：本地软删成功 → done（正常路径）。
    #[tokio::test]
    async fn delete_local_draft_without_remote_id_soft_deletes_and_done() {
        let pool = test_pool().await;
        put_event(&pool, "ce_1", "", "未推送就删", None, 1).await;
        let change = enqueue(&pool, "q1", "delete", "ce_1", None, None, json!({})).await;
        let api = MockWrite::new();
        let out = flush_one(&api, &pool, "tok", Region::Feishu, &change).await.unwrap();
        assert_eq!(out.0, OneOutcome::Pushed);
        assert_eq!(*api.delete_calls.lock().unwrap(), 0, "无 remote_id 不打飞书");
        let status: String = sqlx::query_scalar("SELECT status FROM calendar_events WHERE id='ce_1'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(status, "cancelled");
        assert_eq!(change_state(&pool, "q1").await.0, "done");
    }

    /* ===== LOW-8：apply_pushed_* 命中 0 行（本地行被并发删）→ mark_failed 留痕，不静默 done ===== */

    /// create 成功，但本地事件行已被并发删除（rows_affected==0）→ 标 failed 留痕（不静默 done）。
    /// 注意：队列行仍在同事务里被补上 remote_id + 置 done（对账用），但 outcome 为 Failed 以暴露异常。
    #[tokio::test]
    async fn create_marks_failed_when_local_row_concurrently_deleted() {
        let pool = test_pool().await;
        // 入队 create，但**不**放本地事件行（模拟入队后、flush 前被并发删）。
        enqueue(&pool, "q1", "create", "ce_gone", None, None, json!({ "summary": "x" })).await;
        let change = ChangeRow {
            id: "q1".into(), op: "create".into(), local_id: "ce_gone".into(),
            calendar_id: "cal_1".into(), remote_event_id: None,
            payload_json: "{\"summary\":\"x\"}".into(), base_etag: None,
            state: "pending".into(), retry_count: 0,
        };
        let api = MockWrite::new().with_create(vec![Reply::Ok(resp_event("ev_new", "1"))]);
        let out = flush_one(&api, &pool, "tok", Region::Feishu, &change).await.unwrap();
        assert_eq!(out.0, OneOutcome::Failed, "本地行缺失 → 留痕而非静默 done");
        let (state, _, err) = change_state(&pool, "q1").await;
        assert_eq!(state, "failed");
        assert!(err.unwrap().contains("本地"), "last_error 应说明本地行缺失");
    }

    /* ===== MED-5：冲突处理时主记录已不存在 → mark_failed 留痕，不静默置 conflict ===== */

    /// update 真冲突，但主记录在处理时已不存在（被并发删）→ save_local_draft 返回 NoMaster →
    /// 标 failed 留痕（绝不静默置 conflict 丢编辑），且不产生草稿、不留半截覆盖。
    #[tokio::test]
    async fn conflict_with_missing_master_marks_failed_not_silent_conflict() {
        let pool = test_pool().await;
        // 入队 update（base_etag=5），但**不**放主记录行（模拟主记录被并发删）。
        let change = enqueue(
            &pool, "q1", "update", "ce_gone", Some("ev_1"), Some("5"),
            json!({ "summary": "本地版" }),
        ).await;
        // get 返回 etag=9（!= base 5）→ 真冲突分支。
        let api = MockWrite::new().with_get(vec![Reply::Ok(resp_event("ev_1", "9"))]);

        let out = flush_one(&api, &pool, "tok", Region::Feishu, &change).await.unwrap();
        assert_eq!(out.0, OneOutcome::Failed, "主记录缺失 → 留痕，不静默 conflict");
        assert_eq!(change_state(&pool, "q1").await.0, "failed");
        // 没有任何草稿被造出来（事务回滚）。
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events WHERE local_draft=1").await, 0);
    }

    /* ===== MED-4：冲突处置幂等 —— 重放不堆重复草稿 + 队列置 conflict 在同一事务 ===== */

    /// 同一条 update 真冲突连跑两次（模拟崩溃重放）：草稿只产出一条（幂等），主记录稳定为远端版，
    /// 队列在第一次就已 conflict（同一事务原子提交，第二次因 base_etag 仍不变再判冲突但不再堆草稿）。
    #[tokio::test]
    async fn conflict_resolution_is_idempotent_no_duplicate_drafts() {
        let pool = test_pool().await;
        put_event(&pool, "ce_1", "ev_1", "本地版标题", Some("5"), 0).await;
        let change = enqueue(
            &pool, "q1", "update", "ce_1", Some("ev_1"), Some("5"),
            json!({ "summary": "本地版标题" }),
        ).await;

        // 两轮都让 get 返回 etag=9（!= base 5）→ 都判真冲突。
        let api = MockWrite::new().with_get(vec![
            Reply::Ok(resp_event("ev_1", "9")),
            Reply::Ok(resp_event("ev_1", "9")),
        ]);

        // 第一次冲突处置：存草稿 + 覆盖主 + 置 conflict（同一事务）。
        let out1 = flush_one(&api, &pool, "tok", Region::Feishu, &change).await.unwrap();
        assert_eq!(out1.0, OneOutcome::Conflicted);
        assert_eq!(change_state(&pool, "q1").await.0, "conflict", "第一次即在同一事务置 conflict");
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM calendar_events WHERE local_draft=1").await, 1, "一条草稿");

        // 模拟重放：把队列状态手工回退到 pending（remote_id/base_etag 不变），再跑一次。
        sqlx::query("UPDATE calendar_change_queue SET state='pending' WHERE id='q1'")
            .execute(&pool).await.unwrap();
        let out2 = flush_one(&api, &pool, "tok", Region::Feishu, &change).await.unwrap();
        assert_eq!(out2.0, OneOutcome::Conflicted);

        // 关键：草稿仍只有一条（幂等守卫拦住重复堆草稿），主记录仍是远端版。
        assert_eq!(
            count(&pool, "SELECT COUNT(*) FROM calendar_events WHERE local_draft=1").await,
            1,
            "重放不得堆出第二条草稿（评审 MED-4）"
        );
        let main_title: String =
            sqlx::query_scalar("SELECT title FROM calendar_events WHERE id='ce_1'")
                .fetch_one(&pool).await.unwrap();
        assert_eq!(main_title, "远端 ev_1", "主记录稳定为远端版");
    }

    /* ================= flush_pending：整队列聚合 + 单点失败不中断 ================= */

    #[tokio::test]
    async fn flush_pending_aggregates_and_continues_on_failure() {
        let pool = test_pool().await;
        // q1 create 成功；q2 delete 失败（非 404）；q3 update 无冲突成功。按 created_at 顺序消费。
        put_event(&pool, "ce_1", "", "新", None, 1).await;
        put_event(&pool, "ce_2", "ev_2", "删", Some("1"), 0).await;
        put_event(&pool, "ce_3", "ev_3", "改", Some("8"), 1).await;
        enqueue(&pool, "q1", "create", "ce_1", None, None, json!({})).await;
        enqueue(&pool, "q2", "delete", "ce_2", Some("ev_2"), Some("1"), json!({})).await;
        enqueue(&pool, "q3", "update", "ce_3", Some("ev_3"), Some("8"), json!({})).await;

        let api = MockWrite::new()
            .with_create(vec![Reply::Ok(resp_event("ev_new", "1"))])
            .with_delete(vec![Reply::Err(FeishuError::Http("网络抖动".into()))])
            .with_get(vec![Reply::Ok(resp_event("ev_3", "8"))]) // 远端 etag==base → 无冲突
            .with_patch(vec![Reply::Ok(resp_event("ev_3", "9"))]);

        let result = flush_pending(&api, &pool, "tok", Region::Feishu).await.unwrap();

        assert_eq!(result.pushed, 2, "q1 + q3 成功");
        assert_eq!(result.failed, 1, "q2 失败");
        assert_eq!(result.conflicted, 0);

        // 失败的 q2 不影响后面的 q3（单点失败继续）。
        assert_eq!(change_state(&pool, "q1").await.0, "done");
        assert_eq!(change_state(&pool, "q2").await.0, "failed");
        assert_eq!(change_state(&pool, "q3").await.0, "done");
    }

    /* ================= etag_matches 纯函数 ================= */

    #[test]
    fn etag_matches_semantics() {
        assert!(etag_matches(Some("5"), Some("5")), "相等 → 无冲突");
        assert!(!etag_matches(Some("5"), Some("6")), "不等 → 冲突");
        assert!(!etag_matches(None, Some("5")), "base 缺失 → 保守判冲突");
        assert!(!etag_matches(Some("5"), None), "远端 etag 缺失 → 保守判冲突");
        assert!(!etag_matches(None, None), "都缺失 → 保守判冲突");
    }
}
