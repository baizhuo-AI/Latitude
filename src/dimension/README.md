# src/dimension — 新桌面种子运行时

> **状态：feature-gated seed runtime**。本目录承载[桌面前端 PRD](../../docs/specs/2026-08-19-dimension-desktop-frontend-prd.md) 的视觉组件；布局解释器位于 `src/runtime/layout/`，桌面投影位于 `src/projections/desktop/`。

## 现状

- `App → MainWindow` 已接入默认关闭的 `VITE_DIMENSION_DESKTOP` 开关；关闭仍渲染原 `BoardShell`，开启后渲染全屏 `DimensionApp`，主窗口现有 scheduler / sync / Feishu bridge 不移动也不重复启动。
- 本地可用 `?dimension=1` 临时打开、`?dimension=0` 强制回退。Dimension 桌面使用懒加载，开关关闭时不下载秘书立绘和新桌面代码。
- 生产入口使用 `SEED_LAYOUT_DOCUMENT + SEED_DESKTOP_PROJECTION`。样例只在应用头标注「演示模式」：不读 SQLite、不调 LLM、不写库，不冒充真实状态。
- 资讯反馈、血缘、提案和对话条动作都会给出原型提示。真正写入要等 Proposal / Change Set 与数据 adapter 到位，不能绕开确认闸门。

## 已落地的运行时边界

- `src/runtime/layout/types.ts`：背景 / 卡 / 排布三层 `LayoutDocumentV1`；排布只存策略与参数，不存坐标。
- `src/runtime/layout/validate.ts`：重复 id、悬空 binding、非法 span、错误五区顺序和坐标字段的运行时校验。
- `src/runtime/layout/LayoutRenderer.tsx`：显式 native 注册表；`declarative / html` 只保留协议，当前显示可见安全降级，绝不执行。
- `src/runtime/layout/seedLayout.ts`：冻结 `5 + 7 / 4 + 4 + 4` 五卡位。
- `src/projections/desktop/seedProjection.ts`：五区种子内容；换内容不改变 slot。
- `src/dimension/nativeRegistry.tsx`：九种 native 卡穷尽注册表。

## 已对齐的规范

| 项 | 口径 | 出处 |
|---|---|---|
| 养成参数 | 三条：熟悉 / 默契 / 权能（「关系」不做数值） | 总纲 §5.5 |
| 秘书称谓 | 不预设专名，UI 不出现人名 | 总纲 §1.3 |
| 状态徽章 | 在岗 / 在想 / 有事说 | 总纲 §4.6 |
| 阶段外显 | 显示阶段名（「默契 · 合拍」），裸数值仅内部 | 总纲 §5.5 |
| 秘书立绘 | 3 状态 × 3 语义动作，共 9 张资源（4 张真透明、5 张暖纸底）；动作由运行语义确定、非法动作回退默认且禁止随机；熟悉 / 默契 / 权能分别驱动体量 / 微动 / 工具 | 前端 PRD §3.2；`src/assets/secretary/` |
| 种子骨架 | 上排资讯 `5` + 日程 `7`，下排复盘规划 / 节奏 / 弹性各 `4` | 总纲 §5.2 |
| 资讯硬上限 | 渲染边界代码强制最多 3 条；标题 / 理由 / 来源 / 三反馈齐全 | 总纲 §4.1 |
| 运行状态 | 无真实 adapter 时显示未知，不硬编码在线 | 前端 PRD §3.1 |

## 下一批接线

下一切片应实现只读 DesktopProjection adapter，把现有 Todo / Calendar 接到日程与节奏区；SQLite/LLM、Proposal 持久化、三种边缘状态和 HTML 沙箱仍不在本切片内。

定向验收：

```bash
npx vitest run src/runtime/layout/layoutDocument.test.ts src/runtime/layout/LayoutRenderer.test.tsx src/dimension/cards/nativeCards.test.tsx src/lib/featureFlags.test.ts
npm run build
npm run ladle:build
```
