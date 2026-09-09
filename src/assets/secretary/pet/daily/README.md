# 秘书日常动作素材

本目录是 2026-09-06 新增的 4 张坐姿透明 PNG：`sitting_write`、`notes_sort`、`tea`、`tidy`。
保持原有桌宠的人物、服饰和渲染质感，未修改上层目录已有的 36 张 PNG。

运行时通过 `PetArticulated.tsx` 的关节遮罩分别移动手、笔、纸和头部，身体与脚保持固定。偷看复用原有 `idle_look_left` / `idle_look_right` 的头部表情；翻资料、打盹复用原有站姿。

8 种日常动作和 1 种偷看互动的分段时长见 `src/dimension/pet/petActivities.ts`。闲暇表演不会调用 Agent，也不生成或保存方案、清单等内容。

使用内置 image_gen 生成。提示词、制作阶段、透明通道检查与实际采用文件的 SHA256 见 [source.json](./source.json)。
生成器未能提供合格透明通道的坐姿翻书、打盹、抬头候选只保留在本机制作记录中，未用于产品，也未做本地抠图。
