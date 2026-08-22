/**
 * syncBus.test.ts — 跨窗口同步桥接单测(修复 4.2)
 *
 * 重点覆盖「后端 latitude://data-changed → 前端 syncBus」的 memory 孤儿桥:
 *  1. dataChangedToSyncTopic 纯函数:memory 转嫁,其余返回 null(不重复广播)
 *  2. bridgeDataChangedToSync:收到 payload="memory" 的 data-changed → emitSync("memory")
 *  3. 非 memory payload 不转嫁(避免与 useDataSync 的 data-changed 路径双触发 hydrate)
 *  4. 取消函数会 unlisten
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── mock Tauri event:emit 用来断言转嫁;listen 默认不挂(测试注入假 listen) ──────
const emitSpy = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("@tauri-apps/api/event", () => ({
  emit: (...args: unknown[]) => emitSpy(...args),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import {
  dataChangedToSyncTopic,
  bridgeDataChangedToSync,
} from "./syncBus";

const EVENT_NAME = "latitude-sync";

beforeEach(() => {
  emitSpy.mockClear();
});

describe("dataChangedToSyncTopic", () => {
  it("把后端 'memory' 转嫁成 syncBus 的 memory topic", () => {
    expect(dataChangedToSyncTopic("memory")).toBe("memory");
  });

  it("其余 topic 返回 null(已由 useDataSync 的 data-changed 路径直接消费,不重复广播)", () => {
    for (const p of ["todos", "goals", "activities", "calendar_events", "conversations", "", "unknown"]) {
      expect(dataChangedToSyncTopic(p)).toBeNull();
    }
  });
});

describe("bridgeDataChangedToSync", () => {
  /** 造一个假 listen:捕获回调,返回可断言被调用的 unlisten */
  function makeFakeListen() {
    const unlisten = vi.fn();
    let captured: ((event: { payload: string }) => void) | null = null;
    const listenFn = vi.fn((_event: string, cb: (e: { payload: string }) => void) => {
      captured = cb;
      return Promise.resolve(unlisten);
    });
    return {
      listenFn: listenFn as unknown as Parameters<typeof bridgeDataChangedToSync>[0],
      fire: (payload: string) => captured?.({ payload }),
      unlisten,
      raw: listenFn,
    };
  }

  it("监听的是后端 data-changed 事件名", async () => {
    const fake = makeFakeListen();
    bridgeDataChangedToSync(fake.listenFn);
    await Promise.resolve();
    expect(fake.raw).toHaveBeenCalledWith(
      "latitude://data-changed",
      expect.any(Function)
    );
  });

  it("收到 payload='memory' → emitSync('memory')(发到 syncBus 事件)", async () => {
    const fake = makeFakeListen();
    bridgeDataChangedToSync(fake.listenFn);
    await Promise.resolve();
    fake.fire("memory");
    expect(emitSpy).toHaveBeenCalledTimes(1);
    const call = emitSpy.mock.calls[0] as unknown as [string, { topic: string }];
    expect(call[0]).toBe(EVENT_NAME);
    expect(call[1].topic).toBe("memory");
  });

  it("非 memory payload 不转嫁(不调 emit,避免双触发)", async () => {
    const fake = makeFakeListen();
    bridgeDataChangedToSync(fake.listenFn);
    await Promise.resolve();
    fake.fire("todos");
    fake.fire("goals");
    fake.fire("calendar_events");
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("取消函数会 unlisten", async () => {
    const fake = makeFakeListen();
    const off = bridgeDataChangedToSync(fake.listenFn);
    await Promise.resolve(); // 让 listen Promise 解析,unlisten 被存下
    off();
    expect(fake.unlisten).toHaveBeenCalledTimes(1);
  });
});
