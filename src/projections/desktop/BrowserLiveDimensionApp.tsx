import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DeskThread } from "../../dimension/DeskThread";
import { DimensionPresetApp } from "../../dimension/presets/DimensionPresetApp";
import type {
  AnchorRow,
  CardHandlers,
  FeedFeedback,
  FeedItem,
  LineageRef,
} from "../../dimension/types";
import type { ChatMessageRow, ConversationRow } from "../../lib/db";
import {
  BROWSER_COMPANION_COMPONENT_ID,
  BROWSER_SYSTEM_COMPONENT_IDS,
  resolveBrowserComponentRuntimeState,
} from "../../runtime/composition/browserProduction";
import {
  assistantTextFromRun,
  type CandidateCommand,
  type DueCandidateItem,
  DesktopRuntimeProvider,
  type DesktopRuntimePort,
  type KnowledgeContext,
  type KnowledgeNode,
  type RuntimeServiceState,
  type SchedulerOutboxItem,
  type WebSearchItem,
  type WebSearchResponse,
  useDesktopRuntime,
} from "../../runtime/host";
import {
  buildBrowserProjection,
  candidateStateOf,
  isCandidateNode,
} from "./browserProjection";
import { BrowserCompositionDialog } from "./BrowserCompositionDialog";
import {
  BrowserDataSafetyDialog,
  type BrowserDataSafetyActionAvailability,
  type BrowserDataSafetyActions,
} from "./BrowserDataSafetyDialog";
import {
  parseBrowserUiDraftOperations,
  uiChangeSetFromAgentRun,
  useBrowserUiComposition,
} from "./browserUiComposition";
import {
  BROWSER_SESSION_STORAGE_KEY,
  BrowserProfileCoordinator,
  type BrowserRecoveryStore,
} from "./browserProfile";

const EMPTY_CONTEXT: KnowledgeContext = { nodes: [], edges: [] };

type BrowserMessage = Pick<ChatMessageRow, "id" | "role" | "content" | "createdAt">;

export interface BrowserLiveDimensionAppProps {
  /** Tests and future shells can inject a compatible runtime without changing the UI. */
  runtime?: DesktopRuntimePort;
  healthPollMs?: number;
  dataSafetyActions?: BrowserDataSafetyActions;
  /** Test/shell seam; production defaults to the durable IndexedDB store. */
  profileRecoveryStore?: BrowserRecoveryStore;
}

/**
 * Browser P0 entry. Both services stay behind DesktopRuntimePort: no provider SDK,
 * credential, SQLite adapter or demo dataset is allowed into this component tree.
 */
export function BrowserLiveDimensionApp({
  runtime,
  healthPollMs = 10_000,
  dataSafetyActions,
  profileRecoveryStore,
}: BrowserLiveDimensionAppProps = {}) {
  return (
    <DesktopRuntimeProvider runtime={runtime} healthPollMs={healthPollMs}>
      <BrowserLiveDimensionSurface
        dataSafetyActions={dataSafetyActions}
        profileRecoveryStore={profileRecoveryStore}
      />
    </DesktopRuntimeProvider>
  );
}

