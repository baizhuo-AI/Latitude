# 维度工程实施计划

- 日期：2026-08-20
- 版本：v1.1（v1.1 一致性收口：测试基线表述修正 + 新增 §7 追踪表）
- 状态：生效。**取代** `2026-08-15-dimension-second-mind-refactor-plan.md`（已删除，git 历史可查）
- 定位：工程侧唯一计划文档。产品定义与架构见[总纲 PRD](../specs/2026-08-20-dimension-master-prd.md)，图谱见[知识库设计](../specs/2026-08-20-dimension-cognitive-graph-design.md)，实验操作见[harness 实验设计](../specs/2026-08-19-dimension-harness-experiment-design.md)。本文档回答三件事：**现有代码怎么复用、新系统怎么分批建、沙箱安全边界的工程规格**

> **叙事声明：这不是重构。** 维度（Latitude）是一个新产品；仓库里的现有代码不是「待改造的旧产品」，而是**资产库**——壳、引擎适配、调度、管道都是可直接复用的组件。工程计划从「建什么、复用什么」出发，不从「改什么」出发。

---

## 1. 可复用资产盘点

从旧版本（Daybreak 时期）继承的组件及其在维度中的新位置：

| 资产 | 现有能力 | 在维度中的位置 |
|---|---|---|
| Tauri 2 + React 多窗口壳 | 主窗、对话悬浮条、启动器 | 桌面应用外壳；todo 悬浮窗砍掉（内容入日程象限） |
| SQLite 本地库 | 各业务表、本地真相源 | 唯一真相源；新增 migration 体系与图谱表 |
| Engine Adapter（API / Claude Code / Codex / Fake） | 可替换推理层 | 保留；Fake Engine 供场景回放测试；Claude Code / Codex 适配器未来兼任**执行插件**的手 |
| AI 秘书主动引擎（触发 / 负荷 / 闸门 / 冷却 / 预算 / 投递 / 反馈） | 主动触达治理 | 复用为 check-in、候选、提案的**投递运行时**；上游改接图谱与共创流 |
| 飞书管道（入站 → 秘书核心 → 回发） | IM 通道 | **channel adapter 的第一个实现**；备用通道插件 |
| Memory Facts | told / inferred 记忆 | 经兼容策略迁入图谱（图谱设计 §11.2） |
| Daily Digest / Reflection | 日结摘要与阶段反思 | 素材与逻辑并入周回顾 / 叙事投影 |
| Calendar / MCP | 外部上下文与执行通道 | 日程象限数据源；MCP 动作统一受权能治理 |
| AI Listener 角色与状态机（Idle / Thinking / Presenting…） | 硬件端角色语义 | 秘书在场状态徽章语义；录音感知插件（P6） |
| 测试基线 | **55 / 57 套件通过**（2026-08-20 实测）——`tokens.test.ts` 1 个断言失败（旧色值镜像）；`ChatBar.test.tsx` **整个套件加载失败、0 测试执行**（`react-i18next` mock 缺 `initReactI18next` 导出）。注意：常被引用的「736 / 737」是失真表述——分母不含 ChatBar 套件的任何测试，它一个都没跑 | P0 修至**全部 57 套件绿**后冻结为门禁 |

## 2. 现有代码处置清单

