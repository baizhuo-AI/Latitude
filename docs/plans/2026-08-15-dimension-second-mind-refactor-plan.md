# 维度重构计划：认知突破与行为管理的个人成长 Agent

- 日期：2026-08-15
- 状态：V2，产品定位已收束，可进入产品与技术评审
- **2026-08-19 修订**：第 1 节产品定义升级为 harness 命题（依据 [harness 实验设计](../specs/2026-08-19-dimension-harness-experiment-design.md) 拍板 ⑤）；若实验中 H7/H8 证伪则回退到原定义。本文档其余部分待实验结账后统一修订
- **2026-08-19 追加（口径反转）**：第 6 节「自定义 HTML 是能力上限而不是默认路径」的定位已修订——自由 HTML 模块升级为 **OS 面板成长的核心能力**，渲染底层自 P0 起承诺「布局即数据」（种子布局是默认布局文档，不是硬编码页面）；§6.1 的沙箱与 Capability API 安全边界不变。录音、computer history、调度外部 coding agent 以**插件**形式进入，非必选。详见 harness 实验设计 1.2 与 5.2
- 对应仓库：`~/Documents/Daybreak`
- 当前分支：`feature/ai-secretary`
- 计划口径：以 1 名全职核心开发者配合 AI 开发为估算基础；工期按“有效开发周”计算，不等于自然周承诺

> **看见原本看不见的，做到过去做不到的。** 维度帮助你突破认知边界，并把新的理解转化为真实改变。

## 0. 结论先行

这次重构不是一次 UI 改版，也不是推倒重写。它要完成的是一次产品中心迁移：把现在围绕待办、日历和聊天组织的效率工具，迁移为围绕“认知模型—认知突破—行为实验—真实结果—认知修订”组织的个人成长 Agent。

它回应的是一个越来越普遍的处境：大数据算法持续替人筛选“值得看见的信息”，效率更高了，认知边界却可能越来越窄。人并不只缺信息，也常被既有假设、单一叙事和重复行为困住。维度不是再提供一条更聪明的信息流，而是帮助用户发现自己正在用什么框架理解世界，引入异质证据和替代视角，再把新的理解变成一次能够被现实检验的行动。

现有 AI 秘书已经具备可替换模型、本地 SQLite、长期记忆、主动触达闸门、日终纪要、日历与飞书入口、MCP 和多窗口运行能力。这些是新产品的基础设施，应保留并升级。真正缺失的是位于它们上方的认知—行为中枢：系统现在会记、会提醒、会排任务，但还不能持续维护“你目前相信什么、为什么相信、什么证据会动摇它、它正在影响哪些选择”，也不能把一次认知变化稳定转化成行为、结果和下一轮修订。

重构遵循五个决定：

1. **第一验证对象不是页面，而是认知—行为闭环。** MVP 必须证明：一次新的理解能形成一个可验证动作，真实结果又能在 7 天内影响后续判断、首页模块、建议或主动触达。
2. **先建设可审计的认知—行为图谱，再建设自由生成的界面。** 没有证据、反证、适用情境、时间、纠错和回滚，自生长主页只会变成随机卡片生成器。
3. **“伙伴”是交互方式，不是产品目的。** 熟悉、默契、权能用于降低长期沟通成本、提高判断质量和安全代理能力；不能把聊天时长、情绪依赖或关系等级本身当成增长目标。
4. **模块化不是“模型随便写 HTML”。** 维度要提供稳定外壳、模块协议、数据绑定、权限和生命周期；原生模块、声明式生成模块、自定义 HTML 都只是不同渲染器。
5. **采用渐进替换，不做大爆炸重写。** 现有 Todo、Goal、Calendar、Activity、Memory、Digest 继续作为已确认数据和执行能力，通过适配层逐步接入新内核。

按照下面的阶段推进，完成 P0—P3 后可以得到第一版可体验产品，约 7—9 个有效开发周；P4 完成关系与权能闭环，形成可对外测试的 Alpha；P5—P6 再兑现自由模块和 AI Listener 的完整接入。

## 1. 重构后的产品目标

维度的产品定义是（2026-08-19 修订）：

> **一个个人成长 harness：以「认知突破 + 行为管理」为理论内核，提供有限的积木和生长语法，让每个用户在日常交互中长出属于自己形态的成长系统。**

Harness 分四层：理论内核（物理规则，不可让渡）、积木（有限原语集，产品方定义）、生长语法（AI 观察摩擦提出形态提案、用户裁决、留痕可回滚）、种子形态（所有人相同的最小默认配置）。用户不「配置」产品，AI 当园丁；形态生长与认知成长共用同一套「提案—裁决」语法。四层定义与验证假设（H7/H8）见 [harness 实验设计](../specs/2026-08-19-dimension-harness-experiment-design.md)。

