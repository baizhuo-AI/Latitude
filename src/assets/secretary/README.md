# 秘书立绘资源

资源契约：三个运行状态 × 三个语义动作，共九张同身份 PNG。产品目标仍是九张真实透明切图；当前首批交付中四张通过 alpha 验收，五张采用与固定秘书栏一致的暖纸底，不含棋盘格，可直接用于 PRD 明确限定的浅色纸张主题。

| 文件 | 运行状态 | 动作键 | 运行语义 | 默认 | 当前底图 |
|---|---|---|---|---|---|
| `secretary-ready.png` | `READY / 在岗` | `idle` | 合上本子安静待机 | 是 | 真实 alpha |
| `secretary-ready-listening.png` | `READY / 在岗` | `listening` | 接收用户输入或聆听口述 | 否 | 真实 alpha |
| `secretary-ready-organizing.png` | `READY / 在岗` | `organizing` | 归拢已接收信息，尚未形成判断 | 否 | 暖纸底 |
| `secretary-thinking.png` | `THINKING / 在想` | `pondering` | 形成单一判断或寻找下一步 | 是 | 真实 alpha |
| `secretary-thinking-writing.png` | `THINKING / 在想` | `writing` | 记录、整理或生成可呈现内容 | 否 | 暖纸底 |
| `secretary-thinking-comparing.png` | `THINKING / 在想` | `comparing` | 对照候选、证据或方案 | 否 | 暖纸底 |
| `secretary-presenting.png` | `PRESENTING / 有事说` | `offering` | 递出一项提案、结果或纸卡 | 是 | 真实 alpha |
| `secretary-presenting-reminding.png` | `PRESENTING / 有事说` | `reminding` | 提醒时间敏感事项 | 否 | 暖纸底 |
| `secretary-presenting-acknowledging.png` | `PRESENTING / 有事说` | `acknowledging` | 对确认、完成或采纳给出克制反馈 | 否 | 暖纸底 |

固定秘书栏通过 `dim-secretary-sprite-paper-matte` 做纸底融合。若资源要离开浅色纸张主题、进入深色主题或复用到独立浮层，先把这五张重新导出为真实 alpha；这不应靠 CSS 色键抠图临时绕过。

## 动作选择契约

- 动作由明确的运行语义选择，禁止按定时器、重渲染或随机数轮播；
- 输入语义不变时，动作必须稳定，避免角色无缘无故“表演”；
- 动作键缺失、与运行状态不匹配或资源不可用时，回退到该状态默认动作：`READY → idle`、`THINKING → pondering`、`PRESENTING → offering`；
- 状态徽章、文案与动作键由同一状态源派生，图片内不嵌入状态文字。

## 角色不变量

- 同一个无年龄化的成年角色，不做「儿童长成大人」的字面养成；
- 暖灰金短发、灰绿眼睛、黄绿色菱形发夹；
- 炭黑档案员外套、暖白内搭、克制的橄榄色细节；
- 不嵌入秘书名字、状态文字或 UI 徽章；
- 完整身体与安全留白保留在素材内，由容器负责裁切和生长。

## 生长映射

三条参数不能平均成一个「关系分」。它们分别控制不同的视觉维度：

- **熟悉**：立绘在画框里的连续缩放，`0 → 100` 映射为 `0.76 → 1.04`；
- **默契**：呼吸与轻摆等微动幅度，数值越高越自然；
- **权能**：只显示用户已经显式授予的工具页签，绝不因熟悉或默契自动增加。

运行状态、动作与生长状态正交：状态限定动作集合，运行语义选择具体图片，参数只决定同一动作如何呈现。默契只控制微动幅度，不负责随机换动作。

## 生成提示词

使用内置 ImageGen，以 `docs/assets/dimension-demo/` 三张桌面稿作为风格参考。最终提示词骨架：

```text
Use case: stylized-concept / identity-preserve
Asset type: production character portrait for the fixed 176px Latitude secretary rail
Subject: one ageless young-adult chibi anime secretary; short warm ash-blond bob;
muted green-gray eyes; lime diamond hairpin; charcoal archival-style jacket;
warm cream and olive details; one field notebook
Style: restrained editorial anime with gouache and colored-pencil texture;
clean dark-olive linework; readable at 176px
Composition: full-body, fixed center anchor and baseline, generous transparent margins
Action matrix: READY has idle / listening / organizing;
THINKING has pondering / writing / comparing;
PRESENTING has offering / reminding / acknowledging
Action contract: every gesture has a clear runtime meaning; no random or timed variants;
keep the same anchor, silhouette scale, identity and outfit across all nine assets
Constraints: same identity and outfit across states; genuine transparent alpha;
no name, text, badge, logo, UI frame, floor shadow or watermark;
young adult, modest and non-sexualized; no glossy gacha finish
```

背景提取另走 `background-extraction` 编辑，并逐张用 `sips -g hasAlpha` 验收。生成器若把棋盘格烘焙进文件，不得入库；本批次未稳定得到 alpha 的五张已改为明确的暖纸底，并在上表如实标记。

## 验收预览

- [九动作矩阵](../../../out/secretary-action-matrix.png)
- [三阶段生长矩阵](../../../out/secretary-growth-matrix.png)
