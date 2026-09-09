# 维度认知—行为图谱：知识库设计

- 日期：2026-08-20
- 版本：v1.3（v1.2 承诺检测；v1.3 成为领域模型唯一权威——原重构计划 §5 随该文件退役）
- 状态：待评审
- 定位：**理解层的详细设计，领域模型的唯一权威**。展开[总纲 PRD](2026-08-20-dimension-master-prd.md) §3.3 数据架构；与总纲冲突时以总纲为准；工程批次见[工程实施计划](../plans/2026-08-20-dimension-implementation-plan.md)
- 读者：实现者。本文档是 P0（契约冻结）与 P1（认知模型）的直接工程输入

---

## 0. 图谱回答什么问题

知识库不是「存储用户说过的话」，而是持续维护四个问题的可追溯答案：

1. **你目前相信什么、在意什么？**（认知节点）
2. **凭什么？**（证据链、推理链、适用边界）
3. **这些认知正在影响哪些选择和行动？**（认知 → 决策 → 行动的血缘）
4. **现实结果如何反过来改变了认知？**（结果 → 修订的回路）

四个问题连起来就是产品飞轮：**认知决定行为的方向，行为检验并重塑认知**。

**设计原则**（物理规则在图谱层的体现）：

| 原则 | 图谱层的落实 |
|---|---|
| 证据先于结论 | 无证据的 claim 不能进入 active；推断必须带 inferred 标记 |
| 候选先于写入 | 观察层（observation）与真相层（claim）物理分离；只有用户裁决能跨层 |
| 可追溯 | 任何节点可回答「你从哪来」：证据、推理、修订历史全部是边 |
| 可修订不可篡改 | 旧认知不硬删，只改状态；修订必须挂原因（outcome 或用户纠正） |
| 可导出可删除 | 全量导出为可读格式；删除有明确的级联语义（§10） |

---

## 1. 三层知识模型

```text
┌─ Evidence 层（发生了什么）────────────────────┐
│ 速记、对话、check-in、日程完成、资讯反馈、       │
│ 录音转写*、电脑使用轨迹*（* = 感知插件）        │
│ 特性：只增不改，带来源与隐私等级                │
└──────────────┬───────────────────────────┘
               │ 提取器（模型，版本化）
┌─ Observation 层（系统看到了什么）─────────────┐
│ 候选观察：模式、言行差、重复主题、可能的信念     │
│ 特性：可能错误；未经确认；有生命周期（会过期）    │
└──────────────┬───────────────────────────┘
               │ 统一 Domain Change Set（自动 / 提案 / 共创）
┌─ Claim 层（可追溯、可修订的认知层）───────────┐
│ 信念、假设、框架、价值、偏好、边界、事实         │
│ + 张力、决策、实验、行动、结果                  │
│ 特性：双时态、状态机、Toulmin 结构、全血缘       │
└──────────────────────────────────────────┘
```

三层分离仍是信任架构的根基，但它分离的是**证据、推断和权威**，不是把模型永远锁在候选层。当前用户 standing grant 允许模型经统一 Domain Change Set 自动创建或修订 Claim；这类对象必须保持 `origin=model / authority=system_inferred`，并携带证据、版本、before/after、逆操作和回滚。只有用户直接陈述、纠正或裁决才能获得 `user_*` 权威。提案确认与共创仍是可选授权模式，不是当前自动模式的必经步骤。

---

## 2. 本体（Ontology）

### 2.1 节点类型

| 节点 | 说明 | 关键字段（通用字段外） |
|---|---|---|
| `evidence` | 原始证据元数据（内容或指针） | source（quick_note / chat / checkin / schedule / feed_feedback / recording* / computer_history*）、captured_at、privacy_level、content/media_ref、hash |
| `observation` | 模型从证据提取的候选信息 | kind（pattern / say_do_gap / recurring_theme / possible_belief / outcome_signal / **commitment**——承诺三元组：对谁 / 承诺什么 / 期限，必须带原文证据引用）、confidence、extractor_version、status（proposed / touched / shaping / concluded / parked / expired） |
| `claim` | 可追溯的认知节点；权威字段明确区分用户陈述与模型推断 | kind（belief / assumption / frame / value / preference / boundary / fact）、statement、warrant、qualifier、confidence、specificity、domain、sensitivity、status、origin、authority |
| `tension` | 张力：并存且相互矛盾的认知/证据的聚合点 | around（主题）、strength、status（open / eased / resolved） |
| `decision` | 显式决策记录 | question、options、selected、rationale |
| `experiment` | 行为实验 | hypothesis、trigger、action、success_signal、stop_condition、duration、status |
| `action` | 进入日程的验证动作/规划条目 | schedule_ref、reversibility、time_cost、status |
| `outcome` | 行动/实验/建议的真实结果 | result（confirmed / limited / refuted / abandoned）、user_rating、note |
| `topic` | 主题/领域锚点（资讯挂靠、敏感度分级的载体） | name、sensitivity（low / medium / high）、user_adjusted |