内核价值仍收束为两个关键词（以下原文不变）——它不是心理陪伴产品，也不只是日程、待办和目标工具：

**认知突破。** 维度维护的不是一份“关于你的资料”，而是一个动态认知模型：你目前相信什么、判断从何而来、在哪些情境成立、有哪些反证和盲点、影响了哪些选择、后来如何被修订。它通过个人历史、异质信息、反例和替代框架，帮助用户看见原本看不见的问题。它不能用 AI 的统一答案替换算法的信息茧房。

**行为管理。** 维度不把成长等同于更多待办、打卡或自律。它把新的理解转成一个小而可验证的行为实验：明确假设、触发条件、行动、成功信号和停止条件；再根据真实结果更新认知。更准确的关系不是“行为跟随认知”，而是：**认知决定行为的方向，行为检验并重塑认知。**

产品叙事分成四层，后续设计不得倒置：

| 层级 | 定义 | 在产品中的作用 |
|---|---|---|
| 核心价值 | 认知突破 + 行为管理 | 回答用户为什么要使用维度 |
| 工作机制 | 个人认知模型 + 认知—行为反馈闭环 | 决定系统怎样学习和产生改变 |
| 交互形态 | 长期伙伴、秘书、自生长个人 OS | 让复杂内核以自然方式进入日常生活 |
| 关系系统 | 熟悉、默契、权能 | 降低沟通成本、提高判断质量、治理代理边界 |

对外可使用一句更有传播力的表达：

> **在算法决定你看见什么的时代，维度帮助你重新获得定义自己、改变自己的能力。**

第一目标用户收窄为：有明确自我提升需求，正处于学习迷茫、事业过载或生活瓶颈，并且感到信息很多、判断却没有变清楚的个人用户。首个高频切口不是泛化“每日决策减负”，而是每天完成一次轻量闭环：**一个值得突破的认知问题 + 一个验证它的真实行动。**

## 2. 当前系统审计

### 2.1 可以直接继承的底座

| 现有资产 | 当前能力 | 重构中的位置 |
|---|---|---|
| Tauri 2 + React 多窗口壳 | 主工作台、对话条、待办窗、启动器 | 保留为稳定外壳和多入口承载层 |
| SQLite 本地真相源 | Todo、Goal、对话、活动、纪要、记忆、主动日志 | 保留；新增迁移系统与新领域表 |
| Engine Adapter | API、Claude Code、Codex、Fake Engine | 继续作为可替换推理层，模型不拥有人格、权限和记忆 |
| AI 秘书主动引擎 | 触发、负荷、闸门、冷却、预算、投递、反馈 | 升级为“认知挑战与行为提案的投递层”，不负责认知模型本身 |
| Memory Facts | told / inferred、durable / transient、置顶和过期 | 迁移为认知节点的兼容输入 |
| Daily Digest / Reflection | 日终事实摘要与阶段复盘 | 升级为成长叙事和结果评估的数据源 |
| Calendar / Feishu / MCP | 外部上下文与执行通道 | 作为感知器官和执行器，由权能系统统一治理 |
| AI Listener 角色与状态机 | Idle、Listening、Thinking、Speaking、Presenting | 作为同一个 AI 伙伴在硬件端的具身入口 |

### 2.2 当前产品与目标之间的断层

| 当前状态 | 目标状态 | 需要的结构性变化 |
|---|---|---|
| 首页由今日待办、空档和重新排程构成 | 首页表达“今天值得突破的认知 + 验证它的行动” | `BriefingPage` 升级为 Home Composer 的投影视图 |
| “关于你”是记忆事实列表 | 用户可以看到自己当前的认知模型及其变化 | 事实升级为带证据、反证、情境、置信度、时效、冲突和版本的认知节点 |
| Telos 是年 / 季 / 月目标清单 | 方向、假设与选择会被讨论、验证和调整 | 引入框架、反目标、张力、决策、实验与结果，而非只做目标 CRUD |
| 30 天等于聊天或活动历史 | 30 天呈现“哪些认识和行为真的改变了” | 新增信念修订、行为实验、结果、模块生命周期和关系事件 |
| Persona 是静态语气预设 | 角色既有统一形象，也会随关系调整行为 | 将“声音与形象”同“判断策略和关系状态”解耦 |
| 主动秘书依据任务和日历触发 | 主动性还要依据认知冲突、当前张力、行为触发和实验结果 | 在 trigger 前增加 Cognitive Challenge / Behavior Planner 层 |
| 反思生成一段文字后结束 | 反思会修订认知并改变下次行为 | 每次反思产出可审阅的 Change Set，并能应用或回滚 |
| 固定侧栏按功能页导航 | 首页会自然长出模块，工具退居二级 | 改为稳定主壳 + 动态主页 + 工具库 |
| 权限是连接器配置 | 权能是用户明确授予的关系能力 | 新增按领域、风险、动作划分的 Authority Grant 与行动账本 |

