# src/dimension — 新桌面种子运行时

> **状态：feature-gated seed runtime**。本目录承载[前端体验 PRD](../../docs/specs/2026-08-19-dimension-desktop-frontend-prd.md) 的视觉与交互探针；布局解释器位于 `src/runtime/layout/`，桌面投影位于 `src/projections/desktop/`。这里的三种预设尚不等于 PRD 中行动、推理、演化三种体验职责已经完成。

## 现状

- `App → MainWindow` 已接入 `VITE_DIMENSION_DESKTOP` 开关；关闭仍渲染原 `BoardShell`，开启后渲染全屏 `LiveDimensionApp`，主窗口现有 scheduler / sync / Feishu bridge 不移动也不重复启动。
- 真实桌面端默认关闭，可用 `?dimension=1` 临时打开、`?dimension=0` 强制回退。**纯浏览器预览（无 Tauri / 无本地数据库）默认直开新桌面**，并由 `LiveDimensionApp` 回退到明确标注「演示模式」的种子投影——不把「连不上本地内核」伪装成空数据或正常在线。
- Dimension 桌面使用懒加载，真实桌面端开关关闭时不下载秘书立绘和新桌面代码。
- **纸面预设在桌面端已接真实数据**（2026-08-23）：`src/projections/desktop/liveProjection.ts` 把 todos / calendar_events / activities / proposals / daily_digest 只读投影到五区；锚点「完成」写回 SQLite，血缘点击显示真实来源。
- **三层甲板取代形态预览条**（2026-08-24）：桌面 / 线索板 / 星图是同一份投影的三个层次，空间模型是「桌面在最下、线索板在头顶、星图最高」——滚轮向上 / 触摸下拉 / PageUp 是抬头升层，向下回落；`DimensionDeck` 一根轨道垂直平移，换层带衔接视差（离开层内容反向滞后）与各层入场错峰动效，换层有冷却防穿层。三层常驻挂载，层内状态不丢。顶部「形态预览」条已退役，演示标注由每层头部的运行状态（演示模式）承担。
- **秘书侧边栏全局化**（2026-08-24）：侧边栏从桌面层抽出来成为全局常驻栏（层级在甲板之上），可收起成细条并记忆（localStorage）；三层共享同一位秘书与同一条对话出口。
- **桌面散铺种子**（2026-08-24）：骨架仍是 `5 + 7 / 4 + 4 + 4`，表现上便签允许 ~2° 倾斜与轻微偏移，左上资讯卡用报纸样式（newsprint 衬线版头）；种子内容是具体的一天——今日早报 / 给客户 1 准备日报、修改客户 2 的 agent badcase 等工作锚点 / 右下「核心记忆点」便签。种子投影不再有提案卡，提案演示靠显式注入。
- **线索板 v3**（2026-08-24）：回到中心命题 + 四周纸条的板子布局，加木框边框；重点线索按锚点 `tags` 聚成「事件维度」线索纸（如工作现状 / 个人项目进度 / 短期规划），金线连回命题，提案纸以暗红虚线相连；无标签时诚实留白。**v4 补充**：线索纸可以在板上拖动重排（钉法记 localStorage，墨线跟着走）；线索与桌面是层级关系——点按线索纸低头进这条线的聚焦桌面（不属于该维度的锚点退焦 + 可退出的聚焦胶囊），纸上 ⋯ 展开详情抽屉。
- **星图 v3 · 夜空**（2026-08-24）：不再做信息量——一枚北极星（近期命题，白炽核心 + 三层渐散光晕 + 柔和四芒 + 呼吸环）+ 外圈进度环 + 从地平线升向北极星的星径（今日锚点，完成的更亮）+ 远山地平线 + 底部一行观测注记；点星径仍有观测行与星源出口。观测台 / 提案 / 资讯节点从星图撤下，那些归桌面与线索板。
- **换层隐喻动画**（2026-08-24）：层间无硬边界——移动中两层微微失焦，上下缘有大气渐晕；落定后进入层播自己的隐喻：桌面便签从桌心散开排开、线索纸落下后轻轻晃荡、星空从近处拉远的小缩放。
- **桌面便签拖拽与编辑**（2026-08-24）：五张卡都可以拖散（鼠标 / 触控笔；触摸屏留给换层手势），偏移只写表现层（localStorage），骨架与数据不动；从按钮 / 输入框按下不启动拖拽。普通双击卡片进入编辑，`Shift + 双击`才放回槽位；可打开的认知卡仍以单击翻开手帐。
- **桌面交互加密**：带来源的行动锚点可点字改名（Enter 提交 / Esc 取消），写回真实待办标题；点秘书立绘她会注意到你（倾听动作 + 气泡 +「聊聊」「有什么要我定的？」两个真实出口）。
- **对话条接真秘书**：发送即走 `chatStore.sendMessage`（API 引擎 function calling / CLI 引擎均可），回复以流式升起到桌面同一张纸（DeskThread）；秘书徽章状态由真实运行语义决定（在想 = 引擎生成中，有事说 = 有提案待裁决）。
- **提案—裁决最小闭环**：秘书经 `propose_change` 工具递交提案（proposals 表，V14）；弹性格渲染裁决五态（有点意思 / 这对我成立 / 要不试试 / 不太对 / 先放着），裁决写回并留痕；「要不试试」把行动面落地成今日待办。形态变更提案暂不开放（执行器未接，提了落不了地）。
- **设置真实可达**：全局秘书栏左下角「设置」下钻打开完整设置页（引擎 key / 数据导出删除都在这里）；秘书栏收起后仍保留齿轮入口，合上原位返回。
- 候选线索、资讯策展、养成三参数计算尚未接入：对应区域显示诚实的留白，秘书文案明确承认边界（PRD §13.1）。
- 演示路径保留：`DimensionApp` 默认 props 仍是 `SEED_LAYOUT_DOCUMENT + SEED_DESKTOP_PROJECTION`，供 Stories / 测试 / 甲板复用。

