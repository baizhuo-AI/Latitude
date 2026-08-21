# 飞书对话入口 — 本地并存方案

> ⚠️ **文档状态：historical（已实现，口径可能过期）**
> 本文描述的是 Latitude 早期（Daybreak 时期）的设计与实现，**不是当前产品规范**。
> 当前权威：[产品总纲](../specs/2026-08-20-dimension-master-prd.md) · [工程实施计划](../plans/2026-08-20-dimension-implementation-plan.md)。
> 保留原因：其中的实现细节与踩坑记录仍对工程有效。

> 状态:第 1-6 步代码全部完成，`cargo check` / `tsc --noEmit` / `npm test` 均 0 报错·无回归；
> 待 app 实跑端到端验收。第 2 步链路已实跑通过（websocket connected）。
> 日期:2026-06-19 ｜ 分支:`feature/ai-secretary`

## 1. 目标

让 Daybreak 秘书除了「对话悬浮条」之外，再多一个**飞书入口**：用户在飞书里私聊 bot
（如「今天有啥」「帮我加个待办」），bot 走 **同一个 Daybreak 秘书核心**回复——同一份数据、
同一套人设、同一批工具、同一条对话记忆。两个入口**并存**，不是二选一。

**明确的边界(第一版认下的取舍):**
- 秘书核心和数据**留在本地 Mac**，不上云。
- 飞书入口**只在 Daybreak App 开着时活**（长连接要 App 进程维持）。App 关 → 飞书侧静默
  （连「离线提示」都发不出，因为发提示的进程就是 App 本身）。这是已知限制，第一版接受。

## 2. 现状(摸过真实代码后的关键事实)

| 维度 | 事实 | 出处 |
|---|---|---|
| 秘书大脑在哪 | **前端 React**（不是 Rust）。对话主循环是 `chatStore.sendMessage` | `src/lib/chatStore.ts` |
| 系统提示词 | 单一收口 `buildAgentSystemPrompt()`，两条大脑共用，注入人设/待办/Telos/记忆 | `src/lib/llm/index.ts` |
| 两条大脑 | API 直连（deepseek-api，前端执行工具）/ 本地 CLI（claude/codex/kiro，连本机 MCP:42800） | `chatStore.ts` / `src-tauri/src/cli_agent/` |
| 会话存储 | SQLite（`conversations` / `messages` 两表），前端直接走 plugin-sql 读写，**无来源渠道字段** | `src/lib/db.ts` |
| 飞书已有能力 | **只有日历同步（读写）+ 多维表格**。后台引擎每 5 分钟拉日历进本地库。**无邮件、无 IM 消息** | `src-tauri/src/feishu/` |
| 飞书入站能力 | **完全没有**。无事件订阅消费、无长连接客户端、收不到任何飞书消息 | 同上 |
| 飞书发消息 | **没有**。现有「发」只到日历事件 CRUD，无 `/im/v1/messages` | `src-tauri/src/feishu/client.rs` |
| MCP server | 暴露 22 个原子数据工具（待办/目标/活动/记忆/字段），HTTP 127.0.0.1:42800，随 app 常驻；**无「跑一轮对话」入口** | `src-tauri/src/mcp/server.rs` |

**飞书后台配置（开发者后台，已就绪）:** 同一个自建应用 `cli_a97ac2d349fa9cc5` 已开机器人能力、
已订阅 `im.message.receive_v1`（接收消息）、收发消息权限均已开通、订阅方式为**长连接**。
Daybreak 的飞书日历配置（`~/Library/Application Support/com.apple.todo-floating-panel/feishu_config.json`）
里 `app_id` 与之**完全一致**——一个应用同时干「日历同步（用户身份 token）」和「bot 收发（应用身份 token）」。

**旧 bot:** 曾用同一应用做过一个 Bash + lark-cli 的 bridge（claude-bridge），已停并禁用自启
（launchd KeepAlive bootout + RunAtLoad disable），plist 保留可回滚。它证明了 lark-cli 这条收发链路可用：
- 收消息:`lark-cli event consume im.message.receive_v1 --as bot`（NDJSON 流）
- 发消息:`lark-cli api POST /im/v1/messages --as bot`

## 3. 最终架构

**一个核心（前端，复用）+ 飞书适配器（Rust，监督 lark-cli）+ 一个常驻 webview 当执行器。**

```
飞书私聊消息
  → lark-cli event consume（Daybreak Rust 监督的常驻子进程，NDJSON 流）
  → Rust 解析（谁发的 / 发了啥 / chat_id）
  → emit Tauri 事件给「常驻 webview 执行器」
  → 执行器调 submitAgentRound(convId, text)   ← 复用前端核心，人设/工具/记忆/历史全一致
  → 秘书回复 → 交回 Rust
  → lark-cli api POST /im/v1/messages → 发回该 chat_id
```

