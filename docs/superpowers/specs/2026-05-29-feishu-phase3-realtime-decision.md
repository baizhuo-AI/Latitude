# Phase 3 准实时（飞书/Lark 长连接）可行性与决策

> 调研产出（3 个 agent：长连接协议 + Rust 生态可行性 + 综合决策）。本相位**不写没法端到端验证的代码**，只出可行性结论与集成路径备查。

## 决策（TL;DR）

结论：暂缓。准实时长连接技术可行（社区 SDK open-lark，约 1-2 人天），但对 Daybreak 日历场景边际价值很小——长连接只是把"5min 定时拉"换成"事件触发拉"，真正的增量同步代码 Phase 2 已经写好且必须保留做兜底，秒级实时对"早晨简报/当天规划"非刚需。建议停在 Phase 2 轮询。好消息是现有代码已埋好接入点（SyncHandle::wake()），未来想上时改动极小。

---

## 1. 一句话结论

**暂缓。** 现在不做长连接，停在 Phase 2 的 5min 定时增量轮询；它是完整可用的主同步通道，不是临时凑合。长连接列为 Phase 3 可选增强，等出现明确的"改动要秒级反映"诉求再上——届时改动量很小（详见第 4 节）。

---

## 2. 理由：为什么是暂缓而不是现在做

**技术可行性：可行，但靠单点社区依赖。**
飞书官方没有 Rust 长连接 SDK（只有 Go/Java/Python/Node 四个官方版）。Rust 侧能用的只有一个社区库 open-lark（91 star，实质单人维护），它逆向了飞书未公开的私有 protobuf 帧协议。能接，约 1-2 人天，但飞书一旦改协议，这个库不一定及时跟上，且它的顶层 `open()` 断线后直接退出、不自带重连外循环，需要自己补一层。这是一条"能走但脚下不踏实"的路。

**成本：不止接入那 1-2 人天，是多养一套常驻链路。**
桌面端长连接有生命周期硬伤——App 关闭/睡眠/断网时连接就断，醒来必须重连 + 补拉离线期间的变更。同一应用多端登录时，飞书"集群模式不广播"，一条推送只随机投给其中一个端，其它端收不到。这两点意味着：**即便上了长连接，定时轮询也必须保留做兜底**。所以长连接不是"替换轮询"，是"在轮询之上再加一条需要维护的实时通道"。

**对日历场景的边际价值：很小。这是暂缓的决定性理由。**
关键机制：飞书的"日程变更事件"推送**本身不带变更内容**，它只是一个"这个日历有东西变了"的信号，载荷里只有 user_id_list / calendar_id。要拿到具体改了什么，仍然得回头调"获取日程列表"接口 + sync_token 做增量拉取——**而这套增量拉取逻辑 Phase 2 本来就要写、已经写好了**。

所以长连接换来的实际收益只有两点：
- **延迟**：从"平均 2.5min、最坏 5min"降到"秒级"；
- **省空转**：没变化时不发轮询请求。

而 Daybreak 的定位是个人日历 / 每日简报。用户看的是"今天和未来的安排"，一条日程在 5 分钟内的改动延迟，对"早晨简报、当天规划"这类使用时机几乎无感知。真正在意秒级的是"会议马上要开、临时被改/取消"这种即时提醒——但那本就该走通知，而且飞书自家 App 已经会推。**Daybreak 没必要替飞书做这件它已经做好的事。**

一句话权衡：长连接是"锦上添花的延迟优化 + 省流量"，不是"能力解锁"。当前不值这个维护成本。

---

## 3. 若要做：集成路径与前置依赖（备查，现在不动手）

我核对了现有代码，接入点其实已经埋好，比两份调研假设的还干净。

**现有代码的关键事实（接入会用到的真实函数名）：**
- 增量同步的唯一入口是 `src-tauri/src/feishu/engine.rs:137` 的 `sync_once()`——拉 list + 推进 sync_token + 写库，全在里面，一轮全量/增量同步就这一个函数。
- 后台调度是 `engine.rs:292` 的 `run_scheduler()`，内部一个 `tokio::time::interval`（`SYNC_INTERVAL = 5min`，engine.rs:51）+ 一个 `select!`：要么 5min ticker 到点、要么收到手动唤醒信号，谁先来跑谁。
- **已经有手动唤醒机制**：`engine.rs:339` 的 `SyncHandle` 暴露 `wake()`（engine.rs:358），调一下就让 scheduler"立即插一轮同步"，且和定时触发共用同一把全局串行锁（不会两轮并发刷库）。现在"手动立即同步"按钮 `feishu_sync_now`（engine.rs:464）走的就是这个。

**所以长连接的集成路径极短——它不写任何新的同步逻辑，只是 `wake()` 的第三个调用方：**
1. 加依赖：open-lark 的 `websocket` feature（用 feature 裁剪只开 websocket + auth，关掉它庞大的 platform API crate，控制编译体积/时间）。底层会引入 `tokio-tungstenite` + `prost`，与现有 tokio 栈契合。
2. 新起一个常驻 tokio 任务（跟 `run_scheduler` 并列），用 open-lark 的 `LarkWsClient::open()` 建长连接、收事件。
3. 收到 `calendar.calendar.event.changed_v4` / `calendar.calendar.changed_v4` 事件 → **不解析正文（也没正文）**，直接调现有的 `SyncHandle::wake()`，让 scheduler 插一轮 `sync_once()` 走已有增量逻辑。事件只当触发器。
4. 在外面包一层重连循环 + 退避（open-lark 顶层 `open()` 断线就 return，不自带重连外循环，这是要补的活）。
5. **定时 5min 轮询原样保留**，覆盖 App 离线 / 睡眠期间漏掉的变更，以及"集群只投一个端"导致其它端漏收的情况。长连接和轮询天然共存——现有 `select!` 已经是"两个触发源喂同一个 sync"的结构，加第三个源不改原有逻辑。

