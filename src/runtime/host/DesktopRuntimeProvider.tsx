import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type {
  DesktopRuntimeHealth,
  DesktopRuntimePort,
  RuntimeServiceState
} from "./DesktopRuntimePort";
import {
  HttpDesktopRuntime,
  type HttpDesktopRuntimeOptions
} from "./HttpDesktopRuntime";

export interface DesktopRuntimeContextValue {
  runtime: DesktopRuntimePort;
  health: DesktopRuntimeHealth | null;
  state: RuntimeServiceState;
  refreshHealth: (signal?: AbortSignal) => Promise<DesktopRuntimeHealth>;
}

const DesktopRuntimeContext = createContext<DesktopRuntimeContextValue | null>(null);

export interface DesktopRuntimeProviderProps extends PropsWithChildren {
  /** 测试或未来 Tauri adapter 可直接注入；浏览器默认创建 HttpDesktopRuntime。 */
  runtime?: DesktopRuntimePort;
  httpOptions?: HttpDesktopRuntimeOptions;
  /** 0 表示只在挂载时检查一次。 */
  healthPollMs?: number;
}

export function DesktopRuntimeProvider({
  children,
  runtime: injectedRuntime,
  httpOptions,
  healthPollMs = 10_000
}: DesktopRuntimeProviderProps) {
  // options 只在 runtime 第一次创建时读取；避免父组件对象字面量触发会话丢失。
  const ownedRuntime = useRef<DesktopRuntimePort | null>(null);
  if (!ownedRuntime.current) {
    ownedRuntime.current = injectedRuntime ?? new HttpDesktopRuntime(httpOptions);
  }
  const runtime = injectedRuntime ?? ownedRuntime.current;
  const [health, setHealth] = useState<DesktopRuntimeHealth | null>(null);

  const refreshHealth = useCallback(
    async (signal?: AbortSignal) => {
      const next = await runtime.health({ signal, retries: 0, timeoutMs: 2_000 });
      if (!signal?.aborted) setHealth(next);
      return next;
    },
    [runtime]
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshHealth(controller.signal).catch(() => undefined);
    if (!(healthPollMs > 0)) return () => controller.abort();
    const timer = window.setInterval(() => {
      void refreshHealth(controller.signal).catch(() => undefined);
    }, healthPollMs);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [healthPollMs, refreshHealth]);

  const value = useMemo<DesktopRuntimeContextValue>(
    () => ({
      runtime,
      health,
      state: health?.state ?? "starting",
      refreshHealth
    }),
    [health, refreshHealth, runtime]
  );

  return (
    <DesktopRuntimeContext.Provider value={value}>
      {children}
    </DesktopRuntimeContext.Provider>
  );
}

export function useDesktopRuntime(): DesktopRuntimeContextValue {
  const value = useContext(DesktopRuntimeContext);
  if (!value) {
    throw new Error("useDesktopRuntime 必须在 DesktopRuntimeProvider 内使用");
  }
  return value;
}

/** Local desktop notes also work in seed/native views without an HTTP provider. */
export function useDesktopRuntimeOptional(): DesktopRuntimeContextValue | null {
  return useContext(DesktopRuntimeContext);
}
