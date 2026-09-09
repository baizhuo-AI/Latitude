# 水彩星图素材

2026-09-09，以用户认可的「星光 / 窗边一角」草案左图为参照，通过内置 image_gen 分别生成背景和可合成的星光。运行时引用本目录素材，原始生成图另行保留。

- `watercolor-night.png`：1536 × 1024，完整横版水彩夜空。没有主星，动态北极星由界面叠加。
- `painted-starlight.png`：1280 × 1280，黑底的不规则星光。整个星标以 `mix-blend-mode: screen` 融入背景；黑色不是可见的图片框。中央没有另加圆核。
- `north-starlight-v2.png`：北极星专用的精简版本，使用内置 image_gen 修改前一版素材；集中白色亮光，减少外围光尘与颗粒。小星仍使用前一版素材。

认可草案：`exec-51add6d1-2f7b-4214-a2c2-85172202954d.png`。

生成输出：

- `exec-19da37cb-7c71-4eb5-972e-186806140bb9.png`
- `exec-aa9cbd1c-f7d4-43e6-a64a-6e4f9dda2e4e.png`

## 背景提示词

Use case: style-transfer. Asset: production background for a personal journal app's star map. Use ONLY the LEFT painted night-sky panel of the reference as the exact art direction. Create a clean WIDE landscape 3:2 or 16:10 night sky filling the entire image edge to edge. Match its tactile indigo watercolor and gouache on fine paper, very delicate irregular blue-gray clouded pigment, muted navy #101f35, sparse tiny warm-white stars. IMPORTANT: REMOVE the large central bright star and all central glow; the app will overlay its own animated star there. Leave the upper central portion quiet, dark and uncluttered for that later star. The lower half can have the same very restrained milky pigment wisps as the left reference. No dominant bright objects, no mountains or horizon, no frame, no cream border, no text, no person, no interface, no extra illustrated objects. The result must be a flat full-bleed watercolor sky texture, not a screenshot of the diptych. Preserve the beautiful handmade grain without adding digital purple nebulas.

## 星光提示词

Use case: background-extraction. Production compositing asset: isolate and redraw ONLY the luminous main star from the LEFT sky panel of this approved watercolor reference, centered on a perfectly pure black (#000000) square background so it can be screen-blended into that sky. The star is a small dazzling indistinct source surrounded by uneven fragile champagne-white and icy blue rays, irregular tiny specks of luminous paint, delicate watery haze. Match the actual painterly star in the reference: hand-painted gouache and watercolor paper grain, soft and fragmented light, refined and restrained. The luminous cluster should occupy the central 45% of the square, fully fade to pure black well before all four edges; rays vary in length and angle, no symmetric cross or icon. IMPORTANT: no visible circular disk, no round white sphere, no circular ring, no lens aperture, no sharp star outline, no regular polygon, no blue background or surrounding sky. At the very center, tiny blown-out irregular light points merge together; it is bright but impossible to distinguish a physical shape. No other stars outside this single local luminous cluster. No text, no border, no person.

## 动效边界

北极星只保留单层素材，透明度在 0.97–1 之间缓慢变化，不重复叠加外围光尘，不改变尺寸、位置或角度；小星错峰闪烁，标题位于星点下方。减少动态偏好下停止动画。原有视图进出场编排由 deck 控制。

## 北极星第二版

生成来源：`exec-ef8e33da-cb59-4866-ba3a-f8caa63c8503.png`。方式：内置 image_gen，编辑 `painted-starlight.png`。

### 最终提示词

Use case: precise-object-edit. Edit target: the supplied square black-background starlight asset for a personal journal app. Refine this SAME single central star: preserve its loose irregular diagonal spread and soft indistinct silhouette, but make the light noticeably brighter and much more restrained. Concentrate intense clean ivory-white luminosity into one small irregular overexposed point, whose edge is lost in the light; there must be NO round disk, visible core outline, ring, orb, or regular cross. Remove almost all the detached specks, paint splatters, granular debris, blue clouds, and busy microtexture. Keep only a few delicate uneven rays fading very smoothly and quickly into black, with a faint breath of scattered light close to the source. It should feel like a distant bright star seen through slightly moist air, with a light handmade sensitivity, quiet and simple. The center should read as dazzling even when this whole asset is shown at 240px; surrounding space stays dark. Keep the luminous spread within the central 55 percent of the square and all edges perfectly pure black #000000 for screen compositing. Avoid nebula, galaxy, explosion, fireworks, glitter, decorative bokeh, lens flare circles, lens flare crosses, dense watercolor grain, hyper-detailed AI fantasy illustration. No other stars, no text, no UI. Output one square image.
