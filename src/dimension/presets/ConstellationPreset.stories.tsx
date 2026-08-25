import type { Story, StoryDefault } from "@ladle/react";
import { SEED_DESKTOP_PROJECTION } from "../../projections/desktop/seedProjection";
import { ConstellationPreset } from "./ConstellationPreset";

export default {
  title: "Dimension/预设/夜航星图"
} satisfies StoryDefault;

export const FullSky: Story = () => (
  <div style={{ position: "fixed", inset: 0 }}>
    <ConstellationPreset
      projection={SEED_DESKTOP_PROJECTION}
      onAction={(action, node) => {
        // Story 只验证视觉和事件契约，不伪装持久化成功。
        console.info("constellation", action, node.id);
      }}
    />
  </div>
);