通用字段（所有节点）：`id`、`created_at`、`updated_at`、`legacy_ref`（迁移来源）、`deleted_at`（软删，仅用户删除动作产生）。

### 2.2 边类型

| 边 | 语义 | 典型连接 |
|---|---|---|
| `supports` | 支持（带 `strength`，见下） | evidence/observation → claim |
| `contradicts` | 反证（带 `strength`，见下） | evidence/observation → claim |
| `about` | 挂靠主题/领域 | claim / observation / feed_item → topic |
| `tension_of` | 参与构成张力 | claim / evidence → tension |
| `influences` | 认知影响选择 | claim → decision |
| `implemented_as` | 决策/规划落为行动 | decision / experiment → action |
| `resulted_in` | 行动产生结果 | action / experiment → outcome |
| `updates` | 结果/纠正修订认知，**子类型**：`confirms`（增强）/ `contracts`（收窄边界）/ `revises`（推翻替换） | outcome / correction → claim |
| `supersedes` | 新认知替代旧认知 | claim → claim |
| `derived_from` | 提取血缘 | observation → evidence；claim → observation |

**边权重（strength）**：`supports` / `contradicts` 边携带离散档权重——`strong / medium / weak`。一条用户反复亲口确认的证据和一次速记里顺嘴提到的不等值。初值由代码按证据质量评定（来源直接性 × 时效 × 用户确认强度），用户裁决时可改。**只用离散档不用连续小数**（防伪精确）；权重只参与排序与阈值计算，外化仍然是「证据 N 条 / 反证 M 条」的密度信号。

血缘链路（四象限的灵魂）在图上就是一条可遍历路径：

```text
feed_item --about--> topic <--about-- claim --influences--> decision
--implemented_as--> action --resulted_in--> outcome --updates--> claim
```

「为什么这样排」「这条日程从哪来」都是这条路径的展示，不需要单独生成解释。

---

## 3. 认知节点的内部结构（Toulmin 映射）

一条 claim 的完整形态：

| Toulmin 要素 | 图谱实现 | 必填？ |
|---|---|---|
| Claim（判断） | `statement`（用户视角的自然语言，尽量保留原话） | 必填 |
| Grounds（证据） | `supports` 边指向的 evidence/observation | active 状态必须 ≥1 |
| Warrant（推理链） | `warrant` 字段：为什么这些证据支持这个判断 | 可缺；缺则展开态显示「还没聊出为什么」 |
| Qualifier（适用边界） | `qualifier` 字段：什么情境下成立/不成立 | 可缺；contraction 操作写入这里 |
| Rebuttal（反证） | `contradicts` 边指向的 evidence/observation | 可缺；有则构成 tension 候选 |

附加字段：

- `confidence`（0-1）：由证据数量、质量、时效与用户确认强度合成（§6），不由模型口头报数。
- `specificity`：特异性标记——「换任何人任何一天都成立」的句子标 generic，**generic 的 claim 不参与候选挖掘与桌面出场**（Grice 约束的图谱层落地）。
- `domain` + `sensitivity`：经 `about` 边挂靠 topic，继承其敏感度（§9）。

**字段允许缺失但不硬填**：缺 warrant 的认知照样存，展开态如实显示；模型不得为了字段完整而编造推理链。

---

## 4. 时间模型：双时态

每条 claim 与关键边有两条时间线：

- **有效时间**（valid_from / valid_to）：这条认知在用户生活里从何时成立到何时失效；
- **记录时间**（recorded_at / superseded_at）：系统何时知道、何时被替代。

双时态回答两类问题：「我现在相信什么」（valid + active）与「**当时**为什么那样判断」（按 recorded_at 回放）。后者是 30 天叙事和「第一次被懂」（引用几周前的速记）的数据基础。

---

## 5. 修订语义（AGM 映射）

