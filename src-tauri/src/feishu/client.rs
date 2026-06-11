//! 飞书 / Lark 出站 HTTP 客户端（Phase 2 同步引擎的网络底座）。
//!
//! 只负责「发一个鉴权过的 GET、把飞书的统一响应壳解开、429 自动退避重试」。业务语义
//! （拉日历列表 / 日程列表 / 增量游标）在 sync.rs，这里不掺合。
//!
//! 飞书 OpenAPI 的统一响应壳是 `{ code, msg, data }`：HTTP 200 不代表成功，必须看 body 里
//! 的 `code`——`code == 0` 才是真成功，非 0 是业务错误（含 token 失效）。所以本层在 HTTP 层
//! 之上再剥一层 code 判定，把这两类错误都收敛进 [`FeishuError`]。
//!
//! 退避策略（429）：优先采纳响应头给的建议等待秒数（`Retry-After` / 飞书私有的
//! `X-Ogw-Ratelimit-Reset`），没有头才用指数退避兜底（base 1s，factor 2，cap 60s，最多 5 次）。
//! 重试**全部耗尽**前不会把 `RateLimited` 抛给上层——上层看到的要么是成功、要么是已经尽力的失败。
//!
//! 关键决策：低并发场景不在 client 层做信号量限流，由 engine 层保证「同一时刻一个同步任务、
//! 日历串行」（见实施计划 P2-1）。所以这里没有任何全局并发控制，只有单请求的退避。

use std::fmt;
use std::time::Duration;

use serde_json::Value;
use url::Url;

use crate::feishu::Region;

/// 退避基数：第一次重试等约 1 秒。
const BACKOFF_BASE_SECS: u64 = 1;
/// 退避倍率：每次重试等待时间翻倍（1s → 2s → 4s …）。
const BACKOFF_FACTOR: u64 = 2;
/// 单次请求最多重试次数（不含首次）。耗尽后返回最后一次的错误。
const MAX_RETRIES: u32 = 5;
/// 退避等待上限：再怎么指数增长，单次也不睡超过 60 秒（含响应头建议值也截到这）。
const BACKOFF_CAP_SECS: u64 = 60;

/// 飞书出站调用的错误分类。
///
/// 故意只分四类，覆盖上层要分别处置的场景：
/// - [`Http`](FeishuError::Http)：连不上 / 超时 / 非 JSON 响应等传输层问题（可整轮重试）。
/// - [`RateLimited`](FeishuError::RateLimited)：429 且退避重试已耗尽（上层放弃本轮、等下次调度）。
/// - [`Api`](FeishuError::Api)：飞书 body `code != 0` 的业务错误（带原始 code/msg 供排查）。
/// - [`TokenExpired`](FeishuError::TokenExpired)：access_token 失效（上层应 refresh 后重试本轮）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeishuError {
    /// 传输层错误（reqwest 报错 / 读 body 失败 / body 不是 JSON）。
    Http(String),
    /// 触发限流且重试耗尽。`retry_after` 是最后一次建议的等待秒数（供日志 / 上层决定下次间隔）。
    RateLimited { retry_after: u64 },
    /// 飞书业务错误：响应壳 `code != 0`。
    Api { code: i64, msg: String },
    /// access_token 失效 / 过期（由特定业务 code 映射而来）。上层应刷新 token 再重试。
    TokenExpired,
}

impl fmt::Display for FeishuError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FeishuError::Http(e) => write!(f, "飞书请求传输失败：{e}"),
            FeishuError::RateLimited { retry_after } => {
                write!(f, "飞书接口限流（已重试耗尽，建议等待 {retry_after}s）")
            }
            FeishuError::Api { code, msg } => {
                write!(f, "飞书接口返回错误（code {code}）：{msg}")
            }
            FeishuError::TokenExpired => write!(f, "飞书 access_token 已失效，需刷新后重试"),
        }
    }
}

impl std::error::Error for FeishuError {}