### 关键决策与取舍

1. **复用前端核心，绝不在 Rust 另写一套大脑。**
   理由:系统提示词、工具、记忆都收口在前端；Rust 重写 = 两套大脑要对齐人设/工具，正是历史上
   「两条大脑能力不对齐、CLI 靠 MCP 静默退化」那个坑的放大版。代价是需要一个前端 webview 活着跑核心，
   但这被「App 开着才活」的边界完全覆盖，零额外代价。

2. **飞书收发复用 lark-cli（照搬旧 bridge），不写原生 Rust 长连接。**
   理由:长连接协议、bot 身份认证 lark-cli 全包；Daybreak 的 `cli_agent` 本来就在 spawn 外部 CLI
   （claude/codex/kiro），监督 lark-cli 子进程是轻车熟路。这一并消掉了「写原生长连接」「自己管 tenant_access_token」两块工作。

3. **先本地，不上云。** 上云要把数据搬离 Mac + 养一个线上服务（数据隐私 + 运维质变），
   当前阶段过早。若日后高频在外用、Mac 常关机，再单独评估上云（见 `2026-06-19-feishu-calendar-sync` 同类讨论）。

### 已知取舍 / 限制

- **lark-cli 运行时依赖:** Daybreak 从此依赖本机装了 lark-cli 且 auth 过 bot 身份。自用 OK（已就绪）。
  **若日后要把飞书入口分发给其他用户，这个依赖要重新考虑**（打包 lark-cli，或换原生实现）。
- **App 关 = 飞书静默:** 见 §1 边界。

## 4. 第一版范围

私聊 1 对 1、秘书用**本地数据**回答 + 管**本地待办/目标**、**不碰飞书写操作**
（反向操作飞书 = 「C 形态」，缓做）。群聊、@机器人、reaction 等后续再说。

## 5. 实施路径(分步 + 验收)

| 步 | 做什么 | 验收 | 状态 |
|---|---|---|---|
| 0 | 飞书后台:机器人能力 + 事件订阅 + 收发消息权限（长连接） | 后台已配齐 | ✅ 已就绪 |
| 1 | 前端把 `sendMessage` 抽成入口无关的 `submitAgentRound(convId, text, opts)`，对话窗改为调它 | 悬浮条行为与重构前一致（tsc 0 报错、测试无新增失败） | ✅ 已完成 |
| 2 | Rust 监督 `lark-cli event consume` 常驻子进程收 IM 事件，解析 NDJSON | 后台日志能打印收到的飞书消息 | ✅ 实跑通过（websocket 连上、收到消息）|
| 3 | Rust 用 `lark-cli im +messages-send` 发消息（出站） | 飞书里看到 bot 回话 | ✅ 实测通过（echo 已被第 4 步替换为核心）|
| 4 | 接通 Rust ↔ 主窗前端:消息→`feishu://incoming`→`submitAgentRound`→`feishu_send_reply` 发回 | **手机飞书私聊「今天有啥」拿到与对话窗一致的回复** | ✅ 代码完成，待实跑 |
| 5 | conversations 加 `channel`+`external_id`；飞书每个 chat_id 映射一条 conversation | 飞书对话与窗口对话不串；记忆/人设共享 | ✅ 代码完成 |
| 6 | 离线静默兜底 + 文档写明限制 | App 关时飞书无响应（已知，不算 bug） | ✅ 由设计保证（stdin-close 优雅停 + daemon 自退）|

### 第 1 步落地说明（已完成）

`submitAgentRound` 现位于 `src/lib/chatStore.ts`，是从 `sendMessage` 抽出的「大脑编排」：
落库用户消息 → 主动消息首回写回 → assistant 占位 → **从 DB 组装历史（真相源）** → 路由大脑 → 回复落库。
全程不碰 Zustand / 窗口状态；UI 表现通过可选 `hooks` 回调投影。`sendMessage` 现在只解析会话、
把每一步投影到 store。飞书执行器（第 4 步）只需 `submitAgentRound(convId, text)`、不传 hooks、取返回值即可。

> 非主窗（飞书执行 webview）调用时注意:`backend` 默认读 settings store 内存态，而非主窗的 settings
> 可能不是真相源，应通过 `opts.backend` 显式传入从真相源读到的值（见 `AgentRoundOptions` 注释）。

### 第 2 步落地说明（代码完成，待实跑验证）

新增 `src-tauri/src/feishu/inbound.rs`:随 app 启动的常驻任务 `run_inbound()`，监督
`lark-cli event consume im.message.receive_v1 --as bot`（命令形状已对 lark-cli 1.0.48 核实），
逐行读 NDJSON、目前打到日志（`[feishu-inbound] 收到消息 …`）。两个 spawn 坑已落实:stdin 持有写端
防 EOF、复用 `cli_agent::{resolve_cli_bin, enhanced_path}` 处理 GUI PATH。进程掉线指数退避自动重连；
lark-cli 没装则只记日志退出、不影响主应用。已在 `lib.rs` setup 挂上。`cargo check` 0 报错。