**前置依赖（卡在产品/管理侧，不是写代码能解决的）：**
- **平台分叉**：长连接**只有国内飞书（open.feishu.cn）支持**。Lark 国际版开发者后台根本没有"长连接"选项（平台级限制），只能 Webhook + 公网地址。若产品要双平台，Phase 3 长连接只能覆盖飞书侧，Lark 侧维持轮询。
- **应用类型**：必须是"企业自建应用"。应用商店 / ISV 应用用不了长连接。
- **scope 审批**：日历变更订阅需要 `calendar:calendar:readonly`（只读，最小够用、审批阻力小）这类权限，**企业账号下要企业管理员在审核规则里通过**。这是个跑流程的前置，建议要上之前先去申请、别等开发完才发现卡审批。

注：长连接确实免公网回调地址、免 Encrypt Key / Verification Token（这点调研无误，对桌面端是真优势），但上面三个硬约束抵消了相当一部分便利。

---

## 4. 暂缓的底气：停在 Phase 2 轮询为什么是"完整可用"，以及未来最小切入点

**为什么 5min 轮询是完整方案、不是半成品：**
- 它是**主同步通道**，sync_token 增量机制保证不漏变更、不重复拉全量，事务保证"写事件 + 推进游标"原子（中途出错整体回滚）。功能上闭环。
- 它**无论如何都得保留**——就算未来上了长连接，轮询仍是离线期 / 多端漏收的唯一兜底。所以它不是"将来要被替换的临时方案",是长期主力。
- 对 Daybreak 的实际使用场景（简报、当天规划），5min 延迟用户基本无感。体验损失很小且可接受。

**未来想上时的最小切入点（一句话给未来的自己）：**
现有代码已经把"立即同步"的开关（`SyncHandle::wake()`）做好了，长连接要做的全部就是"**收到飞书推送 → 调 wake() → 复用 sync_once()**"，外加一层重连兜底。不需要重写同步、不需要碰拉取逻辑。所以这事可以放心推迟——它不会因为现在不做而欠下技术债，反而是等真有秒级诉求时再花 1-2 人天接上即可，且接入面非常窄。

**触发重新评估的信号**（出现任一再考虑启动 Phase 3）：用户明确抱怨"在飞书改了日程，Daybreak 这边半天不更新"；或产品要做"会议临开提醒"这类强实时功能（但那更该走通知体系，不一定靠日历同步）。在这些信号出现前，长连接不进开发排期。

---

## 附:协议调研要点

飞书长连接(WebSocket)事件订阅可用于桌面应用准实时收日历变更,且确实免公网回调地址、免 Encrypt Key,但有三个硬约束必须在方案里前置:(1)仅 open.feishu.cn(国内飞书)支持,Lark 国际版(open.larksuite.com)开发者后台不提供长连接,只能 Webhook+公网地址;(2)仅"企业自建应用"可用,应用商店/ISV 应用不支持;(3)日历推送只是"变更通知"(只给 user_id_list / calendar_id),不含日程正文,必须回查 list+sync_token。协议走 wss 全双工,握手/鉴权/心跳/重连全部封装在官方 SDK 里、协议不公开,无法自行实现裸 WebSocket;官方提供 Go/Python/Java/Node.js 四个 SDK。日历订阅需 calendar:calendar / calendar:calendar:read / calendar:calendar:readonly 任一权限,企业账号下需管理员审批开通。

## 附:Rust 可行性要点

结论：在 Tauri 进程内用 Rust 接飞书/Lark 长连接事件订阅【可行（推荐勉强偏可行）】。存在一个活跃维护、已封装好飞书私有长连接协议(含 protobuf 帧 + 心跳 + 端点申请 + 分包重组)的第三方 SDK open-lark（v0.16.1，2026-05 更新），其 websocket 能力直接复用项目已有的 tokio/reqwest/rustls 技术栈，接入成本约 1-2 人天。但有两个关键约束压低评级：(1)飞书官方不提供 Rust 长连接 SDK，只有 Go/Java/Python/Node 官方版，Rust 侧全靠社区 open-lark 这一个单点依赖(91 star，bus factor=1)；(2)长连接对日历场景的实时性收益被「日程变更事件本身只是无 payload 的信号、仍要回头调 list+sync_token 增量拉」这一机制大幅稀释——它把「5min 轮询」变成「事件触发的增量拉」，省的是轮询空转和把延迟从平均 2.5min 降到秒级，但拉取逻辑你 Phase 2 已经要写，长连接只是换了触发器。建议：日历场景维持 Phase 2 定时增量轮询(5min)即可满足真实需求；长连接列为 Phase 3 可选增强，且优先评估「混合方案」（长连接只当 webhook 的免公网替代品来触发增量拉，而非自己从零实现协议）。若要做，直接用 open-lark 的 websocket feature，不要自己用 tokio-tungstenite 从零撸协议（私有 protobuf 帧无官方文档，纯逆向，踩坑成本高）。

## 官方文档引用

- https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode
- https://feishu.apifox.cn/doc-7518429
- https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
- https://open.feishu.cn/document/server-docs/calendar-v4/calendar/subscription
- https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/calendar-v4/calendar/events/changed
- https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/calendar-v4/calendar-event/events/changed
- https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/list
- https://open.feishu.cn/document/server-docs/application-scope/scope-list
- https://github.com/openclaw/openclaw/issues/51663
- https://github.com/larksuite/node-sdk/blob/main/README.zh.md