### 2.3 当前质量基线

2026-08-15 本地执行 `npm test -- --run` 的结果为：57 个测试文件中 55 个通过，737 个测试中 736 个通过。已有两个失败分别来自 `ChatBar.test.tsx` 的 `react-i18next` mock 不完整，以及设计 token 测试仍期待旧色值。这两项不是本次重构造成，但必须在 P0 固化为已知基线并修复，否则后续阶段无法使用“全绿”作为验收门禁。

## 3. 目标体验与信息架构

### 3.1 三个一级产品面

重构后的一级导航只保留三个稳定产品面，对话作为随时可唤起的交互层，而不是唯一入口。

**今天。** 不是待办页，而是当天的认知—行动工作台。它回答四个问题：今天哪条判断最值得重新看、为什么、还有什么不同视角、用什么行动验证。页面由稳定外壳和可变化模块组成。

**30 天。** 不是聊天记录，而是改变的证据。它展示最近 30 天哪些旧认识被挑战、哪些实验被执行、结果如何、哪些行为真的改变、认知模型因此怎样修订，以及哪些模块出现、合并或退出。

**我们。** 展示维度如何理解用户的判断方式，以及这种理解可以被授予多大行动边界。这里包含认知模型、熟悉、默契、权能、证据与纠错入口。它是核心闭环的支持层，不把关系进度本身当作用户终点。

Todo、Calendar、Activity、Telos、Connections、Settings 不删除，统一收入“工具与资料”二级入口；它们仍可被模块引用，也保留直接管理能力。

### 3.2 “今天”首页的稳定骨架

首页可以变化，但不能每天像换了一个产品。建议固定五个视觉锚点：

1. **伙伴在场。** 使用 AI Listener 已确认的秘书角色、服装、道具和状态语义。角色不是装饰：Idle 表示安静陪伴，Thinking 表示正在形成判断，Presenting 表示有提案待确认。
2. **一个认知问题。** 用一句自然语言指出今天最值得重新看的判断、假设或盲点，例如“你可能不是缺少更多信息，而是在推迟作出取舍”。必须能展开查看个人证据、外部证据、反证和适用边界。
3. **一个替代视角。** 不直接宣布标准答案，而是说明“还可以怎样理解”，并标明来源与不确定性，防止用 AI 信息茧房替代原有茧房。
4. **一个验证动作。** 将替代视角转成足够小、可逆、可观察结果的行动；涉及价值冲突、证据不足或高风险时先澄清或请求授权。
5. **情境模块与纠正入口。** 根据用户近况放入 2—5 个长期或临时模块；用户可以说“这个前提不成立”“这个证据不适用于我”“实验结果相反”，反馈必须进入认知图谱和运行时，而不只停留在聊天记录里。

### 3.3 外显关系参数

外显只保留“熟悉、默契、权能”三个参数。它们是核心闭环的支持机制：鼓励用户提供高质量信息和结果反馈，让协作成本、判断质量与代理边界可见、可解释；不承担“让用户沉迷培养 AI”的增长目标。

| 参数 | 它回答的问题 | 证据来源 | 建议外显方式 |
|---|---|---|---|
| 熟悉 | 维度对“你是谁、相信什么、如何判断、处于什么阶段”了解多少 | 已确认认知节点的覆盖度、时效、置信度、关键领域空白 | 阶段 + 到下一阶段的进度 + 最近新增认识 |
| 默契 | 维度能否理解并有效补充你的判断方式 | 替代视角质量、建议采纳、用户纠正、选择一致性、实验结果，且按领域计算 | 阶段 + 最近一次“补得上 / 被纠正”的具体证据 |
| 权能 | 你允许维度替你做到哪一步 | 用户显式授权、风险级别、动作范围、撤销记录 | 当前最高授权阶段 + 各领域授权清单 |

建议阶段名称先作为工作稿：

- 熟悉：初见 → 认识你 → 看见模式 → 懂你的处境 → 持续同行
- 默契：试探 → 对得上 → 合拍 → 稳定补位 → 心照不宣
- 权能：只观察 → 给建议 → 代你准备 → 低风险代办 → 受托协同

内部可以保留 0—100 的连续值用于计算和进度动画，但产品默认展示阶段、趋势和证据。权能绝不能靠分数自动升级，只能由用户显式授予；熟悉和默契也不能由消息数量直接增长。

## 4. 目标内核：从记忆库到认知—行为运行时

### 4.1 核心闭环

