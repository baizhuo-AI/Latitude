import type { Story, StoryDefault } from "@ladle/react";
import "../../styles/index.css";
import { DimensionPresetApp } from "./DimensionPresetApp";

export default {
  title: "Dimension/桌面预设/三层甲板"
} satisfies StoryDefault;

/** 桌面 / 线索板 / 星图共用同一份内容；显式导航或 PageDown / PageUp 换视图，桌面手势只操作画布。 */
export const PresetLab: Story = () => (
  <div style={{ position: "fixed", inset: 0 }}>
    <DimensionPresetApp syncUrl={false} />
  </div>
);