export function BrowserLiveDimensionSurface({
  dataSafetyActions,
  profileRecoveryStore,
}: {
  dataSafetyActions?: BrowserDataSafetyActions;
  profileRecoveryStore?: BrowserRecoveryStore;
} = {}) {
  const { runtime, health, state, refreshHealth } = useDesktopRuntime();
  const [context, setContext] = useState<KnowledgeContext>(EMPTY_CONTEXT);
  const [contextLoading, setContextLoading] = useState(true);
  const [contextError, setContextError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [notice, setNotice] = useState<string | null>(null);
  const [secretaryNotice, setSecretaryNotice] = useState<string | null>(null);
  const [threadOpen, setThreadOpen] = useState(false);
  const [messages, setMessages] = useState<BrowserMessage[]>([]);
  const [messageHydrationError, setMessageHydrationError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [webResults, setWebResults] = useState<WebSearchItem[]>([]);
  const [searchReason, setSearchReason] = useState<string | undefined>();
  const [lastSearchQuery, setLastSearchQuery] = useState("");
  const [outcomeTarget, setOutcomeTarget] = useState<AnchorRow | null>(null);
  const [inspectedNode, setInspectedNode] = useState<KnowledgeNode | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [dataSafetyOpen, setDataSafetyOpen] = useState(false);
  const [compositionOpen, setCompositionOpen] = useState(false);
  const [domainBusy, setDomainBusy] = useState(false);
  const [candidateDueItems, setCandidateDueItems] = useState<DueCandidateItem[]>([]);
  const [outcomeCollectionActionId, setOutcomeCollectionActionId] = useState<string | null>(null);
  const pollController = useRef<AbortController | null>(null);
  const activeDueNotice = useRef<string | null>(null);
  const acknowledgedCandidateDue = useRef(new Set<string>());
  const sessionId = useMemo(getOrCreateBrowserSessionId, []);
  const browserProfile = useMemo(
    () => new BrowserProfileCoordinator(runtime, () => sessionId, profileRecoveryStore),
    [profileRecoveryStore, runtime, sessionId],
  );

  const domainReady = health?.domain.state === "ready";
  const agentReady = health?.agent.state === "ready";
  const agentAuthentication = optionalText(
    recordOf(health?.agent.details?.model)?.authentication,
  );

  const refreshContext = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setContextLoading(true);
    try {
      const next = await runtime.getContext({ limit: 300 }, { retries: 1 });
      setContext(next);
      setContextError(null);
      setNow(new Date());
      return next;
    } catch (error) {
      setContextError(readableError(error, "认知图谱暂时读取失败"));
      throw error;
    } finally {
      if (!options.silent) setContextLoading(false);
    }
  }, [runtime]);

  useEffect(() => {
    if (health?.domain.state === "ready") {
      void refreshContext().catch(() => undefined);
    } else if (health?.domain.state === "unavailable") {
      setContextLoading(false);
    }
  }, [health?.domain.state, refreshContext]);

  useEffect(() => {
    if (!agentReady) return;
    let active = true;
    void runtime.agent.listMessages(sessionId, { retries: 1 })
      .then((response) => {
        if (!active) return;
        const restored: BrowserMessage[] = response.messages.map((message, index) => ({
          id: message.id ?? `host-message-${message.seq ?? index}`,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt ?? new Date().toISOString(),
        }));
        setMessages((current) => current.length > 0 ? current : restored);
        setMessageHydrationError(null);
      })
      .catch((error) => {
        if (active) setMessageHydrationError(readableError(error, "历史会话暂时未读回"));
      });
    return () => {
      active = false;
    };
  }, [agentReady, runtime.agent, sessionId]);

  useEffect(() => {
    if (!domainReady) return;
    const refreshVisibleContext = () => {
      if (document.visibilityState === "visible") {
        void refreshContext({ silent: true }).catch(() => undefined);
      }
    };
    // Calendar fallback for scheduler / other-window writes. It refreshes the
    // read model only and never interrupts an active Agent turn or form draft.
    const timer = window.setInterval(refreshVisibleContext, 20_000);
    document.addEventListener("visibilitychange", refreshVisibleContext);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisibleContext);
    };
  }, [domainReady, refreshContext]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      // Leaving the page only stops browser polling. It does not silently cancel
      // the durable Host task; explicit cancellation has its own button below.
      pollController.current?.abort();
    },
    [],
  );

  const effectiveState: RuntimeServiceState = contextError && context.nodes.length === 0
    ? "unavailable"
    : state;
  const browserProjection = useMemo(
    () =>
      buildBrowserProjection({
        context,
        runtimeState: effectiveState,
        now,
        webResults,
        searchReason,
      }),
    [context, effectiveState, now, searchReason, webResults],
  );
  const uiComposition = useBrowserUiComposition(browserProjection.layout);
  const projection = browserProjection.projection;
  const layout = uiComposition.layout;
  const livingUi = useMemo(() => {
    const state = (componentId: string) =>
      resolveBrowserComponentRuntimeState(
        uiComposition.document,
        uiComposition.registry,
        componentId,
      ) ?? { visible: false, actions: {} };
    return {
      control: state(BROWSER_SYSTEM_COMPONENT_IDS.control),
      candidates: state(BROWSER_SYSTEM_COMPONENT_IDS.candidates),
      thread: state(BROWSER_SYSTEM_COMPONENT_IDS.thread),
      outcome: state(BROWSER_SYSTEM_COMPONENT_IDS.outcome),
      diagnostics: state(BROWSER_SYSTEM_COMPONENT_IDS.diagnostics),
      dataSafety: state(BROWSER_SYSTEM_COMPONENT_IDS.dataSafety),
      inspector: state(BROWSER_SYSTEM_COMPONENT_IDS.inspector),
    };
  }, [uiComposition.document, uiComposition.registry]);
  const dataSafetyAvailability: BrowserDataSafetyActionAvailability = {
    export: livingUi.dataSafety.actions.export === true,
    integrity: livingUi.dataSafety.actions.integrity === true,
    restore: livingUi.dataSafety.actions.restore === true,
    delete: livingUi.dataSafety.actions.delete === true,
    purge: livingUi.dataSafety.actions.purge === true,
    rollback: livingUi.dataSafety.actions.rollback === true,
    close: livingUi.dataSafety.actions.close === true,
  };
  const outcomeCanOpen = livingUi.outcome.visible &&
    livingUi.outcome.actions.close === true;
  const threadCanOpen = livingUi.thread.visible && livingUi.thread.actions.close === true;
  const diagnosticsCanOpen = livingUi.diagnostics.visible &&
    livingUi.diagnostics.actions.close === true;
  const dataSafetyCanOpen = livingUi.dataSafety.visible &&
    livingUi.dataSafety.actions.close === true;
  const inspectorCanOpen = livingUi.inspector.visible &&
    livingUi.inspector.actions.close === true;
  const announcedDueActions = useRef(new Set<string>());
  const deliveredSchedulerReceipts = useRef(new Set<string>());
  const rejectedUiResources = useRef(new Set<string>());

  useEffect(() => {
    if (!threadCanOpen) setThreadOpen(false);
    if (!outcomeCanOpen) setOutcomeTarget(null);
    if (!diagnosticsCanOpen) setDiagnosticsOpen(false);
    if (!dataSafetyCanOpen) setDataSafetyOpen(false);
    if (!inspectorCanOpen) setInspectedNode(null);
  }, [
    dataSafetyCanOpen,
    diagnosticsCanOpen,
    inspectorCanOpen,
    outcomeCanOpen,
    threadCanOpen,
  ]);

  useEffect(() => {
    if (!agentReady) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (!active || polling || document.visibilityState !== "visible") return;
      polling = true;
      try {
        const response = await runtime.agent.listSchedulerOutbox({ retries: 1 });
        const latestOutcomeCollection = [...response.items]
          .reverse()
          .find((candidate) => candidate.kind === "outcome_collection" && candidate.domainId &&
            context.nodes.some((node) =>
              node.id === candidate.domainId && node.kind === "action" && !node.outcome,
            ));
        if (latestOutcomeCollection?.domainId) {
          // Delivery acknowledgement only means that the Browser showed the
          // prompt. It is not an outcome. Keep the Domain id from acknowledged
          // receipts so a restart can still open the unresolved action.
          setOutcomeCollectionActionId(latestOutcomeCollection.domainId);
          setSecretaryNotice(schedulerSecretaryNotice(latestOutcomeCollection, context.nodes));
        }
        const item = response.items.find(
          (candidate) =>
            candidate.deliveryStatus === "pending" &&
            !deliveredSchedulerReceipts.current.has(candidate.receiptKey),
        );
        if (!item || !active) return;
        deliveredSchedulerReceipts.current.add(item.receiptKey);
        setSecretaryNotice(schedulerSecretaryNotice(item, context.nodes));
        setNotice(schedulerDeliveryNotice(item.kind));
        await runtime.agent.acknowledgeSchedulerOutbox(item.receiptKey, {
          idempotencyKey: `browser-delivery:${item.receiptKey}`,
        });
      } catch {
        // Scheduler delivery is additive: context, chat, and explicit user work
        // remain usable when this quiet polling path is temporarily unavailable.
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 15_000);
    const onVisibility = () => void poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [agentReady, context.nodes, runtime.agent]);

  useEffect(() => {
    const alreadyApplied = new Set(
      uiComposition.history.flatMap((entry) => entry.sourceRunId ? [entry.sourceRunId] : []),
    );
    const candidate = context.nodes.find((node) => {
      const payload = recordOf(node.payload);
      return node.kind === "resource" &&
        payload?.resourceType === "ui_change_set" &&
        !alreadyApplied.has(node.id) &&
        !rejectedUiResources.current.has(node.id);
    });
    if (!candidate) return;
    try {
      const draft = uiDraftFromResource(candidate, uiComposition.document.id);
      uiComposition.applyChangeSet(draft);
      setNotice("桌面调整已应用，也可以随时撤销。");
    } catch (error) {
      rejectedUiResources.current.add(candidate.id);
      setNotice(readableError(error, "这次桌面调整无法应用"));
    }
  }, [context.nodes, layout.arrangement.orderedCardIds, uiComposition]);

  useEffect(() => {
    const due = context.nodes.filter((node) => {
      if (node.kind !== "action" || isClosed(node)) return false;
      const reviewAt = optionalText(node.reviewAt);
      return reviewAt !== undefined && Date.parse(reviewAt) <= now.getTime();
    });
    const unseen = due.filter((node) => !announcedDueActions.current.has(node.id));
    if (unseen.length > 0) {
      unseen.forEach((node) => announcedDueActions.current.add(node.id));
      const dueNotice =
        unseen.length === 1
          ? `“${nodeLabel(unseen[0])}”到了结果窗口，秘书在等你回收真实结果。`
          : `有 ${unseen.length} 个行动到了结果窗口，秘书在等你回收真实结果。`;
      setNotice(dueNotice);
      activeDueNotice.current = dueNotice;
      setSecretaryNotice(dueNotice);
    } else if (due.length === 0 && activeDueNotice.current) {
      const staleDueNotice = activeDueNotice.current;
      activeDueNotice.current = null;
      setSecretaryNotice((current) => current === staleDueNotice ? null : current);
    }
  }, [context.nodes, now]);

  useEffect(() => {
    if (!domainReady) {
      setCandidateDueItems([]);
      return;
    }
    let active = true;
    void runtime.listDueCandidates({ at: now.toISOString(), limit: 50 }, { retries: 1 })
      .then((response) => {
        if (!active) return;
        setCandidateDueItems(response.items);
        const first = response.items[0];
        if (first) {
          setSecretaryNotice(first.prompt);
        }
        for (const item of response.items) {
          if (acknowledgedCandidateDue.current.has(item.receiptKey)) continue;
          // Recording delivery is not a conclusion and does not change the
          // candidate state. It only prevents the three- or seven-day light
          // prompt from being delivered repeatedly across refresh/restart.
          acknowledgedCandidateDue.current.add(item.receiptKey);
          void runtime.commandCandidate({
            candidateId: item.candidate.id,
            command: "acknowledge_due",
            audit: { actor: "system", sessionId, authorizationMode: "automatic" },
          }, { idempotencyKey: `candidate-due:${item.receiptKey}` }).catch(() => {
            acknowledgedCandidateDue.current.delete(item.receiptKey);
          });
        }
      })
      .catch(() => {
        // Candidate reminders are additive; a due read failure never hides or
        // rewrites the durable candidate nodes already present in context.
      });
    return () => {
      active = false;
    };
  }, [context.nodes, domainReady, now, runtime, sessionId]);

  const runtimeDataSafetyActions = useMemo<BrowserDataSafetyActions>(
    () => ({
      exportAll: () => browserProfile.exportAll(),
      checkIntegrity: () => browserProfile.checkIntegrity(),
      prepareDangerous: (request) => browserProfile.prepareDangerous(request),
      prepareRecentRecovery: () => browserProfile.prepareRecentRecovery(),
      commitDangerous: (request) => browserProfile.commitDangerous(request),
      listChangeSets: async () =>
        (await runtime.listChangeSets()).map((changeSet) => ({
          id: changeSet.id,
          title: changeSet.rationale || changeSet.reasonType || changeSet.id,
          summary: changeSet.reasonType,
          status: changeSet.status,
          actor: changeSet.proposerActor,
          createdAt: changeSet.createdAt,
          reversible: changeSet.reversible,
        })),
      rollbackChangeSet: (changeSetId) =>
        runtime.applyChange({
          operation: "rollback",
          changeSetId,
          reason: "用户从数据与安全面板显式回滚",
          audit: { actor: "user", sessionId, authorizationMode: "automatic" },
        }),
    }),
    [browserProfile, runtime, sessionId],
  );
  const resolvedDataSafetyActions = dataSafetyActions ?? runtimeDataSafetyActions;

  const deskMessages = useMemo<ChatMessageRow[]>(
    () =>
      messages.map((message) => ({
        ...message,
        convId: sessionId,
      })),
    [messages, sessionId],
  );
  const conversation = useMemo<ConversationRow>(
    () => ({
      id: sessionId,
      title: "本地对话",
      channel: "local-browser",
      createdAt: messages[0]?.createdAt ?? new Date().toISOString(),
      updatedAt: messages[messages.length - 1]?.createdAt ?? new Date().toISOString(),
    }),
    [messages, sessionId],
  );

  const appendMessage = useCallback((role: "user" | "assistant", content: string) => {
    const createdAt = new Date().toISOString();
    setMessages((current) => [
      ...current,
      {
        id: `browser-message-${createdAt}-${current.length}`,
        role,
        content,
        createdAt,
      },
    ]);
  }, []);

  const refreshAll = useCallback(async () => {
    setNotice("正在重新连接本地服务…");
    try {
      const nextHealth = await refreshHealth();
      if (nextHealth.domain.state === "ready") {
        await refreshContext();
        setNotice("已刷新。");
      } else {
        setNotice("本地服务还没连上。");
      }
    } catch (error) {
      setNotice(readableError(error, "本地服务仍未连接"));
    }
  }, [refreshContext, refreshHealth]);

  const sendAgentTurn = useCallback(
    async (text: string) => {
      if (!agentReady) {
        setNotice("本地助手还没连上，请稍后再试。");
        return;
      }
      if (activeRunId) {
        setNotice("上一轮仍在本机执行；可以等待，或明确停止它。");
        return;
      }
      setThreadOpen(true);
      appendMessage("user", text);
      setAgentStatus("正在提交");
      const controller = new AbortController();
      pollController.current = controller;
      try {
        const accepted = await runtime.agent.startTurn(
          {
            sessionId,
            text,
            systemPrompt:
              `Current Latitude browser UiSurfaceV2 is ${uiComposition.document.id} revision ${uiComposition.document.revision}. ` +
              "If and only if the user asks to customize the interface, call ui_customize with this exact surfaceId and baseRevision. " +
              `Registered components in current order: ${uiComposition.document.components
                .slice()
                .sort((left, right) => left.order - right.order)
                .map((component) => `${component.id}:${component.type}`)
                .join(", ")}. ` +
              "Only visibility, move/order, registered spans, presentation props, and registered event-command bindings are allowed; never put Domain content in UI props.",
          },
          { signal: controller.signal },
        );
        setActiveRunId(accepted.runId);
        setAgentStatus(runStatusLabel(accepted.status));
        const finished = await runtime.agent.waitForRun(accepted.runId, {
          signal: controller.signal,
          pollIntervalMs: 350,
          onStatus: (run) => setAgentStatus(runStatusLabel(run.status)),
        });
        if (finished.status === "failed") {
          appendMessage("assistant", finished.error?.message || "这次没有完成，请再试一次。");
        } else if (finished.status === "cancelled") {
          appendMessage("assistant", "已停止。已完成的内容会保留。");
        } else {
          appendMessage(
            "assistant",
            assistantTextFromRun(finished) || "完成了。",
          );
          const uiDraft = uiChangeSetFromAgentRun(finished as unknown as Record<string, unknown>);
          if (uiDraft) {
            uiComposition.applyChangeSet(uiDraft);
            setNotice("桌面已更新。");
          }
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          appendMessage("assistant", readableError(error, "这轮没有完成"));
        }
      } finally {
        setActiveRunId(null);
        setAgentStatus(null);
        pollController.current = null;
        if (domainReady) await refreshContext().catch(() => undefined);
      }
    }, [
      activeRunId,
      agentReady,
      appendMessage,
      domainReady,
      refreshContext,
      runtime.agent,
      sessionId,
      uiComposition,
    ],
  );

  const cancelAgentTurn = useCallback(async () => {
    if (!activeRunId) return;
    try {
      setAgentStatus("正在停止");
      await runtime.agent.cancelRun(activeRunId);
      setNotice("正在停止…");
    } catch (error) {
      setNotice(readableError(error, "停止请求没有送达"));
    }
  }, [activeRunId, runtime.agent]);

  const derivedSearch = useMemo(() => deriveSearchQuery(context), [context]);
  const searchWeb = useCallback(
    async (explicitQuery?: string) => {
      const query = explicitQuery?.trim() || searchDraft.trim() || derivedSearch.query;
      if (!query) {
        setNotice("先写一个要查的问题。");
        return;
      }
      if (!agentReady) {
        setNotice("本地助手还没连上，现在不能搜索。");
        return;
      }
      setSearchBusy(true);
      try {
        const response = await runtime.searchWeb({ query, maxResults: 3, freshnessDays: 30 });
        setWebResults(response.results ?? []);
        setLastSearchQuery(response.query || query);
        setSearchReason(
          searchDraft.trim()
            ? `你主动搜索“${query}”`
            : derivedSearch.reason,
        );
        setNotice(webSearchCoverageNotice(response));
        if (domainReady) await refreshContext().catch(() => undefined);
      } catch (error) {
        setNotice(readableError(error, "搜索没有完成"));
      } finally {
        setSearchBusy(false);
      }
    }, [
      agentReady,
      derivedSearch.query,
      derivedSearch.reason,
      domainReady,
      refreshContext,
      runtime,
      searchDraft,
    ],
  );

  const createWeeklyReview = useCallback(async () => {
    if (!domainReady || domainBusy) {
      setNotice("本地服务未连接，暂时不能生成周回顾。");
      return;
    }
    setDomainBusy(true);
    try {
      await runtime.createWeeklyReview({
        audit: { actor: "user", sessionId, authorizationMode: "automatic" },
      });
      await refreshContext();
      setNotice("周回顾已生成。");
    } catch (error) {
      setNotice(readableError(error, "周回顾没有生成"));
    } finally {
      setDomainBusy(false);
    }
  }, [domainBusy, domainReady, refreshContext, runtime, sessionId]);

  const applyCandidateCommand = useCallback(async (
    candidateId: string,
    command: CandidateCommand,
  ) => {
    if (!domainReady || domainBusy) {
      setNotice("本地服务未连接，本次没有保存。");
      return;
    }
    setDomainBusy(true);
    try {
      await runtime.commandCandidate({
        candidateId,
        command,
        audit: { actor: "user", sessionId, authorizationMode: "automatic" },
      });
      await refreshContext();
      setNotice(candidateCommandNotice(command));
    } catch (error) {
      setNotice(readableError(error, "候选状态没有写入"));
    } finally {
      setDomainBusy(false);
    }
  }, [domainBusy, domainReady, refreshContext, runtime, sessionId]);

  const recordFeedFeedback = useCallback(
    async (itemId: string, feedback: FeedFeedback) => {
      if (!domainReady) {
        setNotice("本地服务未连接，本次没有保存。");
        return;
      }
      const feed = projection.bindings["desktop.feed"];
      const item = feed?.kind === "feed"
        ? feed.items.find((candidate) => candidate.id === itemId)
        : undefined;
      const feedbackLabel = {
        "new-angle": "有新角度",
        known: "已知道",
        "not-useful": "没用",
      }[feedback];
      const targetNodeId = item?.lineage?.entityType === "resource"
        ? item.lineage.entityId
        : undefined;
      if (!item || !targetNodeId) {
        setNotice("这条资讯暂时不能保存反馈。");
        return;
      }
      setDomainBusy(true);
      try {
        await runtime.applyFeedback({
          feedbackType: feedback === "not-useful" ? "reject" : "confirm",
          targetNodeId,
          // Domain records this click as its own user EvidenceRef. The webpage's
          // provenance must not impersonate the user's relevance judgement.
          evidenceRefs: [],
          correctedScope: {
            curatorFeedback: feedFeedbackPayload(
              itemId,
              feedback,
              item,
              lastSearchQuery,
              searchReason,
            ),
          },
          audit: { actor: "user", sessionId, authorizationMode: "automatic" },
        });
        await refreshContext();
        setNotice(`已留痕：${feedbackLabel}。`);
      } catch (error) {
        setNotice(readableError(error, "资讯反馈没有写入"));
      } finally {
        setDomainBusy(false);
      }
    }, [
      domainReady,
      projection.bindings,
      lastSearchQuery,
      refreshContext,
      runtime,
      searchReason,
      sessionId,
    ],
  );

  const editAction = useCallback(
    async (row: AnchorRow, nextText: string) => {
      if (!domainReady || row.lineage?.entityType !== "action") return;
      setDomainBusy(true);
      try {
        await runtime.applyChange({
          operation: "update",
          id: row.lineage.entityId,
          label: nextText,
          audit: { actor: "user", sessionId, authorizationMode: "automatic" },
        });
        await refreshContext();
        setNotice(`已改名：${nextText}`);
      } catch (error) {
        setNotice(readableError(error, "行动名称没有写入"));
      } finally {
        setDomainBusy(false);
      }
    }, [domainReady, refreshContext, runtime, sessionId],
  );

  const openLineage = useCallback(
    (lineage: LineageRef) => {
      if (!inspectorCanOpen) {
        setNotice("来源检查器已在组件设置中关闭。");
        return;
      }
      const node = context.nodes.find((candidate) => candidate.id === lineage.entityId);
      if (node) setInspectedNode(node);
      else setNotice("当前投影能确认这条来源，但完整节点不在本次 context 窗口里。");
    },
    [context.nodes, inspectorCanOpen],
  );

  const cardHandlers = useMemo<CardHandlers>(
    () => ({
      ...(outcomeCanOpen
        ? {
            onAnchorComplete: (row: AnchorRow) => {
              if (row.lineage?.entityType === "action") setOutcomeTarget(row);
            },
          }
        : {}),
      onAnchorEdit: editAction,
      ...(inspectorCanOpen ? { onLineage: openLineage } : {}),
      onFeedFeedback: (itemId, feedback) => {
        void recordFeedFeedback(itemId, feedback);
      },
    }),
    [editAction, inspectorCanOpen, openLineage, outcomeCanOpen, recordFeedFeedback],
  );

  return (
    <>
      <DimensionPresetApp
        projection={projection}
        layout={layout}
        composition={{
          document: uiComposition.document,
          registry: uiComposition.registry,
        }}
        paperHandlers={cardHandlers}
        localCardEditing="disabled"
        secretaryPresentation="rail"
        secretaryNotice={secretaryNotice}
        onCompanionVisibilityChange={(visible) => {
          uiComposition.applyChangeSet({
            actor: "user",
            reason: visible ? "唤回左侧秘书栏" : "暂时隐藏左侧秘书栏",
            operations: [
              {
                op: "set_visibility",
                componentId: BROWSER_COMPANION_COMPONENT_ID,
                visible,
              },
            ],
          });
        }}
        onSendMessage={(text) => void sendAgentTurn(text)}
        thread={
          <>
            {livingUi.control.visible && (
              <BrowserControlStrip
                healthState={state}
                domainState={health?.domain.state ?? "starting"}
                agentState={health?.agent.state ?? "starting"}
                agentAuthentication={agentAuthentication}
                contextLoading={contextLoading}
                notice={notice ?? contextError}
                searchDraft={searchDraft}
                searchBusy={searchBusy}
                activeRunId={activeRunId}
                agentStatus={agentStatus}
                domainBusy={domainBusy}
                actionAvailability={{
                  search: livingUi.control.actions.search === true,
                  refresh: livingUi.control.actions.refresh === true,
                  review: livingUi.control.actions.review === true,
                  cancel: livingUi.control.actions.cancel === true,
                }}
                onSearchDraftChange={setSearchDraft}
                onSearch={() => void searchWeb()}
                onRefresh={() => void refreshAll()}
                onReview={() => void createWeeklyReview()}
                onCancel={() => void cancelAgentTurn()}
              />
            )}
            {livingUi.candidates.visible && (
              <CandidateInterventionStrip
                candidates={context.nodes.filter(isCandidateNode)}
                dueItems={candidateDueItems}
                busy={domainBusy || !domainReady}
                actionAvailability={{
                  touch: livingUi.candidates.actions.touch === true,
                  shape: livingUi.candidates.actions.shape === true,
                  conclude: livingUi.candidates.actions.conclude === true,
                  park: livingUi.candidates.actions.park === true,
                }}
                onCommand={(candidateId, command) => {
                  void applyCandidateCommand(candidateId, command);
                }}
              />
            )}
            {threadOpen && threadCanOpen && (
              <DeskThread
                messages={deskMessages}
                conversations={[conversation]}
                currentId={sessionId}
                streaming=""
                loading={Boolean(activeRunId)}
                onSelectConversation={() => undefined}
                onClose={() => setThreadOpen(false)}
                closeEnabled={livingUi.thread.actions.close === true}
              />
            )}
          </>
        }
        onOpenReview={() => void createWeeklyReview()}
        onOpenSettings={() => {
          if (diagnosticsCanOpen) setDiagnosticsOpen(true);
        }}
        onAdjustDesktop={() => setCompositionOpen(true)}
        onCardVisibilityChange={(cardId, visible) => {
          uiComposition.applyChangeSet({
            actor: "user",
            reason: visible ? "添加桌面卡片" : "移除桌面卡片",
            operations: [
              {
                op: "set_visibility",
                componentId: cardId,
                visible,
              },
            ],
          });
        }}
        onSecretaryInteract={(intent) => {
          if (intent === "chat") {
            if (threadCanOpen) setThreadOpen(true);
          }
          else if (intent === "review") void createWeeklyReview();
          else {
            if (!outcomeCanOpen) {
              setNotice("结果回收模块已在组件设置中关闭。");
              return;
            }
            const eventDue = outcomeCollectionActionId
              ? context.nodes.find((node) =>
                  node.id === outcomeCollectionActionId &&
                  node.kind === "action" &&
                  !isClosed(node),
                )
              : undefined;
            const due = eventDue ?? firstDueAction(context.nodes, now);
            if (due) {
              setOutcomeTarget({
                text: nodeLabel(due),
                meta: "结果待回收",
                actionable: true,
                lineage: {
                  entityType: "action",
                  entityId: due.id,
                  label: "来自你的行动",
                },
              });
            } else {
              setOutcomeCollectionActionId(null);
              setNotice("现在没有到期、需要你裁决结果的行动。");
            }
          }
        }}
        layerHandlers={{
          onFeedFeedback: (itemId, feedback) => void recordFeedFeedback(itemId, feedback),
          onLineage: openLineage,
          onRelationInspect: (metric) => {
            const lineage = metric.lineage?.[0];
            if (lineage) openLineage(lineage);
          },
          onCompleteAnchor: (row) => {
            if (row.lineage?.entityType === "action" && outcomeCanOpen) {
              setOutcomeTarget(row);
            }
          },
          onNodeOpen: (node) => {
            if (!inspectorCanOpen) return;
            const source = context.nodes.find((candidate) => candidate.id === node.id);
            if (source) setInspectedNode(source);
          },
        }}
      />

      {outcomeTarget && outcomeCanOpen && (
        <OutcomeDialog
          row={outcomeTarget}
          action={context.nodes.find((node) => node.id === outcomeTarget.lineage?.entityId)}
          busy={domainBusy}
          closeEnabled={livingUi.outcome.actions.close === true}
          submitEnabled={livingUi.outcome.actions.submit === true}
          onClose={() => setOutcomeTarget(null)}
          onSubmit={async ({ outcome, effect, revisedStatement }) => {
            if (!outcomeTarget.lineage || !domainReady) return;
            setDomainBusy(true);
            try {
              const action = context.nodes.find(
                (node) => node.id === outcomeTarget.lineage?.entityId,
              );
              await runtime.recordOutcome({
                actionId: outcomeTarget.lineage.entityId,
                label: `结果：${outcomeTarget.text}`,
                outcome,
                effect,
                observedAt: new Date().toISOString(),
                claimId: claimIdOf(action),
                ...(["contracts", "revises"].includes(effect)
                  ? { revisedStatement }
                  : {}),
                audit: { actor: "user", sessionId, authorizationMode: "automatic" },
              });
              setOutcomeTarget(null);
              await refreshContext();
              setNotice("结果已保存。");
            } catch (error) {
              setNotice(readableError(error, "结果没有写入"));
            } finally {
              setDomainBusy(false);
            }
          }}
        />
      )}

      {inspectedNode && inspectorCanOpen && (
        <NodeDialog
          node={inspectedNode}
          closeEnabled={livingUi.inspector.actions.close === true}
          onClose={() => setInspectedNode(null)}
        />
      )}

      {diagnosticsOpen && diagnosticsCanOpen && (
        <DiagnosticsDialog
          sessionId={sessionId}
          health={health}
          messageHydrationError={messageHydrationError}
          actionAvailability={{
            dataSafety: livingUi.diagnostics.actions.data_safety === true && dataSafetyCanOpen,
            close: livingUi.diagnostics.actions.close === true,
          }}
          onDataSafety={() => {
            if (!dataSafetyCanOpen) return;
            setDiagnosticsOpen(false);
            setDataSafetyOpen(true);
          }}
          onClose={() => setDiagnosticsOpen(false)}
        />
      )}

      {dataSafetyOpen && dataSafetyCanOpen && (
        <BrowserDataSafetyDialog
          actions={resolvedDataSafetyActions}
          actionAvailability={dataSafetyAvailability}
          onChanged={async () => {
            await refreshContext().catch(() => undefined);
          }}
          onClose={() => setDataSafetyOpen(false)}
        />
      )}

      {compositionOpen && (
        <BrowserCompositionDialog
          // A rollback increments the authoritative surface revision. Remount
          // the draft editor so it cannot keep showing pre-rollback controls.
          key={`browser-composition-${uiComposition.document.revision}`}
          layout={layout}
          document={uiComposition.document}
          registry={uiComposition.registry}
          history={uiComposition.history}
          onApply={(draft) => {
            uiComposition.applyChangeSet(draft);
            setNotice("桌面已保存。");
          }}
          onRollback={(id) => {
            uiComposition.rollbackChangeSet(id);
            setNotice("已撤销上次桌面调整。");
          }}
          onReset={() => {
            uiComposition.resetToProductLayout();
            setNotice("已恢复产品默认桌面；回滚动作仍有记录。");
          }}
          onClose={() => setCompositionOpen(false)}
        />
      )}
    </>
  );
}

