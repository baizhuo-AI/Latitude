import type { Story, StoryDefault } from "@ladle/react";
import "../../styles/index.css";
import { DimensionPresetApp } from "./DimensionPresetApp";

export default {
  title: "Dimension/桌面预设/三层甲板"
} satisfies StoryDefault;

/** 桌面 / 线索板 / 星图共用同一份内容；滚轮、触摸或 PageDown / PageUp 换层。 */
export const PresetLab: Story = () => (
  <div style={{ position: "fixed", inset: 0 }}>
    <DimensionPresetApp syncUrl={false} />
  </div>
);
