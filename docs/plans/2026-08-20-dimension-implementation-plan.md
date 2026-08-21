# 维度工程实施计划

- 日期：2026-08-20
- 版本：v1
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
| 测试基线 | 736 / 737 通过（2026-08-15，两项已知失败与新工作无关） | P0 修至全绿后冻结为门禁 |

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
| `src/dimension/`（dimension.css、types.ts） | 复用 | 视觉 token 直接用；types 升级为布局文档三层 schema |

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

- **基线门禁**：736 / 737 → P0 修至全绿后，「全量测试绿」是每批次的合入门禁。
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
