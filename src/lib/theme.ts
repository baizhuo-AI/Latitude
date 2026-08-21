import { create } from "zustand";

/**
 * 主题切换
 *
 * 三种模式:
 * - "light":强制亮色
 * - "dark" :强制暗色
 * - "system":跟随系统(默认)
 *
 * 应用方式:document.documentElement 上加/去 .dark class。Tailwind 的 darkMode: "class" 据此切。
 *
 * 注意:为避免页面加载时"先白后黑"的闪烁,初始 class 在 index.html 的 <script> 里就提前算好,
 * 不依赖此模块加载完成。
 */

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "latitude.theme";

function readStored(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveActual(mode: ThemeMode): "light" | "dark" {
  return mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode;
}

function applyToDom(actual: "light" | "dark") {
  const root = document.documentElement;
  if (actual === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

interface ThemeStore {
  /** 用户选择的模式(可能是 system) */
  mode: ThemeMode;
  /** 当前实际生效的(只会是 light 或 dark) */
  actual: "light" | "dark";
  /** 用户主动切换 */
  setMode: (mode: ThemeMode) => void;
  /** 三态循环:light → dark → system → light */
  cycle: () => void;
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  mode: readStored(),
  actual: resolveActual(readStored()),
  setMode: (mode) => {
    window.localStorage.setItem(STORAGE_KEY, mode);
    const actual = resolveActual(mode);
    applyToDom(actual);
    set({ mode, actual });
  },
  cycle: () => {
    const order: ThemeMode[] = ["light", "dark", "system"];
    const next = order[(order.indexOf(get().mode) + 1) % order.length];
    get().setMode(next);
  }
}));

/**
 * 监听系统主题变化(只在 mode === "system" 时响应)
 * 在 main.tsx 启动时调用一次即可。
 */
export function watchSystemTheme() {
  if (typeof window === "undefined") return;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", () => {
    const { mode } = useThemeStore.getState();
    if (mode === "system") {
      const actual = mq.matches ? "dark" : "light";
      applyToDom(actual);
      useThemeStore.setState({ actual });
    }
  });
}
