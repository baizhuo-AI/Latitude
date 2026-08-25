import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  DesktopRuntimeHealth,
  DesktopRuntimePort
} from "./DesktopRuntimePort";
import {
  DesktopRuntimeProvider,
  useDesktopRuntime
} from "./DesktopRuntimeProvider";

const roots: Array<ReturnType<typeof createRoot>> = [];
const reactActGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeAll(() => {
  reactActGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete reactActGlobal.IS_REACT_ACT_ENVIRONMENT;
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
});

function fakeRuntime(health: DesktopRuntimeHealth): DesktopRuntimePort {
  return {
    kind: "http",
    agent: {} as DesktopRuntimePort["agent"],
    health: vi.fn(async () => health),
    getContext: vi.fn(),
    applyChange: vi.fn(),
    listChangeSets: vi.fn(),
    createAction: vi.fn(),
    createCandidate: vi.fn(),
    commandCandidate: vi.fn(),
    listDueCandidates: vi.fn(),
    recordOutcome: vi.fn(),
    applyFeedback: vi.fn(),
    createWeeklyReview: vi.fn(),
    exportDomainData: vi.fn(),
    checkDomainIntegrity: vi.fn(),
    prepareDangerousData: vi.fn(),
    commitDangerousData: vi.fn(),
    runAgentTurn: vi.fn(),
    searchWeb: vi.fn()
  } as DesktopRuntimePort;
}

describe("DesktopRuntimeProvider", () => {
  it("把本机双服务健康状态注入组件树，并允许显式刷新", async () => {
    const health: DesktopRuntimeHealth = {
      state: "ready",
      checkedAt: "2026-08-24T12:00:00Z",
      agent: {
        service: "agent",
        state: "ready",
        checkedAt: "2026-08-24T12:00:00Z"
      },
      domain: {
        service: "domain",
        state: "ready",
        checkedAt: "2026-08-24T12:00:00Z"
      }
    };
    const runtime = fakeRuntime(health);
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);

    function Probe() {
      const { state, refreshHealth } = useDesktopRuntime();
      useEffect(() => {
        if (state === "ready") void refreshHealth();
      }, [refreshHealth, state]);
      return <span>{state}</span>;
    }

    await act(async () => {
      root.render(
        <DesktopRuntimeProvider runtime={runtime} healthPollMs={0}>
          <Probe />
        </DesktopRuntimeProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toBe("ready");
    expect(runtime.health).toHaveBeenCalledTimes(2);
  });
});