| 操作 | 触发 | 图谱变化 | 状态 |
|---|---|---|---|
| **Expansion**（新增） | 裁决通过的新候选 | 新 claim + supports 边 | active |
| **Confirmation**（增强） | outcome=confirmed 或用户重申 | `updates:confirms` 边；confidence 上调；last_confirmed_at 刷新 | active |
| **Contraction**（收窄） | outcome=limited 或用户说「只在……时成立」 | `updates:contracts` 边；qualifier 写入/收紧；valid 范围不变 | active（scoped） |
| **Revision**（推翻替换） | outcome=refuted 或用户纠正「其实是……」 | 新 claim + `supersedes` 旧 claim；旧 claim 关 valid_to | 旧 superseded，新 active |
| **Dispute**（争议中） | 反证累积但用户未裁决 | contradicts 边 + tension 节点 | disputed（仍可见，标注争议） |
| **Expire**（过期） | valid_to 到期或长期未确认且时效衰减到阈值 | 状态流转 | expired（不进上下文，可复活） |

**硬规则**：每条 updates / supersedes 边必须挂原因节点（outcome、用户纠正或新 evidence）——「系统自己想通了」不是合法的修订理由。模型可自动应用有证据的修订，但权威仍是 `system_inferred`；用户纠正永远即时生效、全端同步。

---

## 6. 置信与新鲜度

```text
confidence = f(证据数与质量, 用户确认强度, 反证存在性, 时效)
```

- **权威与确认强度分开计算**：用户主动陈述 > 用户裁决 > 用户一键确认；模型自动写入单列为 `system_inferred`，无论置信度多高都不冒充用户确认。observation 不进入用户确认强度。
- **新鲜度**：`last_confirmed_at` + 按 kind 差异化的衰减曲线（value/boundary 衰减慢，preference/假设衰减快）。衰减到阈值不删除，转入「待重新确认」——复盘的候选来源之一（「你半年前说过 X，现在还这样想吗？」）。
- **养成参数的供数**：熟悉 = active claim 的领域覆盖度 × 平均新鲜度；默契 = 候选命中率 + 建议被采纳后 outcome 的正确率（校准度）。两者都是图谱查询，不是独立计数器。
- **冲突检测**：同一 claim 同时有 supports 与 contradicts 边、或两条 active claim 语义互斥 → 自动创建/更新 tension 节点。**tension 是资讯象限的挂靠点**（异质视角优先投向 open tension）和候选挖掘的高优先来源。
- **结构重要性（派生指标）**：由 `influences` 出边数与血缘下游规模计算——一条 claim 牵动多少决策与行动，它就是多大的**枢纽**。派生不入真相层，夜间重算（§8.4）。两个消费点：① 候选挖掘优先级——挑战枢纽信念价值最大；② **大胆度公式的调节项**——结构重要性越高，证据充分度门槛越高（牵动一片的信念错不起，挑战它之前证据要更扎实）。

---

## 7. 写入管线与权限

| 写入者 | 能写什么 | 机制 |
|---|---|---|
| 感知器官（代码） | evidence | 幂等（source + hash 去重）、只增 |
| 提取器（模型，版本化） | observation + derived_from 边 | 事件触发或受限批处理；带 extractor_version 供回放 |
| 用户裁决（共创流） | observation → claim 升格；warrant/qualifier 补全；修订操作 | 共创流状态机（harness 实验设计附录 B） |
| 提案确认 | 低风险 fact/preference 的一键升格；形态变更 | Proposal / Change Set，可回滚 |
| 用户直接编辑 | 任何自己的 claim 的陈述与边界 | 直接生效，记 correction evidence |
| 模型（standing grant） | 可创建、版本化修订或撤回 observation / claim / tension / action 等领域对象 | 只能经统一 Domain Change Set 写入，固定 `origin=model / authority=system_inferred`，保留证据、before/after、逆操作与回滚；不得伪造 `user_*` 权威或绕过领域不变量 |

所有跨层与修订操作产生 Change Set（before/after），支持回滚——图谱变更与形态变更共用同一套机制。

---

## 8. 读侧：检索与上下文编译

### 8.1 Context Compiler（场景化子图）

每个消费场景按需编译子图，而不是把「全部记忆」塞进上下文：

| 消费者 | 取什么 |
|---|---|
| 对话（秘书核心） | 当前话题 about 的 active claim（含 qualifier）+ 近期 evidence + 开放 tension |
| 候选挖掘 | 模式查询结果（§8.2）+ 相关历史裁决（避免重提被拒候选） |
| 资讯策展 | open tension + 活跃 topic + 用户反馈史 |
| 执行代拟（指令起草） | preference/boundary 子图 + 相关项目 fact |
| 周回顾 / 养成时间线 | 按 recorded_at 的变更流投影 |

**成对取证纪律**：任何场景取某条 claim 时，supports 与 contradicts 边**必须一起取**——反茧房在检索层的落地；只喂支持证据的上下文编译是违规实现。

