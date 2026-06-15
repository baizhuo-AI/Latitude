# 飞书表格 Connector 实现计划

> **执行颗粒度说明**：本计划按「实施路径级」编写（任务、顺序、依赖、验收、精确接入点），不堆完整函数代码——这是甲方偏好（交付下游工程师/agent 领走，而非手把手 TDD）。关键的接口契约、数据结构形状、文件:行号接入点都给全，下游据此即可落地。需要把某个任务展开成代码级 TDD 子计划时，单独再拆。
>
> 配套设计文档：[2026-06-12-feishu-table-connector-design.md](../specs/2026-06-12-feishu-table-connector-design.md)

**Goal：** 用户贴飞书表格链接 + 开关后，能在对话里让 AI 自动把今日项目进展按 upsert 写入飞书多维表格。

**Architecture：** 薄 connector 框架（首期=代码组织约定，非运行时插件机制）+ 飞书表格 connector。后端复用现有 `FeishuClient`/keychain 直调 Bitable REST；前端新增 1 个配置 Section + 2 个 AI 工具（预览/写入二段式）；项目聚合与 upsert 匹配用代码做（准），进展摘要与缺失发问交 AI（活）。

**Tech Stack：** Rust（Tauri command + reqwest，复用 feishu 模块）、React + TypeScript、Zustand、飞书 Bitable v1 + Wiki v2 REST API。

---

## 落地策略：薄框架怎么落

spec 要求「薄框架」，但首期只有一个 connector，**不建运行时插件系统**（YAGNI）。框架在首期体现为**代码组织约定**：

- 把「链接解析 / 读结构 / 写入」三个公共能力写成**职责清晰、与飞书业务解耦的函数**（放在 `bitable.rs` 内分段，命名上区分「通用解析」与「飞书专有」）。
- 把「拉数据 / 聚合 / 预览 / 确认」的编排放在前端工具层，AI 提示词驱动。
- 将来加第二个 connector 时，再把这些已验证的边界**抽象成 trait/接口**——现在不预先抽象（spec §7 决策：只抽已验证重复的能力）。

判断标准：本计划任何「为了通用性而提前建的抽象层」都应删掉，直到第二个 connector 出现。

---

## 文件结构总览

**新建：**
| 文件 | 职责 |
|------|------|
| `src-tauri/src/feishu/bitable.rs` | Bitable/Wiki REST 调用：解析 wiki→base、读字段、读记录、写记录；3 个 Tauri command |
| `src/lib/feishuBitable.ts` | 前端 invoke 薄封装（仿 `calendarSync.ts`） |
| `src/components/FeishuBitableSection.tsx` | 设置页配置 UI（贴链接 + 开关 + 测试连接），仿 `FeishuConnectSection` |

**修改（精确接入点）：**
| 文件:行 | 改动 |
|---------|------|
| `src-tauri/src/feishu/oauth.rs:33` | `SCOPES` 数组追加 6 个 bitable/wiki scope |
| `src-tauri/src/feishu/mod.rs`（仿 :8-18） | 加 `pub mod bitable;` |
| `src-tauri/src/lib.rs:240-254` | `generate_handler!` 追加 3 个新 command |
| `src/lib/db.ts`（建表段 + `dbListTodos` 附近 :349） | 加 `completed_at` 列 + 迁移 + 查询函数（见 M0） |
| `src/lib/store.ts:36-51` + 状态更新处 | `Todo` 加 `completedAt`；改 done 时写时间戳 |
| `src/lib/chatTools.ts:51`（`CHAT_TOOLS` 数组） | 追加 2 个工具对象 |
| `src/lib/settings.ts:33`（`FeishuPrefs`）+ :87 + :152 + setter | 加 bitable 配置字段（链接/app_token/table_id/启用），4 处同步 |
| `src/pages/SettingsPage.tsx:176` 后 | 挂载 `<FeishuBitableSection />` |

---

## 关键前置决策（请 review 时拍板）