/// 把飞书的业务错误 code 归类：是否属于「token 失效」一类。
///
/// 命中则上层应走 refresh→重试；否则当普通业务错误（Api）抛出。
///
/// TODO（联调补全）：以下 code 取自飞书公开文档的常见值，**最终以真实凭证联调时返回的为准**。
/// 常见 user_access_token 失效相关：
///   - 99991677：access_token 过期（**联调实测确认**，msg: "Authentication token expired"）
///   - 99991661：access_token 无效
///   - 99991663 / 99991664：access_token 无效 / 过期（tenant/user 体系历史值）
///   - 99991668：token 过期
/// 联调时把真实出现的失效 code 加进这个列表即可，逻辑不用改。
fn is_token_expired_code(code: i64) -> bool {
    matches!(code, 99991677 | 99991661 | 99991663 | 99991664 | 99991668)
}

/// 计算第 `attempt` 次重试（attempt 从 0 起算）前应等待的时长。
///
/// 纯函数，不睡眠、不碰网络，方便单测。规则：
/// 1. 若响应头给了建议秒数 `retry_after`（`Retry-After` / `X-Ogw-Ratelimit-Reset`），**优先采纳**，
///    但仍截到 `BACKOFF_CAP_SECS` 上限（防御服务端给个离谱大值把同步卡死）。
/// 2. 否则指数退避：`BACKOFF_BASE_SECS * BACKOFF_FACTOR^attempt`，同样截到 cap。
///
/// 注意：返回 0 是可能的（极少见，比如头里明确给了 0），调用方对 0 直接不睡即可。
pub fn backoff_delay(attempt: u32, retry_after: Option<u64>) -> Duration {
    // 响应头优先：服务端最懂自己什么时候恢复。
    if let Some(secs) = retry_after {
        return Duration::from_secs(secs.min(BACKOFF_CAP_SECS));
    }
    // 指数退避：base * factor^attempt。用 checked_pow + saturating_mul 防溢出（大 attempt 时
    // 直接饱和到很大值，再被 cap 截下来），绝不 panic。
    let factor_pow = BACKOFF_FACTOR.checked_pow(attempt).unwrap_or(u64::MAX);
    let secs = BACKOFF_BASE_SECS
        .saturating_mul(factor_pow)
        .min(BACKOFF_CAP_SECS);
    Duration::from_secs(secs)
}

/// 出站 HTTP 客户端。一个 region 一个实例（host 在 region 上定一处，见 mod.rs）。
///
/// `http` 复用同一个 [`reqwest::Client`]（内部带连接池），不要每次请求新建。
#[derive(Clone)]
pub struct FeishuClient {
    http: reqwest::Client,
    region: Region,
}

impl FeishuClient {
    /// 新建一个绑定到某区域的客户端。
    ///
    /// reqwest::Client::new() 在本项目的 feature 组合下不会失败（rustls + webpki-roots，无系统
    /// 证书库读取），沿用 commands.rs:182 的 `Client::new()` 风格直接构造。
    pub fn new(region: Region) -> Self {
        FeishuClient {
            http: reqwest::Client::new(),
            region,
        }
    }

