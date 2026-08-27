import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopRuntimeHealth,
  DesktopRuntimePort,
  KnowledgeContext,
} from "../../runtime/host";
import {
  BROWSER_LAYOUT_COMPONENT_IDS,
  layoutV1ToUiSurfaceV2,
} from "../../runtime/composition/browserProduction";
import { SEED_LAYOUT_DOCUMENT } from "../../runtime/layout/seedLayout";
import { BrowserLiveDimensionApp } from "./BrowserLiveDimensionApp";
import {
  BROWSER_SESSION_STORAGE_KEY,
  type BrowserRecoveryBackup,
  type BrowserRecoveryStore,
  createBrowserProfile,
} from "./browserProfile";

function memoryRecoveryStore(): BrowserRecoveryStore {
  let backup: BrowserRecoveryBackup | null = null;
  return {
    saveLatest: async (next) => {
      backup = structuredClone(next);
    },
    loadLatest: async () => backup ? structuredClone(backup) : null,
    clear: async () => {
      backup = null;
    },
  };
}

function readyHealth(): DesktopRuntimeHealth {
  const checkedAt = "2026-08-24T12:00:00Z";
  return {
    state: "ready",
    checkedAt,
    agent: { service: "agent", state: "ready", checkedAt },
    domain: { service: "domain", state: "ready", checkedAt },
  };
}

function closureRuntime() {
  let context: KnowledgeContext = {
    nodes: [
      {
        id: "evidence-1",
        kind: "evidence_event",
        label: "三次上午写作记录",
        statement: "三次都在 25 分钟内进入状态",
        authority: "source_verified",
      },
    ],
    edges: [],
  };

  const getContext = vi.fn(async () => structuredClone(context));
  const recordOutcome = vi.fn(async (request: Parameters<DesktopRuntimePort["recordOutcome"]>[0]) => {
    context = {
      ...context,
      nodes: [
        ...context.nodes.map((node) =>
          node.id === request.actionId
            ? { ...node, status: "concluded", outcome: request.outcome }
            : node,
        ),
        {
          id: "outcome-1",
          kind: "outcome",
          label: request.label ?? "行动结果",
          statement: request.outcome,
          authority: "system_recorded",
        },
      ],
    };
    return {
      ok: true,
      changeSetId: "cs-outcome",
      value: { id: "outcome-1", actionId: request.actionId, outcome: request.outcome },
    };
  });
  const createWeeklyReview = vi.fn(async () => {
    context = {
      ...context,
      nodes: [
        ...context.nodes,
        {
          id: "review-1",
          kind: "insight",
          label: "本周现实回顾",
          statement: "证据形成行动，行动留下了一个真实结果。",
          payload: { reviewType: "weekly" },
          authority: "system_inferred",
        },
      ],
    };
    return {
      ok: true,
      changeSetId: "cs-review",
      value: { node: context.nodes[context.nodes.length - 1] },
    };
  });

  const runtime: DesktopRuntimePort = {
    kind: "http",
    health: vi.fn(async () => readyHealth()),
    getContext,
    applyChange: vi.fn(async () => ({ ok: true, changeSetId: "cs-change", value: null })),
    listChangeSets: vi.fn(async () => []),
    createAction: vi.fn(),
    createCandidate: vi.fn(),
    commandCandidate: vi.fn(),
    listDueCandidates: vi.fn(async () => ({
      ok: true,
      dueBefore: new Date().toISOString(),
      sensitivityCeiling: "highest",
      items: [],
    })),
    exportDomainData: vi.fn(),
    checkDomainIntegrity: vi.fn(),
    prepareDangerousData: vi.fn(),
    commitDangerousData: vi.fn(),
    recordOutcome,
    applyFeedback: vi.fn(async () => ({ ok: true, changeSetId: "cs-feedback", value: {} })),
    createWeeklyReview,
    runAgentTurn: vi.fn(),
    searchWeb: vi.fn(async (request) => ({ query: request.query, results: [] })),
    agent: {
      health: vi.fn(async () => ({ ok: true })),
      startTurn: vi.fn(async () => ({ runId: "run-1", status: "queued" as const })),
      getRun: vi.fn(),
      waitForRun: vi.fn(async () => {
        context = {
          ...context,
          nodes: [
            ...context.nodes,
            {
              id: "action-1",
              kind: "action",
              label: "验证上午写作",
              statement: "连续三天在上午写 25 分钟",
              expectedOutcome: "至少两天完成 500 字",
              trigger: "工作日早上九点坐到书桌前",
              observationWindow: { duration: "连续 3 天" },
              reviewAt: "2020-01-01T09:00:00Z",
              status: "active",
              authority: "system_inferred",
              payload: { claimId: "claim-1" },
            },
          ],
        };
        return {
          runId: "run-1",
          status: "completed" as const,
          result: {
            runId: "run-1",
            sessionId: "session-test",
            status: "completed" as const,
            assistantText: "我已基于证据建立一个带回看时间的行动。",
            stepsUsed: 2,
            toolCallsUsed: 1,
            startedAt: "2026-08-24T12:00:00Z",
            finishedAt: "2026-08-24T12:00:01Z",
          },
        };
      }),
      cancelRun: vi.fn(),
      listMessages: vi.fn(async () => ({ sessionId: "session-test", messages: [] })),
      listSchedulerOutbox: vi.fn(async () => ({ items: [] })),
      acknowledgeSchedulerOutbox: vi.fn(),
      exportState: vi.fn(),
      checkIntegrity: vi.fn(),
      prepareDangerousData: vi.fn(),
      commitDangerousData: vi.fn(),
      search: vi.fn(async (request) => ({ query: request.query, results: [] })),
    },
  };
  return { runtime, getContext, recordOutcome, createWeeklyReview };
}