**决策 A — 「今天完成的事项」数据源**：todos 表无 `completed_at` 列（只有 `scheduledDate` 排期日 + `updated_at`）。三选一：
- **A1（推荐）加 `completed_at` 列**：status 变 `done` 时写入当前时间戳。最准，但要一次轻量 DB 迁移 + 改 done 的写入路径。本计划 M0 按此写。
- A2 近似口径：`status==="done" && scheduledDate===今天`。零改动，但「今天完成但排期在别天」「今天完成但没排期」都漏。
- A3 用 `updated_at` 当天 + `status==="done"` 近似：漏掉「今天 done 但之后又被编辑过」的边界。

**决策 B — 重新授权**：加 bitable scope 后，已连飞书日历的用户必须重新走一次 OAuth（且飞书开放平台后台要先勾选这些权限）。计划在 M2 含「引导重新授权」UI 与说明文案。这是体验代价，无法绕过。

**决策 C — MCP 对齐（默认不做）**：`chatTools.ts:8` 注释要求工具集与后端 MCP（`src-tauri/src/mcp/`，供外部 Claude Code 调用）对齐。首期**只做应用内对话**，不同步 MCP 工具。若要外部也能触发，列为后续扩展。

---

## M0：数据基础（前置，约 0.5 天）

> 目标：让「今天完成的事项」可被精确查询。对应决策 A1。

### Task 0.1：todos 表加 `completed_at` 列
- **文件**：`src/lib/db.ts`（建表 DDL 段；前端负责 schema，Rust 不建表）
- **做什么**：建表语句加 `completed_at TEXT`（ISO 字符串，可空）；加幂等迁移（`ALTER TABLE ... ADD COLUMN`，包 try/catch 容忍已存在），跟随项目现有迁移模式。
- **依赖**：无
- **验收**：应用启动无报错；用 SQLite 工具看到新列；老数据该列为 NULL。

### Task 0.2：完成时写入时间戳
- **文件**：`src/lib/store.ts`（`Todo` 类型 :36-51 加 `completedAt?: string`；改 status 的 action）；`db.ts` 写入函数
- **做什么**：status 从非 done 变为 `done` 时写 `completedAt=now`；变回非 done 时清空。`rowToTodo`（db.ts:312）加字段映射。
- **依赖**：0.1
- **验收**：把一个 todo 标完成 → DB `completed_at` 有值；改回 todo → 清空。

### Task 0.3：查询「今天完成」函数
- **文件**：`src/lib/db.ts`（`dbListTodos` :349 附近）
- **做什么**：加 `dbListTodosCompletedOn(dateKey: string): Promise<Todo[]>`，按 `completed_at` 的本地日期前缀过滤 + `status==="done"`。
- **依赖**：0.1
- **验收**：建议加单测（纯查询）：插入跨日完成的数据，断言只返回当日的。

---

## M1：后端 Bitable 写入能力（约 1.5 天）

> 目标：Rust 侧能解析链接、读结构、读写记录，3 个 command 暴露给前端。

### Task 1.1：扩 OAuth scope
- **文件**：`src-tauri/src/feishu/oauth.rs:33`
- **做什么**：`SCOPES` 追加 `"bitable:app"`、`"base:field:read"`、`"base:record:read"`、`"base:record:create"`、`"base:record:update"`、`"wiki:node:retrieve"`。（注：写入是 create/update，非 `write`；本次验证已确认 scope 名合法。）
- **依赖**：无
- **验收**：重新走授权流，授权 URL 含这些 scope；授权成功（前提：飞书后台已勾权限）。

### Task 1.2：新建 bitable.rs — 链接解析（通用能力）
- **文件**：`src-tauri/src/feishu/bitable.rs`（新建）；`mod.rs` 加 `pub mod bitable;`
- **做什么**：实现 `resolve_table_link(api, token, url) -> Result<{app_token, table_id}>`：
  - 按 URL **路径段**分流：`/base/{token}` 直接取 app_token；`/wiki/{node_token}` 走 wiki 解析。**不靠 token 前缀判断**（已验证坑：新版 node_token 不以 `wik` 开头，误判会报 131005）。
  - wiki 解析：`api.get_json(token, "/wiki/v2/spaces/get_node", &[("token", node_token), ("obj_type","wiki")])` → 取 `data.node.obj_token` 作为 app_token。
  - `table_id` 从 URL `table=` query 取。