**实跑结论（2026-06-19）:** `npm run tauri:dev` 起 app，日志依次出现 `consuming as cli_a97ac2d349fa9cc5`
→ `online_instance_cnt=0`（无其它实例抢连接，旧 bot 已干净停）→ `feishu-websocket: connected`，链路打通。

**入站事件结构（lark-cli 已扁平化处理，第 4/5 步直接用）:** 顶层字段
`chat_id`(oc_前缀) / `chat_type`(p2p|group) / `sender_id`(ou_前缀 open_id) / `message_id`(om_前缀) /
`message_type` / `content` / `event_id`(可去重) / `create_time` / `timestamp`。
**`content` 对 text/post/image 等已渲染成人类可读文本**，可直接喂核心；只有 interactive(卡片)是原始 JSON 串。

**lark-cli 的 event-bus 守护进程（关于第 6 步）:** `event consume` 底层连一个 lark-cli 自启的
event-bus daemon，长连接由它持有。实跑日志显示 **该 daemon「最后一个消费者断开 30s 后自动退出」**
（`auto-exits 30s after last consumer`）——所以「App 关 = 飞书静默」基本自洽:app 退出 → 我们的 consume
子进程死 → 30s 后 daemon 自杀。第 6 步只需保证**优雅停**:`event consume` 的停止方式是**关 stdin 或 SIGTERM，
绝不能 kill -9**（会泄漏服务端订阅）。我们持有 stdin、进程随 app 退出而 drop，天然走优雅停。

**一个待定项（非阻塞）:** 日志有 `proxy detected: HTTPS_PROXY=… credentials will transit through this proxy`
警告（用户本机有代理）。连接照常成功；如不希望 bot 凭证经本地代理，可给 spawn 注入 `LARK_CLI_NO_PROXY=1`，
但需确认禁代理后仍能连上（飞书国内域名通常不需代理）。当前保持现状未动。

### 第 3 步落地说明（代码完成，待实测）

新增 `src-tauri/src/feishu/outbound.rs`:`send_text(chat_id, text, idempotency_key)`，用
`lark-cli im +messages-send --as bot --chat-id <oc_> --text <…>`（高层命令，自动构造 body，比 raw
`api POST` 少手搓 content JSON 的出错面），带可选幂等键防重发。inbound 的消费循环里临时挂了 **echo**:
收到 `message_type==text` 的消息就回 `（echo…）你说的是:<原文>`，用入站 `event_id` 当幂等键。`cargo check` 0 报错。

> **echo 是临时验证段，第 4 步删除:** 第 4 步把 echo 换成「emit 给常驻 webview → `submitAgentRound` → 回复」，
> 让飞书走真正的秘书核心。`send_text` 本身是正式出站能力，保留。

> **实测（你来）:** app 重编后从飞书私聊 bot 发「你好」，应在飞书里收到
> `（echo · 第 3 步验证）你说的是:你好`，终端打印 `[feishu-inbound] 已回复 chat=…`。
>
> （echo 已实测通过，并在第 4 步被秘书核心替换。）

### 第 4-6 步落地说明（代码完成，待端到端实跑）

**第 4 步（接通核心）:** inbound 的 echo 已删，改为 `app.emit("feishu://incoming", payload)` 把文本消息发给前端；
新增 `src/lib/feishuChat.ts` 的 `setupFeishuChatBridge()`（在 `App.tsx` 的 MainWindow 挂一份）监听该事件 →
映射会话 → `submitAgentRound` 跑秘书核心 → `invoke("feishu_send_reply")` → Rust 命令 `outbound::send_text` 发回飞书。
**只在主窗执行**（主窗「关闭=隐藏」始终存活、settings 在此为真相源）。飞书消息**串行处理**（v1 不并发，避免同会话历史交错）。

**第 5 步（会话映射）:** `conversations` 表加 `channel`（默认 'local'）+ `external_id` 两列 + 索引
`idx_conversations_external`（db.ts 迁移 V13）。飞书用 `dbFindConversationByExternal('feishu', chat_id)`
复用同一条会话（找不到则建，标 `channel='feishu'`、`external_id=chat_id`、标题「飞书 · oc_…」）。本地对话不受影响。

**第 6 步（优雅离线）:** 由设计保证——app 退出 → consume 子进程 stdin 关闭 → lark-cli 优雅停（非 kill -9，
不泄漏服务端订阅）→ event-bus daemon 在最后一个消费者断开 30s 后自动退出。App 关 = 飞书静默（已知限制）。

