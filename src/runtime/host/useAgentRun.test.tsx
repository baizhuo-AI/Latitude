import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentClient, AgentRunResult, AgentProgressPage } from "./agentClient";
import { useAgentRun, mergeProgress } from "./useAgentRun";
import { LocalRuntimeError } from "./localHttp";

function fixture(recovered = false) {
  let finish!: (run: AgentRunResult) => void;
  const pending = new Promise<AgentRunResult>((resolve) => { finish = resolve; });
  const getProgress = vi.fn(async (_id: string, after = -1): Promise<AgentProgressPage> => ({
    runId: "run", after, next: 1, hasMore: false, phase: "working",
    items: after < 1 ? [{ seq: 1, kind: "reasoning", text: "核对实际记录" }] : [],
  }));
  const agent = {
    getLatestRun: vi.fn(async () => ({ run: recovered ? { runId: "run", status: "running" } : null })),
    getProgress, waitForRun: vi.fn(() => pending), cancelRun: vi.fn(), startTurn: vi.fn(),
  } as unknown as AgentClient;
  const onFinished = vi.fn(async () => {});
  return { agent, finish, getProgress, onFinished };
}

describe("live run recovery", () => {
  it("can retry discovery when the page initially opened offline", async () => {
    const f = fixture(true);
    vi.mocked(f.agent.getLatestRun).mockRejectedValueOnce(new LocalRuntimeError("离线", { code: "network_error", retryable: true }));
    const { result } = renderHook(() => useAgentRun(f.agent, "session", true, f.onFinished));
    await waitFor(() => expect(result.current.connectionError).toBe("离线"));
    act(() => result.current.reconnect());
    await waitFor(() => expect(result.current.activeRunId).toBe("run"));
    expect(f.agent.startTurn).not.toHaveBeenCalled();
  });

  it("renders reasoning before the final answer and does not duplicate it on the last read", async () => {
    const f = fixture();
    const { result } = renderHook(() => useAgentRun(f.agent, "session", true, f.onFinished));
    await waitFor(() => expect(f.agent.getLatestRun).toHaveBeenCalled());
    act(() => result.current.follow("run"));
    await waitFor(() => expect(result.current.progress[0]?.text).toBe("核对实际记录"));
    expect(f.onFinished).not.toHaveBeenCalled();
    act(() => f.finish({ runId: "run", status: "completed" }));
    await waitFor(() => expect(f.onFinished).toHaveBeenCalledTimes(1));
    expect(result.current.progress).toHaveLength(1);
    expect(result.current.activeRunId).toBeNull();
  });

  it("restores a running task and unmount only disconnects, never cancels or resubmits", async () => {
    const f = fixture(true);
    const view = renderHook(() => useAgentRun(f.agent, "session", true, f.onFinished));
    await waitFor(() => expect(view.result.current.activeRunId).toBe("run"));
    await waitFor(() => expect(view.result.current.progress).toHaveLength(1));
    view.unmount();
    expect(f.agent.cancelRun).not.toHaveBeenCalled();
    expect(f.agent.startTurn).not.toHaveBeenCalled();
    const again = renderHook(() => useAgentRun(f.agent, "session", true, f.onFinished));
    await waitFor(() => expect(again.result.current.activeRunId).toBe("run"));
    act(() => f.finish({ runId: "run", status: "completed" }));
    await waitFor(() => expect(f.onFinished).toHaveBeenCalledWith({ runId: "run", status: "completed" }, true));
  });

  it("reconnects after a transient network failure without cancelling the Host run", async () => {
    const f = fixture();
    vi.mocked(f.agent.waitForRun).mockRejectedValueOnce(new LocalRuntimeError("连接中断", { code: "network_error", retryable: true }));
    const { result } = renderHook(() => useAgentRun(f.agent, "session", true, f.onFinished));
    act(() => result.current.follow("run"));
    await waitFor(() => expect(result.current.connectionError).toBe("连接中断"));
    await waitFor(() => expect(f.agent.waitForRun).toHaveBeenCalledTimes(2), { timeout: 2500 });
    expect(f.agent.cancelRun).not.toHaveBeenCalled();
    act(() => f.finish({ runId: "run", status: "cancelled" }));
    await waitFor(() => expect(result.current.activeRunId).toBeNull());
  });

  it("updates each actual tool call and coalesces adjacent reasoning chunks", () => {
    expect(mergeProgress([], [
      { seq: 1, kind: "reasoning", text: "先" }, { seq: 2, kind: "reasoning", text: "核对" },
      { seq: 3, kind: "tool", text: "读取", callId: "a", state: "running" },
      { seq: 4, kind: "tool", text: "读取", callId: "a", state: "failed" },
    ])).toEqual([
      { seq: 1, kind: "reasoning", text: "先核对" },
      { seq: 3, kind: "tool", text: "读取", callId: "a", state: "failed" },
    ]);
  });
});