```text
信息环境、现实经历与交互
  ↓
Evidence（发生了什么）
  ↓
Observation（系统看到了什么）
  ↓
Current Cognitive Model（你目前相信什么、怎样判断）
  ↓
Cognitive Breakthrough（盲点、反证、异质观点、替代框架）
  ↓
Behavior Management（选择、计划、行为实验、触发条件）
  ↓
Proposal / Change Set（建议验证或改变什么）
  ↓ 用户确认、纠正或授权
Home / Modules / Rules / Actions（界面和行为发生变化）
  ↓
Outcome + Reflection（结果如何）
  ↓
Cognitive Revision（保留、修订、限制或推翻旧认识）
  └──────────────回到 Current Cognitive Model
```

这是维度真正的产品飞轮。熟悉、默契和权能随闭环结果更新，但位于飞轮外侧，不替代认知与行为结果。任何“自我进化”都必须经过提案、用户纠错、版本记录和可回滚应用，不能让模型直接修改自己的长期规则。

### 4.2 七层运行时

| 层 | 职责 | 代码与模型边界 |
|---|---|---|
| 感知层 | 接收聊天、任务、日历、活动、飞书、Listener 和外部信息证据 | 接入、幂等、隐私、来源和时间由代码保证；模型只做提取 |
| 认知模型层 | 维护事实、信念、假设、框架、价值、偏好、边界、判断原则和张力 | 节点 / 边状态机、证据、反证和版本由代码管理；模型提出候选 |
| 认知突破层 | 识别盲点、失效前提、单一叙事和关键分歧，引入异质观点与替代框架 | 检索必须兼顾支持与反对证据；模型必须表达边界和不确定性 |
| 行为管理层 | 将新理解转成决策、计划、触发器和有限期行为实验 | 模型负责提出方案；约束、风险、可逆性、停止条件和结果回收由代码检查 |
| 变更控制层 | 把建议表达成可确认、可编辑、可回滚的 Proposal / Change Set | 完全由应用掌管状态与事务 |
| 模块运行时 | 组合主页模块并管理出现、更新、衰减、合并和退出 | 模型只能请求模块变化，Runtime 验证后执行 |
| 关系与权能层 | 根据闭环质量更新熟悉 / 默契，执行显式授权，记录代办行为 | 评分规则、权限门禁和审计由确定性代码掌管；不得反向绑架核心目标 |

## 5. 核心领域模型

新模型不要求一次建完，但命名和边界需要在 P0 冻结，避免后续每个功能自建一套真相源。

| 实体 | 核心字段 | 说明 |
|---|---|---|
| `evidence_items` | source、source_ref、captured_at、content / media_ref、privacy、hash | 原始证据元数据；AI Listener 音频仍在文件系统，数据库存路径和校验 |
| `observations` | kind、content、evidence_ids、confidence、extractor_version、status | 系统从证据中看到的候选信息，不等于事实 |
| `personal_claims` | kind、subject、predicate、object、context、confidence、valid_from / to、recorded_at、status | 认知节点；kind 至少包含 belief / assumption / frame / value / preference / boundary，支持 active / disputed / superseded / expired |
| `cognitive_edges` | from_type / id、relation、to_type / id、context、weight、valid_from / to、recorded_at、status | 表达 supports / contradicts / reframes / influences / implemented_as / resulted_in / updates 等关系 |
| `claim_evidence` | claim_id、evidence / observation_id、support / contradict、weight | 一条认知节点可以有多条支持或冲突证据 |
| `cognitive_challenges` | target_claim_id、blind_spot、counterevidence_refs、alternative_frame、uncertainty、status | 一次“认知突破”的可审阅对象，不把模型答案直接写成真相 |
| `decisions` | question、options、selected、rationale、claim_refs、status | 连接认知与行动的显式决策记录 |
| `proposals` | proposal_type、target_domain、payload、reason、evidence_refs、risk、status | 建议创建、修改、撤销或询问什么 |
| `change_sets` | proposal_id、before_json、after_json、applied_at、rolled_back_at | 任何运行时变化都能解释和回滚 |
| `behavior_experiments` | hypothesis、action、trigger、duration、success_signal、stop_condition、status | 将新理解变成有限期、可逆、可验证的尝试 |
| `outcomes` | subject_type / id、result、user_rating、evidence_refs、recorded_at | 记录建议或实验是否有用，而不只记录是否点击 |
| `module_instances` | module_type、renderer、config、bindings、status、reason、expiry、version | 主页上实际存在的模块及生命周期 |
| `relationship_events` | dimension、domain、event_type、delta、reason、evidence_refs | 熟悉和默契的可解释变化；权能只记录授权事件 |
| `authority_grants` | domain、action、risk_ceiling、mode、expires_at、revoked_at | 按领域和动作授权，不设全局“万能代理”开关 |
| `narrative_entries` | date、entry_type、title、summary、refs、importance | 30 天页面的统一叙事投影 |

