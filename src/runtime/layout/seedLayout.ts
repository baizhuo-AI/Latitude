import type { CardPresentation, NativeCardKind } from "../../dimension/types";
import type { LayoutDocumentV1 } from "./types";

/**
 * 批次 0 的种子桌面。
 *
 * 这是数据，不是页面模板：替换 binding、presentation 或 arrangement 后，
 * LayoutRenderer 会直接解释新文档，不需要改 DimensionApp 的 JSX。
 */
export const SEED_LAYOUT_DOCUMENT = {
  schemaVersion: 1,
  id: "dimension-seed-desktop",
  revision: 1,
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
        eyebrow: "FOR YOU · ONE ANGLE",
        title: "一个值得带走的角度",
        tilt: -0.12,
        tape: {
          side: "left",
          offset: 28,
          width: 70,
          color: "rgb(198 216 48 / 38%)",
          tilt: -2
        }
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
        eyebrow: "TODAY · SCHEDULE",
        title: "今天的三个锚点",
        tilt: 0.08
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
        eyebrow: "WEEKLY · REVIEW",
        title: "这周有一个新判断",
        tilt: -0.08
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
        eyebrow: "RHYTHM · FOCUS",
        title: "下一段完整时间：90 分钟",
        tilt: 0.1,
        paper: "plain"
      }
    },
    {
      id: "seed-flex",
      region: "flex",
      renderer: "native",
      kind: "proposal",
      span: 4,
      binding: "desktop.flex",
      presentation: {
        eyebrow: "A SMALL TRY",
        title: "要不要先做一个小版本？",
        tilt: -0.12,
        paper: "sticky"
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
      "先放一条和今天直接相关的材料，不做信息流",
      "日程是今天最常看的内容，因此占最大面积",
      "复盘、节奏和待确认的事情留在下排，需要时再点亮"
    ]
  }
} satisfies LayoutDocumentV1<NativeCardKind, CardPresentation>;