    /// 发一个鉴权过的 GET，返回飞书响应壳里的整个 body（`{code,msg,data}` 的 Value）。
    ///
    /// 流程：
    /// 1. 拼 URL：`{region.api_base()}/{path}`（api_base 已含 `https://{host}/open-apis`）。
    /// 2. 注入 `Authorization: Bearer {token}` + 附加 query。
    /// 3. 发请求；HTTP 429 → 读响应头建议值 / 指数退避，循环重试至多 MAX_RETRIES 次。
    /// 4. 解析 body 为 JSON；飞书 `code != 0` → token 失效类转 [`TokenExpired`]，否则 [`Api`]。
    ///
    /// 关键决策：重试循环只针对 429（限流是「等会儿就好」）。其它 HTTP 错误码（4xx/5xx）不在这层
    /// 盲目重试——5xx 是否可重试、4xx 的语义差异交给上层按 body code 决策，避免无脑重放写坏状态。
    /// （本契约下只做 GET 只读，无副作用，但仍保守不重试非 429。）
    pub async fn get_json(
        &self,
        token: &str,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<Value, FeishuError> {
        let url = self.build_url(path, query)?;
        // GET 无 body：每次重试都新建一个相同的 GET builder。
        self.send_with_retry(|| self.http.get(&url).bearer_auth(token))
            .await
    }

    /// 发一个鉴权过的 POST（JSON body），用于「新建事件」等写操作（Phase 4 回写）。
    ///
    /// 与 [`get_json`](FeishuClient::get_json) 共用同一套 429 退避 + 响应壳解读，只是动词换成 POST、
    /// 带 JSON body。reqwest 的 "json" feature 已开（见 Cargo.toml），故可直接 `.json(&body)`。
    ///
    /// 关键决策（写操作的重试安全性）：本层重试**只针对 429**——429 是「请求根本没被处理就被网关挡下」，
    /// 重放安全。其它失败（传输错误 / 5xx / 业务 code!=0）一律不在本层重放，避免「请求其实已在服务端
    /// 生效、但我们没收到响应」时盲目重发造成重复创建。写操作的幂等由上层（writeback.rs）用变更队列的
    /// remote_event_id 把关（已建过就不再 create）。
    pub async fn post_json(
        &self,
        token: &str,
        path: &str,
        body: &Value,
    ) -> Result<Value, FeishuError> {
        let url = self.build_url(path, &[])?;
        self.send_with_retry(|| self.http.post(&url).bearer_auth(token).json(body))
            .await
    }

    /// 发一个鉴权过的 PATCH（JSON body），用于「更新事件」（Phase 4 回写）。语义同 [`post_json`]。
    pub async fn patch_json(
        &self,
        token: &str,
        path: &str,
        body: &Value,
    ) -> Result<Value, FeishuError> {
        let url = self.build_url(path, &[])?;
        self.send_with_retry(|| self.http.patch(&url).bearer_auth(token).json(body))
            .await
    }

    /// 发一个鉴权过的 DELETE（无 body），用于「删除事件」（Phase 4 回写）。语义同 [`post_json`]。
    ///
    /// 注：远端事件已不存在时，飞书可能返回业务 code!=0（如 1254404 事件不存在）。本层仍如实把它当
    /// [`Api`] 错误返回——「远端已删 = 删成功」的语义判定放在上层 writeback.rs（它知道这是 delete 意图）。
    pub async fn delete(&self, token: &str, path: &str) -> Result<Value, FeishuError> {
        let url = self.build_url(path, &[])?;
        self.send_with_retry(|| self.http.delete(&url).bearer_auth(token))
            .await
    }

    /// 拼完整请求 URL（api_base + path + 已编码 query）。抽出来给 GET/POST/PATCH/DELETE 共用。
    ///
    /// path 可能带或不带前导 '/'，统一成「api_base + '/' + 去掉前导斜杠的 path」。
    /// 用 url crate 拼 query 并做 percent-encoding（与 oauth.rs 的 build_authorize_url 同款）。
    /// 注意：reqwest 0.13 的 RequestBuilder::query 在 "query" feature 之后，本项目未开该 feature
    ///（且任务限定不改 Cargo.toml），故手动拼 query 串，行为等价、依赖更少。
    fn build_url(&self, path: &str, query: &[(&str, &str)]) -> Result<String, FeishuError> {
        let base = format!("{}/{}", self.region.api_base(), path.trim_start_matches('/'));
        let mut parsed =
            Url::parse(&base).map_err(|e| FeishuError::Http(format!("拼接请求 URL 失败：{e}")))?;
        {
            let mut pairs = parsed.query_pairs_mut();
            for (k, v) in query {
                pairs.append_pair(k, v);
            }
        }
        Ok(parsed.to_string())
    }

    /// 发请求 + 429 退避重试 + 响应壳解读，所有动词共用的核心循环。
    ///
    /// `build_req` 是「构造一个全新 RequestBuilder」的闭包——每次重试都重新构造一个（reqwest 的
    /// RequestBuilder 带 body 时不可 Clone，故用闭包按需重建，比手动 clone 干净）。GET/DELETE 重建
    /// 即重发同一请求；POST/PATCH 重建会重新序列化同一份 body，等价重发。
    ///
    /// 重试只针对 429（与 get_json 原有语义一致）：其它 HTTP 状态码不在这层盲目重试，读 body 看飞书
    /// `code` 判成败（HTTP 200 也可能 code!=0）。
    async fn send_with_retry<F>(&self, build_req: F) -> Result<Value, FeishuError>
    where
        F: Fn() -> reqwest::RequestBuilder,
    {
        // 最近一次 429 建议的等待秒数（重试耗尽时塞进 RateLimited 供上层 / 日志参考）。
        let mut last_retry_after: u64 = 0;

        // attempt = 0 是首次请求；之后每次 429 都 +1，到 MAX_RETRIES 仍 429 就放弃。
        for attempt in 0..=MAX_RETRIES {
            let resp = build_req()
                .send()
                .await
                .map_err(|e| FeishuError::Http(e.to_string()))?;

            let status = resp.status();

            // 429：限流。读响应头建议值 → 退避 → 重试（除非已是最后一次）。
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = parse_retry_after(resp.headers());
                last_retry_after = retry_after.unwrap_or(0);
                if attempt == MAX_RETRIES {
                    // 重试预算耗尽，把限流如实抛给上层（上层放弃本轮、等下次调度）。
                    return Err(FeishuError::RateLimited {
                        retry_after: last_retry_after,
                    });
                }
                let delay = backoff_delay(attempt, retry_after);
                tokio::time::sleep(delay).await;
                continue;
            }

            // 非 429：读 body 解析。飞书即便业务失败也常返回 HTTP 200 + code!=0，所以这里不靠
            // HTTP 状态码判成败，直接解 body 看 code（HTTP 4xx/5xx 通常 body 也带 code/msg）。
            // DELETE 等接口可能返回空 body：空 body 解析失败时当作 code 0 成功（无错误信息可读）。
            let raw = resp
                .bytes()
                .await
                .map_err(|e| FeishuError::Http(format!("读取响应体失败：{e}")))?;
            if raw.is_empty() {
                // 空响应体：HTTP 层已非 429（多半是 2xx 的 204/空体成功），按成功返回空对象。
                return Ok(Value::Object(serde_json::Map::new()));
            }
            let body: Value = serde_json::from_slice(&raw)
                .map_err(|e| FeishuError::Http(format!("响应不是合法 JSON：{e}")))?;

            return interpret_body(body);
        }

        // 循环结构上保证会在循环内 return（attempt 到 MAX_RETRIES 的 429 分支会 return）。
        // 这里仅为类型完整性兜底，正常不可达。
        Err(FeishuError::RateLimited {
            retry_after: last_retry_after,
        })
    }
}