| 现有模块 / 文件 | 处置 | 说明 |
|---|---|---|
| `src/pages/BriefingPage.tsx` | 替换 | 被四象限桌面（布局文档 + 渲染器）替换；任务与空档计算降级为日程象限的数据 adapter |
| `src/pages/AboutYouPage.tsx` | 替换 | 被养成时间线与想法地图（P4 / P5）替换 |
| `src/pages/TelosPage.tsx` | 降级 | 目标数据成为规划象限数据源；页面收入工具下钻 |
| `src/pages/ChatHistoryPage.tsx` | 降级 | 会话归档工具，从下钻进入 |
| `src/pages/ActivitiesPage.tsx` | 降级 | evidence 采集入口之一 |
| `src/lib/persona/personaSpec.ts` | 复用改造 | 承载「语言人格」的默认中性版；人格可生长（总纲 §4.6） |
| `src/lib/memorySection.ts` | 替换 | 被 Context Compiler（图谱设计 §8.1）替换 |
| `src/lib/secretary/*` | 复用 | 投递运行时；scheduler / gate / load / deliver 全保留 |
| `src/lib/db.ts` | 拆分 | 按领域拆 `src/lib/db/migrations/` + `repositories/`，停止单文件膨胀 |
| `src/components/BoardShell.tsx` / `Sidebar.tsx` | 替换 | 被布局文档渲染器与「桌面唯一入口」导航模型替换 |
| 飞书 bridge | 复用改造 | 抽出 channel adapter 接口，微信 iLink 为第二实现 |
| `src/dimension/`（dimension.css、types.ts） | 复用 | 视觉 token 与原生卡 payload 直接用；布局三层 schema 独立放入 `src/runtime/layout/`，避免业务内容与排布耦合 |

**目录边界**（新代码只进新边界，旧调用逐个替换，不为整洁而搬家）：

```text
src/domain/graph/          # evidence / observation / claim / 边 / 修订操作
src/domain/proposals/      # Proposal / Change Set（认知与形态共用）
src/runtime/layout/        # 布局文档 + 渲染器（背景 / 卡 / 排布）
src/runtime/channels/      # channel adapter（微信 / 飞书 / 应用内）
src/runtime/delivery/      # 投递运行时（原 secretary）
src/plugins/               # 感知 / 通道 / 执行插件契约与实现
src/projections/           # desktop / review / timeline / mindmap 投影
src/lib/db/migrations/  src/lib/db/repositories/
```

## 3. 批次计划

编号沿用 P 体系（各文档已广泛引用）。工期按 1 名全职开发者 + AI 协作的有效开发周估算。

| 批次 | 内容 | 工期 | 入口门禁 |
|---|---|---|---|
| **批次 0：种子实验**（当前） | 布局 schema + 最小渲染器、微信 iLink spike、六表、共创流、导出；详见 harness 实验设计 §7 | 3.5-4 周搭建 + 1 周 dogfood + 3-4 周运行 | 开源卫生审计通过 |
| **P0：契约冻结** | 词汇表冻结（含领域敏感度分级、warrant / contraction、内容契约）、migration runner、测试基线修至全绿 | 1 周 | **实验结账完成**（H 表逐条判定） |
| **P1：图谱全量** | 图谱设计 v1.2 全量本体、六表迁移、memory_facts 迁移、Context Compiler、模式查询清单、结构分析投影 | 2 周 | P0 契约评审通过 |
| **P2：桌面正式版** | 布局文档三层完整实现、四象限全规格（前端 PRD）、展开态、下钻、第 0 天 / 留白 / 授权三态 | 2-3 周 | P1 图谱可用 |
| **P3：叙事投影** | 周回顾、养成时间线、结构演化叙事（双环区分） | 2 周 | — |
| **P4：养成与权能** | 三参数计算与外显、熟悉阶段、Authority Grant、行动账本、执行插件全四档 | 2 周 | 权能自动化过**单独安全评审** |
| **P5：模块运行时** | declarative 渲染积木、HTML 沙箱点亮（§4）、想法地图界面、配置引擎（形态提案自动落地） | 3 周 | 布局协议在 P2 稳定 |
| **P6：感知插件** | 录音（AI Listener 版本化协议）、computer history（先出采集边界设计文档再开发） | 2 周 | 插件契约定稿 |

**决策门**：实验不结账不进 P0；P2 完成做一次真实 dogfood 复核闭环；P4 任何自动执行必须单独安全评审；P6 与硬件节奏解耦（先用录音文件做协议验收）。

## 4. 沙箱安全边界（工程规格）

三档渲染积木（native / declarative / HTML）共享 **ModuleManifest**：

```text
id · type · version · title · renderer · dataBindings · permissions
config · state · createdReason · status · lastUsefulAt · expiresAt
exitCriteria · rollbackVersion
```

