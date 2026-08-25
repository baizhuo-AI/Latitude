import type { Story, StoryDefault } from "@ladle/react";
import "../../styles/index.css";
import { SEED_DESKTOP_PROJECTION } from "../../projections/desktop/seedProjection";
import { ClueBoardPreset } from "./ClueBoardPreset";

export default {
  title: "Dimension/桌面预设"
} satisfies StoryDefault;

/** 同一份 seed projection 的线索板解释：支持关系用金线，待验证关系用暗红线。 */
export const ClueBoard: Story = () => (
  <div style={{ position: "fixed", inset: 0 }}>
    <ClueBoardPreset
      projection={SEED_DESKTOP_PROJECTION}
      onEnterThread={(thread) => console.info("enter thread", thread.title)}
      onTraceLineage={(lineage) => console.info("trace lineage", lineage)}
      onAcceptProposal={(bindingId) => console.info("accept proposal", bindingId)}
      onRejectProposal={(bindingId) => console.info("reject proposal", bindingId)}
      onOpenThesis={() => console.info("open thesis")}
    />
  </div>
);
