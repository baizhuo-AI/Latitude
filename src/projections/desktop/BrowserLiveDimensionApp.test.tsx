import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopRuntimeHealth,
  DesktopRuntimePort,
  KnowledgeContext,
} from "../../runtime/host";
import {
  BROWSER_LAYOUT_COMPONENT_IDS,
  BROWSER_PRODUCT_LAYOUT_DOCUMENT as SEED_LAYOUT_DOCUMENT,
  layoutV1ToUiSurfaceV2,
} from "../../runtime/composition/browserProduction";
import { BrowserLiveDimensionApp } from "./BrowserLiveDimensionApp";
import {
  BROWSER_SESSION_STORAGE_KEY,
  type BrowserRecoveryBackup,
  type BrowserRecoveryStore,
  createBrowserProfile,
} from "./browserProfile";
import { readDraft, updateDraft } from "../../dimension/composer/draftStore";

const RAW_SCHEDULER_BADCASE = [
  "该 action 已到日历触底 reviewAt（2026-08-27T17:00:00Z），但这是无人值守提醒，没有新的用户证据，所以我不会写入 outcome。",
  "**Action**: 跑通维度完整产品闭环 (node_40e31aca, sensitivity low, demo profile)",
  "当前入口只遵循来源、权限能只认有效授权 receipt，并要求 typed 依据。",
].join("\n");

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
  const recordActivity = vi.fn(async (
    request: Parameters<DesktopRuntimePort["recordActivity"]>[0],
  ) => {
    const id = `activity-${context.nodes.filter((node) => node.kind === "evidence_event").length}`;
    const node = {
      id,
      kind: "evidence_event",
      label: "用户记录的行动",
      statement: request.content,
      authority: "source_verified",
      payload: {
        evidenceType: "activity",
        occurredAt: request.occurredAt,
        authorship: "user",
      },
    };
    context = { ...context, nodes: [...context.nodes, node] };
    return {
      ok: true,
      changeSetId: `cs-${id}`,
      value: {
        sourceRecordId: `source-${id}`,
        evidenceRefId: `evidence-${id}`,
        nodeId: id,
        node,
      },
    };
  });

  const providerOptions = [
    {
      id: "deepseek-official",
      label: "DeepSeek",
      configured: true,
      credentialName: "DEEPSEEK_API_KEY",
      models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
    },
    {
      id: "openai",
      label: "OpenAI",
      configured: false,
      credentialName: "OPENAI_API_KEY",
      models: [{ id: "gpt-5.4-mini", label: "GPT-5.4 mini" }],
    },
    {
      id: "anthropic",
      label: "Anthropic",
      configured: true,
      credentialName: "ANTHROPIC_API_KEY",
      models: [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }],
    },
  ];
  const runtime: DesktopRuntimePort = {
    kind: "http",
    health: vi.fn(async () => readyHealth()),
    getContext,
    applyChange: vi.fn(async () => ({ ok: true, changeSetId: "cs-change", value: null })),
    recordActivity,
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
      getLatestRun: vi.fn(async () => ({ run: null })),
      getProgress: vi.fn(async (runId) => ({ runId, after: -1, next: -1, hasMore: false, phase: "finished" as const, items: [] })),
      getPersona: vi.fn(async () => ({ current: { version: 0, persona: "测试人设", preferences: "", reason: "默认", actor: "system" as const, createdAt: "2026-09-04" }, history: [] })),
      updatePersona: vi.fn(),
      health: vi.fn(async () => ({ ok: true })),
      getProviderSettings: vi.fn(async () => ({
        active: { provider: "deepseek-official", model: "deepseek-v4-flash" },
        options: providerOptions,
        appliesTo: "next_turn" as const,
      })),
      updateProviderSettings: vi.fn(async (request) => ({
        active: request,
        options: providerOptions,
        appliesTo: "next_turn" as const,
      })),
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
            explanation: {
              summary: "这次回答依据你刚才说的话和已完成的保存操作。",
              steps: [
                "把你这次说的话作为本轮依据",
                "建立了一个带回看时间的小行动",
              ],
            },
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
  return { runtime, getContext, recordActivity, recordOutcome, createWeeklyReview };
}

async function openCardContent(user: ReturnType<typeof userEvent.setup>, title: string) {
  const card = await screen.findByRole("group", { name: `卡片：${title}` });
  fireEvent.contextMenu(card, { clientX: 280, clientY: 220 });
  await user.click(screen.getByRole("menuitem", { name: /编辑内容|查看内容/ }));
  return screen.getByRole("dialog", { name: new RegExp(`(?:编辑|查看)内容：${title}`) });
}