describe("BrowserLiveDimensionApp 产品闭环", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  async function openDataSafety(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "设置" }));
    const diagnostics = screen.getByRole("dialog", { name: "本地服务诊断" });
    expect(diagnostics).toHaveClass("dimension-root");
    await user.click(within(diagnostics).getByRole("button", { name: "数据与安全…" }));
    expect(screen.getByRole("dialog", { name: "数据与安全" })).toBeInTheDocument();
  }

  it("把 evidence → Agent action → outcome → weekly review 接成真实 UI 写回", async () => {
    const user = userEvent.setup();
    const { runtime, recordOutcome, createWeeklyReview } = closureRuntime();
    render(
      <BrowserLiveDimensionApp
        runtime={runtime}
        healthPollMs={0}
        profileRecoveryStore={memoryRecoveryStore()}
      />,
    );

    await waitFor(() => expect(runtime.getContext).toHaveBeenCalled());
    expect(screen.getAllByText("现在没有未闭环的行动").length).toBeGreaterThan(0);

    await user.type(
      screen.getByRole("textbox", { name: "跟秘书说话" }),
      "根据现有证据创建一个能回收结果的小行动",
    );
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(screen.getAllByText("验证上午写作").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "查看来源：来自你的行动" }));
    const sourceDialog = screen.getByRole("dialog", { name: "图谱来源详情" });
    expect(sourceDialog).toHaveClass("dimension-root");
    await user.click(within(sourceDialog).getByRole("button", { name: "合上" }));
    expect(runtime.agent.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "根据现有证据创建一个能回收结果的小行动",
        sessionId: expect.stringMatching(/^latitude-browser-/),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(runtime.agent.waitForRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ pollIntervalMs: 350 }),
    );

    await user.click(screen.getByRole("button", { name: "完成：验证上午写作" }));
    const outcomeDialog = screen.getByRole("dialog", { name: "回收行动结果" });
    expect(outcomeDialog).toHaveClass("dimension-root");
    expect(outcomeDialog).toHaveStyle({ zIndex: "100" });
    expect(outcomeDialog).toHaveTextContent("原本预期：至少两天完成 500 字");
    expect(outcomeDialog).toHaveTextContent("触发情境：工作日早上九点坐到书桌前");
    expect(outcomeDialog).toHaveTextContent("观察窗口：连续 3 天");
    await user.type(screen.getByRole("textbox", { name: "实际结果" }), "三天里有两天完成了 600 字");
    await user.selectOptions(screen.getByRole("combobox", { name: "对认知的影响" }), "confirms");
    await user.click(screen.getByRole("button", { name: "写入真实结果" }));

    await waitFor(() => {
      expect(recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "action-1",
          outcome: "三天里有两天完成了 600 字",
          effect: "confirms",
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText(/到了结果窗口，秘书在等你回收真实结果/))
        .not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "周回顾" }));
    await waitFor(() => expect(createWeeklyReview).toHaveBeenCalledOnce());
    await waitFor(() => {
      expect(screen.getByText("证据形成行动，行动留下了一个真实结果。")).toBeInTheDocument();
    });
  });

  it("从真实候选投影推进或搁置，3 天 due 只提示且只走 typed command", async () => {
    const user = userEvent.setup();
    const runtime = closureRuntime().runtime;
    const candidate = {
      id: "candidate-browser-1",
      kind: "experiment",
      label: "把上午写作变成可持续节律",
      statement: "先观察哪一种启动方式值得继续共创",
      status: "proposed",
      payload: {
        interventionType: "candidate",
        candidateState: "proposed",
        proposedSilenceDueAt: "2026-08-20T12:00:00Z",
      },
    };
    vi.mocked(runtime.getContext)
      .mockResolvedValueOnce({ nodes: [candidate], edges: [] })
      .mockResolvedValueOnce({
        nodes: [{
          ...candidate,
          status: "active",
          payload: { ...candidate.payload, candidateState: "touched" },
        }],
        edges: [],
      })
      .mockResolvedValueOnce({
        nodes: [{
          ...candidate,
          status: "parked",
          payload: { ...candidate.payload, candidateState: "parked" },
        }],
        edges: [],
      });
    vi.mocked(runtime.listDueCandidates).mockResolvedValue({
      ok: true,
      dueBefore: "2026-08-24T12:00:00Z",
      sensitivityCeiling: "highest",
      mutationPolicy: "due queries never transition, conclude, or park candidates",
      items: [{
        candidate,
        dueKind: "proposed_silence",
        dueAt: "2026-08-20T12:00:00Z",
        receiptKey: "candidate:browser:proposed",
        recommendedCommand: "acknowledge_due",
        prompt: "这个候选已经安静放了 3 天。要不要先搁置？",
      }],
    });
    vi.mocked(runtime.commandCandidate).mockResolvedValue({
      ok: true,
      changeSetId: "candidate-browser-change",
      value: {
        candidate,
        receipt: {
          command: "touch",
          previousState: "proposed",
          state: "touched",
          recordedAt: "2026-08-24T12:00:00Z",
          changeSetId: "candidate-browser-change",
        },
      },
    });

    render(
      <BrowserLiveDimensionApp
        runtime={runtime}
        healthPollMs={0}
        profileRecoveryStore={memoryRecoveryStore()}
      />,
    );

    expect(await screen.findByRole("region", { name: "候选共创" })).toHaveTextContent(
      "把上午写作变成可持续节律",
    );
    await waitFor(() => {
      expect(runtime.commandCandidate).toHaveBeenCalledWith({
        candidateId: "candidate-browser-1",
        command: "acknowledge_due",
        audit: expect.objectContaining({ actor: "system" }),
      }, { idempotencyKey: "candidate-due:candidate:browser:proposed" });
    });
    expect(screen.getByRole("region", { name: "候选共创" })).toHaveTextContent("候选 ·");
    expect(screen.getByRole("region", { name: "候选共创" })).not.toHaveTextContent("已搁置");
    await user.click(screen.getByRole("button", {
      name: "看看：把上午写作变成可持续节律",
    }));
    await waitFor(() => {
      expect(runtime.commandCandidate).toHaveBeenCalledWith({
        candidateId: "candidate-browser-1",
        command: "touch",
        audit: expect.objectContaining({ actor: "user" }),
      });
    });
    expect(await screen.findByText(/已查看 · 先观察哪一种启动方式值得继续共创/))
      .toBeInTheDocument();

    await user.click(screen.getByRole("button", {
      name: "先搁置：把上午写作变成可持续节律",
    }));
    await waitFor(() => {
      expect(runtime.commandCandidate).toHaveBeenLastCalledWith({
        candidateId: "candidate-browser-1",
        command: "park",
        audit: expect.objectContaining({ actor: "user" }),
      });
    });
    expect(await screen.findByText(/已搁置 · 先观察哪一种启动方式值得继续共创/))
      .toBeInTheDocument();
  });

  it("塑形 7 天的轻提醒展示后只写 delivery receipt，不伪造结论", async () => {
    const runtime = closureRuntime().runtime;
    const candidate = {
      id: "candidate-shaping-due",
      kind: "experiment",
      label: "仍在塑形的候选",
      statement: "这条候选还没有得到用户结论",
      status: "shaping",
      payload: {
        interventionType: "candidate",
        candidateState: "shaping",
        shapingFollowupDueAt: "2026-08-20T12:00:00Z",
      },
    };
    vi.mocked(runtime.getContext).mockResolvedValue({ nodes: [candidate], edges: [] });
    vi.mocked(runtime.listDueCandidates).mockResolvedValue({
      ok: true,
      dueBefore: "2026-08-24T12:00:00Z",
      sensitivityCeiling: "highest",
      items: [{
        candidate,
        dueKind: "shaping_followup",
        dueAt: "2026-08-20T12:00:00Z",
        receiptKey: "candidate:shaping:followup",
        recommendedCommand: "acknowledge_due",
        prompt: "这个候选已经塑形 7 天。还要继续共创吗？",
      }],
    });
    vi.mocked(runtime.commandCandidate).mockResolvedValue({
      ok: true,
      changeSetId: "candidate-prompt-receipt",
      value: {
        candidate,
        receipt: {
          command: "acknowledge_due",
          previousState: "shaping",
          state: "shaping",
          dueKind: "shaping_followup",
          recordedAt: "2026-08-24T12:00:00Z",
          changeSetId: "candidate-prompt-receipt",
        },
      },
    });

    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);

    expect((await screen.findAllByText("这个候选已经塑形 7 天。还要继续共创吗？")).length)
      .toBeGreaterThan(0);
    await waitFor(() => {
      expect(runtime.commandCandidate).toHaveBeenCalledTimes(1);
      expect(runtime.commandCandidate).toHaveBeenCalledWith({
        candidateId: "candidate-shaping-due",
        command: "acknowledge_due",
        audit: expect.objectContaining({ actor: "system" }),
      }, { idempotencyKey: "candidate-due:candidate:shaping:followup" });
    });
    expect(screen.getByRole("region", { name: "候选共创" })).toHaveTextContent("整理中");
    expect(screen.getByRole("region", { name: "候选共创" })).not.toHaveTextContent("已形成结论");
  });

  it("把结构化观察窗口显示为可读时间，而不是泄漏 JSON", async () => {
    const user = userEvent.setup();
    const runtime = closureRuntime().runtime;
    vi.mocked(runtime.getContext).mockResolvedValue({
      nodes: [
        {
          id: "action-window-1",
          kind: "action",
          label: "验证时间回收",
          expectedOutcome: "形成一次可读回收",
          trigger: "本地服务启动后",
          observationWindow: {
            startsAt: "2026-08-24T18:00:00.000Z",
            endsAt: "2026-08-24T20:00:00.000Z",
          },
          reviewAt: "2020-01-01T09:00:00Z",
          status: "active",
        },
      ],
      edges: [],
    });
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);

    await user.click(await screen.findByRole("button", { name: "完成：验证时间回收" }));
    const dialog = screen.getByRole("dialog", { name: "回收行动结果" });
    expect(dialog).toHaveTextContent(/观察窗口：.+至.+/);
    expect(dialog).not.toHaveTextContent(/\{"endsAt"/);
  });

  it("contracts / revises 必须提交新 statement，并显式提供 refutes", async () => {
    const user = userEvent.setup();
    const { runtime, recordOutcome } = closureRuntime();
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);
    await waitFor(() => expect(runtime.getContext).toHaveBeenCalled());

    await user.type(
      screen.getByRole("textbox", { name: "跟秘书说话" }),
      "建立行动并回收结果",
    );
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(screen.getAllByText("验证上午写作").length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: "完成：验证上午写作" }));

    expect(screen.getByRole("option", { name: "现实反驳了原判断" })).toHaveValue("refutes");
    await user.type(screen.getByRole("textbox", { name: "实际结果" }), "只有一天完成");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "对认知的影响" }),
      "contracts",
    );
    const submit = screen.getByRole("button", { name: "写入真实结果" });
    expect(submit).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "认知修订" }),
      "只在前一晚睡眠超过七小时时，上午写作更稳定",
    );
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => {
      expect(recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          effect: "contracts",
          revisedStatement: "只在前一晚睡眠超过七小时时，上午写作更稳定",
        }),
      );
    });
  });

  it("资讯三键通过 typed applyFeedback 写入 Domain，不只留在 React state", async () => {
    const user = userEvent.setup();
    const runtime = closureRuntime().runtime;
    vi.mocked(runtime.getContext).mockResolvedValue({
      nodes: [
        {
          id: "resource-web-1",
          kind: "resource",
          label: "有来源的新研究",
          statement: "一条已经落入 Domain 的资讯。",
          payload: {
            query: "上午写作专注力",
            url: "https://example.test/research",
            title: "有来源的新研究",
            retrievedAt: "2026-08-24T11:30:00Z",
            provider: "deepseek-official",
            contentHash: "hash-research",
            evidenceRefId: "evidence-ref-web-1",
            untrustedContent: true,
            promptAuthority: "none",
          },
        },
      ],
      edges: [],
    });
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);

    expect((await screen.findAllByText("有来源的新研究")).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "有新角度" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "已知道" }).length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole("button", { name: "没用" })[0]);

    await waitFor(() => {
      expect(runtime.applyFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          feedbackType: "reject",
          targetNodeId: "resource-web-1",
          evidenceRefs: [],
          correctedScope: {
            curatorFeedback: expect.objectContaining({
              feedback: "not-useful",
              url: "https://example.test/research",
              provider: "deepseek-official",
              contentHash: "hash-research",
            }),
          },
        }),
      );
    });
  });

  it("刷新浏览器后按持久 sessionId 从 Host 读回对话", async () => {
    window.localStorage.setItem("latitude.browser-agent.session.v1", "latitude-browser-persisted");
    const runtime = closureRuntime().runtime;
    vi.mocked(runtime.agent.listMessages).mockResolvedValue({
      sessionId: "latitude-browser-persisted",
      messages: [
        {
          id: "host-message-1",
          role: "assistant",
          content: "这是刷新前已经完成并持久化的回复。",
          createdAt: "2026-08-24T12:00:00Z",
        },
      ],
    });
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);

    await waitFor(() => {
      expect(runtime.agent.listMessages).toHaveBeenCalledWith(
        "latitude-browser-persisted",
        expect.objectContaining({ retries: 1 }),
      );
    });
    await userEvent.click(screen.getByRole("button", { name: "打开对话" }));
    expect(screen.getByText("这是刷新前已经完成并持久化的回复。")).toBeInTheDocument();
  });

  it("Browser Live ignores legacy whole-card semantic payload overrides", async () => {
    window.localStorage.setItem(
      "dim-card-edits-latitude-browser-live",
      JSON.stringify({
        bindings: {
          "desktop.flex": {
            kind: "note",
            body: "伪造的本地长期认知",
            quote: "这段内容没有经过 Domain",
          },
        },
        presentations: {},
        threadBindings: {},
        threadPresentations: {},
      }),
    );
    const { runtime } = closureRuntime();
    const { container } = render(
      <BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />,
    );

    await waitFor(() => expect(runtime.getContext).toHaveBeenCalled());
    expect(screen.queryByText("伪造的本地长期认知")).not.toBeInTheDocument();
    expect(screen.getAllByText("图谱里还没有可投影的认知。").length).toBeGreaterThan(0);
    expect(container.querySelector("[data-card-editable='true']")).toBeNull();
  });

  it("消费图谱中的 AI ui_change_set，并通过同一白名单实际改变桌面", async () => {
    const runtime = closureRuntime().runtime;
    vi.mocked(runtime.getContext).mockResolvedValue({
      nodes: [
        {
          id: "resource-ui-1",
          kind: "resource",
          label: "UI customization: 隐藏早报",
          statement: "当前只保留行动闭环",
          payload: {
            resourceType: "ui_change_set",
            schemaVersion: 2,
            surfaceId: "latitude-browser-live",
            // Host/Domain 仍保留旧字段供已持久资源恢复；Browser 以 surfaceId 为准。
            baseLayoutId: "latitude-browser-live",
            baseRevision: 3,
            operations: [
              { op: "set_visibility", componentId: "seed-feed", visible: false },
              { op: "set_span", componentId: "seed-schedule", span: 12 },
              { op: "set_title", componentId: "seed-schedule", title: "AI 调整后的行动" },
            ],
          },
        },
      ],
      edges: [],
    });
    const { container } = render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);

    await waitFor(() => {
      expect(container.querySelector('[data-layout-card-id="seed-feed"]')).not.toBeInTheDocument();
    });
    const schedule = container.querySelector('[data-layout-card-id="seed-schedule"]');
    expect(schedule?.closest("[data-span]")).toHaveAttribute("data-span", "12");
    expect(screen.getByText("AI 调整后的行动")).toBeInTheDocument();
  });

  it("AI resource 通过同一 surface 隐藏秘书栏/解绑 chat，用户可从左侧安全唤回", async () => {
    const user = userEvent.setup();
    const runtime = closureRuntime().runtime;
    vi.mocked(runtime.getContext).mockResolvedValue({
      nodes: [
        {
          id: "resource-ui-companion-1",
          kind: "resource",
          label: "UI customization: 暂时收起秘书",
          statement: "暂时收起桌宠并关闭聊天入口",
          payload: {
            resourceType: "ui_change_set",
            schemaVersion: 2,
            surfaceId: "latitude-browser-live",
            baseRevision: 3,
            operations: [
              {
                op: "set_visibility",
                componentId: "secretary-companion",
                visible: false,
              },
              {
                op: "bind_action",
                componentId: "secretary-companion",
                event: "chat",
                commandId: null,
              },
            ],
          },
        },
      ],
      edges: [],
    });
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);

    const restore = await screen.findByRole("button", { name: "唤回秘书" });
    expect(JSON.parse(window.localStorage.getItem(
      "latitude.browser-ui-composition.v2:latitude-browser-live",
    )!).document.components.find(
      (item: { id: string }) => item.id === "secretary-companion",
    )).toMatchObject({
      visible: false,
      actions: {
        review: "latitude.companion.review",
        outcome: "latitude.companion.outcome",
      },
    });

    await user.click(restore);
    expect(await screen.findByRole("button", { name: "查看" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "聊聊" })).not.toBeInTheDocument();
  });

  it("AI resource 对系统模块的显隐和解绑落进同一 surface，并让不可用动作明确禁用", async () => {
    const runtime = closureRuntime().runtime;
    vi.mocked(runtime.getContext).mockResolvedValue({
      nodes: [
        {
          id: "resource-ui-system-1",
          kind: "resource",
          label: "UI customization: 专注桌面",
          statement: "暂时收起运行控制并关闭发送入口",
          payload: {
            resourceType: "ui_change_set",
            schemaVersion: 2,
            surfaceId: "latitude-browser-live",
            baseRevision: 3,
            operations: [
              {
                op: "set_visibility",
                componentId: "browser-control-strip",
                visible: false,
              },
              {
                op: "bind_action",
                componentId: "command-bar",
                event: "send",
                commandId: null,
              },
            ],
          },
        },
      ],
      edges: [],
    });
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "本地产品闭环控制" }))
        .not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    });
    const persisted = JSON.parse(window.localStorage.getItem(
      "latitude.browser-ui-composition.v2:latitude-browser-live",
    )!);
    expect(persisted.document.components.find(
      (component: { id: string }) => component.id === "browser-control-strip",
    )).toMatchObject({ visible: false });
    expect(persisted.document.components.find(
      (component: { id: string }) => component.id === "command-bar",
    ).actions).not.toHaveProperty("send");
    expect(persisted.changes[0]).toMatchObject({
      actor: "model",
      sourceRunId: "resource-ui-system-1",
    });
  });

  it("组件回滚递增 revision 后立即重建控制面板草稿", async () => {
    const user = userEvent.setup();
    const runtime = closureRuntime().runtime;
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);
    await waitFor(() => expect(runtime.getContext).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "调整桌面" }));
    const title = screen.getByRole("textbox", { name: "schedule 标题" });
    const originalTitle = (title as HTMLInputElement).value;
    await user.clear(title);
    await user.type(title, "临时验收标题");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await user.click(screen.getByRole("button", { name: "调整桌面" }));
    expect(screen.getByRole("textbox", { name: "schedule 标题" })).toHaveValue(
      "临时验收标题",
    );
    await user.click(screen.getByText("变更记录"));
    await user.click(screen.getByRole("button", { name: "反转这条操作" }));

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "schedule 标题" })).toHaveValue(
        originalTitle,
      );
    });
  });

  it("浏览器生产桌面可以移除卡片并从添加入口恢复", async () => {
    const user = userEvent.setup();
    const runtime = closureRuntime().runtime;
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);
    await waitFor(() => expect(runtime.getContext).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "从桌面移除：当前认知张力" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "当前认知张力" }))
        .not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "＋ 添加卡片" }));
    await user.click(screen.getByRole("button", { name: "+ 当前认知张力" }));
    expect(await screen.findByRole("heading", { name: "当前认知张力" }))
      .toBeInTheDocument();
  });

  it("默认数据安全 adapter 要求两个服务使用同一确认短语并执行两阶段可恢复清空", async () => {
    const user = userEvent.setup();
    const runtime = closureRuntime().runtime;
    vi.mocked(runtime.exportDomainData).mockResolvedValue({
      format: "latitude.constellation.export@0.1",
      schemaVersion: "2",
      exportedAt: "2026-08-24T12:00:00Z",
      checksum: `sha256:${"d".repeat(64)}`,
      data: { nodes: [] },
    });
    vi.mocked(runtime.agent.exportState).mockResolvedValue({
      schemaVersion: 1,
      exportedAt: "2026-08-24T12:00:00Z",
      checksum: "a".repeat(64),
      files: {},
    });
    vi.mocked(runtime.prepareDangerousData).mockResolvedValue({
      ok: true,
      operation: "delete_all",
      token: "danger-delete-1",
      expiresAt: "2099-08-24T12:10:00Z",
      requiredConfirmation: "DELETE ALL LOCAL DATA",
    });
    vi.mocked(runtime.commitDangerousData).mockResolvedValue({
      ok: true,
      changeSetId: "cs-delete",
      value: null,
    });
    vi.mocked(runtime.agent.prepareDangerousData).mockResolvedValue({
      operation: "delete_all",
      token: "agent-delete-1",
      expiresAt: "2099-08-24T12:05:00Z",
      confirmationPhrase: "DELETE ALL LOCAL DATA",
    });
    vi.mocked(runtime.agent.commitDangerousData).mockResolvedValue({
      ok: true,
      operation: "delete_all",
      checksum: "0".repeat(64),
      backupPath: "/local/agent-backup",
      restartRequired: true,
    });
    render(
      <BrowserLiveDimensionApp
        runtime={runtime}
        healthPollMs={0}
        profileRecoveryStore={memoryRecoveryStore()}
      />,
    );
    await waitFor(() => expect(runtime.getContext).toHaveBeenCalled());
    await openDataSafety(user);

    await user.click(screen.getByRole("button", { name: "第一步：准备可恢复清空" }));
    expect(await screen.findByText("DELETE ALL LOCAL DATA")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("完整可恢复备份已写入并读回");
    const confirmation = screen.getByRole("textbox", { name: "危险操作确认短语" });
    const commit = screen.getByRole("button", { name: "第二步：确认执行" });
    expect(commit).toBeDisabled();
    await user.type(confirmation, "DELETE ALL LOCAL DATA");
    expect(commit).toBeEnabled();
    await user.click(commit);

    await waitFor(() => {
      expect(runtime.commitDangerousData).toHaveBeenCalledWith({
        token: "danger-delete-1",
        confirmation: "DELETE ALL LOCAL DATA",
      });
      expect(runtime.agent.commitDangerousData).toHaveBeenCalledWith({
        token: "agent-delete-1",
        confirmation: "DELETE ALL LOCAL DATA",
      });
    });
  });

  it("完整 browser profile 恢复时分别交付 Domain/Agent snapshot，并恢复 UI 与会话身份", async () => {
    const user = userEvent.setup();
    const runtime = closureRuntime().runtime;
    const domain = {
      format: "latitude.constellation.export@0.1" as const,
      schemaVersion: "2",
      exportedAt: "2026-08-24T12:00:00Z",
      checksum: `sha256:${"1".repeat(64)}`,
      data: { nodes: [] },
    };
    const agent = {
      schemaVersion: 1 as const,
      exportedAt: "2026-08-24T12:00:00Z",
      checksum: "2".repeat(64),
      files: {},
    };
    const legacyLayout = structuredClone(SEED_LAYOUT_DOCUMENT);
    legacyLayout.id = "latitude-browser-live";
    legacyLayout.revision = 3;
    const legacyFiveSurface = layoutV1ToUiSurfaceV2(legacyLayout);
    legacyFiveSurface.components = legacyFiveSurface.components.filter((item) =>
      BROWSER_LAYOUT_COMPONENT_IDS.includes(
        item.id as (typeof BROWSER_LAYOUT_COMPONENT_IDS)[number],
      ));
    const profile = await createBrowserProfile({
      domain,
      agent,
      uiComposition: {
        format: "latitude.browser-ui-composition@0.2",
        exportedAt: "2026-08-24T12:00:00Z",
        documents: {
          "latitude-browser-live": {
            document: legacyFiveSurface,
            changes: [],
          },
        },
      },
      browserState: {
        agentSessionId: "latitude-browser-restored-session",
        localStorage: {
          "dim-rail-collapsed": "1",
          "latitude.secretary-companion.v1": JSON.stringify({
            x: 123,
            y: 234,
            hidden: true,
          }),
        },
      },
      exportedAt: "2026-08-24T12:00:00Z",
    });
    vi.mocked(runtime.prepareDangerousData).mockResolvedValue({
      ok: true,
      operation: "restore",
      token: "danger-restore-1",
      expiresAt: "2099-08-24T12:10:00Z",
      requiredConfirmation: "RESTORE LOCAL DATA",
      snapshotChecksum: domain.checksum,
    });
    vi.mocked(runtime.commitDangerousData).mockResolvedValue({
      ok: true,
      changeSetId: "cs-restore",
      value: null,
    });
    vi.mocked(runtime.agent.prepareDangerousData).mockResolvedValue({
      operation: "restore",
      token: "agent-restore-1",
      expiresAt: "2099-08-24T12:05:00Z",
      confirmationPhrase: "RESTORE LOCAL DATA",
      snapshot: agent,
    });
    vi.mocked(runtime.agent.commitDangerousData).mockResolvedValue({
      ok: true,
      operation: "restore",
      checksum: agent.checksum,
      backupPath: "/local/agent-backup",
      restartRequired: true,
    });
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);
    await waitFor(() => expect(runtime.getContext).toHaveBeenCalled());
    await openDataSafety(user);
    window.localStorage.setItem(
      "latitude.browser-ui-composition.v1:obsolete-layout",
      JSON.stringify({ stale: true }),
    );

    const file = new File([JSON.stringify(profile)], "latitude-profile.json", {
      type: "application/json",
    });
    Object.defineProperty(file, "text", {
      configurable: true,
      value: async () => JSON.stringify(profile),
    });
    await user.upload(screen.getByLabelText("选择恢复文件"), file);
    await screen.findByText(/文件已检查/);
    await user.click(screen.getByRole("button", { name: "第一步：准备完整恢复" }));
    await waitFor(() => {
      expect(runtime.prepareDangerousData).toHaveBeenCalledWith({
        operation: "restore",
        snapshot: domain,
      });
      expect(runtime.agent.prepareDangerousData).toHaveBeenCalledWith({
        operation: "restore",
        snapshot: agent,
      });
    });
    await user.type(
      screen.getByRole("textbox", { name: "危险操作确认短语" }),
      "RESTORE LOCAL DATA",
    );
    await user.click(screen.getByRole("button", { name: "第二步：确认执行" }));
    await waitFor(() => expect(runtime.commitDangerousData).toHaveBeenCalledOnce());
    expect(
      window.localStorage.getItem("latitude.browser-ui-composition.v1:obsolete-layout"),
    ).toBeNull();
    expect(window.localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)).toBe(
      "latitude-browser-restored-session",
    );
    expect(window.localStorage.getItem("dim-rail-collapsed")).toBe("1");
    expect(JSON.parse(window.localStorage.getItem("latitude.secretary-companion.v1")!))
      .toEqual({ x: 123, y: 234, hidden: true });
    expect(await screen.findByRole("button", { name: "唤回秘书" })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(
      "latitude.browser-ui-composition.v2:latitude-browser-live",
    )!).document.components).toHaveLength(15);
  });

  it("对新增 Web curated outbox 前向兼容：侧边秘书栏显示并回执", async () => {
    const runtime = closureRuntime().runtime;
    vi.mocked(runtime.agent.listSchedulerOutbox).mockResolvedValue({
      items: [
        {
          receiptKey: "web-digest:2026-08-24",
          runId: "scheduled-run-1",
          kind: "daily_curation",
          domainId: "2026-08-24",
          dueAt: "2026-08-24T12:00:00Z",
          text: "为你带回一条有真实链接的写作研究。",
          deliveryStatus: "pending",
          createdAt: "2026-08-24T12:00:01Z",
        },
      ],
    });
    vi.mocked(runtime.agent.acknowledgeSchedulerOutbox).mockResolvedValue({
      receiptKey: "web-digest:2026-08-24",
      runId: "scheduled-run-1",
      kind: "daily_curation",
      domainId: "2026-08-24",
      dueAt: "2026-08-24T12:00:00Z",
      text: "为你带回一条有真实链接的写作研究。",
      deliveryStatus: "acknowledged",
      createdAt: "2026-08-24T12:00:01Z",
      acknowledgedAt: "2026-08-24T12:00:02Z",
    });

    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);

    expect(await screen.findByText("为你带回一条有真实链接的写作研究。"))
      .toBeInTheDocument();
    expect(screen.getByText("秘书带回了一条有真实来源的资讯策展。")).toBeInTheDocument();
    await waitFor(() => {
      expect(runtime.agent.acknowledgeSchedulerOutbox).toHaveBeenCalledWith(
        "web-digest:2026-08-24",
        { idempotencyKey: "browser-delivery:web-digest:2026-08-24" },
      );
    });
  });

  it("事件时钟 outcome_collection 用 domainId 打开真实行动，不退化成 reviewAt 猜测", async () => {
    const user = userEvent.setup();
    const runtime = closureRuntime().runtime;
    vi.mocked(runtime.getContext).mockResolvedValue({
      nodes: [{
        id: "action-event-due",
        kind: "action",
        label: "事件已经触发的观察行动",
        expectedOutcome: "回收刚刚发生的现实信号",
        trigger: "证据事件与被测试认知建立关系",
        observationWindow: "事件发生后立即回收",
        reviewAt: "2099-01-01T00:00:00Z",
        status: "active",
      }],
      edges: [],
    });
    vi.mocked(runtime.agent.listSchedulerOutbox).mockResolvedValue({
      items: [{
        receiptKey: "outcome:event:action-event-due",
        runId: "scheduled-event-run",
        kind: "outcome_collection",
        domainId: "action-event-due",
        dueAt: "2026-08-24T12:00:00Z",
        text: "刚刚的证据事件让这个行动提前进入结果回收。",
        deliveryStatus: "pending",
        createdAt: "2026-08-24T12:00:01Z",
      }],
    });
    vi.mocked(runtime.agent.acknowledgeSchedulerOutbox).mockResolvedValue({
      receiptKey: "outcome:event:action-event-due",
      runId: "scheduled-event-run",
      kind: "outcome_collection",
      domainId: "action-event-due",
      dueAt: "2026-08-24T12:00:00Z",
      text: "刚刚的证据事件让这个行动提前进入结果回收。",
      deliveryStatus: "acknowledged",
      createdAt: "2026-08-24T12:00:01Z",
      acknowledgedAt: "2026-08-24T12:00:02Z",
    });

    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);
    expect(await screen.findByText("刚刚的证据事件让这个行动提前进入结果回收。"))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看" }));
    expect(screen.getByRole("dialog", { name: "回收行动结果" }))
      .toHaveTextContent("事件已经触发的观察行动");
  });

  it("重启后从已送达 receipt 恢复未回收的事件行动，而不把送达当成完成", async () => {
    const user = userEvent.setup();
    const runtime = closureRuntime().runtime;
    vi.mocked(runtime.getContext).mockResolvedValue({
      nodes: [{
        id: "action-event-unresolved",
        kind: "action",
        label: "重启后仍待回收",
        expectedOutcome: "必须由用户给出结果",
        reviewAt: "2099-01-01T00:00:00Z",
        status: "active",
      }],
      edges: [],
    });
    vi.mocked(runtime.agent.listSchedulerOutbox).mockResolvedValue({
      items: [{
        receiptKey: "outcome:event:action-event-unresolved",
        runId: "scheduled-event-restart",
        kind: "outcome_collection",
        domainId: "action-event-unresolved",
        dueAt: "2026-08-24T12:00:00Z",
        text: "这条提醒此前已经显示过。",
        deliveryStatus: "acknowledged",
        createdAt: "2026-08-24T12:00:01Z",
        acknowledgedAt: "2026-08-24T12:00:02Z",
      }],
    });

    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);
    await waitFor(() => expect(runtime.agent.listSchedulerOutbox).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "查看" }));
    expect(screen.getByRole("dialog", { name: "回收行动结果" }))
      .toHaveTextContent("重启后仍待回收");
    expect(runtime.agent.acknowledgeSchedulerOutbox).not.toHaveBeenCalled();
  });

  it("真实 Web Search 明示 publishedAt 后过滤、无日期排除与非穷尽覆盖", async () => {
    const user = userEvent.setup();
    const runtime = closureRuntime().runtime;
    vi.mocked(runtime.searchWeb).mockResolvedValue({
      query: "写作与深度工作",
      results: [],
      retrievedAt: "2026-08-24T12:00:00.000Z",
      coverage: {
        mode: "published_at_post_filter",
        providerSupportsFreshness: false,
        requestedFreshnessDays: 30,
        cutoff: "2026-07-25T12:00:00.000Z",
        providerResultCount: 10,
        datedResultCount: 7,
        excludedUndatedCount: 3,
        excludedStaleCount: 7,
        returnedResultCount: 0,
        exhaustive: false,
      },
    });
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);
    await waitFor(() => expect(runtime.getContext).toHaveBeenCalled());

    await user.type(screen.getByRole("textbox", { name: "搜索资讯" }), "写作与深度工作");
    await user.click(screen.getByRole("button", { name: "搜索" }));

    expect(await screen.findByText(/时间过滤后没有可展示的 dated 结果/)).toHaveTextContent(
      "排除无日期 3 条、过期 7 条",
    );
    expect(screen.getByText(/时间过滤后没有可展示的 dated 结果/)).toHaveTextContent(
      "不是该时间段的穷尽结果",
    );
    expect(runtime.searchWeb).toHaveBeenCalledWith({
      query: "写作与深度工作",
      maxResults: 3,
      freshnessDays: 30,
    });
  });

  it("服务断开时诚实显示未连接，不回退演示数据", async () => {
    const checkedAt = new Date().toISOString();
    const runtime = closureRuntime().runtime;
    vi.mocked(runtime.health).mockResolvedValue({
      state: "unavailable",
      checkedAt,
      agent: { service: "agent", state: "unavailable", checkedAt },
      domain: { service: "domain", state: "unavailable", checkedAt },
    });
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);

    await waitFor(() => expect(screen.getAllByText("本地服务 · 未连接").length).toBeGreaterThan(0));
    expect(screen.queryByText("演示模式")).not.toBeInTheDocument();
    expect(screen.getByText("稍等…")).toBeInTheDocument();
  });

  it("Provider 拒绝凭证时显示 DeepSeek 鉴权失败，不把它含糊写成 API 异常", async () => {
    const checkedAt = new Date().toISOString();
    const runtime = closureRuntime().runtime;
    vi.mocked(runtime.health).mockResolvedValue({
      state: "unavailable",
      checkedAt,
      agent: {
        service: "agent",
        state: "unavailable",
        checkedAt,
        details: {
          model: {
            provider: "deepseek-official",
            configured: true,
            authentication: "failed",
          },
        },
      },
      domain: { service: "domain", state: "ready", checkedAt },
    });

    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);

    expect(await screen.findByLabelText("本地服务状态"))
      .toHaveTextContent("数据 已连接 · 助手 DeepSeek 鉴权失败");
  });
});
