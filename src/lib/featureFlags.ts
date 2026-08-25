export interface DimensionDesktopFlagOptions {
  /** 注入值用于纯函数测试；省略时读取 Vite 环境变量。 */
  envValue?: string;
  /** 注入查询串用于 SSR / 测试；省略时在浏览器读取 location.search。 */
  search?: string;
  /**
   * 没有任何显式信号（query / env 都未设置）时的默认值。
   * 浏览器预览（非 Tauri）没有本地数据库，用它默认落到演示桌面；
   * 真实桌面端不传，保持默认关闭的产品决策。
   */
  fallbackWhenUnset?: boolean;
}

const ENABLED_ENV_VALUES = new Set(["1", "true", "on"]);

/**
 * 新桌面开关。
 *
 * 优先级：显式 query 回退开关 > Vite 环境变量 > fallbackWhenUnset > 默认关闭。
 * `?dimension=0` 必须能覆盖已开启的环境变量，给现场保留无构建回退通道。
 */
export function dimensionDesktopEnabled(
  { envValue, search, fallbackWhenUnset }: DimensionDesktopFlagOptions = {}
): boolean {
  const resolvedSearch =
    search ?? (typeof window === "undefined" ? "" : window.location.search);
  const queryValue = new URLSearchParams(resolvedSearch).get("dimension");

  if (queryValue === "1") return true;
  if (queryValue === "0") return false;

  const resolvedEnvValue = (
    envValue ??
    import.meta.env?.VITE_DIMENSION_DESKTOP ??
    ""
  )
    .trim()
    .toLowerCase();
  if (ENABLED_ENV_VALUES.has(resolvedEnvValue)) return true;
  // env 显式给了非启用值视为显式关闭信号，不被 fallback 覆盖
  if (resolvedEnvValue !== "") return false;
  return fallbackWhenUnset === true;
}
