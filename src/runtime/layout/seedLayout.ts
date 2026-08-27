import type { CardPresentation, NativeCardKind } from "../../dimension/types";
import type { LayoutDocumentV1 } from "./types";

/**
 * 批次 0 的种子桌面。
 *
 * 这是数据，不是页面模板：替换 binding、presentation 或 arrangement 后，
 * LayoutRenderer 会直接解释新文档，不需要改 DimensionApp 的 JSX。
 *
 * 骨架仍是冻结的 5+7 / 4+4+4（总纲 §5.2），但纸不是摆给阅卷人的：
 * 早报歪在左上、锚点纸略微错位、记忆点便签斜贴在右下 —— 散铺感写在
 * presentation 里（tilt / offsetY / tape / dogear），骨架本身不动。
 */
export const SEED_LAYOUT_DOCUMENT = {
  schemaVersion: 1,
  id: "dimension-seed-desktop",
  revision: 2,
  background: {
    theme: "paper",
    texture: "linen",
    density: "comfortable",
    tokenOverrides: {
      "--dim-desk": "#e9e4d6"
    }
  },
  cards: [
    {
      id: "seed-feed",
      region: "feed",
      renderer: "native",
      kind: "feed",
      span: 5,
      binding: "desktop.feed",
      presentation: {
        eyebrow: "今日资讯",
        title: "今日早报",
        tilt: -0.9,
        offsetY: 4,
        paper: "newsprint",
        clip: true
      }
    },
    {
      id: "seed-schedule",
      region: "schedule",
      renderer: "native",
      kind: "anchors",
      span: 7,
      binding: "desktop.schedule",
      presentation: {
        eyebrow: "今天",
        title: "今天的锚点",
        tilt: 0.35,
        offsetY: -2
      }
    },
    {
      id: "seed-review-plan",
      region: "review-plan",
      renderer: "native",
      kind: "progress",
      span: 4,
      binding: "desktop.reviewPlan",
      presentation: {
        eyebrow: "本周",
        title: "这周有一个新判断",
        tilt: -1.1,
        offsetY: 12
      }
    },
    {
      id: "seed-rhythm",
      region: "rhythm",
      renderer: "native",
      kind: "chart",
      span: 4,
      binding: "desktop.rhythm",
      presentation: {
        eyebrow: "专注时间",
        title: "下一段完整时间：90 分钟",
        tilt: 0.7,
        offsetY: 2,
        paper: "grid"
      }
    },
    {
      id: "seed-flex",
      region: "flex",
      renderer: "native",
      kind: "note",
      span: 4,
      binding: "desktop.flex",
      presentation: {
        eyebrow: "记住",
        title: "核心记忆点",
        tilt: -1.7,
        offsetY: 7,
        paper: "sticky",
        dogear: true,
        tape: {
          side: "right",
          offset: 26,
          width: 64,
          color: "rgb(198 216 48 / 40%)",
          tilt: 3
        }
      }
    }
  ],
  arrangement: {
    strategy: "frequency-weighted",
    orderedCardIds: [
      "seed-feed",
      "seed-schedule",
      "seed-review-plan",
      "seed-rhythm",
      "seed-flex"
    ],
    params: { maxChangesPerRefresh: 1 },
    rationale: [
      "早报在左上：一天的认知从打开开始",
      "日程是今天最常看的内容，因此占最大面积",
      "复盘、节奏安静在下排，记忆点便签斜贴在右下角"
    ]
  }
} satisfies LayoutDocumentV1<NativeCardKind, CardPresentation>;