逻辑上使用一张认知—行为图谱：

```text
Evidence ──supports / contradicts──▶ Belief / Assumption / Frame
                                      │
                                  influences
                                      ▼
                                  Decision
                                      │
                                implemented_as
                                      ▼
                              Action / Experiment
                                      │
                                  resulted_in
                                      ▼
                                   Outcome
                                      │
                                    updates
                                      └────────────▶ Belief / Assumption / Frame
```

首期不引入独立图数据库。SQLite 继续作为真相源，节点与边采用来源可追溯、有效时间与记录时间分离的双时态设计；检索层再按需要构建图投影、全文索引和向量索引。旧认识不硬删，使用 disputed / superseded / invalidated 保留历史，否则系统无法解释“为什么以前那样判断、后来为何改变”。

`memory_facts` 首期不删除。迁移策略是将 told 事实映射为较高置信认知节点，将 inferred 事实映射为待确认节点，并保留旧 ID 作为 `legacy_ref`。迁移后旧 API 先通过兼容视图或 Repository Adapter 继续工作，直到所有消费者切换完毕。

## 6. 模块化主页协议

### 6.1 稳定外壳与三种渲染器

模块自由度建立在一个稳定契约上：

- **原生模块**：React 实现，适合核心、高频、需要复杂交互的模块。
- **声明式生成模块**：模型选择系统组件并生成配置，适合多数可变化卡片，是前期主力。
- **自定义 HTML 模块**：在 sandboxed iframe 中运行，适合高度个性化的展示和轻交互，是能力上限而不是默认路径。

所有渲染器共享 `ModuleManifest`：`id`、`type`、`version`、`title`、`renderer`、`dataBindings`、`permissions`、`config`、`state`、`createdReason`、`status`、`lastUsefulAt`、`expiresAt`、`exitCriteria`、`rollbackVersion`。

自定义 HTML 不得直接访问 SQLite、文件系统或任意网络。它只能通过受控 Capability API 读取声明过的数据、发起低风险 UI 事件或生成 Proposal；默认 CSP 禁止外部脚本，模块包需要签名 / 哈希、版本记录、资源上限、超时与一键停用。

### 6.2 模块生命周期

```text
proposed → preview → active → updated → fading → archived
                          ├→ merged
                          └→ rolled_back
```

每个模块出现时要告诉用户“为什么现在出现”；长期无用、目标完成或情境消失后自动进入 fading，并允许用户保留。首页变化应以局部更新为主，不允许每天全量重排；固定锚点不动，单次最多新增或替换一个主要模块。

### 6.3 MVP 的三块积木

第一版只做三类原生 / 声明式模块，先验证闭环：

1. **认知突破**：今天最值得重看的一个信念、假设或框架，包含个人证据、外部证据、反证、替代视角和适用边界。
2. **验证动作**：从新视角推出的一个小而可逆的真实行动，可开始、调整、交给工具准备，或说明“为什么现在不做”。
3. **行为实验**：一个有限期假设、触发条件、做法、成功信号和停止条件；结束后必须回收结果并更新认知节点。

现有今日 Todo、日历空档、目标和活动作为这些模块的数据源或辅助视图，不再主导首页结构。

## 7. 现有代码到目标架构的迁移图

| 当前模块 / 文件 | 迁移方向 | 处理策略 |
|---|---|---|
| `src/pages/BriefingPage.tsx` | `HomePage` + `HomeComposer` | 保留任务与空档计算，降为数据适配器；重写页面编排 |
| `src/pages/AboutYouPage.tsx` | “我们”页面中的 Cognitive Model Inspector | Persona 与用户模型拆开；增加信念 / 假设 / 框架、证据、反证、情境、冲突和纠正 |
| `src/pages/TelosPage.tsx` | Direction / Decision Architecture 模块 | 兼容原 Goal CRUD，新增张力、反目标、决策和行为实验关联 |
| `src/pages/ChatHistoryPage.tsx` | 工具库中的会话归档 | 不再承担“30 天”；新建 Narrative Projection |
| `src/pages/ActivitiesPage.tsx` | Evidence / Outcome 输入之一 | 保留直接记录，支持关联 Claim、实验和叙事 |
| `src/lib/persona/personaSpec.ts` | Character Voice Policy | 保留语气与称呼；移除对“判断能力”的越权定义 |
| `src/lib/memorySection.ts` | Cognitive Model Context Compiler | 从平铺事实串升级为按场景选取、同时包含支持 / 反对证据与适用边界的上下文 |
| `src/lib/secretary/*` | Proactive Delivery Runtime | 保留 scheduler / gate / load / deliver；上游改接认知突破与行为管理层输出 |
| `src/lib/db.ts` | migration + repositories | 停止继续膨胀单文件；按领域拆 migration、repository 和 projection |
| `src/components/BoardShell.tsx` / `Sidebar.tsx` | Stable Shell / Module Navigation | 一级导航收敛；旧页面迁入工具库并保留兼容路由 |
| AI Listener bridge | Evidence / Observation / Proposal Client | 使用版本化协议，重点捕捉“说的、选的、实际做的”之间的差异，不直接写 Todo 或 Memory |