- **依赖**：1.1
- **验收**：建议单测纯 URL 解析部分（路径分流 + table 参数提取）；集成验证：传测试表 wiki 链接（spec §10）返回 app_token `DuLGbPlJLaQTVps6G5ycLAAqnqh` + table `tblLBu6pqWs9Bf5L`。

### Task 1.3：bitable.rs — 读字段结构
- **文件**：`src-tauri/src/feishu/bitable.rs`
- **做什么**：`list_fields(api, token, app_token, table_id) -> Vec<FieldMeta>`，调 `GET /bitable/v1/apps/{app_token}/tables/{table_id}/fields`。`FieldMeta { field_id, name, type }`（Serialize）。
- **依赖**：1.2
- **验收**：对测试表返回 5 字段（项目/FDE/最近进展/当前状态/更新时间），类型对得上 spec §10。

### Task 1.4：bitable.rs — 读现有记录（upsert 前提）
- **文件**：`src-tauri/src/feishu/bitable.rs`
- **做什么**：`list_records(api, token, app_token, table_id, page_size) -> Vec<RecordRow>`，调 `GET .../records`。`RecordRow { record_id, fields: Value }`。首期读全量（表通常不大），`page_size=500`。
- **依赖**：1.2
- **验收**：能列出测试表现有行（含我们之前写入的那条），返回 record_id + 字段值。

### Task 1.5：bitable.rs — 写记录（create / update）
- **文件**：`src-tauri/src/feishu/bitable.rs`
- **做什么**：
  - `create_records(api, token, app_token, table_id, rows: Vec<Map>) -> Vec<record_id>`：`POST .../records/batch_create`，body `{records:[{fields:{...}}]}`，单批 ≤200。
  - `update_record(api, token, app_token, table_id, record_id, fields: Map)`：`PUT .../records/{record_id}`，body `{fields:{...}}`。
  - CellValue：text 直接字符串；datetime 传毫秒时间戳（注意：批量接口里 datetime 用毫秒数值，非字符串——实现时按字段类型转换）。
- **依赖**：1.3, 1.4
- **验收**：能新建一行、能更新指定 record_id 的一行；飞书表里可见。

### Task 1.6：3 个 Tauri command + 注册
- **文件**：`src-tauri/src/feishu/bitable.rs`（command）；`src-tauri/src/lib.rs:253` 后注册
- **做什么**：仿 `engine.rs:524 feishu_flush_queue` 的骨架（`async fn(app: AppHandle, ...) -> Result<T, String>`，用 `KeychainEnv::new(db_path)` + `env.prepare(region)` 取 `(FeishuClient, token)`）：
  - `feishu_bitable_describe(region, link) -> { app_token, table_id, fields, existing_rows }`：解析+读结构+读现有行，一次返回（前端配置「测试连接」与预览都用）。
  - `feishu_bitable_create(region, app_token, table_id, rows) -> Vec<record_id>`
  - `feishu_bitable_update(region, app_token, table_id, record_id, fields) -> ()`
  - 每个 command 内编排 token 过期重试：命中 `FeishuError::TokenExpired` → `env.refresh_token(region)` + `env.on_refreshed(...)`（engine.rs:431/451 现成）→ 重试一次。
  - 在 `lib.rs` 的 `generate_handler!` 追加三行。
- **依赖**：1.2–1.5
- **验收**：前端 `invoke("feishu_bitable_describe", {region, link})` 能拿到测试表结构 + 现有行；create/update 能改动飞书表。

---

## M2：前端配置 UI + 桥接（约 1 天）

> 目标：设置页能贴链接、测试连接、开关启用；配置持久化。

### Task 2.1：invoke 薄封装
- **文件**：`src/lib/feishuBitable.ts`（新建，仿 `calendarSync.ts:40`）
- **做什么**：导出与 3 个 command 对齐的函数（`describeBitable(region, link)`、`createBitableRecords(...)`、`updateBitableRecord(...)`），类型与 Rust 返回逐字对齐（snake_case）。薄封装不 try/catch，抛给调用方。
- **依赖**：M1
- **验收**：在 devtools 调 `describeBitable` 能拿到结构。

