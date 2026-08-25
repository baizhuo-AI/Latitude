import type { RuntimeJson, RuntimeRequestOptions } from "./DesktopRuntimePort";

const TRANSIENT_STATUS = new Set([408, 425, 429, 502, 503, 504]);

export interface LocalHttpOptions {
  timeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
  fetchImpl?: typeof fetch;
}

interface JsonRequestOptions extends RuntimeRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: RuntimeJson;
  /** POST 只有带幂等键或明确声明后才能安全重试。 */
  retryable?: boolean;
}

export class LocalRuntimeError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { code: string; status?: number; retryable?: boolean; cause?: unknown }
  ) {
    super(message);
    this.name = "LocalRuntimeError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        enumerable: false,
        configurable: true
      });
    }
  }
}

export class LocalJsonHttpClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, options: LocalHttpOptions = {}) {
    this.baseUrl = normalizeRuntimeUrl(baseUrl);
    this.timeoutMs = positiveInt(options.timeoutMs, 12_000);
    this.retries = nonNegativeInt(options.retries, 2);
    this.retryBaseMs = positiveInt(options.retryBaseMs, 120);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async json<T>(path: string, options: JsonRequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const retries = nonNegativeInt(options.retries, this.retries);
    const canRetry =
      method === "GET" ||
      options.retryable === true ||
      Boolean(options.idempotencyKey);

    let lastError: unknown;
    for (let attempt = 0; attempt <= (canRetry ? retries : 0); attempt += 1) {
      if (options.signal?.aborted) throw abortError(options.signal.reason);
      try {
        return await this.singleAttempt<T>(path, options);
      } catch (error) {
        lastError = error;
        if (
          attempt >= retries ||
          !canRetry ||
          !isRetryableError(error) ||
          options.signal?.aborted
        ) {
          throw error;
        }
        await abortableDelay(this.retryBaseMs * 2 ** attempt, options.signal);
      }
    }
    throw lastError;
  }

  private async singleAttempt<T>(
    path: string,
    options: JsonRequestOptions
  ): Promise<T> {
    const timeoutMs = positiveInt(options.timeoutMs, this.timeoutMs);
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new DOMException("请求超时", "TimeoutError")),
      timeoutMs
    );
    const { signal, cleanup } = combineSignals(options.signal, timeoutController.signal);

    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

      const response = await this.fetchImpl(resolvePath(this.baseUrl, path), {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
        // Local services do not use browser credentials. A same-origin HTTPS
        // deployment may sit behind HTTP auth or a same-origin session.
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer"
      });

      if (!response.ok) {
        const retryable = TRANSIENT_STATUS.has(response.status);
        throw new LocalRuntimeError(
          `本地服务请求失败（HTTP ${response.status}）`,
          { code: "http_error", status: response.status, retryable }
        );
      }
      if (response.status === 204) return undefined as T;

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("application/json")) {
        throw new LocalRuntimeError("本地服务返回了非 JSON 响应", {
          code: "invalid_content_type"
        });
      }
      try {
        return (await response.json()) as T;
      } catch (error) {
        throw new LocalRuntimeError("本地服务返回了无效 JSON", {
          code: "invalid_json",
          cause: error
        });
      }
    } catch (error) {
      if (options.signal?.aborted) throw abortError(options.signal.reason);
      if (timeoutController.signal.aborted) {
        throw new LocalRuntimeError(`本地服务请求超过 ${timeoutMs}ms`, {
          code: "timeout",
          retryable: true,
          cause: error
        });
      }
      if (error instanceof LocalRuntimeError) throw error;
      if (isAbortLike(error)) throw abortError(error);
      throw new LocalRuntimeError("无法连接本地服务", {
        code: "network_error",
        retryable: true,
        cause: error
      });
    } finally {
      clearTimeout(timeout);
      cleanup();
    }
  }
}

export function normalizeRuntimeUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new LocalRuntimeError("本地服务地址无效", {
      code: "invalid_base_url",
      cause: error
    });
  }
  const isLoopback = parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  const browserOrigin = globalThis.location?.origin;
  const isSameOriginHttps = parsed.protocol === "https:" &&
    typeof browserOrigin === "string" && parsed.origin === browserOrigin;
  if (!isLoopback && !isSameOriginHttps) {
    throw new LocalRuntimeError(
      "浏览器 Runtime 只允许连接 loopback HTTP 或当前页面同源 HTTPS",
      { code: "non_loopback_base_url" }
    );
  }
  if (parsed.username || parsed.password) {
    throw new LocalRuntimeError("服务地址不能包含用户名或密码", {
      code: "credentials_in_base_url"
    });
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function createRuntimeRequestId(prefix = "req"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}_${uuid}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal.reason);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resolvePath(baseUrl: string, path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${normalized}`;
}

function combineSignals(
  external: AbortSignal | undefined,
  timeout: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const forward = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const onExternal = () => external && forward(external);
  const onTimeout = () => forward(timeout);
  if (external?.aborted) forward(external);
  else external?.addEventListener("abort", onExternal, { once: true });
  if (timeout.aborted) forward(timeout);
  else timeout.addEventListener("abort", onTimeout, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      external?.removeEventListener("abort", onExternal);
      timeout.removeEventListener("abort", onTimeout);
    }
  };
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? -1) >= 0 ? (value as number) : fallback;
}

function isRetryableError(error: unknown): boolean {
  return error instanceof LocalRuntimeError && error.retryable;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortError(reason?: unknown): DOMException {
  if (reason instanceof DOMException && reason.name === "AbortError") return reason;
  return new DOMException("操作已取消", "AbortError");
}