建议新增目录边界：

```text
src/domain/evidence/
src/domain/cognitive-model/
src/domain/cognitive-breakthrough/
src/domain/behavior/
src/domain/proposals/
src/domain/modules/
src/domain/relationship/
src/domain/authority/
src/projections/home/
src/projections/narrative/
src/lib/db/migrations/
src/lib/db/repositories/
```

这些目录表达领域归属，不要求为了“整洁”一次搬完旧代码。新功能只进新边界，旧调用逐个替换。

## 8. 分阶段实施计划

### P0：冻结契约与修复基线（1 周）

目标是让重构具备可验证的起点，而不是马上改首页。

工作内容包括：冻结产品词汇和实体边界；把现有 SQLite 初始化改为显式 schema version + 顺序 migration；修复当前两项测试失败；建立 feature flag；为 Todo、Goal、Memory、Activity、Digest 增加统一 legacy adapter；定义 Evidence / Observation / Cognitive Node / Cognitive Edge / Challenge / Decision / Behavior Experiment / Proposal、ModuleManifest 和 Relationship Event 的 TypeScript 契约；补充 6 个端到端用户场景 fixture。

验收门禁：现有功能无数据丢失；全量测试回到全绿；空库和旧库都可迁移；新功能关闭时产品行为与当前版本一致；协议评审通过后 P1 才能开工。

### P1：认知模型与纠错闭环（2 周）

目标是把“记住几条事实”升级为“能解释你当前如何形成判断，以及这个判断怎样被证据修订”。

实现 `personal_claims`、`cognitive_edges`、`claim_evidence`、Observation 和 Proposal 的最小表与 Repository；迁移 `memory_facts`；建立认知节点与边的 active / disputed / superseded / expired 状态机；在“关于你”基础上做 Cognitive Model Inspector；对每条推断展示来源、反证、适用情境、置信和“对 / 不对 / 只在……成立 / 改成……”；实现 Cognitive Model Context Compiler，让聊天和后续规划按场景读取图谱子集。

验收门禁：任何 inferred 节点都不能静默变成 confirmed；用户纠正后旧节点被保留为 superseded 而非硬删；同一纠正在所有窗口和模型引擎下即时生效；可以从一句判断追溯到支持证据、反证和历史版本。

### P2：“今天”首页 V1 与认知突破—行为管理中枢（2—3 周）

目标是让首页第一次从“今日待办表”变成“今天值得突破的认知 + 验证它的行动”。

实现 Cognitive Challenge Candidate、Behavior Planner、Home Snapshot 和 Home Composer；首页固定角色区、认知问题、替代视角、验证动作和 2—3 个情境模块；任务、日历、目标、活动、认知节点和外部异质证据通过 adapter 进入 planner；所有判断输出 reason、confidence、support_refs、counterevidence_refs、scope 和 valid_until；首页变化通过 Proposal / Change Set 生效；角色视觉复用 AI Listener 的档案秘书形象和纸张、石墨、青柠、天空蓝、日光黄、珊瑚色语义。

验收门禁：冷启动有可用空状态；同一输入在 Fake Engine 下可重放；用户可追问“为什么、反例是什么、为什么适用于我”；单次刷新不会无理由重排；一次认知突破能在 7 天场景测试里形成至少一个验证动作，结果会修订至少一个后续判断或模块。

### P3：“30 天”与认知—行为修订运行时（2 周）

目标是让回顾不再是一篇生成后被遗忘的文字。

实现 `behavior_experiments`、`decisions`、`outcomes`、`narrative_entries` 和 Change Set 时间线；把聊天、Activity、Digest、Proposal、认知节点 / 边变化、模块生命周期投影成 30 天故事；提供每周共同回顾；反思最多提出 1—3 个系统变化，例如限制或修订一条旧认识、创建实验、调整触发器、降低某类提醒、保留 / 退出模块；用户逐项接受、编辑或拒绝。

验收门禁：反思产生的每个变化都能看到 before / after；可以一键回滚；实验到期后必须收结果，不能无限挂起；30 天默认不展示原始聊天推理，只展示可理解的事件和变化。

完成 P0—P3 后形成第一版可用产品：今天、30 天、我们、持续对话、旧工具库，并具备第一个完整的认知突破—行为验证闭环。

### P4：关系成长与权能（2 周）