interface BrowserControlStripProps {
  healthState: RuntimeServiceState;
  domainState: RuntimeServiceState;
  agentState: RuntimeServiceState;
  agentAuthentication?: string;
  contextLoading: boolean;
  notice: string | null;
  searchDraft: string;
  searchBusy: boolean;
  activeRunId: string | null;
  agentStatus: string | null;
  domainBusy: boolean;
  actionAvailability: {
    search: boolean;
    refresh: boolean;
    review: boolean;
    cancel: boolean;
  };
  onSearchDraftChange: (value: string) => void;
  onSearch: () => void;
  onRefresh: () => void;
  onReview: () => void;
  onCancel: () => void;
}

function CandidateInterventionStrip({
  candidates,
  dueItems,
  busy,
  actionAvailability,
  onCommand,
}: {
  candidates: KnowledgeNode[];
  dueItems: DueCandidateItem[];
  busy: boolean;
  actionAvailability: Partial<Record<CandidateCommand, boolean>>;
  onCommand: (candidateId: string, command: CandidateCommand) => void;
}) {
  const dueByCandidate = new Map(
    dueItems.map((item) => [item.candidate.id, item] as const),
  );
  const visible = candidates
    .filter((candidate) =>
      ["proposed", "touched", "shaping", "concluded", "parked"]
        .includes(candidateStateOf(candidate)),
    )
    .sort((left, right) => {
      const rank = { shaping: 0, touched: 1, proposed: 2, concluded: 3, parked: 4 };
      return (rank[candidateStateOf(left) as keyof typeof rank] ?? 9) -
        (rank[candidateStateOf(right) as keyof typeof rank] ?? 9);
    })
    .slice(0, 3);
  if (visible.length === 0) return null;

  return (
    <section
      className="dim-paper"
      aria-label="候选共创"
      style={{
        flexShrink: 0,
        padding: "10px 12px",
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>候选共创</strong>
        <span className="dim-meta">你来决定如何推进，超时只会提醒。</span>
      </div>
      {visible.map((candidate) => {
        const state = candidateStateOf(candidate);
        const due = dueByCandidate.get(candidate.id);
        const actions = candidateActions(state);
        return (
          <article
            key={candidate.id}
            data-candidate-id={candidate.id}
            data-candidate-state={state}
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 8,
              borderTop: "1px solid color-mix(in srgb, var(--dim-ink) 12%, transparent)",
              paddingTop: 8,
            }}
          >
            <span style={{ flex: "1 1 260px", minWidth: 0 }}>
              <strong style={{ display: "block", fontSize: 13 }}>{nodeLabel(candidate)}</strong>
              <span className="dim-meta">
                {candidateStateLabel(state)} · {optionalText(candidate.statement)
                  || optionalText(candidate.content)
                  || "等待进一步塑形"}
              </span>
              {due && (
                <span className="dim-meta" role="status" style={{ display: "block" }}>
                  {due.prompt}
                </span>
              )}
            </span>
            {actions.map((action) => (
              <button
                key={action.command}
                type="button"
                className={action.command === "park" ? "dim-btn dim-btn--quiet" : "dim-btn"}
                disabled={busy || actionAvailability[action.command] !== true}
                aria-disabled={busy || actionAvailability[action.command] !== true}
                title={actionAvailability[action.command] === true
                  ? undefined
                  : "该候选动作已在组件设置中关闭"}
                aria-label={`${action.label}：${nodeLabel(candidate)}`}
                onClick={() => onCommand(candidate.id, action.command)}
              >
                {action.label}
              </button>
            ))}
          </article>
        );
      })}
    </section>
  );
}

