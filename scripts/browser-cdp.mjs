import { Buffer } from "node:buffer";

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Minimal Chrome DevTools Protocol client for the local Browser smoke test.
 * It deliberately uses Node 22's built-in WebSocket instead of a browser-test
 * dependency or model/provider SDK.
 */
export class BrowserCdp {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #commandTimeoutMs;
  #closed = false;

  static async connect(webSocketUrl, options = {}) {
    const factory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    const socket = factory(webSocketUrl);
    await waitForSocketOpen(socket, options.connectTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    return new BrowserCdp(socket, options);
  }

  constructor(socket, options = {}) {
    this.#socket = socket;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    socket.addEventListener("message", (event) => {
      void this.#handleMessage(event.data).catch((error) => this.#failAll(error));
    });
    socket.addEventListener("close", () => {
      this.#closed = true;
      this.#failAll(new Error("Chrome DevTools connection closed"));
    });
    socket.addEventListener("error", () => {
      this.#failAll(new Error("Chrome DevTools connection failed"));
    });
  }

  async send(method, params = {}, options = {}) {
    if (this.#closed || this.#socket.readyState !== 1) {
      throw new Error(`Cannot send ${method}: Chrome DevTools connection is not open`);
    }
    const id = this.#nextId++;
    const timeoutMs = options.timeoutMs ?? this.#commandTimeoutMs;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Chrome DevTools command timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
    });
    try {
      this.#socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(error);
      }
    }
    return response;
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(method);
    };
  }

  async enablePageRuntime() {
    await Promise.all([
      this.send("Page.enable"),
      this.send("Runtime.enable"),
      this.send("Log.enable"),
    ]);
  }

  async navigate(url) {
    const result = await this.send("Page.navigate", { url });
    if (result.errorText) throw new Error(`Chrome navigation failed: ${result.errorText}`);
    await this.waitForExpression("document.readyState === 'complete'", {
      description: `document ready at ${url}`,
      timeoutMs: 20_000,
    });
  }

  async evaluate(expression, options = {}) {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: options.awaitPromise ?? true,
        returnByValue: options.returnByValue ?? true,
        userGesture: options.userGesture ?? false,
      },
      options,
    );
    if (result.exceptionDetails) {
      throw new Error(
        `Browser evaluation failed: ${formatExceptionDetails(result.exceptionDetails)}`,
      );
    }
    return result.result?.value;
  }

  async waitForExpression(expression, options = {}) {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const pollMs = options.pollMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression, { timeoutMs: Math.min(5_000, timeoutMs) })) {
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await delay(pollMs);
    }
    const suffix = lastError instanceof Error ? `; last error: ${lastError.message}` : "";
    throw new Error(
      `Timed out waiting for ${options.description ?? expression}${suffix}`,
    );
  }

  async captureScreenshot() {
    const result = await this.send(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: true, fromSurface: true },
      { timeoutMs: 20_000 },
    );
    if (typeof result.data !== "string" || result.data.length === 0) {
      throw new Error("Chrome returned an empty screenshot");
    }
    return Buffer.from(result.data, "base64");
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error("Chrome DevTools client closed"));
    try {
      this.#socket.close();
    } catch {
      // The owned Chrome process is the authoritative lifecycle boundary.
    }
  }

  async #handleMessage(data) {
    const message = JSON.parse(await webSocketDataToText(data));
    if (Number.isInteger(message.id)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `Chrome DevTools ${pending.method} failed (${String(message.error.code)}): ${String(message.error.message)}`,
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method !== "string") return;
    for (const listener of this.#listeners.get(message.method) ?? []) {
      listener(message.params ?? {});
    }
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

/**
 * Runtime exceptions and console errors are correctness failures. Screenshots
 * remain diagnostics; this event stream is one of the smoke test's hard gates.
 */
export function installBrowserFailureTracker(cdp) {
  const failures = [];
  const seen = new Set();
  const add = (kind, message) => {
    const normalized = String(message || "unknown browser error").trim();
    const key = `${kind}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    failures.push({ kind, message: normalized });
  };
  const dispose = [
    cdp.on("Runtime.exceptionThrown", (event) => {
      add("exception", formatExceptionDetails(event.exceptionDetails ?? event));
    }),
    cdp.on("Runtime.consoleAPICalled", (event) => {
      if (event.type !== "error") return;
      add("console.error", formatRemoteArguments(event.args));
    }),
    cdp.on("Log.entryAdded", (event) => {
      // Chrome reports missing optional resources (most commonly favicon.ico)
      // as network log errors. Those are not console/JavaScript exceptions;
      // product API failures still fail through DOM state, the strict stub
      // route ledger, and Domain readback.
      if (event.entry?.level !== "error" || event.entry?.source === "network") return;
      add("log.error", event.entry.text);
    }),
  ];
  return {
    failures,
    assertEmpty() {
      if (failures.length === 0) return;
      const summary = failures
        .slice(0, 8)
        .map((failure) => `${failure.kind}: ${failure.message}`)
        .join("\n");
      throw new Error(`Browser emitted ${failures.length} error event(s):\n${summary}`);
    },
    dispose() {
      for (const remove of dispose) remove();
    },
  };
}

/**
 * Record every page-owned network request after installation and fail if any
 * target is outside loopback. Chrome's resolver flags are defense in depth;
 * this CDP ledger is the acceptance assertion that makes
 * `externalNetwork:false` evidence-backed rather than a launch-time claim.
 */
export async function installLoopbackNetworkGuard(cdp) {
  const externalRequests = [];
  const seen = new Set();
  const observe = (rawUrl, kind) => {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) return;
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return;
    }
    if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
      return;
    }
    const key = `${kind}:${parsed.href}`;
    if (seen.has(key)) return;
    seen.add(key);
    externalRequests.push({ kind, url: parsed.href });
  };
  const dispose = [
    cdp.on("Network.requestWillBeSent", (event) => {
      observe(event.request?.url, event.type ?? "request");
    }),
    cdp.on("Network.webSocketCreated", (event) => {
      observe(event.url, "websocket");
    }),
  ];
  await cdp.send("Network.enable");
  return {
    externalRequests,
    assertExternalNetworkFalse() {
      if (externalRequests.length === 0) return;
      const detail = externalRequests
        .slice(0, 8)
        .map((request) => `${request.kind}: ${request.url}`)
        .join("\n");
      throw new Error(
        `Browser attempted ${externalRequests.length} external network request(s):\n${detail}`,
      );
    },
    dispose() {
      for (const remove of dispose) remove();
    },
  };
}

function waitForSocketOpen(socket, timeoutMs) {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Chrome DevTools WebSocket open timed out")), timeoutMs);
    const onOpen = () => finish();
    const onError = () => finish(new Error("Chrome DevTools WebSocket failed to open"));
    const onClose = () => finish(new Error("Chrome DevTools WebSocket closed before opening"));
    const finish = (error) => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
}

async function webSocketDataToText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (data && typeof data.text === "function") return data.text();
  return String(data);
}

function formatExceptionDetails(details) {
  return details?.exception?.description || details?.exception?.value || details?.text || "unknown exception";
}

function formatRemoteArguments(args) {
  if (!Array.isArray(args) || args.length === 0) return "console.error without arguments";
  return args
    .map((argument) => argument?.value ?? argument?.description ?? argument?.type ?? "unknown")
    .join(" ");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