/// 出站「写」能力 trait（Phase 4 回写）。抽出来只为一件事：让 [`writeback`](crate::feishu::writeback)
/// 的核心逻辑能在单测里注入 mock（不联网跑通 create/update/delete + 三态冲突）。生产路径由
/// [`FeishuClient`] 实现，path/body 的拼装落在实现里（与 sync.rs 的 [`CalendarApi`] 同一思路）。
///
/// 四个方法对应飞书日历事件接口：
///  - [`create_event`](WriteApi::create_event)：`POST   /calendar/v4/calendars/{cal}/events`
///  - [`patch_event`](WriteApi::patch_event)：  `PATCH  /calendar/v4/calendars/{cal}/events/{id}`
///  - [`delete_event`](WriteApi::delete_event)：`DELETE /calendar/v4/calendars/{cal}/events/{id}`
///  - [`get_event`](WriteApi::get_event)：      `GET    /calendar/v4/calendars/{cal}/events/{id}`（取远端 etag 做冲突判定）
///
/// 返回飞书响应壳里的整个 body（`{code,msg,data}` 的 Value，已由实现剥掉 HTTP 层、解读过 code）。
/// 用原生 async fn in trait + 显式 `impl Future + Send`（理由同 [`CalendarApi`]：engine 层 spawn 要 Send）。
pub trait WriteApi {
    /// 新建事件。`body` 是飞书 events 接口要的事件对象 JSON。返回含新建事件（含 event_id / etag）的 body。
    fn create_event(
        &self,
        token: &str,
        calendar_id: &str,
        body: &Value,
    ) -> impl std::future::Future<Output = Result<Value, FeishuError>> + Send;

