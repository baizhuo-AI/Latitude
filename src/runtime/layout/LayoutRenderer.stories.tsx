import type { Story, StoryDefault } from "@ladle/react";
import type { ReactNode } from "react";
import type { DesktopProjection } from "../../projections/desktop/types";
import { SEED_DESKTOP_PROJECTION } from "../../projections/desktop/seedProjection";
import type { CardPresentation } from "../../dimension/types";
import "../../styles/index.css";
import "../../dimension/dimension.css";
import { LayoutRenderer } from "./LayoutRenderer";
import { SEED_LAYOUT_DOCUMENT } from "./seedLayout";
import type { LayoutDocumentV1 } from "./types";

export default {
  title: "Dimension/布局运行时"
} satisfies StoryDefault;

function StoryFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className="dimension-root"
      style={{ minHeight: "100vh", padding: 28, boxSizing: "border-box" }}
    >
      {children}
    </div>
  );
}

/** 完整 5+7 / 4+4+4 种子布局。 */
export const SeedLayout: Story = () => (
  <StoryFrame>
    <LayoutRenderer
      document={SEED_LAYOUT_DOCUMENT}
      bindings={SEED_DESKTOP_PROJECTION.bindings}
    />
  </StoryFrame>
);

const CONTENT_SWAP_PROJECTION = {
  ...SEED_DESKTOP_PROJECTION,
  bindings: {
    ...SEED_DESKTOP_PROJECTION.bindings,
    "desktop.reviewPlan": {
      kind: "progress",
      body: "内容已经替换，但五个 slot 的顺序、区域和宽度保持不动。",
      percent: 68,
      leftMeta: "同一骨架 · 新投影"
    }
  }
} satisfies DesktopProjection;

/** 只换 projection 内容，肉眼确认 slot 边界没有重排。 */
export const ContentSwapSameSkeleton: Story = () => (
  <StoryFrame>
    <LayoutRenderer
      document={SEED_LAYOUT_DOCUMENT}
      bindings={CONTENT_SWAP_PROJECTION.bindings}
    />
  </StoryFrame>
);

const UNSUPPORTED_RENDERER_LAYOUT: LayoutDocumentV1<string, CardPresentation> = {
  ...SEED_LAYOUT_DOCUMENT,
  cards: SEED_LAYOUT_DOCUMENT.cards.map((card) =>
    card.id === "seed-feed" ? { ...card, renderer: "html" as const } : card
  )
};

/** html 契约存在但实验期不会执行，必须显示安全降级。 */
export const UnsupportedRendererFallback: Story = () => (
  <StoryFrame>
    <LayoutRenderer
      document={UNSUPPORTED_RENDERER_LAYOUT}
      bindings={SEED_DESKTOP_PROJECTION.bindings}
    />
  </StoryFrame>
);