目标是让熟悉、默契、权能成为降低认知—行为协作成本的真实关系状态，而不是装饰数值或产品终点。

实现 Relationship Event、按领域评分、阶段与证据说明；熟悉从已确认模型覆盖度和时效计算；默契从建议 / 选择 / 纠正 / 结果计算；建立 Authority Grant、风险矩阵和 Action Ledger；支持“只建议、代我准备、执行前确认、低风险自动执行”四种模式；现有 MCP、日历和飞书动作统一经过授权检查。

验收门禁：权能不能自动升级；每次代办都有授权来源、输入、输出和撤销 / 补救路径；撤销授权立即跨窗口生效；不同领域可以处于不同阶段；关系数值变化能解释到具体事件。

### P5：模块运行时与自定义 HTML（3 周）

目标是兑现“有底层支持的自由度”。

先实现 Module Registry、Manifest 校验、声明式 renderer、生命周期调度、版本与回滚；再实现 sandboxed iframe、自定义 HTML 包、Capability API、CSP、资源配额和禁用开关；提供一套示例主页和 8—12 个基础模块积木，让模型通过组合、参数和数据绑定适配用户，而不是每次从空白生成。

验收门禁：坏模块不能拖垮主应用；无授权模块读不到数据；自定义 HTML 不可直连数据库、文件系统和任意网络；模块更新可预览和回滚；30 天能解释模块为什么出现、改变或退出。

### P6：AI Listener 正式接入（2 周，不含硬件开发）

目标是把 Listener 变成维度的感知器官，重点捕捉“用户说了什么、选择了什么、实际做了什么”之间的差异，并保持被动采集与主动交互分离。

定义版本化 ingest 协议；被动录音只进入 Evidence，经本地 ASR 后生成 Observation；中高风险内容进入 Proposal Inbox；只有 confirmed / committed 才写入 Activity、Todo、Claim 或 Digest；桌面和圆屏共享角色状态语义；硬件 Presenting 状态只展示少量高价值提案；重复导入按 device + session + hash 幂等。

验收门禁：原始证据可追溯；不可靠说话人信息不得自动创建用户任务；重复上传不重复写入；拒绝的提案不污染长期模型；物理 MIC OFF 状态在桌面端可见且不可被软件静默覆盖。

## 9. 第一版明确不做什么

为了让第一版真正闭环，以下能力延后：

- 不做任意第三方模块市场；P5 只支持本地可信模块包。
- 不允许模型直接改系统提示词、权限规则或数据库 schema。
- 不把全天录音自动变成大量任务，不做不可靠的情绪诊断、人格定型或心理治疗承诺。
- 不追求覆盖健康、关系、财务、学习等所有领域；MVP 先覆盖“一个认知问题、一个验证动作、一个行为实验”。
- 不删除旧 Todo、Calendar、Telos、Activity 和 Chat 页面；先降级为工具库，等行为数据证明无用后再退役。
- 不把“聊天更多”作为关系增长目标；沉默、纠正和拒绝同样是有效关系数据。

## 10. 质量、测试与观测

### 10.1 北极星验收

MVP 的核心用例不是“AI 生成了漂亮首页”，也不是“用户觉得 AI 很懂我”，而是：

> 用户原本相信“我要再收集更多信息，才能作出决定”。维度结合他的历史行为指出这个假设的适用边界，提供支持与反对证据，并提出一个替代框架。用户确认后执行一次“小范围先决策、再补信息”的行为实验。真实结果让旧认识被保留、限制或修订，并在 7 天内改变至少一次首页判断、建议、主动触达或后续实验；用户能看到整条因果链。

### 10.2 产品指标

| 指标 | 定义 | 目的 |
|---|---|---|
| First Useful Breakthrough | 首次出现“我原来没这样看过，而且愿意验证”的时刻所需时间 | 衡量开箱即用与真实认知价值 |
| Cognition-to-Action Rate | 被用户认可的新视角形成验证动作的比例 | 防止产品停留在漂亮洞察 |
| Outcome Revision Rate | 有结果的行为实验实际修订认知节点或适用边界的比例 | 衡量行为是否真的反哺认知 |
| Correction Consequence Rate | 被纠正内容在 7 天内影响后续行为的比例 | 衡量系统是否真的学习 |
| Experiment Closure Rate | 到期实验获得结果并形成结论的比例 | 防止行为管理沦为新待办 |
| Perspective Diversity | 认知突破中支持证据、反证和异质来源的有效覆盖 | 防止 AI 复制新的信息茧房 |
| Module Survival / Dismissal | 模块保留、使用、衰减、删除情况 | 衡量主页是否真的贴合 |
| Authority Overreach | 未授权、越级或无法解释的动作次数 | 必须长期为 0 |
| Relationship Explainability | 关系阶段变化可追溯到证据的比例 | 防止伪养成系统 |