    /// 更新事件（PATCH 局部更新）。`event_id` 是远端事件 id，`body` 是要改的字段。
    fn patch_event(
        &self,
        token: &str,
        calendar_id: &str,
        event_id: &str,
        body: &Value,
    ) -> impl std::future::Future<Output = Result<Value, FeishuError>> + Send;

    /// 删除事件。
    fn delete_event(
        &self,
        token: &str,
        calendar_id: &str,
        event_id: &str,
    ) -> impl std::future::Future<Output = Result<Value, FeishuError>> + Send;

    /// 读单个事件（取远端当前状态 / etag，做三态冲突判定用）。
    fn get_event(
        &self,
        token: &str,
        calendar_id: &str,
        event_id: &str,
    ) -> impl std::future::Future<Output = Result<Value, FeishuError>> + Send;
}

/// 飞书日历事件接口路径前缀（与 sync.rs 的 CALENDARS_PATH 同源）。
const EVENTS_PATH_PREFIX: &str = "/calendar/v4/calendars";

/// 生产实现：把「哪个 path、哪个动词」的业务语义落在这里，HTTP 细节转调 FeishuClient 的
/// post_json / patch_json / delete / get_json（与 sync.rs 把 CalendarApi 的 path/query 落在 impl 同款）。
impl WriteApi for FeishuClient {
    async fn create_event(
        &self,
        token: &str,
        calendar_id: &str,
        body: &Value,
    ) -> Result<Value, FeishuError> {
        let path = format!("{EVENTS_PATH_PREFIX}/{calendar_id}/events");
        self.post_json(token, &path, body).await
    }

    async fn patch_event(
        &self,
        token: &str,
        calendar_id: &str,
        event_id: &str,
        body: &Value,
    ) -> Result<Value, FeishuError> {
        let path = format!("{EVENTS_PATH_PREFIX}/{calendar_id}/events/{event_id}");
        self.patch_json(token, &path, body).await
    }

    async fn delete_event(
        &self,
        token: &str,
        calendar_id: &str,
        event_id: &str,
    ) -> Result<Value, FeishuError> {
        let path = format!("{EVENTS_PATH_PREFIX}/{calendar_id}/events/{event_id}");
        self.delete(token, &path).await
    }

    async fn get_event(
        &self,
        token: &str,
        calendar_id: &str,
        event_id: &str,
    ) -> Result<Value, FeishuError> {
        let path = format!("{EVENTS_PATH_PREFIX}/{calendar_id}/events/{event_id}");
        self.get_json(token, &path, &[]).await
    }
}

/// 从响应头解析「建议等待秒数」。两个来源，谁先解析成功用谁：
/// 1. `Retry-After`：HTTP 标准头，飞书也会给（值是秒数的整数）。
/// 2. `X-Ogw-Ratelimit-Reset`：飞书网关私有头，限流恢复倒计时（秒）。
///
/// 注：`Retry-After` 标准上也允许 HTTP-date 形式，但飞书用的是秒数整数，这里只解整数；
/// 解不出就当作「没有建议值」返回 None，交给指数退避兜底。
fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    for name in ["retry-after", "x-ogw-ratelimit-reset"] {
        if let Some(v) = headers.get(name) {
            if let Ok(s) = v.to_str() {
                if let Ok(secs) = s.trim().parse::<u64>() {
                    return Some(secs);
                }
            }
        }
    }
    None
}

