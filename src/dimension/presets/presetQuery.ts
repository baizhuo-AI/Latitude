export type DimensionPresetId = "paper" | "clue-board" | "constellation";

export const DIMENSION_PRESET_IDS = [
  "paper",
  "clue-board",
  "constellation"
] as const satisfies readonly DimensionPresetId[];

const PRESET_IDS = new Set<string>(DIMENSION_PRESET_IDS);

/**
 * 形态预设只影响视觉解释器，不改变 DesktopProjection 或 LayoutDocument。
 * 缺失、旧链接或非法值都回到 PRD 的纸面桌面。
 */
export function resolveDimensionPreset(search?: string): DimensionPresetId {
  const resolvedSearch =
    search ?? (typeof window === "undefined" ? "" : window.location.search);
  const value = new URLSearchParams(resolvedSearch).get("preset");

  return value && PRESET_IDS.has(value)
    ? (value as DimensionPresetId)
    : "paper";
}

/** 保留 dimension 等其他参数，只同步可分享的 preset 选择。 */
export function replaceDimensionPresetInUrl(preset: DimensionPresetId): void {
  if (typeof window === "undefined") return;

  const url = new URL(window.location.href);
  if (preset === "paper") url.searchParams.delete("preset");
  else url.searchParams.set("preset", preset);

  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
}