function BrowserControlStrip({
  healthState,
  domainState,
  agentState,
  agentAuthentication,
  contextLoading,
  notice,
  searchDraft,
  searchBusy,
  activeRunId,
  agentStatus,
  domainBusy,
  actionAvailability,
  onSearchDraftChange,
  onSearch,
  onRefresh,
  onReview,
  onCancel,
}: BrowserControlStripProps) {
  return (
    <section
      className="dim-paper"
      aria-label="本地产品闭环控制"
      style={{
        flexShrink: 0,
        padding: "8px 12px",
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
      }}
      data-runtime-state={healthState}
    >
      <span className="dim-meta" aria-label="本地服务状态">
        数据 {serviceLabel(domainState)} · 助手 {agentServiceLabel(agentState, agentAuthentication)}
        {contextLoading ? " · 读取中" : ""}
      </span>
      <form
        style={{ display: "flex", alignItems: "center", gap: 6, flex: "1 1 280px" }}
        onSubmit={(event) => {
          event.preventDefault();
          if (actionAvailability.search) onSearch();
        }}
      >
        <input
          className="dim-input"
          aria-label="搜索资讯"
          value={searchDraft}
          onChange={(event) => onSearchDraftChange(event.target.value)}
          placeholder="搜索资讯…"
          disabled={!actionAvailability.search}
        />
        <button
          type="submit"
          className="dim-btn"
          disabled={!actionAvailability.search || searchBusy || agentState !== "ready"}
          aria-disabled={!actionAvailability.search || searchBusy || agentState !== "ready"}
        >
          {searchBusy ? "搜索中…" : "搜索"}
        </button>
      </form>
      <button
        type="button"
        className="dim-btn dim-btn--quiet"
        onClick={onRefresh}
        disabled={!actionAvailability.refresh}
        aria-disabled={!actionAvailability.refresh}
      >
        刷新
      </button>
      <button
        type="button"
        className="dim-btn dim-btn--accent"
        onClick={onReview}
        disabled={!actionAvailability.review || domainBusy || domainState !== "ready"}
        aria-disabled={!actionAvailability.review || domainBusy || domainState !== "ready"}
      >
        周回顾
      </button>
      {activeRunId && (
        <button
          type="button"
          className="dim-btn"
          onClick={onCancel}
          disabled={!actionAvailability.cancel}
          aria-disabled={!actionAvailability.cancel}
        >
          停止
        </button>
      )}
      {(agentStatus || notice) && (
        <span className="dim-meta" role="status">
          {agentStatus ? `助手 · ${agentStatus}` : notice}
        </span>
      )}
    </section>
  );
}