**敏感度过滤**：high sensitivity 的 claim 不进入主动候选与资讯策展的上下文（大胆度四因子的硬闸在读侧执行）；对话中用户主动提起时才可引用。

### 8.2 候选挖掘 = 图上的模式查询

挖掘不是让模型自由联想，而是**先跑确定性模式查询圈定素材，再让模型在素材内提问**。初版模式清单：

| 模式 | 查询形态 |
|---|---|
| 言行差 | 「说要做 X」的 evidence 与日程/行动完成记录的差集 |
| 重复主题 | 近 N 天 evidence 的 topic 聚类，频次 ≥3 且无对应 claim |
| 承诺漂移 | 同一 action 被多次顺延 |
| 张力激活 | open tension 新增证据 |
| 待重确认 | 新鲜度衰减到阈值的 claim |
| 实验到期 | experiment 到期未回收 |
| **未承接的承诺** | evidence 中检测到 commitment（任何证据源：速记、对话、微信消息、computer history*、录音转写*），且日程中无对应条目 → 走**提案档**外显（「你答应了 X，要放进日程吗？」一键确认，带原文血缘），**绝不直接写日程**（物理规则 2）。定位为兜底网而非保证书，不承诺全覆盖 |

模式查询保证候选**必然挂着真实证据**（出场资格代码化的实现基础）；模型的职责是把素材变成一个好问题。

### 8.3 结构分析投影（网络分析层）

在结构化边之上跑网络分析，全部作为**派生投影**：夜间批算、不入真相层、可随时丢弃重算（个人规模图用 SQLite + 内存计算即可，无需图数据库）：

| 分析 | 计算 | 消费者 |
|---|---|---|
| 中心性（枢纽度） | degree + 血缘下游规模（轻量版；后续可换 PageRank） | 候选优先级、大胆度调节、熟悉参数的「枢纽覆盖率」 |
| 社区发现 | Louvain/Leiden 聚类 | topic 自动校准（社区≈生活领域分区）、图谱可视化的宏观分组 |
| 张力热点 | contradicts 边密集子图 | 资讯策展定向、复盘候选高优区 |
| 结构演化 | 按 recorded_at 的快照对比：新社区出现、枢纽转移、张力消解 | 养成时间线叙事（「结构变了」比「数量涨了」更能说明成长）、周/月回顾 |

### 8.4 可视化供数契约（想法地图）

图谱的前端展示（产品边界见前端体验 PRD §6.4）由三个只读投影 API 供数：

1. **宏观图**：社区分组 + 节点（大小=枢纽度、色=领域、张力热点标记）+ 主干边。过滤规则在供数层执行：generic 节点不输出；high sensitivity 领域输出为「折叠簇」（只给数量与领域名，展开需用户确认）；observation 层永不输出。
2. **ego 子图**：单条 claim 的一跳邻域——证据（带 strength）、反证、影响的决策/行动、修订历史链。
3. **时间切片**：按 recorded_at 重建任意日期的宏观图，供演化回放。

节点标签一律用用户原话（statement），不输出内部术语——外化语言原则在供数层落实。

### 8.5 索引

- SQLite 为唯一真相源；边表 + 递归 CTE 做图遍历（个人规模图 <10⁵ 节点，无需图数据库）；
- FTS5 全文索引（evidence、claim.statement）；
- 向量索引（本地嵌入）用于主题聚类与相似检索——**只做召回，权威判断走结构化边**；
- 投影表（桌面内容、周回顾）由领域事件重建，可随时丢弃重算。

---

## 9. 领域敏感度分级（初版，进 P0 词汇冻结）

| 级 | 领域（topic 预置） | 图谱行为 |
|---|---|---|
| low | 工作、学习、效率、兴趣、项目 | 正常参与挖掘、策展、候选 |
| medium | 财务、职业选择、家庭日程、社交 | 参与挖掘；候选措辞保守档；资讯策展需用户开启该主题 |
| high | 亲密关系、健康、心理状态、信仰 | **不进入主动候选与策展**；用户主动提起才可引用；相关 evidence 默认 privacy 最高级 |

用户可调任何 topic 的级别（调级本身记 preference claim）。新 topic 由提取器建议分级、用户确认。

---

## 10. 隐私与生命周期

