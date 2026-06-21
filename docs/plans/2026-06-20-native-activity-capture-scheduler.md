# 活动记录原生调度器(Native Activity-Capture Scheduler)实施方案

> **给下游执行的技术方案。** 任务用 `- [ ]` 跟踪。颗粒到"做哪几件事 / 顺序 / 依赖 / 验收",不逐行写代码——下游照仓库现有范式实现。
>
> **背景:** 活动记录("这阵在忙啥")的心跳目前是主工作台窗口渲染进程里的 `setInterval`(`src/lib/secretary/scheduler.ts` + `wiring.ts startSecretaryScheduler`,挂在 `App.tsx` MainWindow)。macOS 会冻结隐藏/最小化窗口里的 JS 定时器,而本 app 常态就是藏主窗只露悬浮条 → **藏窗即停**,主动提醒形同虚设。

**目标:** 即使所有窗口隐藏/最小化,活动记录也能按 `intervalMin` 准时触发(创建可回复对话 + 发系统通知)。

**架构:** 新建一个 Rust 后台引擎,**照搬 `src-tauri/src/feishu/engine.rs` 的 `tokio::time::interval` 范式**——在 Tauri 进程里常驻 tick,不受任何窗口可见性影响。到点时直接用 `sqlx` 写库(对话+消息+proactive_log)、用 `tauri-plugin-notification` 发横幅、用 lib.rs 现成的 `notify` 回调(emit `daybreak://data-changed`)让活跃窗口刷新。前端把"主动配置"通过一个 tauri command 推给 Rust(设置在 localStorage,Rust 读不到)。同时从前端 TS 调度器摘掉 activity_capture,避免双触发。

**技术栈:** Rust / tokio / sqlx(`SqlitePool`,仓库已用)/ tauri-plugin-notification(已装并注册)/ tauri command + `app.manage` 状态(已有范式)。

## 全局约束
- **只动 activity_capture 这一档**;晨报 / 会议将至 / ddl / 任务搁置 / 刚完成仍留在前端 TS 调度器,不在本次范围。
- **文案降级:后台触发用固定模板**(与现有 `ACTIVITY_CAPTURE_PROMPT` 一致:zh `最近在忙啥?一句话记一下就好 🗒️`),**不在后台调 LLM**(窗口可能已睡)。"窗口活着时用大脑富文案"是后续增强,本次不做。
- **对话 id 必须沿用 `ac` 前缀**——`chatStore` 的回复 writeback 靠此前缀把用户回答写回 `activity_log`(见 `deliverProactive.ts isActivityCaptureConvId`)。
- **工作时段判断用本地时区小时**(对齐前端 `new Date().getHours()`),Rust 用 `chrono` Local。
- **跨重启的"上次触发"以 DB `proactive_log` 为真相源**(不另存内存计数)。
- 字段口径一律对齐 `src/lib/db.ts` 里 `dbInsertConversation` / `dbInsertMessage` / `dbLogProactiveSent` 写的列(下游照该 schema 写,勿臆造列名)。

---

### 任务 1:设置桥(前端 → Rust)
让 Rust 拿得到主动配置(设置只在前端 localStorage)。

- [ ] Rust 定义 `ProactiveRuntimeConfig`:`enabled`(= proactive.activityCapture.enabled)、`master_on`(= proactive.mode != "off")、`interval_min`、`work_start`、`work_end`、`paused_until: Option<i64>`(= reminder.pausedUntil ms)、`channel: String`(chat/notification/float/all)、`lang`。
- [ ] `app.manage(Mutex<Option<ProactiveRuntimeConfig>>)`(范式同 lib.rs 现有的 `ShortcutActions` / `SyncHandle`)。
- [ ] tauri command `set_proactive_config(state, config)` 写入该 state;注册进 `tauri::generate_handler![...]`。
- [ ] 前端:`src/lib/settings.ts` 的 `persist`(或 `setProactive`/`setReminder`)之后 `invoke("set_proactive_config", {...})`;`App.tsx` 主窗启动 `useEffect` 推一次初始值。

**文件:** 新建 `src-tauri/src/secretary/mod.rs`、`src-tauri/src/secretary/config.rs`;改 `src-tauri/src/lib.rs`(mod 声明 + manage + handler);改 `src/lib/settings.ts`、`src/App.tsx`。
**依赖:** 无。
**验收:** UI 改"记录间隔 / 工作时段 / 主动姿态 / 提醒方式"后,Rust state 同步更新(临时加 log 或 set 后回读验证)。

### 任务 2:原生秘书引擎骨架(照搬 feishu/engine.rs)
常驻 tokio 任务,周期 tick,判定"此刻该不该触发活动记录"(先只判定、只 log)。

- [ ] 新建 `src-tauri/src/secretary/engine.rs`,导出 `run_scheduler(app, pool, config_state, notify)`;内部 `tokio::time::interval`(tick 30–60s;真正节奏由 interval_min 把关)。
- [ ] 每 tick:读 config_state;缺失 / `!master_on` / `!enabled` → skip。
- [ ] 读 DB:`SELECT MAX(sent_at) FROM proactive_log WHERE type='activity_capture'`(sqlx)→ `last_fired`。
- [ ] 闸条件(镜像 `triggers.ts shouldRunActivityCapture`):`enabled && 本地小时 ∈ [work_start, work_end) && (now - last_fired) >= interval_min*60_000 && !(paused_until.is_some() && now <= paused_until)`。
- [ ] `lib.rs setup()` 里 `tauri::async_runtime::spawn(secretary::engine::run_scheduler(...))`(紧挨现有 `feishu::engine::run_scheduler` 那行)。本任务只在"该触发"时 `log "would fire activity_capture"`,不落库不通知。

