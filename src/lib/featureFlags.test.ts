import { afterEach, describe, expect, it, vi } from "vitest";
import { dimensionDesktopEnabled } from "./featureFlags";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("dimensionDesktopEnabled", () => {
  it("默认关闭，且没有 window 时也能安全求值", () => {
    vi.stubEnv("VITE_DIMENSION_DESKTOP", "");
    vi.stubGlobal("window", undefined);

    expect(dimensionDesktopEnabled()).toBe(false);
  });

  it.each(["1", "true", "TRUE", " on "])("接受开启环境变量 %s", (envValue) => {
    expect(dimensionDesktopEnabled({ envValue, search: "" })).toBe(true);
  });

  it.each(["", "0", "false", "off", "yes"])("其它环境变量 %s 保持关闭", (envValue) => {
    expect(dimensionDesktopEnabled({ envValue, search: "" })).toBe(false);
  });

  it("query dimension=1 强制开启", () => {
    expect(
      dimensionDesktopEnabled({ envValue: "false", search: "?dimension=1" })
    ).toBe(true);
  });

  it("query dimension=0 强制关闭，覆盖已开启的环境变量", () => {
    expect(
      dimensionDesktopEnabled({ envValue: "true", search: "?dimension=0" })
    ).toBe(false);
  });

  it("其它 query 值回退到环境变量", () => {
    expect(
      dimensionDesktopEnabled({ envValue: "on", search: "?dimension=preview" })
    ).toBe(true);
    expect(
      dimensionDesktopEnabled({ envValue: "off", search: "?dimension=preview" })
    ).toBe(false);
  });

  it("省略注入参数时读取浏览器 query 和 Vite 环境变量", () => {
    vi.stubEnv("VITE_DIMENSION_DESKTOP", "true");
    window.history.replaceState({}, "", "/?dimension=0");
    expect(dimensionDesktopEnabled()).toBe(false);

    window.history.replaceState({}, "", "/?dimension=1");
    expect(dimensionDesktopEnabled()).toBe(true);
  });

  it("无任何显式信号时可由 fallbackWhenUnset 默认开启（浏览器预览）", () => {
    expect(
      dimensionDesktopEnabled({ envValue: "", search: "", fallbackWhenUnset: true })
    ).toBe(true);
    expect(
      dimensionDesktopEnabled({ envValue: "", search: "", fallbackWhenUnset: false })
    ).toBe(false);
  });

  it("显式关闭信号不被 fallback 覆盖", () => {
    expect(
      dimensionDesktopEnabled({ envValue: "0", search: "", fallbackWhenUnset: true })
    ).toBe(false);
    expect(
      dimensionDesktopEnabled({ search: "?dimension=0", fallbackWhenUnset: true })
    ).toBe(false);
  });
});