**自定义 HTML 积木的硬边界**：

- 运行在 sandboxed iframe；**不得**直接访问 SQLite、文件系统或任意网络；
- 只能通过受控 **Capability API**：读取声明过的数据绑定、发起低风险 UI 事件、生成 Proposal；
- 默认 CSP 禁止外部脚本；积木包需签名 / 哈希、版本记录、资源上限、超时与一键停用；
- 第三方积木包经插件机制分发时复用同一套边界，另加来源标识与安装确认。

**积木实例生命周期**：`proposed → preview → active → updated → fading → archived`（分支：`merged` / `rolled_back`）。出现必须给理由；变化走生长语法（单次一个主要变更、可回滚）；长期无用自动 fading、用户可钉住。

## 5. 测试与质量

- **基线门禁**：当前 55 / 57 套件通过 → P0 必须修到 **57 / 57 套件全绿**（含 ChatBar 套件恢复可加载），此后「全量套件绿」是每批次的合入门禁。
  **门禁以套件数为准，不以测试数为准**：套件加载失败时其测试不计入分母，用测试通过率会漏掉「整个套件没跑」的情况。
- **测试分层**：
  - 领域纯函数：图谱 8 条不变量（图谱设计 §12）、修订操作、双时态、大胆度因子、权限矩阵；
  - Migration：空库 / 实验期六表 / 含脏数据与冲突 ID 的 memory_facts 快照；
  - Contract：TypeScript ↔ Rust ↔ MCP ↔ 通道插件协议 ↔ Engine Adapter 的输入输出一致性；
  - Scenario：**七条固定用户故事**——学习迷茫、事业过载、家庭工作冲突、信息茧房、用户纠错、拒绝建议、撤销授权——加北极星链路（候选 → 裁决 → 行动 → 结果 → 修订），全部可在 Fake Engine 下重放；
  - UI：骨架恒定、成对取证展开、提案 diff、回滚、下钻返回原位。
- **观测**：记录模型版本、extractor_version、候选与拒绝原因、用户纠正、结果；默认不记录不必要的原始隐私内容。

## 6. 工程风险

**双真相源。** 触发：迁移期间新旧系统并行，同一业务被两套 scheduler 驱动或两处写入｜影响：数据分叉，信任崩塌｜控制：写入必须经图谱事务 + legacy_ref；迁移期禁止同一业务双 scheduler；投影只读领域层。

**把智能写在 prompt 里。** 触发：赶工把权限、状态机、回滚、幂等、出场资格交给提示词｜影响：不可测、不可审计、随模型漂移｜控制：确定性规则一律代码化，模型只做提取、提问与起草；代码评审设专项检查。

**迁移丢数据。** 触发：memory_facts / 六表迁移的边界情况｜影响：用户积累损失｜控制：三类库快照的 migration 测试；迁移前自动备份；legacy_ref 保留回溯。

**批次范围蔓延。** 触发：「全量愿景」被理解为「每批都多做一点」｜影响：P1-P2 拖长，闭环验证延后｜控制：批次内容以本文档为准，增项走变更记录；决策门不可跳过。

---

## 7. 追踪表：总纲条款 → 批次 → 代码落点

一张表管收口。**状态列只有三种**：`已实现`（在跑）/ `原型`（写了但没接线）/ `未开工`。任何人想知道「这条产品决定落到哪了」，查这里。

