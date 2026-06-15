# 飞书表格 Connector 设计文档

- 日期：2026-06-12
- 状态：设计已确认，待写实现计划
- 范围：Daybreak connector（连接器）框架 + 第一个 connector「飞书表格写入」

---

## 1. 概述

### 1.1 背景

Daybreak 是个人任务/活动管理桌面应用（Tauri + React + Rust）。用户希望打通「把今日完成事项/项目进展，由 AI 梳理后写入飞书多维表格」的能力。

经评估，用户要的不是一个单点功能，而是一个 **connector 插件框架**：飞书表格写入只是框架上的第一个 connector，将来可能接入更多外部系统。因此本设计分两层——薄框架 + 飞书表格 connector。

### 1.2 目标

终极用户体验（验收标准）：

> 用户只需 ①粘贴飞书表格链接 ②打开插件开关，之后就能在对话里让 AI 自动总结项目完成情况并写入飞书表格。

拆成设计约束：

- **配置极简**：用户只做「贴链接 + 开关」，不手动配字段映射、不配规则。
- **映射全自动**：AI 读取目标表结构后自适应填写，用户不建映射模板。
- **对话即触发**：用户用自然语言触发，AI 拉数据、聚合、组织、写入。
- **写前轻确认**：写入飞书前，AI 在对话里列出"将写入什么"，用户一句话确认才落库（不弹窗、不打断）。

### 1.3 非目标（首期明确不做）

- 不做第三方插件机制（SDK / manifest / 沙箱 / 动态加载）——框架只内置官方 connector。
- 不做双向同步（首期只做 Daybreak → 飞书表的单向写出，抽象层预留双向）。
- 不做 connector 商店 / 管理中心 UI。
- 不改动现有飞书日历同步模块（参考其认证设计，但不重构、不收编）。
- 产品代码不依赖 `lark-cli`（它仅用于本次链路验证）。

---

## 2. 名词约定

下游执行需要理解的项目内具体名称：

| 名称 | 含义 | 备注 |
|------|------|------|
| Daybreak | 本应用 | Tauri 桌面应用，bundle id `com.apple.todo-floating-panel` |
| `chatTools.ts` | 现有 AI 工具注册表 | `src/lib/chatTools.ts`，已有 18 个 function-calling 工具，AI 通过它调用应用能力 |
| `feishu/client.rs` | 现有飞书 OAuth HTTP 客户端 | `src-tauri/src/feishu/client.rs`，日历同步在用，封装 OAuth/token 刷新/REST 调用 |
| `feishu/keychain.rs` | 现有凭证存储 | 用系统 Keychain 存 app_secret/token，零后端 |
| custom_fields / `field_definitions` | 用户自定义字段系统 | `src/lib/fieldStore.ts` + DB 表 `field_definitions`；todo 可挂 JSON 字段值。**本设计用它承载「项目」归属** |
| Bitable / 多维表格 | 飞书的结构化表格产品 | API 与电子表格（Sheets）不同；本 connector 写的是 Bitable |
| base_token | 多维表格的应用标识 | 写入 API 的必填参数 |
| node_token | 知识库（wiki）节点标识 | wiki 链接里的 token，**≠ base_token**，需解析转换 |
| upsert | 有则更新、无则新增 | 本 connector 的写入语义（区别于无脑 append） |

---

## 3. 整体架构

```
┌─────────────────────────────────────────────────┐
│  Connector 框架（薄壳）                            │
│  · 公共能力：链接解析 / 读目标结构 / 认证编排 /     │
│    执行预览管道 / 凭证存储                          │
│  · 接口约定：每个 connector 声明 needsAuth /        │
│    needsConfig / resolve / describe / preview /    │
│    execute，并暴露 AI tools                         │
└───────────────────────┬─────────────────────────┘
                        │ 第一个 connector 填空实现
                        ▼
┌─────────────────────────────────────────────────┐
│  飞书表格 Connector                                │
│  贴链接 → 解析 wiki→base → 读字段 → 聚合项目 →      │
│  读现有行定 upsert → 对话内确认 → 写入             │
└─────────────────────────────────────────────────┘
```

**职责切分（设计地基）**：凡是「多个 connector 都会重复做」的事归框架；凡是「飞书专有」的逻辑归 connector。判断标准：本次链路验证中已被证明会重复的能力（解析、读结构、授权、执行），才抽进框架；未验证过的不预先抽象（YAGNI）。

---

## 4. 框架层设计

### 4.1 公共能力

| 能力 | 说明 | 飞书的实例 |
|------|------|-----------|
| 链接解析 | 把用户贴的链接解析成可操作的资源句柄；按 URL 路径段分流（`/wiki/` vs `/base/`），不靠 token 前缀猜 | wiki 链接 → 调 wiki get_node → 拿 base_token + table_id |
| 读目标结构 | 「先读懂目标长什么样再写」的通用前提，返回字段名/类型 | 读多维表字段列表 |
| 认证编排 | connector 声明所需 scope，框架**一次性聚合授权**，避免逐项补授权反复打断 | 飞书 OAuth + 一次扫码覆盖全部 scope |
| 执行预览管道 | 统一的「AI 产出 → 渲染预览 → 等用户确认 → 执行」安全阀，所有写外部的 connector 共用 | 把 upsert 计划渲染成表格预览 |
| 凭证存储 | 复用现有 Keychain，零后端 | 同日历同步 |

