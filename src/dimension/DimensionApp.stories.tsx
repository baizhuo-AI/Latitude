import type { Story, StoryDefault } from "@ladle/react";
import "../styles/index.css"; // 提供 --font-sans / --font-mono
import { DimensionApp } from "./DimensionApp";
import { DeskGrid } from "./cards";
import { DESK } from "./sample";
import "./dimension.css";

/**
 * 维度桌面的种子运行时与纸片回归图库。
 *
 * Desk —— 完整 5+7 / 4+4+4 种子桌面。
 * Cards —— 保留旧卡型样例,便于逐张检查纸质、倾斜和点缀。
 */

export default {
  title: "Dimension/桌面"
} satisfies StoryDefault;

/** 完整种子应用。整屏,交互只给明确的原型反馈。 */
export const Desk: Story = () => (
  <div style={{ position: "fixed", inset: 0 }}>
    <DimensionApp />
  </div>
);

/** 只看纸片:检查纸质、倾斜角、胶带和回形针 */
export const Cards: Story = () => (
  <div
    className="dimension-root"
    style={{ minHeight: "100vh", padding: 28, boxSizing: "border-box" }}
  >
    <p className="dim-eyebrow" style={{ marginBottom: 18 }}>
      Paper Stock / 5 — 倾斜角一律在 ±1.2° 内
    </p>
    <DeskGrid cards={DESK.cards} />
  </div>
);
