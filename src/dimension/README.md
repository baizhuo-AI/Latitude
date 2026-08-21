# src/dimension — 新桌面原型（未挂载）

> **状态：prototype / not wired**。本目录是[桌面前端 PRD](../../docs/specs/2026-08-19-dimension-desktop-frontend-prd.md) 的可交互原型，**尚未接入主应用**。

## 现状

- `main.tsx` 渲染的仍是旧的 `<App />`（`BoardShell` 导航）；`DimensionApp` 只被 `DimensionApp.stories.tsx` 引用。
- 数据来自 `sample.ts` 的写死样例：不读 SQLite、不调 LLM、不写库。
- 除「打开 / 合上」外的动作只给原型提示——真正落库要等 Proposal / ChangeSet 变更控制到位，现在直接写会绕开确认闸门。

**「设计冻结」是真的，「种子产品已实现」还不是。** 挂载与接线属于批次 0（见[工程实施计划](../../docs/plans/2026-08-20-dimension-implementation-plan.md) §3）。

## 已对齐的规范

| 项 | 口径 | 出处 |
|---|---|---|
| 养成参数 | 三条：熟悉 / 默契 / 权能（「关系」不做数值） | 总纲 §5.5 |
| 秘书称谓 | 不预设专名，UI 不出现人名 | 总纲 §1.3 |
| 状态徽章 | 在岗 / 在想 / 有事说 | 总纲 §4.6 |
| 阶段外显 | 显示阶段名（「默契 · 合拍」），裸数值仅内部 | 总纲 §5.5 |

## 待接线（批次 0）

`types.ts` 目前是卡片类型的扁平定义，需升级为**布局文档三层 schema**（背景 / 卡 / 排布规则），见总纲 §5.2。