### 4.2 Connector 接口约定

每个 connector 是对以下「填空题」的实现，框架负责把空填好后驱动：

```
Connector {
  id / 名称 / 图标
  needsAuth():   返回所需 scope 列表        → 框架聚合授权
  needsConfig(): 返回需用户填写的配置 schema → 框架渲染配置 UI
  resolve(input):   解析用户输入为资源句柄
  describe(handle): 读取目标结构供 AI 参考
  preview(handle, aiPlan): 组织"将写入什么"供用户过目
  execute(handle, aiPlan): 真正写入
  tools[]:       暴露给 AI 的 function-calling 工具
}
```

### 4.3 与现有模块的关系

- **复用**：飞书 OAuth 走 `feishu/client.rs`，新增 Bitable API 调用；凭证走 `feishu/keychain.rs`。
- **接入 AI**：connector 的 tools 注册进 `chatTools.ts`，AI 自动发现并调用。
- **不碰**：日历同步模块原样保留；仅借鉴其认证/keychain 设计。
- **薄约束**：框架首期只实现「支撑飞书表格所必需」的最小公共能力，代码量应显著小于 connector 本身。

---

## 5. 飞书表格 Connector 设计

### 5.1 配置

- UI：一个链接输入框 + 一个启用开关。
- 存储：connector 实例配置（目标表的 base_token、table_id、表结构缓存）存本地；凭证存 Keychain。

### 5.2 认证与权限

框架打包成**一次扫码授权**，覆盖以下 scope（本次验证已确认的真实 scope 名）：

| scope | 用途 |
|-------|------|
| `wiki:wiki:readonly` + `wiki:node:retrieve` | 解析 wiki 链接 → base_token |
| `bitable:app:readonly` | 访问多维表格应用 |
| `base:field:read` | 读字段结构 |
| `base:record:read` | 读现有项目行（upsert 前提） |
| `base:record:create` | 新增行 |
| `base:record:update` | 更新行 |

> 注意：写入是 `base:record:create` / `base:record:update`，不是 `base:record:write`（后者非法）。多 scope 一次申请时，飞书对非法 scope 会整批拒绝，需保证清单全部合法。

### 5.3 链接解析（关键，含已知坑）

用户贴的通常是知识库内嵌表的链接，形如 `/wiki/{node_token}?table={table_id}`：

1. `node_token ≠ base_token`，必须先调飞书 wiki `get_node` 换取 `obj_token`（即 base_token）。
2. **坑**：新版 wiki node_token 不再以 `wik` 开头，工具易误判为 obj_token 直接查 Bitable，报 `131005 document not found`。正确做法：识别 URL 路径是 `/wiki/`，走 wiki 解析路径；不靠 token 前缀判断。
3. `table_id` 从 URL 的 `table=` 参数取。
4. 兼容 `/base/{base_token}?table={table_id}` 直链（直接取 base_token）。

### 5.4 读取结构

- 读字段列表（字段名 + 类型 + 选项），缓存。
- 读现有记录的主字段值（即已存在的"项目"清单），供 upsert 匹配。

### 5.5 项目维度聚合

- **识别哪个自定义字段代表项目**：connector 默认查找名为「项目」的自定义字段（`field_definitions` 中 name=项目）；若用户的字段不叫这个名，首次同步时由 AI 在对话里问一次"你用哪个字段标项目"，记住该字段 id 复用。保持配置仍是「链接+开关」，项目字段识别走智能默认 + 一次性对话兜底。
- **主路径**：从该自定义字段读取每条 todo 的项目归属，按项目聚合今日完成的 todo/活动。
- **兜底**：字段缺失或值为空的条目，AI 在对话里列出来问用户；用户回答后并入。
- 不靠纯语义猜测做最终归属（避免污染），但 AI 可基于内容给出建议归属让用户确认。

### 5.6 写入语义：upsert

- **匹配键**：表的主字段（第一列文本，如"项目"）。
- 今日聚合出的项目，标题与表中已有项目匹配 → **更新该行**；不匹配 → **新增行**。
- 防误判：标题相近但不完全相同时（如"Daybreak插件" vs "Daybreak 飞书插件"），AI 在确认步主动提示"疑似新项目，确认新建？"。后续可加模糊匹配。

### 5.7 字段映射（AI 自适应）

- AI 看 `describe()` 返回的字段结构，把聚合后的项目数据映射到对应列。
- 人员类字段（如 FDE/负责人）默认填当前授权用户；AI 拿不准的字段在轻确认里标出让用户改。
- 日期类字段按目标格式填（如更新时间填今天）。
- connector 的提示词约束：「最近进展」写成**进展摘要**，不是任务清单流水账。

### 5.8 对话触发

- connector 暴露工具 `sync_today_to_feishu_table`（名称待实现细化）注册进 `chatTools.ts`。
- 用户自然语言（"把今天项目进展写进飞书表"）→ AI 调该工具 → 执行下述数据流。