/// 解读飞书响应壳：`code == 0` 放行返回整个 body；非 0 按 token 失效 / 普通业务错误分流。
///
/// 单独抽出来是为了让「壳解读」这段逻辑可被未来的单测直接喂构造好的 Value 验证（HTTP 部分
/// 不联网测，但这段纯逻辑可测）。
fn interpret_body(body: Value) -> Result<Value, FeishuError> {
    // 缺 code 字段时按成功处理：极少数飞书接口直接返回裸 data；真正的错误一定带 code。
    let code = body.get("code").and_then(Value::as_i64).unwrap_or(0);
    if code == 0 {
        return Ok(body);
    }
    if is_token_expired_code(code) {
        return Err(FeishuError::TokenExpired);
    }
    let msg = body
        .get("msg")
        .and_then(Value::as_str)
        .unwrap_or("未知错误")
        .to_string();
    Err(FeishuError::Api { code, msg })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ===== backoff_delay：纯函数，重点测 =====

    /// 无响应头时，退避随 attempt 单调递增，且任何 attempt 都不超过 cap。
    #[test]
    fn backoff_grows_and_is_capped() {
        // base=1, factor=2 → 1,2,4,8,16（秒）。
        assert_eq!(backoff_delay(0, None), Duration::from_secs(1));
        assert_eq!(backoff_delay(1, None), Duration::from_secs(2));
        assert_eq!(backoff_delay(2, None), Duration::from_secs(4));
        assert_eq!(backoff_delay(3, None), Duration::from_secs(8));
        assert_eq!(backoff_delay(4, None), Duration::from_secs(16));

        // 单调不减。
        let mut prev = Duration::ZERO;
        for attempt in 0..=MAX_RETRIES {
            let d = backoff_delay(attempt, None);
            assert!(d >= prev, "attempt {attempt} 的退避不应小于上一档");
            prev = d;
        }
    }

    /// 大 attempt（指数早已超过 cap）必须被截到 cap，且绝不 panic（溢出防护）。
    #[test]
    fn backoff_caps_at_ceiling_without_overflow() {
        // attempt=6 → 64s 已超 60s cap；更大的 attempt 同样截到 60s。
        assert_eq!(backoff_delay(6, None), Duration::from_secs(BACKOFF_CAP_SECS));
        assert_eq!(backoff_delay(20, None), Duration::from_secs(BACKOFF_CAP_SECS));
        // 极端值不 panic（checked_pow 饱和到 u64::MAX 再被 cap 截下）。
        assert_eq!(
            backoff_delay(u32::MAX, None),
            Duration::from_secs(BACKOFF_CAP_SECS)
        );
    }

    /// 给了响应头建议值时，优先采纳该秒数（仍受 cap 约束）。
    #[test]
    fn backoff_honors_retry_after_header() {
        // 建议 3 秒 → 不管 attempt 是几，都返回约 3 秒。
        assert_eq!(backoff_delay(0, Some(3)), Duration::from_secs(3));
        assert_eq!(backoff_delay(4, Some(3)), Duration::from_secs(3));
        // 建议值超 cap → 截到 cap（防服务端给离谱大值卡死同步）。
        assert_eq!(
            backoff_delay(0, Some(9999)),
            Duration::from_secs(BACKOFF_CAP_SECS)
        );
        // 建议 0 秒 → 不睡。
        assert_eq!(backoff_delay(2, Some(0)), Duration::ZERO);
    }

    // ===== Region host 映射（与上层共享同一处定义，这里复测确认拼 URL 的前提成立）=====

    #[test]
    fn region_host_and_api_base_are_stable() {
        assert_eq!(Region::Feishu.host(), "open.feishu.cn");
        assert_eq!(Region::Lark.host(), "open.larksuite.com");
        assert_eq!(Region::Feishu.api_base(), "https://open.feishu.cn/open-apis");
        assert_eq!(
            Region::Lark.api_base(),
            "https://open.larksuite.com/open-apis"
        );
    }

    // ===== interpret_body：响应壳解读（纯逻辑，可不联网测）=====

    #[test]
    fn body_code_zero_passes_through() {
        let v = serde_json::json!({ "code": 0, "msg": "success", "data": { "items": [] } });
        let out = interpret_body(v.clone()).expect("code 0 应放行");
        assert_eq!(out, v);
    }

    #[test]
    fn body_missing_code_treated_as_success() {
        // 没有 code 字段（极少数裸 data 接口）→ 当成功，原样返回。
        let v = serde_json::json!({ "data": { "x": 1 } });
        assert_eq!(interpret_body(v.clone()).unwrap(), v);
    }

    #[test]
    fn body_nonzero_code_becomes_api_error() {
        let v = serde_json::json!({ "code": 1254005, "msg": "calendar not found" });
        match interpret_body(v).unwrap_err() {
            FeishuError::Api { code, msg } => {
                assert_eq!(code, 1254005);
                assert_eq!(msg, "calendar not found");
            }
            other => panic!("应是 Api 错误，得到 {other:?}"),
        }
    }

    #[test]
    fn body_token_expired_code_becomes_token_expired() {
        for code in [99991663i64, 99991664, 99991668] {
            let v = serde_json::json!({ "code": code, "msg": "invalid access token" });
            assert_eq!(
                interpret_body(v).unwrap_err(),
                FeishuError::TokenExpired,
                "code {code} 应映射为 TokenExpired"
            );
        }
    }

    #[test]
    fn token_expired_classifier_only_matches_known_codes() {
        assert!(is_token_expired_code(99991663));
        assert!(!is_token_expired_code(0));
        assert!(!is_token_expired_code(1254005));
    }

    // ===== parse_retry_after：从响应头取建议秒数 =====

    #[test]
    fn retry_after_header_parsed() {
        use reqwest::header::{HeaderMap, HeaderValue};
        let mut h = HeaderMap::new();
        h.insert("retry-after", HeaderValue::from_static("7"));
        assert_eq!(parse_retry_after(&h), Some(7));
    }

    #[test]
    fn ogw_ratelimit_reset_header_parsed() {
        use reqwest::header::{HeaderMap, HeaderValue};
        let mut h = HeaderMap::new();
        h.insert("x-ogw-ratelimit-reset", HeaderValue::from_static("12"));
        assert_eq!(parse_retry_after(&h), Some(12));
    }

    #[test]
    fn retry_after_takes_priority_over_ogw() {
        use reqwest::header::{HeaderMap, HeaderValue};
        let mut h = HeaderMap::new();
        h.insert("retry-after", HeaderValue::from_static("3"));
        h.insert("x-ogw-ratelimit-reset", HeaderValue::from_static("99"));
        // 列表里 retry-after 在前，先命中。
        assert_eq!(parse_retry_after(&h), Some(3));
    }

    #[test]
    fn no_or_garbage_retry_after_returns_none() {
        use reqwest::header::{HeaderMap, HeaderValue};
        let empty = HeaderMap::new();
        assert_eq!(parse_retry_after(&empty), None);

        let mut h = HeaderMap::new();
        // 非整数（标准允许 HTTP-date，但飞书用秒数；我们解不出就退回指数退避）。
        h.insert("retry-after", HeaderValue::from_static("Wed, 21 Oct 2015 07:28:00 GMT"));
        assert_eq!(parse_retry_after(&h), None);
    }

    // ===== Display / Error =====

    #[test]
    fn errors_display_in_chinese() {
        assert!(FeishuError::TokenExpired.to_string().contains("失效"));
        assert!(FeishuError::RateLimited { retry_after: 5 }
            .to_string()
            .contains("限流"));
        assert!(FeishuError::Api {
            code: 1,
            msg: "boom".into()
        }
        .to_string()
        .contains("boom"));
        assert!(FeishuError::Http("conn reset".into())
            .to_string()
            .contains("conn reset"));
        // 确认实现了 std::error::Error（能当 trait object 用）。
        let _e: &dyn std::error::Error = &FeishuError::TokenExpired;
    }

    // 注（联调验证）：get_json 的 HTTP 链路（拼 URL / 注入 Bearer / 真实 429 重试 / 解 body）
    // 不在单测里联网验证——需要真实 token + 真实接口。验证归 Phase 2 端到端联调：
    // 配好凭证后看 sync 日志确认能拉到数据、限流时能自动退避恢复。
}