| 总纲条款 | 决定了什么 | 批次 | 代码落点 | 状态 |
|---|---|---|---|---|
| §3.1.1 物理规则五条 | 证据可溯、写入需确认、变更可回滚、拒绝是数据、可导出删除 | 贯穿 | `src/domain/graph/`、`src/domain/proposals/` | 未开工 |
| §3.1 生长语法 | AI 提案 → 用户裁决 → 配置变更留痕 | 批次 0（人肉 YAML）→ P5（引擎） | 每用户配置文件 → `src/runtime/layout/` | 未开工 |
| §3.2 感知段 | 速记 / 对话 / check-in 内建；录音与 computer history 为插件 | 批次 0（速记）→ P6（插件） | `src/plugins/sense/` | 未开工（速记逻辑可复用现有 Todo 入口） |
| §3.2 执行段（手的梯子） | 权能四档：只建议 → 代拟 → 确认后调度 → 白名单自动 | 批次 0（前两档走对话）→ P4（后两档） | `src/plugins/act/`、复用 `src-tauri/src/cli_agent/` | 未开工 |
| §3.3 写模型 | 三层知识模型（Evidence / Observation / Claim）、AGM 修订、双时态 | 批次 0（六表）→ P1（全量本体） | `src/domain/graph/`、`src/lib/db/migrations/` | 未开工 |
| §3.3 读模型 | 投影只读领域层，禁止投影间互读 | P1 → P3 | `src/projections/` | 未开工 |
| §3.4 插件器官 | 感知=眼耳、通道=嘴、执行=手；共用授权与账本 | P4（授权体系）| `src/plugins/` | 未开工 |
| §4.1 四象限 | 资讯 / 日程 / 复盘 / 规划 + 血缘链路 | 批次 0（种子布局）→ P2（全规格） | `src/runtime/layout/` + `src/projections/desktop/` | **原型**（默认关闭的主窗功能开关已挂载；当前为 seed projection） |
| §4.1 反茧房硬约束 | 日上限 ≤3、必须挂靠张力、异质加权 | 批次 0 | `src/dimension/cards/FeedCard.tsx` + 资讯策展模块（待建） | 部分已实现（渲染硬上限与反馈三键已落地；策展算法未开工） |
| §4.2 三档生产方式 | 自动 / 提案 / 共创 | 批次 0 | 复用 `src/lib/secretary/`（投递运行时） | 部分已实现（投递闸门在跑） |
| §4.3 出场资格与留白 | 特异性判定；留白是正式内容 | 批次 0 | 出场资格代码化（待建） | 未开工 |
| §4.4 认知沉淀低调 | 对话轻确认 + 小角落提示，不立大卡 | P2 | `src/dimension/cards/` | 原型（卡片壳已有） |
| §4.5 大胆度四因子 | 证据 × 领域敏感度 × 用户偏好 × 当次许可 | P0（分级表）→ P1 | 候选挖掘模块 | 未开工 |
| §4.6 外化语言 | 理论术语止于代码；语言人格可生长 | 贯穿 | `src/lib/persona/personaSpec.ts`、i18n | 部分已实现 |
| §5.1 载体触点 | 桌面为核心；微信主窗口、飞书备用 | 批次 0（步 1b spike） | `src/runtime/channels/`、复用 `src-tauri/src/feishu/` | 飞书已实现，微信未开工 |
| §5.2 布局即数据 | 背景 / 卡 / 排布三层，排布存规则不存坐标 | 批次 0（最小渲染器）→ P5（HTML 积木） | `src/runtime/layout/` + `src/dimension/nativeRegistry.tsx` | **已实现（最小版）**：native 点亮；declarative / HTML 仅协议与安全降级 |
| §5.3 共创流 | 候选异步状态机，跨触点续接；深聊为加速器 | 批次 0 | 回合状态机（待建） | 未开工 |
| §5.4 节奏 | check-in 事件触发 + 每周兜底；日循环 ≤10 分钟 | 批次 0 | 复用 `src/lib/secretary/scheduler.ts` | 部分已实现（调度器在跑，触发条件需改） |
| §5.5 养成系统 | 三参数（熟悉/默契/权能）；关系不做数值；阶段名外显 | 批次 0（不外显）→ P4（完整） | `src/dimension/types.ts`（schema 已对齐三条） | **schema 已对齐**，计算未开工 |
| §6.2 隐私与开源 | 纯本地、无遥测、可导出可删除；开源卫生 | 批次 0 步 0 | `.gitignore`（已挡 pipeline）、导出模块（待建） | 部分已实现 |

**读表纪律**：状态列由**实际代码**决定，不由文档意图决定。任何人发现表与代码不符，以代码为准并回改此表。