### 5.9 写前轻确认

- AI 把 upsert 计划渲染成表格（项目 / 各字段 / 更新 or 新增）输出在对话里。
- 用户确认（"可以"）→ 写入；用户驳回/修改 → AI 调整后重新预览。
- 不弹独立窗口，全程在对话流内。

---

## 6. 端到端数据流

| 阶段 | 框架（通用） | 飞书 connector（专用） |
|------|--------------|------------------------|
| 配置 | 解析链接、聚合授权、缓存结构 | wiki→base 解析、读字段 |
| 触发 | 接住对话同步意图 | 暴露 `sync_today_*` 工具 |
| 聚合 | 拉今日 todo/活动 | 按自定义字段归项目，缺失则发问 |
| 对齐 | — | 读现有项目行，定 upsert 计划 |
| 确认 | 预览→等确认管道 | 渲染计划为表格 |
| 写入 | — | record create / update |

---

## 7. 关键设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 框架开放度 | 内置起步，不做第三方 | 用户明确「先留个框只塞这一个功能」；YAGNI |
| 数据方向 | 单向写出起步，预留双向 | 首期诉求是写出；双向首期翻倍工作量 |
| 与日历同步关系 | 参考但不动 | 降低首期风险，不动已上线能力 |
| 字段映射 | AI 全自动，不存模板 | 用户要极简，绝不手动配映射 |
| 项目来源 | 自定义字段优先 + 对话兜底 | 复用用户已建的自定义字段系统，缺失不瞎猜而是问 |
| 写入语义 | upsert（按主字段匹配） | 目标是项目状态表，非流水表 |
| 写前确认 | 对话内轻确认 | 写外部有副作用，需安全阀但不打断心流 |
| 认证依赖 | 复用 `feishu/client.rs` | lark-cli 仅验证工具，不进产品 |

---

## 8. 首期范围

**In scope**
- 薄 connector 框架（5 项公共能力 + 接口约定）
- 飞书表格 connector（配置 / 认证 / 解析 / 读结构 / 项目聚合 / upsert / 对话触发 / 轻确认 / 写入）
- 复用现有飞书 OAuth 与 Keychain

**Out of scope**
- 第三方插件机制、双向同步、connector 商店 UI、改动日历同步、lark-cli 依赖

---

## 9. 风险与缓解

| 优先级 | 类型 | 风险 | 触发条件 | 缓解 |
|--------|------|------|----------|------|
| 高 | 体验 | AI 把任务堆成流水账，"最近进展"读起来像日志不像总结 | 当日任务多、内容碎 | 轻确认可驳回；提示词约束写成进展摘要 |
| 高 | 实现 | upsert 标题匹配误判，项目名稍有出入就写重复行 | 项目命名不统一 | AI 确认步提示"疑似新项目"；后续加模糊匹配 |
| 中 | 实现 | 框架抽象过早，按飞书量身定的伪通用，加第二个 connector 时推翻 | 接口抽了未验证的能力 | 只抽已验证重复的能力；其余不预抽象 |
| 中 | 项目 | 薄框变重框，不知不觉做成插件平台 | 范围蔓延 | 硬约束：不做第三方/UI 商店/沙箱 |
| 中 | 体验 | 自定义字段「项目」缺失率高，AI 频繁发问，打断"自动"体感 | 用户没养成标项目习惯 | 兜底问答尽量批量一次问完；可建议用户设默认项目 |

---

## 10. 已验证的技术事实（本次链路验证固化）

供下游执行直接复用，避免重复踩坑：

- **链路已端到端跑通**：wiki 链接 → 解析 base_token → 读字段 → 写入记录，全部成功。
- **测试表**：标题「test」，base_token `DuLGbPlJLaQTVps6G5ycLAAqnqh`，table_id `tblLBu6pqWs9Bf5L`。
- **表结构**（项目进展表，5 字段）：

  | 字段名 | field_id | 类型 |
  |--------|----------|------|
  | 项目 | fldfaurp9F | text |
  | FDE | fldj1paSi9 | text |
  | 最近一次工作进展 | fldFCdwalN | text |
  | 当前状态 | fld4xd4LqP | text |
  | 更新时间 | fld3zFnDtc | datetime (yyyy/MM/dd) |

- **解析坑**：node_token 不以 `wik` 开头，必须按 URL `/wiki/` 路径走 get_node，否则报 131005。
- **scope 清单**：见 5.2，写入用 `base:record:create`/`update`，非 `write`。
- **写入格式**：text 直接字符串；datetime 用 `"YYYY-MM-DD HH:mm:ss"`；批量单次 ≤200 行。

---

## 11. 验收标准

1. 用户贴链接 + 开关后，无需再配置即可使用。
2. 全流程仅一次扫码授权。
3. 对话一句话即可触发总结+写入。
4. AI 能从自定义字段读出项目；读不到时在对话里发问。
5. 同一项目重复同步是**更新**而非新增重复行。
6. 写入前用户能在对话里看到完整预览并可驳回。
7. 不依赖 lark-cli；不影响现有日历同步。
