# src/design-system — 旧资产（Daybreak 时期设计系统）

> **状态：legacy asset**。这套设计系统服务的是旧产品（早安 / 待办 / 日历），**不是 Latitude 新桌面的规范**。

## 与新规范的关系

| 维度 | 本目录（旧） | 新桌面（实现口径见 [`src/dimension/README.md`](../dimension/README.md)） |
|---|---|---|
| 主题 | `ThemeMode = "light" \| "dark"`，亮暗双主题 | **实验期无深色模式**——纸张语言依赖暖白底，反色会毁掉它；深色版单独立项 |
| 色板 | 中性 + 语义 + 项目色 | 纸张色板（`src/dimension/dimension.css` 的 `--dim-*`） |
| 阴影 | 有 | **无阴影**，层次靠边框与底色差 |
| 圆角 | 常规 | 2px（近直角） |

**两套不并列**：新桌面一律用 `src/dimension/dimension.css`；本目录只服务尚未迁移的旧页面（Todos / Calendar / Briefing 等），随批次 P2 逐步退役。

## 已知失败测试

`tests/tokens.test.ts` 有 1 个断言失败——它校验 `tokens.ts` 的色值镜像进 `tokens.css`，而 css 已按新纸张语言改过。修复属于 P0 基线门禁（见[工程实施计划](../../docs/plans/2026-08-20-dimension-implementation-plan.md) §5）：要么恢复镜像，要么把该断言随旧设计系统一起退役。