function OutcomeDialog({
  row,
  action,
  busy,
  closeEnabled,
  submitEnabled,
  onClose,
  onSubmit,
}: {
  row: AnchorRow;
  action?: KnowledgeNode;
  busy: boolean;
  closeEnabled: boolean;
  submitEnabled: boolean;
  onClose: () => void;
  onSubmit: (value: {
    outcome: string;
    effect: "confirms" | "contracts" | "revises" | "refutes" | "unknown";
    revisedStatement: string;
  }) => Promise<void>;
}) {
  const [outcome, setOutcome] = useState("");
  const [effect, setEffect] = useState<
    "confirms" | "contracts" | "revises" | "refutes" | "unknown"
  >("unknown");
  const [revisedStatement, setRevisedStatement] = useState("");
  const expectedOutcome = optionalText(action?.expectedOutcome);
  const trigger = actionFieldText(action, "trigger");
  const observationWindow = actionObservationWindow(action);
  const needsRevisedStatement = effect === "contracts" || effect === "revises";

  return (
    <div
      className="dimension-root"
      style={dialogBackdropStyle}
      role="dialog"
      aria-modal="true"
      aria-label="回收行动结果"
    >
      <form
        className="dim-paper"
        style={dialogPaperStyle}
        onSubmit={(event) => {
          event.preventDefault();
          if (
            submitEnabled &&
            outcome.trim() &&
            (!needsRevisedStatement || revisedStatement.trim())
          ) {
            void onSubmit({ outcome: outcome.trim(), effect, revisedStatement: revisedStatement.trim() });
          }
        }}
      >
        <p className="dim-eyebrow">REALITY CHECK · 结果回收</p>
        <h2 style={{ margin: "6px 0 0", fontSize: 20 }}>{row.text}</h2>
        {expectedOutcome && (
          <p className="dim-body">原本预期：{expectedOutcome}</p>
        )}
        {trigger && <p className="dim-body">触发情境：{trigger}</p>}
        {observationWindow && <p className="dim-body">观察窗口：{observationWindow}</p>}
        <label className="dim-body">
          现实里发生了什么？
          <textarea
            aria-label="实际结果"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
            rows={4}
            autoFocus
            style={dialogFieldStyle}
          />
        </label>
        <label className="dim-body">
          对原判断的影响
          <select
            aria-label="对认知的影响"
            value={effect}
            onChange={(event) =>
              setEffect(event.target.value as typeof effect)
            }
            style={dialogFieldStyle}
          >
            <option value="unknown">先只记录结果</option>
            <option value="confirms">支持原判断</option>
            <option value="contracts">收窄适用范围</option>
            <option value="revises">需要修订原判断</option>
            <option value="refutes">现实反驳了原判断</option>
          </select>
        </label>
        {needsRevisedStatement && (
          <label className="dim-body">
            {effect === "contracts" ? "收窄后的判断 / 适用范围" : "修订后的判断"}
            <textarea
              aria-label="认知修订"
              value={revisedStatement}
              onChange={(event) => setRevisedStatement(event.target.value)}
              rows={3}
              style={dialogFieldStyle}
            />
          </label>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            className="dim-btn"
            onClick={onClose}
            disabled={busy || !closeEnabled}
            aria-disabled={busy || !closeEnabled}
          >
            先不记
          </button>
          <button
            type="submit"
            className="dim-btn dim-btn--accent"
            disabled={
              busy ||
              !submitEnabled ||
              !outcome.trim() ||
              (needsRevisedStatement && !revisedStatement.trim())
            }
          >
            {busy ? "写入中…" : "写入真实结果"}
          </button>
        </div>
      </form>
    </div>
  );
}

function NodeDialog({
  node,
  closeEnabled,
  onClose,
}: {
  node: KnowledgeNode;
  closeEnabled: boolean;
  onClose: () => void;
}) {
  return (
    <div
      className="dimension-root"
      style={dialogBackdropStyle}
      role="dialog"
      aria-modal="true"
      aria-label="图谱来源详情"
    >
      <section className="dim-paper" style={dialogPaperStyle}>
        <p className="dim-eyebrow">{node.kind} · {node.authority ?? "authority unknown"}</p>
        <h2 style={{ margin: "6px 0", fontSize: 20 }}>{nodeLabel(node)}</h2>
        <p className="dim-body" style={{ whiteSpace: "pre-wrap" }}>
          {optionalText(node.statement) || optionalText(node.content) || "这条节点没有额外正文。"}
        </p>
        <p className="dim-meta">节点 ID · {node.id}</p>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="dim-btn"
            onClick={onClose}
            disabled={!closeEnabled}
            aria-disabled={!closeEnabled}
          >
            合上
          </button>
        </div>
      </section>
    </div>
  );
}

function DiagnosticsDialog({
  sessionId,
  health,
  messageHydrationError,
  actionAvailability,
  onDataSafety,
  onClose,
}: {
  sessionId: string;
  health: ReturnType<typeof useDesktopRuntime>["health"];
  messageHydrationError: string | null;
  actionAvailability: { dataSafety: boolean; close: boolean };
  onDataSafety: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="dimension-root"
      style={dialogBackdropStyle}
      role="dialog"
      aria-modal="true"
      aria-label="本地服务诊断"
    >
      <section className="dim-paper" style={dialogPaperStyle}>
        <p className="dim-eyebrow">深层设置</p>
        <h2 style={{ margin: "6px 0", fontSize: 20 }}>浏览器产品运行状态</h2>
        <p className="dim-body">数据服务：{serviceLabel(health?.domain.state ?? "starting")}</p>
        <p className="dim-body">
          助手服务：{agentServiceLabel(
            health?.agent.state ?? "starting",
            optionalText(recordOf(health?.agent.details?.model)?.authentication),
          )}
        </p>
        <p className="dim-meta">会话 ID · {sessionId}</p>
        <p className="dim-body">登录凭证只保存在本机。</p>
        {messageHydrationError && <p className="dim-body">{messageHydrationError}</p>}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <button
            type="button"
            className="dim-btn dim-btn--quiet"
            onClick={onDataSafety}
            disabled={!actionAvailability.dataSafety}
            aria-disabled={!actionAvailability.dataSafety}
          >
            数据与安全…
          </button>
          <button
            type="button"
            className="dim-btn"
            onClick={onClose}
            disabled={!actionAvailability.close}
            aria-disabled={!actionAvailability.close}
          >
            合上
          </button>
        </div>
      </section>
    </div>
  );
}

const dialogBackdropStyle = {
  position: "fixed",
  inset: 0,
  // All product dialogs must sit above the workspace and global secretary rail.
  zIndex: 100,
  display: "grid",
  placeItems: "center",
  padding: 24,
  background: "rgb(43 39 31 / 46%)",
} as const;

const dialogPaperStyle = {
  width: "min(560px, 100%)",
  maxHeight: "min(720px, 90vh)",
  overflowY: "auto",
  padding: 22,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  color: "var(--dim-ink)",
} as const;

const dialogFieldStyle = {
  display: "block",
  width: "100%",
  marginTop: 6,
  padding: "8px 10px",
  border: "1px solid var(--dim-line)",
  background: "var(--dim-paper)",
  color: "var(--dim-ink)",
  font: "inherit",
  boxSizing: "border-box",
} as const;

function deriveSearchQuery(context: KnowledgeContext): { query: string; reason?: string } {
  const tension = context.nodes.find((node) => node.kind === "tension" && !isClosed(node));
  const goal = context.nodes.find((node) => node.kind === "goal" && !isClosed(node));
  const source = tension ?? goal;
  if (!source) return { query: "" };
  const query = optionalText(source.statement) || optionalText(source.content) || nodeLabel(source);
  return {
    query,
    reason: tension
      ? `因为你正在验证张力“${nodeLabel(source)}”`
      : `因为它关系到目标“${nodeLabel(source)}”`,
  };
}

function firstDueAction(nodes: readonly KnowledgeNode[], now: Date): KnowledgeNode | undefined {
  return nodes.find((node) => {
    if (node.kind !== "action" || isClosed(node)) return false;
    const reviewAt = optionalText(node.reviewAt);
    return reviewAt !== undefined && Date.parse(reviewAt) <= now.getTime();
  });
}

function schedulerDeliveryNotice(kind: string): string {
  if (kind === "weekly_review") return "本周回顾准备好了。";
  if (kind === "outcome_collection") {
    return "有个行动到了回看时间。";
  }
  if (kind === "revision_resolution") {
    return "有条变化需要你确认。";
  }
  if (
    kind === "daily_curation" ||
    kind === "web_curated_digest" ||
    kind === "curated_web_digest"
  ) {
    return "今天的新资讯准备好了。";
  }
  return "有一条新消息。";
}

function schedulerSecretaryNotice(
  item: SchedulerOutboxItem,
  nodes: readonly KnowledgeNode[],
): string {
  if (item.kind === "outcome_collection") {
    const action = nodes.find((node) => node.id === item.domainId && node.kind === "action");
    if (!action) return "有个行动到了回看时间，实际结果怎么样？";
    const label = nodeLabel(action);
    const shortLabel = label.length > 24 ? `${label.slice(0, 23)}…` : label;
    return `“${shortLabel}”到回看时间了，实际结果怎么样？`;
  }
  if (item.kind === "weekly_review") return "本周回顾准备好了。";
  if (item.kind === "revision_resolution") return "有条变化需要你确认。";
  if (
    item.kind === "daily_curation" ||
    item.kind === "web_curated_digest" ||
    item.kind === "curated_web_digest"
  ) {
    return "今天的新资讯准备好了。";
  }
  return "有件事需要你看看。";
}

function candidateActions(
  state: string,
): Array<{ command: CandidateCommand; label: string }> {
  if (state === "proposed") {
    return [
      { command: "touch", label: "看看" },
      { command: "park", label: "先搁置" },
    ];
  }
  if (state === "touched") {
    return [
      { command: "shape", label: "继续整理" },
      { command: "conclude", label: "确认结论" },
      { command: "park", label: "先搁置" },
    ];
  }
  if (state === "shaping") {
    return [
      { command: "conclude", label: "确认结论" },
      { command: "park", label: "先搁置" },
    ];
  }
  return [];
}

function candidateStateLabel(state: string): string {
  return {
    proposed: "候选",
    touched: "已查看",
    shaping: "整理中",
    concluded: "已形成结论",
    parked: "已搁置",
  }[state] ?? "状态待校验";
}

function candidateCommandNotice(command: CandidateCommand): string {
  return {
    touch: "已打开，你可以继续整理。",
    shape: "已开始整理，7 天没有进展时会提醒一次。",
    conclude: "结论已保存。",
    park: "已搁置。",
    acknowledge_due: "收到！",
  }[command];
}

function isClosed(node: KnowledgeNode): boolean {
  return ["concluded", "superseded", "expired", "rejected", "revoked", "deleted"].includes(
    String(node.status ?? ""),
  ) || Boolean(node.outcome);
}

function claimIdOf(node: KnowledgeNode | undefined): string | undefined {
  if (!node) return undefined;
  const direct = optionalText(node.claimId);
  if (direct) return direct;
  const payload = node.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return optionalText((payload as Record<string, unknown>).claimId);
  }
  return undefined;
}

function actionFieldText(
  node: KnowledgeNode | undefined,
  field: string,
): string | undefined {
  if (!node) return undefined;
  const direct = optionalText(node[field]);
  if (direct) return direct;
  const payload = recordOf(node.payload);
  return optionalText(payload?.[field]);
}

function actionObservationWindow(node: KnowledgeNode | undefined): string | undefined {
  if (!node) return undefined;
  const direct = node.observationWindow;
  const payload = recordOf(node.payload);
  const value = direct ?? payload?.observationWindow;
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = recordOf(value);
  if (!record) return undefined;
  const start = optionalText(record.startsAt)
    || optionalText(record.startAt)
    || optionalText(record.start);
  const end = optionalText(record.endsAt)
    || optionalText(record.endAt)
    || optionalText(record.end);
  const duration = optionalText(record.duration) || optionalText(record.label);
  if (start && end) return `${formatObservationBoundary(start)} 至 ${formatObservationBoundary(end)}`;
  if (duration) return duration;
  try {
    return JSON.stringify(record);
  } catch {
    return undefined;
  }
}

function formatObservationBoundary(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function feedFeedbackPayload(
  itemId: string,
  feedback: FeedFeedback,
  item: FeedItem | undefined,
  query: string,
  reason: string | undefined,
) {
  return {
    feedback,
    itemId,
    title: item?.title ?? null,
    url: item?.url ?? null,
    provider: item?.provider ?? null,
    contentHash: item?.contentHash ?? null,
    searchQuery: query.trim() || null,
    searchReason: reason ?? null,
    reason: reason ?? null,
    recordedAt: new Date().toISOString(),
  };
}

function uiDraftFromResource(node: KnowledgeNode, expectedSurfaceId: string) {
  const payload = recordOf(node.payload);
  const targetSurface = payload?.surfaceId ?? payload?.baseLayoutId;
  if (targetSurface !== expectedSurfaceId) {
    throw new TypeError("ChangeSet 目标不是当前 Browser UiSurfaceV2");
  }
  const operations = parseBrowserUiDraftOperations(payload?.operations);
  if (operations.length === 0) {
    throw new TypeError("ChangeSet 没有浏览器可执行的已注册组件操作");
  }
  return {
    actor: "agent" as const,
    ...(Number.isInteger(payload?.baseRevision)
      ? { baseRevision: Number(payload?.baseRevision) }
      : {}),
    surfaceId: expectedSurfaceId,
    reason: optionalText(node.statement) || optionalText(node.label) || "助手调整桌面",
    sourceRunId: node.id,
    operations,
  };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nodeLabel(node: KnowledgeNode): string {
  return optionalText(node.label) || optionalText(node.title) || "未命名记录";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function webSearchCoverageNotice(response: WebSearchResponse): string {
  const coverage = response.coverage;
  if (!coverage) {
    return response.results.length
      ? `已回收 ${response.results.length} 条有真实链接的讯息；当前 Host 未返回时间覆盖说明。`
      : "搜索完成，但没有返回可展示结果；当前 Host 未返回时间覆盖说明。";
  }
  if (coverage.mode === "published_at_post_filter") {
    const cutoff = coverage.cutoff ? formatCoverageCutoff(coverage.cutoff) : "请求时间窗起点";
    const result = response.results.length
      ? `已回收 ${response.results.length} 条有真实链接的讯息`
      : "时间过滤后没有可展示的 dated 结果";
    return `${result}；Host 在 provider 返回的 ${coverage.providerResultCount} 条候选中，按 publishedAt 过滤到 ${cutoff} 之后，排除无日期 ${coverage.excludedUndatedCount} 条、过期 ${coverage.excludedStaleCount} 条。provider 检索有上限，这不是该时间段的穷尽结果。`;
  }
  return `${response.results.length
    ? `已回收 ${response.results.length} 条有真实链接的讯息`
    : "搜索没有返回可展示结果"}；provider 返回 ${coverage.providerResultCount} 条候选，未执行发布时间过滤，且不是穷尽结果。`;
}

function formatCoverageCutoff(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("zh-CN");
}

function serviceLabel(state: RuntimeServiceState): string {
  return state === "ready" ? "已连接" : state === "starting" ? "启动中" : "未连接";
}

function agentServiceLabel(
  state: RuntimeServiceState,
  authentication?: string,
): string {
  return authentication === "failed" ? "DeepSeek 鉴权失败" : serviceLabel(state);
}

function runStatusLabel(status: string): string {
  return {
    queued: "已排队",
    running: "执行中",
    completed: "已完成",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已停止",
  }[status] ?? status;
}

function readableError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return `${fallback}：${error.message}`;
  return fallback;
}

function getOrCreateBrowserSessionId(): string {
  try {
    const existing = window.localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)?.trim();
    if (existing) return existing;
    const suffix = typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sessionId = `latitude-browser-${suffix}`;
    window.localStorage.setItem(BROWSER_SESSION_STORAGE_KEY, sessionId);
    return sessionId;
  } catch {
    return `latitude-browser-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