## 已落地的运行时边界

- `src/runtime/layout/types.ts`：背景 / 卡 / 排布三层 `LayoutDocumentV1`；排布只存策略与参数，不存坐标。
- `src/runtime/layout/validate.ts`：重复 id、悬空 binding、非法 span、错误五区顺序和坐标字段的运行时校验。
- `src/runtime/layout/LayoutRenderer.tsx`：显式 native 注册表；`declarative / html` 只保留协议，当前显示可见安全降级，绝不执行。卡片外包 `.dim-drag` 拖拽层（`useCardDrag`）：表现层偏移、指针捕获、点击吞并，均不影响卡片语义事件。
- `src/runtime/layout/seedLayout.ts`：冻结 `5 + 7 / 4 + 4 + 4` 五卡位（revision 2：散铺表现——newsprint 报纸资讯、便签微倾斜与偏移）。
- `src/projections/desktop/seedProjection.ts`：五区种子内容；换内容不改变 slot。
- `src/dimension/presets/`：同一份投影的三层解释，由 `DimensionDeck` 垂直换层（桌面在下、线索板在头顶、星图最高）。缺省纸面桌面；`?preset=clue-board` / `?preset=constellation` 直达线索板 / 星图（仍生成可分享链接）。线索板与星图消费真实投影，裁决 / 完成 / 反馈经 `layerHandlers` 与桌面同一出口；线索抽屉由板内自管。
- `src/dimension/nativeRegistry.tsx`：九种 native 卡穷尽注册表。

## 已对齐的规范

| 项 | 口径 | 出处 |
|---|---|---|
| 养成参数 | 三条：熟悉 / 默契 / 权能（「关系」不做数值） | 总纲 §5.5 |
| 秘书称谓 | 不预设专名，UI 不出现人名 | 总纲 §1.3 |
| 状态徽章 | 在岗 / 在想 / 有事说 | 总纲 §4.6 |
| 阶段外显 | 显示阶段名（「默契 · 合拍」），裸数值仅内部 | 总纲 §5.5 |
| 秘书立绘 | 3 状态 × 3 语义动作，共 9 张资源（4 张真透明、5 张暖纸底）；动作由运行语义确定、非法动作回退默认且禁止随机；熟悉 / 默契 / 权能分别驱动体量 / 微动 / 工具 | 前端体验 PRD §7；`src/assets/secretary/` |
| 种子骨架 | 上排资讯 `5` + 日程 `7`，下排复盘规划 / 节奏 / 弹性各 `4` | 总纲 §5.2 |
| 资讯硬上限 | 渲染边界代码强制最多 3 条；标题 / 理由 / 来源 / 三反馈齐全 | 总纲 §4.1 |
| 运行状态 | 无真实 adapter 时显示未知，不硬编码在线 | 前端体验 PRD §10、§13 |

## 下一批接线

下一切片：候选线索投影（等图谱六表）；提案生命周期完整化（parked 到期静默收起、尝试结果回收 → 修订）；资讯策展（换一个角度的真实供给）；养成三参数计算（P4）。

定向验收：

```bash
npx vitest run src/runtime/layout/layoutDocument.test.ts src/runtime/layout/LayoutRenderer.test.tsx src/dimension/cards/nativeCards.test.tsx src/lib/featureFlags.test.ts src/projections/desktop/liveProjection.test.ts src/projections/desktop/LiveDimensionApp.test.tsx
npm run build
npm run ladle:build
```