### 10.3 测试分层

- 领域纯函数测试：认知节点 / 边冲突、支持与反证关系、双时态失效、关系计算、挑战排序、实验生命周期、权限矩阵和时间边界。
- Migration 测试：空库、当前 schema、包含脏数据 / 过期记忆 / 冲突 ID 的旧库快照。
- Contract 测试：TypeScript、Rust、MCP、AI Listener 协议与 Engine Adapter 的输入输出一致性。
- Scenario 测试：学习迷茫、事业过载、家庭工作冲突、信息茧房、用户纠错、拒绝建议、撤销授权七条固定故事。
- UI 测试：首页稳定锚点、支持 / 反对证据展开、适用边界、Proposal diff、模块回滚、关系阶段说明。
- 观测：记录模型版本、prompt / extractor 版本、候选、拒绝原因、用户纠正和结果，但默认不记录不必要的原始隐私内容。

## 11. 主要风险与控制

**把推断写成事实。** 这是最大信任风险。所有 inferred 内容必须带来源、置信度和状态；高影响判断必须先问或给用户纠正入口。

**用 AI 信息茧房替代算法茧房。** 如果系统只检索能支持当前叙事的材料，认知突破会退化为更有说服力的迎合。每个高影响挑战都要同时检索支持证据、反证、异质来源和适用边界，并允许用户查看来源。

**把“认知决定行为”写成单向决定论。** 情境、能力、情绪、社会关系和环境约束同样会影响行为。产品使用“认知决定方向，行为检验并重塑认知”的双向模型，不把执行失败简单归因为观念或意志力。

**把行为管理做成生产力道德。** 行为实验必须小、可逆、有停止条件；休息、拒绝目标、降低投入也可以是有效结果，系统不以完成更多任务作为默认善。

**主页变化过度。** 每天全量重排会让产品失去空间记忆。固定角色、核心判断和交互入口；一次最多改变一个主要模块，并为变化提供理由与撤销。

**把智能写在 Prompt 里。** 权限、状态机、回滚、幂等、去重、生命周期和评分规则必须是代码；模型负责解释和提出候选，不拥有最终真相。

**关系养成游戏化失真。** 关系值不能由消息数增长，不用连续签到奖励；展示真实证据、领域差异和不确定性，允许用户主动降级或重置。

**伙伴叙事压过个人成长。** 关系感可以提高反馈质量，但不能把用户对 AI 的依赖、聊天时长或情绪黏性当成成功。对外传播与产品指标始终回到认知突破和真实行为改变。

**自由模块成为安全后门。** HTML 运行在隔离沙箱内，只能使用 Capability API；模块版本、来源、权限和网络行为全部可见。

**旧系统与新系统形成双真相源。** 新内核通过 Repository / Projection 读取旧表，写入必须经事务和 legacy_ref；迁移期间禁止同一业务同时由两套 scheduler 独立驱动。

**心理学叙事越界。** 理论只用来搭建观察维度和发展框架，不做临床诊断，也不宣称能准确读心。任何人格与发展结论都以可纠正假设呈现。

## 12. 开工顺序与决策门

开工后只按以下顺序推进：先 P0 契约和基线，再 P1 认知模型，之后才改首页。P2 完成时做一次真实 7 天 dogfood；如果“新认识形成验证动作、结果反过来修订认识”不能稳定发生，不进入自由模块开发，而是回到 Cognitive Model、Challenge 和 Behavior Planner 修闭环。P3 后再决定是否扩大内测；P4 任何权能自动化必须经过单独安全评审；P5 自定义 HTML 只在原生 / 声明式模块协议稳定后开放；P6 与 AI Listener 的硬件节奏解耦，桌面端先用录音文件和模拟 Evidence 做协议验收。

首个研发迭代可以立即拆为以下待办：

1. 修复当前两项测试失败，冻结 P0 baseline。
2. 为 SQLite 引入 schema version 与 migration runner，不修改现有数据语义。
3. 建立 `personal_claims`、`cognitive_edges`、`claim_evidence`、`cognitive_challenges`、`behavior_experiments`、`proposals` 的最小 schema 与类型契约。
4. 写 7 条固定用户故事和 1 条“认知突破 → 行为验证 → 结果修订”的北极星 scenario。
5. 把 `memory_facts` 通过 adapter 映射为认知节点，先不切换旧消费者。
6. 做新的“今天”认知突破卡和“我们”Cognitive Model Inspector 原型，验证用户能否看懂支持证据、反证、适用边界和修订历史。

当这六项完成并通过验收，维度才算真正开始从“会做事的 AI 秘书”走向“能帮助你突破认知，并把理解变成改变的个人成长 Agent”。