- **privacy_level** 仍随 evidence 源记录：quick_note/chat 标准级；recording / computer_history 最高级。但它只描述数据性质，不作为交互式 Agent 的读取隔离；用户拥有的本地 Agent 默认可检索全部原始证据。若当前配置的是云模型，命中的原始片段会进入该供应商的模型请求。
- **导出**：全量 JSON（机器可读）+ markdown 卡片集（人可读）；两层导出包（指标层/内容层）是它的子集视图。
- **删除语义**：
  - 删单条 evidence → 其 supports 的 claim 若失去全部证据，降级为 `unsupported` 待用户处置（保留或一并删）；
  - 删单条 claim → 软删 + 血缘下游（action 等）保留但标注「依据已删除」；
  - 「删除我全部数据」→ 全库物理删除 + 导出包提示，不可恢复，2 分钟内完成。
- **不可篡改边界**：软删是用户权利；系统与模型无删除权，只有状态流转权。

---

## 11. 存储实现与演进

### 11.1 实验期六表 → 全量本体的映射

| 实验期表 | 对应本体 | 迁移动作 |
|---|---|---|
| evidence | evidence | 平移（source 枚举对齐） |
| candidates | observation | 平移（状态机字段已同构） |
| cards | claim + experiment 的混合简化（Toulmin 字段为 JSON 列） | 拆列建边：JSON 内证据引用转 supports/contradicts 边 |
| actions | action | 平移 + implemented_as 边补建 |
| outcomes | outcome | 平移 + updates 边补建（结果三分类映射 confirms/contracts/revises） |
| feed_items | feed_item + about 边 | 平移 |

实验期就要求：cards 的 JSON 里**证据以 evidence id 引用而非文本粘贴**——这是迁移可行的唯一前提，S2 验收项。

### 11.2 memory_facts 兼容

迁移策略：told 事实 → 高置信 claim（fact/preference）；inferred → observation（重新走裁决）；保留 legacy_ref；旧 API 经兼容视图过渡。

### 11.3 Schema 治理（开源语境）

- migration 顺序化 + schema_version；任何 schema 变更走迁移，不走运行时 ALTER；
- 本体的节点/边类型枚举是**公共契约**（插件与开源贡献者依赖它）：新增 kind 用 minor 迁移，改语义必须 major + 迁移脚本 + changelog；
- 模型无权触碰 schema（物理规则）；提示词修改走生长语法，与 schema 治理互不越界。

---

## 12. 不变量与测试

图谱层的不变量（任何时刻违反即 bug，做成断言测试与夜间一致性检查）：

1. active claim 至少有一条 supports 边（fact 类允许「用户直述」型 evidence）；
2. observation 不出现在任何 Claim 层消费场景的上下文里（除非明确标注「未经确认」）；
3. 每条 updates / supersedes 边挂有原因节点；
4. superseded / expired claim 不进入 Context Compiler 的「当前信念」集合；
5. high sensitivity claim 不出现在主动候选与策展的编译结果中；
6. 任何桌面内容可沿血缘边回溯到 evidence；
7. 删除后的 evidence 不再被任何导出包含；
8. generic（无特异性）claim 不进入出场资格池。

Scenario 测试沿用七条固定用户故事（清单见工程实施计划 §5）+ 北极星场景（一次候选 → 裁决 → 行动 → 结果 → contraction 的全链路回放，Fake Engine 下可重放）。

---

## 13. 风险

**1. 本体过度设计。** 实现｜触发：P1 就建满 9 类节点 10 类边，多数长期空表｜影响：迁移与维护负担，开发拖慢｜缓解：实验期只用六表；全量本体按消费者驱动逐类点亮（内容契约夹逼——没有消费者的类型不建）。

**2. 提取器污染观察层。** 产品｜触发：提取器高产低质，observation 层堆满噪音｜影响：候选挖掘素材被稀释，H1 命中率下降｜缓解：模式查询先圈素材（§8.2）；observation 带 TTL 自动过期；extractor_version 支持整批回滚。

**3. 置信度公式假精确。** 产品｜触发：confidence 数值被 UI 或模型当作真实概率使用｜影响：伪精确误导判断｜缓解：confidence 只用于排序与阈值，外化永远用「证据 N 条 / 反证 M 条」的密度信号，不показ数值。

**4. 删除级联复杂度。** 实现｜触发：删证据引发的连锁状态改变有边界情况｜影响：删不干净（隐私事故）或误删（数据损失）｜缓解：删除语义（§10）做成独立测试套件；「全删」走整库销毁而非逐条级联。

**5. 向量索引与结构化边打架。** 实现｜触发：相似检索结果被当作权威关系写入｜影响：图谱被联想污染｜缓解：向量只做召回的纪律写进代码评审清单；召回结果必须经模式查询或用户裁决才能成边。