async function openGoalSettings(user: ReturnType<typeof userEvent.setup>, title: string, action: "编辑内容" | "删除") {
  const goal = await screen.findByRole("button", { name: new RegExp(`中期目标 \\d+：${title}.*右键打开卡片设置`) });
  fireEvent.contextMenu(goal, { clientX: 280, clientY: 220 });
  await user.click(screen.getByRole("menuitem", { name: action }));
}

describe("BrowserLiveDimensionApp 产品闭环", () => {
  it("从已落库内容显示便签，完成待办只写业务库，不伪造认知结果", async () => {
    const { runtime, recordOutcome } = closureRuntime();
    let content: import("../../shared/desktopContent").DesktopContent = {
      date: "2026-09-07", events: [],
      todos: [{ id: "business-todo", title: "已保存的真实待办", status: "todo", scheduledDate: null, scheduledTime: null, sourceNodeIds: [], updatedAt: "v1" }],
      digests: [{ date: "2026-06-16", summary: "历史整理的完整内容，不冒充今天", sourceNodeIds: [] }],
    };
    const updateTodo = vi.fn(async () => { content = { ...content, todos: [] }; return { saved: true, updatedAt: "v2" }; });
    runtime.agent.desktop = { read: vi.fn(async () => structuredClone(content)), updateTodo };
    const user = userEvent.setup();
    render(<BrowserLiveDimensionApp runtime={runtime} />);
    await screen.findByText("已保存的真实待办");
    expect(screen.getByRole("heading", { name: "2026-06-16 · 每日整理", level: 4 })).toBeInTheDocument();
    const disclosure = screen.getByText(/^阅读全文/);
    await user.click(disclosure);
    expect(within(disclosure.parentElement!).getByText("历史整理的完整内容，不冒充今天")).toBeVisible();
    const contentDialog = await openCardContent(user, "今天的锚点");
    await user.click(within(contentDialog).getByRole("button", { name: "完成：已保存的真实待办" }));
    await waitFor(() => expect(updateTodo).toHaveBeenCalledWith({ id: "business-todo", expectedUpdatedAt: "v1", status: "done" }));
    expect(recordOutcome).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "回收行动结果" })).not.toBeInTheDocument();
  });

  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("opens a star discussion with context while preserving the unfinished draft and waiting for Send", async () => {
    const user = userEvent.setup();
    const { runtime } = closureRuntime();
    window.localStorage.setItem(BROWSER_SESSION_STORAGE_KEY, "star-discussion-test");
    updateDraft("star-discussion-test", draft => ({ ...draft, text: "先别忘了我刚才想问的事。" }));
    vi.mocked(runtime.getContext).mockResolvedValue({ nodes: [{
      id: "north-goal", kind: "goal", label: "做值得长期投入的事", statement: "留一点时间给真正想做的事。",
      status: "active", authority: "user_stated", payload: { horizon: "north-star", surfaceRole: "constellation.north-star" },
    }], edges: [] });
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} profileRecoveryStore={memoryRecoveryStore()} />);
    await user.click(await screen.findByRole("button", { name: "星图桌面" }));
    await user.click(await screen.findByRole("button", { name: "和维度聊聊" }));
    const composer = await screen.findByRole("textbox", { name: "给秘书发消息" });
    expect((composer as HTMLTextAreaElement).value).toContain("先别忘了我刚才想问的事。");
    expect(readDraft("star-discussion-test").text).toContain("做值得长期投入的事");
    expect(readDraft("star-discussion-test").text).toContain("留一点时间给真正想做的事。");
    expect(runtime.agent.startTurn).not.toHaveBeenCalled();
    expect(runtime.runAgentTurn).not.toHaveBeenCalled();
  });

  // Three real form/save cycles need their own suite-load budget; individual
  // UI waits and every domain/audit assertion retain their original limits.
  it("creates, edits and retracts real medium goals while preserving linked actions", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
    const user = userEvent.setup();
    const { runtime } = closureRuntime();
    let nodes: KnowledgeContext["nodes"] = [
      { id: "linked-action", kind: "action", label: "保留的行动", payload: { mediumGoalId: "new-goal" } },
    ];
    vi.mocked(runtime.getContext).mockImplementation(async () => ({ nodes: structuredClone(nodes), edges: [] }));
    vi.mocked(runtime.applyChange).mockImplementation(async (change) => {
      if (change.operation === "remember") nodes.push({ id: "new-goal", kind: change.kind!, label: change.label,
        statement: change.statement, payload: change.payload, authority: "user_stated" });
      if (change.operation === "update") nodes = nodes.map(n => n.id === change.id ? { ...n, label: change.label, statement: change.statement } : n);
      if (change.operation === "retract") nodes = nodes.filter(n => n.id !== change.id);
      return { ok: true, changeSetId: "goal-change", value: null };
    });
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);
    await user.click(await screen.findByRole("button", { name: "线索板桌面" }));
    await user.click(await screen.findByRole("button", { name: "＋ 新增目标" }));
    await user.type(screen.getByRole("textbox", { name: "目标名称" }), "交付新版本");
    await user.type(screen.getByRole("textbox", { name: "目标说明" }), "完成验收");
    await user.click(screen.getByRole("button", { name: "保存目标" }));
    await openGoalSettings(user, "交付新版本", "编辑内容");
    expect(runtime.applyChange).toHaveBeenCalledWith(expect.objectContaining({ operation: "remember", kind: "goal",
      payload: { horizon: "medium-term", surfaceRole: "clue.theme" }, audit: expect.objectContaining({ actor: "user" }) }));
    await user.clear(screen.getByRole("textbox", { name: "目标名称" }));
    await user.type(screen.getByRole("textbox", { name: "目标名称" }), "交付正式版本");
    await user.click(screen.getByRole("button", { name: "保存目标" }));
    await openGoalSettings(user, "交付正式版本", "删除");
    expect(runtime.applyChange).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/关联的行动和记录会保留/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /中期目标 \d+：交付正式版本/ })).not.toBeInTheDocument());
    expect(nodes.map(n => n.id)).toEqual(["linked-action"]);
    expect(runtime.applyChange).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "retract", id: "new-goal" }));
  }, 15_000);

  it("uses the selected desktop area at each send while keeping attachment display text free of UI context", async () => {
    const user = userEvent.setup();
    const { runtime } = closureRuntime();
    vi.mocked(runtime.getContext).mockResolvedValue({ nodes: [
      { id: "goal-delivery", kind: "goal", label: "客户交付", authority: "user_stated",
        payload: { horizon: "medium-term", surfaceRole: "clue.theme" } },
    ], edges: [] });
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);
    await user.click(await screen.findByRole("button", { name: "线索板桌面" }));
    await user.dblClick(await screen.findByRole("button", { name: /客户交付.*双击进入主页板块/ }));
    await user.click(screen.getByRole("button", { name: "打开对话" }));
    const dialog = screen.getByRole("dialog", { name: "与秘书的对话" });
    await user.upload(within(dialog).getByLabelText("选择附件"), new File(["附件原文只用于本轮"], "材料.md", { type: "text/markdown" }));
    await within(dialog).findByText("材料.md");
    await user.type(within(dialog).getByRole("textbox", { name: "给秘书发消息" }), "先处理这里");
    await user.click(within(dialog).getByRole("button", { name: "发送" }));
    await waitFor(() => expect(runtime.agent.startTurn).toHaveBeenCalledOnce());
    const first = vi.mocked(runtime.agent.startTurn).mock.calls[0][0];
    const firstContext = JSON.parse(first.systemPrompt!.match(/<latitude_ui_context>(.*?)<\/latitude_ui_context>/s)![1]);
    expect(firstContext).toMatchObject({ view: "paper", area: { id: "goal-theme-goal-delivery", title: "客户交付" }, visibleCardIds: expect.any(Array) });
    expect(first.systemPrompt).toContain("this turn only");
    expect(first.text).toContain("附件原文只用于本轮");
    expect(first.text).not.toContain("latitude_ui_context");
    expect(first.text).not.toContain("goal-theme-goal-delivery");
    expect(dialog.querySelector('[data-role="user"]')?.textContent).toBe("先处理这里\n\n附件：材料.md");
    await waitFor(() => expect(within(dialog).getByRole("textbox", { name: "给秘书发消息" })).toHaveValue(""));
    await user.click(screen.getAllByRole("button", { name: "回常用区" }).find(button => button.classList.contains("dim-deck-home"))!);
    await user.type(within(dialog).getByRole("textbox", { name: "给秘书发消息" }), "再看看常用区");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "发送" })).toBeEnabled());
    await user.click(within(dialog).getByRole("button", { name: "发送" }));
    await waitFor(() => expect(runtime.agent.startTurn).toHaveBeenCalledTimes(2));
    const second = vi.mocked(runtime.agent.startTurn).mock.calls[1][0];
    expect(JSON.parse(second.systemPrompt!.match(/<latitude_ui_context>(.*?)<\/latitude_ui_context>/s)![1])).toMatchObject({ view: "paper", area: null });
    expect(second.text).toBe("再看看常用区");
    expect(runtime.applyChange).not.toHaveBeenCalled();
  });

  async function openDataSafety(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "设置" }));
    const diagnostics = screen.getByRole("dialog", { name: "设置" });
    expect(diagnostics).toHaveClass("dimension-root");
    await user.click(within(diagnostics).getByRole("button", { name: "数据与安全…" }));
    expect(screen.getByRole("dialog", { name: "数据与安全" })).toBeInTheDocument();
  }

  it("把 evidence → Agent action → outcome 接成真实 UI 写回，周回顾不再作为卡片菜单动作", async () => {
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
    const contextQuery = vi.mocked(runtime.getContext).mock.calls.find(([query]) => query?.evidenceTypes?.includes("activity"))?.[0];
    expect(contextQuery).toMatchObject({
      evidenceTypes: ["activity"],
      sensitivityCeiling: "highest",
      limit: 500,
    });
    expect(contextQuery?.kinds).toEqual(expect.arrayContaining([
      "evidence_event",
      "goal",
      "action",
      "resource",
      "insight",
    ]));
    expect(screen.getAllByText("现在没有未闭环的行动。").length).toBeGreaterThan(0);

    expect(screen.queryByRole("textbox", { name: "跟秘书说话" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打开对话" }));
    const conversation = screen.getByRole("dialog", { name: "与秘书的对话" });
    await user.type(
      within(conversation).getByRole("textbox", { name: "给秘书发消息" }),
      "根据现有证据创建一个能回收结果的小行动",
    );
    await user.click(within(conversation).getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(screen.getAllByText("验证上午写作").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("为什么这样回答")).toBeInTheDocument();
    const contentDialog = await openCardContent(user, "今天的锚点");
    await user.click(within(contentDialog).getByRole("button", { name: "查看来源：来自你的行动" }));
    const sourceDialog = screen.getByRole("dialog", { name: "图谱来源详情" });
    expect(sourceDialog).toHaveClass("dimension-root");
    await user.click(within(sourceDialog).getByRole("button", { name: "合上" }));
    expect(runtime.agent.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "根据现有证据创建一个能回收结果的小行动",
        sessionId: expect.stringMatching(/^latitude-browser-/),
      }),
    );
    expect(runtime.agent.waitForRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const actionContent = await openCardContent(user, "今天的锚点");
    await user.click(within(actionContent).getByRole("button", { name: "完成：验证上午写作" }));
    const outcomeDialog = screen.getByRole("dialog", { name: "回收行动结果" });
    expect(outcomeDialog).toHaveClass("dimension-root");
    expect(outcomeDialog).toHaveStyle({ zIndex: "230" });
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

    const remainingContent = screen.queryByRole("dialog", { name: /(?:编辑|查看)内容：今天的锚点/ });
    if (remainingContent) await user.click(within(remainingContent).getByRole("button", { name: "关闭卡片内容" }));
    await user.click(screen.getByRole("button", { name: "更多桌面操作" }));
    expect(screen.queryByRole("button", { name: "周回顾" })).not.toBeInTheDocument();
    expect(createWeeklyReview).not.toHaveBeenCalled();
  });

  it("把预算耗尽显示为未完成，不再伪装成一句完成了", async () => {
    const user = userEvent.setup();
    const { runtime } = closureRuntime();
    vi.mocked(runtime.agent.waitForRun).mockResolvedValueOnce({
      runId: "run-1",
      status: "budget_exhausted",
      result: {
        runId: "run-1",
        sessionId: "session-test",
        status: "budget_exhausted",
        assistantText: "",
        budgetStopReason: "wall_clock",
        stepsUsed: 3,
        toolCallsUsed: 4,
        startedAt: "2026-09-03T17:36:22Z",
        finishedAt: "2026-09-03T17:38:29Z",
      },
    });
    render(
      <BrowserLiveDimensionApp
        runtime={runtime}
        healthPollMs={0}
        profileRecoveryStore={memoryRecoveryStore()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "打开对话" }));
    const conversation = screen.getByRole("dialog", { name: "与秘书的对话" });
    const input = within(conversation).getByRole("textbox", { name: "给秘书发消息" });
    await user.type(input, "你知道我最近都在做什么吗");
    await user.click(within(conversation).getByRole("button", { name: "发送" }));

    expect(await screen.findByText(/超过了等待时间，因此没有生成最终回答/))
      .toBeInTheDocument();
    expect(screen.queryByText("完成了。")).not.toBeInTheDocument();
  });

  it("在设置里切换真实 Agent Provider，并阻止未配置的选项保存", async () => {
    const user = userEvent.setup();
    const { runtime } = closureRuntime();
    render(
      <BrowserLiveDimensionApp
        runtime={runtime}
        healthPollMs={0}
        profileRecoveryStore={memoryRecoveryStore()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    const provider = await within(dialog).findByRole("combobox", { name: "Provider" });
    const save = within(dialog).getByRole("button", { name: "保存模型设置" });

    await user.selectOptions(provider, "openai");
    expect(within(dialog).getByText(/OPENAI_API_KEY/)).toBeInTheDocument();
    expect(save).toBeDisabled();

    await user.selectOptions(provider, "anthropic");
    expect(within(dialog).getByRole("combobox", { name: "模型" })).toHaveValue(
      "claude-sonnet-4-6",
    );
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(runtime.agent.updateProviderSettings).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    }));
    expect(await within(dialog).findByText(/下一次对话会使用/)).toBeInTheDocument();
  });

  it("从卡片右键内容页记下今天做过并从两条真实记录发起待确认回看", async () => {
    const user = userEvent.setup();
    const { runtime, recordActivity } = closureRuntime();
    render(
      <BrowserLiveDimensionApp
        runtime={runtime}
        healthPollMs={0}
        profileRecoveryStore={memoryRecoveryStore()}
      />,
    );

    await waitFor(() => expect(screen.getByText("今天做过")).toBeInTheDocument());
    const contentDialog = await openCardContent(user, "今天做过");
    const input = within(contentDialog).getByRole("textbox", { name: "记下一件已经做过的事" });
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "把服务接回原来的纸面");
    const submit = screen.getByRole("button", { name: "记下" });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(recordActivity).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.getAllByText("把服务接回原来的纸面").length).toBeGreaterThan(0);
    });

    await user.type(input, "确认第一步只记录真实发生的事");
    await user.click(screen.getByRole("button", { name: "记下" }));
    await waitFor(() => expect(recordActivity).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "帮我看看今天" }));
    await waitFor(() => {
      expect(runtime.agent.startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("只基于我今天标记为“做过”的真实记录"),
        }),
      );
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
    const candidateContexts: KnowledgeContext[] = [
      { nodes: [candidate], edges: [] },
      { nodes: [{ ...candidate, status: "active", payload: { ...candidate.payload, candidateState: "touched" } }], edges: [] },
      { nodes: [{ ...candidate, status: "parked", payload: { ...candidate.payload, candidateState: "parked" } }], edges: [] },
      { nodes: [{ ...candidate, status: "active", payload: { ...candidate.payload, candidateState: "touched" } }], edges: [] },
    ];
    let candidateContextIndex = 0;
    vi.mocked(runtime.getContext).mockImplementation(async (query) => {
      // The independent note inventory does not advance this candidate scenario.
      if (query?.kinds?.length === 1 && query.kinds[0] === "resource") return { nodes: [], edges: [] };
      return candidateContexts[Math.min(candidateContextIndex++, candidateContexts.length - 1)];
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

    const invitation = await screen.findByRole("button", { name: "秘书找你共创" });
    expect(invitation).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "候选共创" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(runtime.commandCandidate).toHaveBeenCalledWith({
        candidateId: "candidate-browser-1",
        command: "acknowledge_due",
        audit: expect.objectContaining({ actor: "system" }),
      }, { idempotencyKey: "candidate-due:candidate:browser:proposed" });
    });
    await user.click(invitation);
    const paper = screen.getByRole("dialog", { name: "一起想想" });
    expect(paper).toHaveFocus();
    expect(within(paper).getByRole("region", { name: "候选共创" })).toHaveTextContent(
      "把上午写作变成可持续节律",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "一起想想" })).not.toBeInTheDocument();
    expect(invitation).toHaveFocus();
    await user.click(invitation);
    await user.click(document.body);
    expect(screen.queryByRole("region", { name: "候选共创" })).not.toBeInTheDocument();
    await user.click(invitation);
    // Merely opening, dismissing, and reopening her invitation never advances a candidate.
    expect(runtime.commandCandidate).toHaveBeenCalledTimes(1);
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
    await user.click(screen.getByRole("button", { name: "继续共创：把上午写作变成可持续节律" }));
    await waitFor(() => expect(runtime.commandCandidate).toHaveBeenLastCalledWith({
      candidateId: "candidate-browser-1", command: "touch",
      audit: expect.objectContaining({ actor: "user" }),
    }));
    expect(await screen.findByRole("button", { name: "继续整理：把上午写作变成可持续节律" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "确认结论：把上午写作变成可持续节律" })).toBeEnabled();
  });

  it("塑形 7 天的轻提醒展示后只写 delivery receipt，不伪造结论", async () => {
    const user = userEvent.setup();
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
    expect(screen.queryByRole("region", { name: "候选共创" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "秘书找你共创" }));
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

    await screen.findByText("验证时间回收");
    const contentDialog = await openCardContent(user, "今天的锚点");
    await user.click(within(contentDialog).getByRole("button", { name: "完成：验证时间回收" }));
    const dialog = screen.getByRole("dialog", { name: "回收行动结果" });
    expect(dialog).toHaveTextContent(/观察窗口：.+至.+/);
    expect(dialog).not.toHaveTextContent(/\{"endsAt"/);
  });

  it("contracts / revises 必须提交新 statement，并显式提供 refutes", async () => {
    const user = userEvent.setup();
    const { runtime, recordOutcome } = closureRuntime();
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);
    await waitFor(() => expect(runtime.getContext).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "打开对话" }));
    const conversation = screen.getByRole("dialog", { name: "与秘书的对话" });
    await user.type(
      within(conversation).getByRole("textbox", { name: "给秘书发消息" }),
      "建立行动并回收结果",
    );
    await user.click(within(conversation).getByRole("button", { name: "发送" }));
    await waitFor(() => expect(screen.getAllByText("验证上午写作").length).toBeGreaterThan(0));
    const contentDialog = await openCardContent(user, "今天的锚点");
    await user.click(within(contentDialog).getByRole("button", { name: "完成：验证上午写作" }));

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
    await openCardContent(user, "今日早报");
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
    expect(screen.getByRole("complementary", { name: "秘书栏" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "了解你的进度" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "打开对话" }));
    expect(screen.getByRole("dialog", { name: "与秘书的对话" }))
      .toHaveClass("dim-thread--floating");
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "给秘书发消息" })).toHaveFocus();
    });
    expect(screen.queryByRole("textbox", { name: "跟秘书说话" })).not.toBeInTheDocument();
    expect(screen.getByText("这是刷新前已经完成并持久化的回复。")).toBeInTheDocument();
  });

  it("从常驻秘书旁新开独立对话，并把下一轮送到新的 Agent session", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(BROWSER_SESSION_STORAGE_KEY, "latitude-browser-old");
    const runtime = closureRuntime().runtime;
    vi.mocked(runtime.agent.listMessages).mockImplementation(async (requestedSessionId) => ({
      sessionId: requestedSessionId,
      messages: requestedSessionId === "latitude-browser-old"
        ? [{
            id: "old-message",
            role: "assistant",
            content: "上一段对话",
            createdAt: "2026-08-24T12:00:00Z",
          }]
        : [],
    }));
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);

    await user.click(await screen.findByRole("button", { name: "打开对话" }));
    expect(await screen.findByText("上一段对话")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "新开对话" }));

    const nextSessionId = window.localStorage.getItem(BROWSER_SESSION_STORAGE_KEY);
    expect(nextSessionId).toMatch(/^latitude-browser-/);
    expect(nextSessionId).not.toBe("latitude-browser-old");
    await waitFor(() => {
      expect(runtime.agent.listMessages).toHaveBeenCalledWith(
        nextSessionId,
        expect.objectContaining({ retries: 1 }),
      );
    });
    expect(screen.queryByText("上一段对话")).not.toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "给秘书发消息" }), "从这里重新开始");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(runtime.agent.startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: nextSessionId,
          text: "从这里重新开始",
        }),
      );
    });
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

  it("AI resource 通过同一 surface 隐藏左侧秘书栏/解绑 chat，用户可安全唤回", async () => {
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
    expect(await screen.findByRole("button", { name: "查看待处理" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "聊聊" })).not.toBeInTheDocument();
  });

  it("AI resource 的模块显隐与解绑仍保存到同一 surface，已移除的底栏不会重新出现", async () => {
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
      expect(screen.queryByRole("textbox", { name: "跟秘书说话" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "发送" })).not.toBeInTheDocument();
      const saved = JSON.parse(window.localStorage.getItem("latitude.browser-ui-composition.v2:latitude-browser-live") ?? "{}");
      const commandBar = saved.document?.components.find((component: { id: string }) => component.id === "command-bar");
      expect(commandBar).toBeDefined();
      expect(commandBar.actions).not.toHaveProperty("send");
    });
    expect(runtime.agent.startTurn).not.toHaveBeenCalled();
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

    await user.click(screen.getByRole("button", { name: "更多桌面操作" }));
    await user.click(screen.getByRole("button", { name: "调整桌面" }));
    const title = screen.getByRole("textbox", { name: "今天的锚点 标题" });
    const originalTitle = (title as HTMLInputElement).value;
    await user.clear(title);
    await user.type(title, "临时验收标题");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await user.click(screen.getByRole("button", { name: "更多桌面操作" }));
    await user.click(screen.getByRole("button", { name: "调整桌面" }));
    expect(screen.getByRole("textbox", { name: "今天的锚点 标题" })).toHaveValue(
      "临时验收标题",
    );
    await user.click(within(screen.getByRole("dialog", { name: "桌面设置" })).getByText("变更记录"));
    await user.click(screen.getByRole("button", { name: "反转这条操作" }));

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "今天的锚点 标题" })).toHaveValue(
        originalTitle,
      );
    });
  });

  it("浏览器生产桌面可以移除卡片并从添加入口恢复", async () => {
    const user = userEvent.setup();
    const runtime = closureRuntime().runtime;
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);
    await waitFor(() => expect(runtime.getContext).toHaveBeenCalled());

    fireEvent.contextMenu(await screen.findByRole("group", { name: "卡片：最近值得想一想" }), { clientX: 280, clientY: 220 });
    await user.click(screen.getByRole("menuitem", { name: /移除卡片/ }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "最近值得想一想" }))
        .not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /卡片总览/ }));
    await user.click(screen.getByRole("button", { name: "放回桌面：最近值得想一想" }));
    expect(await screen.findByRole("heading", { name: "最近值得想一想" }))
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
    expect(within(screen.getByRole("dialog", { name: "数据与安全" })).getByRole("status")).toHaveTextContent("完整可恢复备份已写入并读回");
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
      ) && item.id !== "seed-activity");
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
    )!).document.components).toHaveLength(16);
  });

  it("资讯通过秘书主动送达并回执，移除搜索栏后不误导到行动结果回收", async () => {
    const user = userEvent.setup();
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

    expect(await within(screen.getByRole("complementary", { name: "秘书栏" }))
      .findByText("今天的新资讯准备好了。"))
      .toBeInTheDocument();
    expect(screen.queryByText("为你带回一条有真实链接的写作研究。"))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "搜索资讯" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "本地产品闭环控制" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(runtime.agent.acknowledgeSchedulerOutbox).toHaveBeenCalledWith(
        "web-digest:2026-08-24",
        { idempotencyKey: "browser-delivery:web-digest:2026-08-24" },
      );
    });
    await user.click(screen.getByRole("button", { name: "打开对话" }));
    expect(screen.getByLabelText("秘书主动发起的话题"))
      .toHaveTextContent("今天的新资讯准备好了。");
    expect(screen.queryByRole("button", { name: "处理这件事" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "回收行动结果" })).not.toBeInTheDocument();
    expect(runtime.searchWeb).not.toHaveBeenCalled();
    expect(runtime.recordOutcome).not.toHaveBeenCalled();
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
        text: RAW_SCHEDULER_BADCASE,
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
      text: RAW_SCHEDULER_BADCASE,
      deliveryStatus: "acknowledged",
      createdAt: "2026-08-24T12:00:01Z",
      acknowledgedAt: "2026-08-24T12:00:02Z",
    });

    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);
    expect(await screen.findByText("“事件已经触发的观察行动”到回看时间了，实际结果怎么样？"))
      .toBeInTheDocument();
    expect(screen.queryByText(/reviewAt|node_|sensitivity|demo profile|typed|receipt/i))
      .not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打开对话" }));
    expect(screen.getByLabelText("秘书主动发起的话题"))
      .toHaveTextContent("事件已经触发的观察行动");
    await user.click(screen.getByRole("button", { name: "处理这件事" }));
    const threadWindow = screen.getByRole("dialog", { name: "与秘书的对话" });
    const outcomeWindow = screen.getByRole("dialog", { name: "回收行动结果" });
    expect(outcomeWindow).toHaveTextContent("事件已经触发的观察行动");
    expect(outcomeWindow).toHaveStyle({ zIndex: "230" });
    expect(threadWindow).toHaveStyle({ zIndex: "170" });

    await user.click(threadWindow);
    expect(threadWindow).toHaveStyle({ zIndex: "230" });
    expect(outcomeWindow).toHaveStyle({ zIndex: "170" });

    await user.click(within(outcomeWindow).getByRole("textbox", { name: "实际结果" }));
    expect(outcomeWindow).toHaveStyle({ zIndex: "230" });
    expect(threadWindow).toHaveStyle({ zIndex: "170" });
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
        text: RAW_SCHEDULER_BADCASE,
        deliveryStatus: "acknowledged",
        createdAt: "2026-08-24T12:00:01Z",
        acknowledgedAt: "2026-08-24T12:00:02Z",
      }],
    });

    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);
    await waitFor(() => expect(runtime.agent.listSchedulerOutbox).toHaveBeenCalled());
    expect(await screen.findByText("“重启后仍待回收”到回看时间了，实际结果怎么样？"))
      .toBeInTheDocument();
    expect(screen.queryByText(/reviewAt|node_|sensitivity|demo profile|typed|receipt/i))
      .not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打开对话" }));
    expect(screen.getByLabelText("秘书主动发起的话题"))
      .toHaveTextContent("重启后仍待回收");
    await user.click(screen.getByRole("button", { name: "处理这件事" }));
    expect(screen.getByRole("dialog", { name: "回收行动结果" }))
      .toHaveTextContent("重启后仍待回收");
    expect(runtime.agent.acknowledgeSchedulerOutbox).not.toHaveBeenCalled();
  });

  it("服务状态和手动刷新收进设置，刷新仍重新读取真实服务与记录", async () => {
    const user = userEvent.setup();
    const runtime = closureRuntime().runtime;
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);
    await waitFor(() => expect(runtime.getContext).toHaveBeenCalled());
    expect(screen.queryByLabelText("本地服务状态")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "设置" }));
    const settings = screen.getByRole("dialog", { name: "设置" });
    expect(within(settings).getByLabelText("本地服务状态"))
      .toHaveTextContent("数据 已连接 · 助手 已连接");
    const priorHealthCalls = vi.mocked(runtime.health).mock.calls.length;
    const priorContextCalls = vi.mocked(runtime.getContext).mock.calls.length;
    await user.click(within(settings).getByRole("button", { name: "刷新" }));
    await waitFor(() => {
      expect(runtime.health).toHaveBeenCalledTimes(priorHealthCalls + 1);
      expect(runtime.getContext).toHaveBeenCalledTimes(priorContextCalls + 1);
    });
    expect(await screen.findByText("已刷新。")).toBeInTheDocument();
  });

  it("服务断开时在设置诚实显示未连接，不回退演示数据", async () => {
    const user = userEvent.setup();
    const checkedAt = new Date().toISOString();
    const runtime = closureRuntime().runtime;
    vi.mocked(runtime.health).mockResolvedValue({
      state: "unavailable",
      checkedAt,
      agent: { service: "agent", state: "unavailable", checkedAt },
      domain: { service: "domain", state: "unavailable", checkedAt },
    });
    render(<BrowserLiveDimensionApp runtime={runtime} healthPollMs={0} />);

    await waitFor(() => expect(runtime.health).toHaveBeenCalled());
    expect(screen.queryByLabelText("本地服务状态")).not.toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /秘书状态：未连接/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "设置" }));
    const settings = screen.getByRole("dialog", { name: "设置" });
    expect(await within(settings).findByLabelText("本地服务状态")).toHaveTextContent("数据 未连接 · 助手 未连接");
    expect(screen.queryByText("演示模式")).not.toBeInTheDocument();
  });

  it("Provider 拒绝凭证时显示 DeepSeek 鉴权失败，不把它含糊写成 API 异常", async () => {
    const user = userEvent.setup();
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
    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(await within(screen.getByRole("dialog", { name: "设置" }))
      .findByLabelText("本地服务状态"))
      .toHaveTextContent("数据 已连接 · 助手 DeepSeek 鉴权失败");
  });
});