**文件:** 新建 `src-tauri/src/secretary/engine.rs`;改 `lib.rs`。
**依赖:** 任务 1。
**验收:** 配置齐 + 到点 + 工作时段内 → tick 打 "would fire";改非工作时段 / 未到间隔 / 别烦我中 → 不打。

### 任务 3:Rust 侧投递(写库 + 通知 + 刷新)
"该触发"时,产生与前端 `deliverProactive` 等价的副作用。

- [ ] 写库(sqlx,列口径照 `db.ts`):
  - `conversations`:`id = "ac{ts}_{rand}"`、`title = "活动记录 · 过去这段时间"`、created/updated = now ISO。
  - `messages`:`role = "assistant"`、`content = 模板文案`、conv_id = 上面的 id。
  - `proactive_log`:`type = "activity_capture"`、conv_id、`sent_at = now ISO`、content_preview、`ref_id = "activity_capture"`。
- [ ] 通知:仅当 `channel ∈ {notification, all}`,用 tauri-plugin-notification Rust API 发(title `Daybreak 活动记录`、body = 模板)。
- [ ] 刷新:调 `notify("conversations")`(复用 lib.rs 现成的 `daybreak://data-changed` 回调;前端 `App.tsx useDataSync` 已监听)。

**文件:** `secretary/engine.rs`(+ 可选 `secretary/db.rs` 放 sqlx 语句)。
**依赖:** 任务 2。
**验收:** 所有窗口隐藏时到点后:① 横幅弹出;② 开 app 能在"对话"看到新"活动记录 · 过去这段时间";③ `proactive_log` 多一条。

### 任务 4:摘掉前端 TS 的 activity_capture(去重)
防前端 + Rust 双触发。

- [ ] `wiring.ts registerSecretaryJobs` **移除** `createProactiveActivityCaptureJob()` 的注册(其余 job 不动)。
- [ ] `runProactiveActivityCapture` / `createProactiveActivityCaptureJob` 函数可保留(便于回滚),加注释"已由 Rust 引擎接管,勿重新注册"。

**文件:** 改 `src/lib/secretary/wiring.ts`。
**依赖:** 任务 3(确认 Rust 路径可用后再摘,避免空窗期)。
**验收:** 一个间隔内只出现一条 activity_capture;前端不再产生该类对话。

### 任务 5:端到端验收 + 回归
- [ ] 真机:`npx tauri build --bundles app` → 装 /Applications → **全部窗口隐藏** → 等一个(临时调短的)间隔 → 横幅 + 对话都出现。
- [ ] **回复闭环(关键集成点)**:打开那条 `ac` 对话回一句 → 确认仍写回"记录"(`activity_log`)——验证 Rust 建的对话与现有 `chatStore` writeback 兼容。
- [ ] 回归:晨报 / 会议 / ddl 等其余主动消息仍照常(它们还在 TS)。
- [ ] 跑 `src/lib/secretary/*.test.ts`(摘 job 不应致红)+ Rust 侧若加测则 `cargo test`。

## 风险点

1. **实现 — 回复 writeback 兼容**:Rust 建的 `ac` 对话,用户回复后能否被现有 `chatStore` writeback 正确写回 `activity_log`?这是最大集成不确定点。任务 5 必须验;不兼容就要补 writeback 对"Rust 建对话"的识别。
2. **实现 — 时区**:Rust 工作时段小时必须用本地时区(`chrono` Local),否则跟前端 `getHours` 对不上,会在错误时段触发或静默。
3. **实现 — 双触发竞态**:任务 4 摘 TS job 要在 Rust 路径验证 OK 后做;两边并存期间靠 `proactive_log` 的同 type 冷却大致兜底,但别长期并存。
4. **体验 — 文案降级**:后台永远模板;想要"窗口活着时用大脑富文案",需引擎加"有活跃窗口就 emit 事件让前端合成"的分支——本次不做,记着。
5. **项目 — 设置桥时序**:前端必须在启动 + 每次改设置时都推给 Rust;漏推会让 Rust 用旧配置。收口在 `settings.ts persist` 处推,降低遗漏。

## 方法(实施顺序)
任务 1 → 任务 2(只 log)→ 任务 3(投递)→ 先验任务 5 的"端到端 + 回复 writeback" → 确认 OK 再做任务 4(摘 TS job)→ 任务 5 全量回归。每任务一个独立验收点,各自一次 commit。

## 不做(本次明确排除)
- 其余主动消息类型下沉 Rust(晨报/会议/ddl/任务搁置/刚完成)——留 TS。
- 后台富文案(LLM 合成)——后台一律模板。
- 全量 `gateProactive`(优先级/预算/去重/多类型)端口——只做 activity_capture 那一小片闸。