### Task 2.2：配置持久化字段
- **文件**：`src/lib/settings.ts`（`FeishuPrefs` :33、`defaults()` :87、`readStored()` 合并校验 :152、加 setter）
- **做什么**：`FeishuPrefs` 加 `bitableLink?: string`、`bitableAppToken?: string`、`bitableTableId?: string`、`bitableEnabled?: boolean`（均非敏感，可入 localStorage；凭证仍走 keychain）。4 处同步改。
- **依赖**：无
- **验收**：设置值后刷新应用仍在；白名单校验不丢字段。

### Task 2.3：配置 UI 组件
- **文件**：`src/components/FeishuBitableSection.tsx`（新建，抄 `SettingsPage.tsx:505 FeishuConnectSection` 骨架）；挂载 `SettingsPage.tsx:176` 后，套 `<div id="bitable-connector">`
- **做什么**：链接输入框（复用 `feishuInputCls`）+ 启用开关 + 「测试连接 / 读取表结构」按钮 → 调 `describeBitable` → 成功则存 app_token/table_id 并显示「已连接『表名』+ 字段列表」；失败（尤其权限不足）显示「请到飞书设置重新授权」并深链到日历授权 section。复用 `Section`/`Field`/`SegmentControl`。
- **依赖**：2.1, 2.2
- **验收**：贴测试表链接 → 点测试 → 显示 5 个字段；开关可切；权限不足时提示重新授权。

### Task 2.4：引导重新授权（决策 B）
- **文件**：`FeishuBitableSection.tsx` + 复用现有 `FeishuConnectSection` 的授权按钮
- **做什么**：检测到 bitable 调用返回权限错误时，提示文案 + 一键跳到飞书账号 section 触发 `feishu_start_auth`（现有 command）。附飞书后台勾选权限的说明链接/文案。
- **依赖**：2.3
- **验收**：未授权 bitable scope 的账号点测试 → 看到清晰的重新授权引导。

---

## M3：AI 工具 + 对话编排（约 1.5 天，connector 业务大脑）

> 目标：对话里一句话触发，AI 聚合项目、缺失发问、预览、确认、写入。二段式（预览/写入）。

### Task 3.1：项目聚合 + upsert 匹配（纯逻辑，建议单测）
- **文件**：`src/lib/feishuBitable.ts`（或新建 `src/lib/bitableSync.ts`）
- **做什么**：函数 `buildSyncPlan(todayTodos, todayActivities, fieldDefs, existingRows, projectFieldId?)`：
  1. 找「项目」自定义字段：`projectFieldId` 优先；否则在 `fieldDefs`（`dbListFields`）里找 name=「项目」；找不到 → 返回 `{ needProjectField: true }`（AI 据此问用户用哪个字段）。
  2. 按该字段值（optionId→label，join `FieldDefinition.options`）把今天的 todo 归到项目；缺值的进 `unassigned[]`（AI 据此发问）。
  3. 与 `existingRows` 按主字段（「项目」列文本）匹配：命中→`{op:"update", record_id}`，未命中→`{op:"create"}`；标题相近不等→标 `suspectNew:true`（AI 提示「疑似新项目」）。
  4. 返回结构化 plan：每项目 `{ project, op, record_id?, suspectNew?, rawItems:[...] }` + `unassigned` + `needProjectField`。
  - **注意**：此函数只做结构化分组与匹配，**不写「最近进展」摘要文字**（交 AI）。
- **依赖**：M0, M2
- **验收**：单测覆盖——命中更新、未命中新建、缺项目进 unassigned、相近标题 suspectNew、无项目字段 needProjectField。

