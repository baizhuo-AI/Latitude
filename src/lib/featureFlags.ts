export interface DimensionDesktopFlagOptions {
  /** 注入值用于纯函数测试；省略时读取 Vite 环境变量。 */
  envValue?: string;
  /** 注入查询串用于 SSR / 测试；省略时在浏览器读取 location.search。 */
  search?: string;
}

const ENABLED_ENV_VALUES = new Set(["1", "true", "on"]);

/**
 * 新桌面开关。
 *
 * 优先级：显式 query 回退开关 > Vite 环境变量 > 默认关闭。
 * `?dimension=0` 必须能覆盖已开启的环境变量，给现场保留无构建回退通道。
 */
export function dimensionDesktopEnabled(
  { envValue, search }: DimensionDesktopFlagOptions = {}
): boolean {
  const resolvedSearch =
    search ?? (typeof window === "undefined" ? "" : window.location.search);
  const queryValue = new URLSearchParams(resolvedSearch).get("dimension");

  if (queryValue === "1") return true;
  if (queryValue === "0") return false;

  const resolvedEnvValue = envValue ?? import.meta.env?.VITE_DIMENSION_DESKTOP ?? "";
  return ENABLED_ENV_VALUES.has(resolvedEnvValue.trim().toLowerCase());
}
