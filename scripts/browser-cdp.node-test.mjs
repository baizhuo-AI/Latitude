import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserCdp,
  installBrowserFailureTracker,
  installLoopbackNetworkGuard,
} from "./browser-cdp.mjs";

test("BrowserCdp correlates command responses and emits protocol events", async () => {
  const socket = new FakeSocket((message, current) => {
    current.emitMessage({ id: message.id, result: { value: message.params.value } });
    current.emitMessage({ method: "Runtime.bindingCalled", params: { name: "fixture" } });
  });
  const cdp = await BrowserCdp.connect("ws://fixture", {
    webSocketFactory: () => socket,
  });
  const events = [];
  cdp.on("Runtime.bindingCalled", (event) => events.push(event));

  const response = await cdp.send("Fixture.command", { value: 42 });
  assert.deepEqual(response, { value: 42 });
  await nextTurn();
  assert.deepEqual(events, [{ name: "fixture" }]);
  await cdp.close();
});

test("BrowserCdp turns protocol errors and command timeouts into hard failures", async () => {
  const failingSocket = new FakeSocket((message, current) => {
    current.emitMessage({
      id: message.id,
      error: { code: -32_000, message: "fixture rejected" },
    });
  });
  const failing = await BrowserCdp.connect("ws://fixture", {
    webSocketFactory: () => failingSocket,
  });
  await assert.rejects(
    failing.send("Fixture.failure"),
    /Fixture\.failure failed \(-32000\): fixture rejected/u,
  );
  await failing.close();

  const silent = await BrowserCdp.connect("ws://fixture", {
    commandTimeoutMs: 20,
    webSocketFactory: () => new FakeSocket(),
  });
  await assert.rejects(silent.send("Fixture.timeout"), /command timed out: Fixture\.timeout/u);
  await silent.close();
});

test("browser failure tracker treats runtime exceptions and console errors as gates", async () => {
  const socket = new FakeSocket((message, current) => {
    current.emitMessage({ id: message.id, result: {} });
  });
  const cdp = await BrowserCdp.connect("ws://fixture", {
    webSocketFactory: () => socket,
  });
  const tracker = installBrowserFailureTracker(cdp);

  socket.emitMessage({
    method: "Runtime.exceptionThrown",
    params: { exceptionDetails: { exception: { description: "Uncaught Error: broken" } } },
  });
  socket.emitMessage({
    method: "Runtime.consoleAPICalled",
    params: { type: "error", args: [{ value: "console broke" }] },
  });
  socket.emitMessage({
    method: "Runtime.consoleAPICalled",
    params: { type: "log", args: [{ value: "allowed" }] },
  });
  socket.emitMessage({
    method: "Log.entryAdded",
    params: {
      entry: { level: "error", source: "network", text: "optional favicon missing" },
    },
  });
  await nextTurn();

  assert.deepEqual(tracker.failures, [
    { kind: "exception", message: "Uncaught Error: broken" },
    { kind: "console.error", message: "console broke" },
  ]);
  assert.throws(() => tracker.assertEmpty(), /Browser emitted 2 error event/u);
  tracker.dispose();
  await cdp.close();
});

test("loopback network guard records external page requests as hard failures", async () => {
  const socket = new FakeSocket((message, current) => {
    current.emitMessage({ id: message.id, result: {} });
  });
  const cdp = await BrowserCdp.connect("ws://fixture", {
    webSocketFactory: () => socket,
  });
  const guard = await installLoopbackNetworkGuard(cdp);

  socket.emitMessage({
    method: "Network.requestWillBeSent",
    params: { type: "Document", request: { url: "http://127.0.0.1:1420/" } },
  });
  socket.emitMessage({
    method: "Network.webSocketCreated",
    params: { url: "ws://localhost:43120/events" },
  });
  socket.emitMessage({
    method: "Network.requestWillBeSent",
    params: { type: "Fetch", request: { url: "https://telemetry.example.test/ping" } },
  });
  await nextTurn();

  assert.deepEqual(guard.externalRequests, [{
    kind: "Fetch",
    url: "https://telemetry.example.test/ping",
  }]);
  assert.throws(
    () => guard.assertExternalNetworkFalse(),
    /attempted 1 external network request/u,
  );
  guard.dispose();
  await cdp.close();
});

class FakeSocket {
  readyState = 0;
  #listeners = new Map();
  #onSend;

  constructor(onSend) {
    this.#onSend = onSend;
    queueMicrotask(() => {
      this.readyState = 1;
      this.#emit("open", {});
    });
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add({ listener, once: options.once === true });
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.#listeners.get(type);
    if (!listeners) return;
    for (const entry of listeners) {
      if (entry.listener === listener) listeners.delete(entry);
    }
  }

  send(raw) {
    this.#onSend?.(JSON.parse(raw), this);
  }

  emitMessage(message) {
    queueMicrotask(() => this.#emit("message", { data: JSON.stringify(message) }));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit("close", {});
  }

  #emit(type, event) {
    const listeners = this.#listeners.get(type);
    if (!listeners) return;
    for (const entry of [...listeners]) {
      entry.listener(event);
      if (entry.once) listeners.delete(entry);
    }
  }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}