### Task 3.2：工具一 — 预览（preview，不写）
- **文件**：`src/lib/chatTools.ts`（`CHAT_TOOLS` 数组追加）
- **做什么**：工具 `preview_feishu_table_sync`，无必填参数（可选 `date`、`project_field_id`）。execute：
  1. 读 `dbListTodosCompletedOn(today)` + `dbListActivities({startDate,endDate:today})` + `dbListFields()`。
  2. 调 `describeBitable`(用已存配置) 拿 existing_rows + fields。
  3. 调 `buildSyncPlan(...)` 得结构化 plan。
  4. 返回 `JSON.stringify({ plan, fields, needProjectField, unassigned })`——**给 AI 看**，不写飞书。
- **依赖**：3.1
- **验收**：对话调用后返回结构化计划；缺项目字段/有未归类项时在返回里标出。

### Task 3.3：工具二 — 写入（write，确认后）
- **文件**：`src/lib/chatTools.ts`
- **做什么**：工具 `write_feishu_table_sync`，参数 `rows`（AI 定稿的最终写入计划：每项目含 op/record_id/各字段最终值，含 AI 写好的「最近进展」摘要、默认 FDE=当前用户、更新时间=今天）。execute：遍历 → `op==="create"` 批量 `createBitableRecords`，`op==="update"` 逐条 `updateBitableRecord` → 返回写入结果摘要 JSON。
- **依赖**：3.2, M1
- **验收**：AI 传入计划后，飞书表对应项目被更新/新建；返回成功条数。

### Task 3.4：AI 提示词（编排规则）
- **文件**：`src/lib/llm/index.ts`（`buildChatSystemPrompt` :301 附近，或工具 description 内）
- **做什么**：写明 connector 行为规约：
  - 用户表达同步意图时，**先调 `preview`**，**绝不直接 `write`**。
  - `needProjectField` → 先问用户用哪个自定义字段标项目。
  - `unassigned` 非空 → 列出来问用户归属，等回答。
  - 把每项目的 `rawItems` 整理成**进展摘要**（不是任务清单流水账）。
  - `suspectNew` → 提示「这像是新项目，确认新建？」。
  - 把最终计划渲染成表格预览 → 用户确认（「可以」）→ 才调 `write`。
- **依赖**：3.2, 3.3
- **验收**：见 M4 端到端。

---

## M4：联调与验收（约 0.5 天）

### Task 4.1：端到端走查（对照 spec §11）
- **做什么**：用测试表 + 构造今日数据，完整走一遍对话流程，逐条核对验收标准。
- **依赖**：M0–M3
- **验收清单**：
  1. ☐ 贴链接 + 开关后无需再配置即可用
  2. ☐ 全流程仅一次扫码授权（重新授权后）
  3. ☐ 对话一句话触发总结+写入
  4. ☐ AI 从自定义字段读出项目；读不到时对话发问
  5. ☐ 同一项目重复同步是**更新**而非新增重复行
  6. ☐ 写入前用户能在对话里看到完整预览并可驳回
  7. ☐ 不依赖 lark-cli；不影响现有日历同步

---

## 跨里程碑风险（含缓解任务归属）

| 优先级 | 风险 | 缓解（归属任务） |
|--------|------|------------------|
| 高 | AI 把任务堆成流水账，进展读着像日志 | 提示词约束写摘要（3.4）+ 预览可驳回（3.2/M4） |
| 高 | upsert 标题误判写重复行 | suspectNew 标记 + AI 确认（3.1/3.4） |
| 高 | 用户没重新授权就用，写入失败 | 权限错误兜底引导（2.4）；无 scope 本地标记，靠失败提示（YAGNI） |
| 中 | completed_at 迁移影响现有 todo 写入 | M0 幂等迁移 + 改 done 路径需回归测试现有 todo 流 |
| 中 | 框架抽象过早 | 落地策略：首期不建插件运行时，只做代码组织（本计划已约束） |
| 中 | datetime CellValue 格式（毫秒 vs 字符串）踩坑 | 1.5 按字段类型转换 + 1.5 验收实写验证 |

---

## 工期粗估

M0(0.5) + M1(1.5) + M2(1) + M3(1.5) + M4(0.5) ≈ **5 人日**（不含飞书后台权限审批等待与重新授权沟通）。