**验证:** `cargo check` 0 报错、`tsc --noEmit` 0 报错、`npm test` 736 过（仅 2 个既有失败 ChatBar/tokens，与本次无关）。

> **端到端实跑（你来，明早验收）:** app 重编后，从飞书私聊 bot 发「今天有啥」/「帮我加个待办:买菜」，
> 应在飞书收到**秘书的真实回复**（不再是 echo），终端打印 `[feishu-inbound] 收到消息…`。工作台对话列表里
> 应出现一条「飞书 · oc_…」会话，点开即这轮对话；若让它建待办，本地待办里应能看到。
> 顺带确认对话悬浮条本身仍正常（第 1 步无退化）。

> **已知限制 / 待办:** ① lark-cli 运行时依赖（分发给他人需重评）；② 早于主窗 JS 挂载到达的消息会丢
> （app 刚启动的极短窗口）；③ CLI 后端下若同时在悬浮条和飞书各跑一轮，`cli-agent-event` 是全局事件会串流
> （API 后端无此问题，且为默认 deepseek-api）；④ 只处理 p2p 文本，群消息/@、图片/卡片未接。

### 追加:选项 A —— 秘书主动消息也推到飞书（已实现）

用户选 A（电脑开着时，主动消息多一个飞书落点；区别于 B「人不在也能找你」= 上云）。实现:
- 新增轻模块 `src/lib/feishuPush.ts` 的 `pushProactiveToFeishu(text)`:取最近飞书会话 chat_id
  （`dbGetLatestFeishuChatId`，你 DM 过 bot 才有，否则静默跳过）→ `invoke("feishu_send_reply")` 发到飞书。
  fire-and-forget，失败只记日志，不影响 app 内投递。**复用已有 Rust 命令，Rust 侧无改动。**
- 挂在两条主动线的投递点（都在 `emitSync("conversations")` 之后）:`deliverProactive`（活动记录 +
  meeting/deadline/stuck/completed 提醒）、`composeMorningBriefing`（晨间简报）。
- 单独成轻模块（只依赖 db + invoke，**不 import chatStore**），避免把对话核心拖进 secretary 测试图。
- 验证:`tsc` 0、`npm test` 736 过（无新增失败）。

> **已知边界:** ① 只在**电脑开着**时推（要「人不在也能收」得走 B=上云）；② 推送目标=最近的飞书会话
> （正常即你和 bot 的单聊；若 bot 在群且群是最近会话，可能推到群，自用单聊为主先不处理）；
> ③ **没 DM 过 bot 之前不推**（不知发哪）——先跟 bot 说句话即可；④ 在飞书**回复**主动消息走入站普通流程，
> **不**回链 activity_capture 的「首次回复」写回（要写回活动记录目前仍需在 app 内回）；
> ⑤ 现有「别烦我/忙时/静默档」节流在 app 内已生效，飞书只把**已放行**的那条同发一份，不会轰炸。

> **实测（你来）:** ① 先从飞书 DM bot 一句（让它拿到你的 chat_id）；② 等一条主动消息触发（或到点的
> 活动记录），应在飞书也收到同一条。

## 6. 风险点(排序)

1. **(实现)跨进程编排 + lark-cli 子进程管理** — 现在的主要剩余工作。有旧 bridge 当模板。
2. **(实现)双大脑分裂诱惑** — 别复用旧 bridge「消息→Claude」那条流，只借**收发管道**，大脑必须走 Daybreak 核心。
3. **(项目)lark-cli 运行时依赖** — 见 §3 限制。
4. **(体验)会话映射 / 串扰** — 飞书 chat_id ↔ conversation 映射要稳，加 channel 字段隔离来源。
5. **(体验)App 关 = 静默** — 已知限制。

### spawn lark-cli 的两个血泪坑（旧 bot 验证过，务必带走）

1. **`event consume` 的 stdin 必须保持打开** — 它把 stdin EOF 当退出信号。GUI 启动的 app spawn
   子进程时 stdin 默认是 /dev/null（秒 EOF），要用 FIFO 或 `tail -f /dev/null` 撑住，否则进程刚起就退。
2. **GUI 环境不继承 PATH/HOME/代理** — spawn lark-cli 要显式注入环境。
   **Daybreak 的 `cli_agent` 为 spawn claude CLI 已解决过这个，有现成代码可抄。**

## 7. 后续可选(非第一版)

- 给 `submitAgentRound` 补一个直接单测（当前无任何用例直接覆盖 `sendMessage`/`submitAgentRound`，
  行为等价靠人工对照保证）。
- 跨窗口「当前活跃对话」同步（现各窗口 `currentId` 独立）。
- 反向操作飞书（C 形态:把待办同步到飞书日历、提醒他人等）。
