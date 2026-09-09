import { ComputerHistoryPanel } from "../../dimension/computer-history/ComputerHistoryPanel";
import { AnimatePresence } from "motion/react";
import { MotionSurface } from "../../dimension/SurfaceMotion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DeskThread,
  type AssistantExplanation,
} from "../../dimension/DeskThread";
import { SecretaryInvitation } from "../../dimension/SecretaryInvitation";
import { listen, emitTo } from "@tauri-apps/api/event";
import { SecretaryDock, BrowserPet } from "../../dimension/pet/SecretaryDock";
import { useSecretaryPet } from "../../dimension/pet/useSecretaryPet";
import { usePetInbox } from "../../dimension/pet/usePetInbox";
import { petCommand, nativePetAvailable } from "../../dimension/pet/nativePet";
import { besidePet } from "../../dimension/pet/geometry";
import type { PetAction, PetSnapshot } from "../../dimension/pet/types";
import { displayComposerMessage, type ComposerSubmission } from "../../dimension/composer/attachments";
import { updateDraft } from "../../dimension/composer/draftStore";
import { NoticeSettings, PetNoticeBubble, useNoticePreferences, type PetNotice } from "../../dimension/pet-notices";
import { DimToast } from "../../dimension/Shell";
import type { GoalChange } from "../../dimension/presets/GoalEditorDialog";
import { DimensionPresetApp } from "../../dimension/presets/DimensionPresetApp";
import type { DesktopViewContext } from "../../dimension/desktopWorkspace";
import { serializeDesktopViewContext } from "../../dimension/desktopViewContext";
import type {
  ActivityEntry,
  AnchorRow,
  CardHandlers,
  FeedFeedback,
  FeedItem,
  LineageRef,
  SecretaryIntent,
} from "../../dimension/types";
import type { ChatMessageRow, ConversationRow } from "../../lib/db";
import {
  BROWSER_COMPANION_COMPONENT_ID,
  BROWSER_SYSTEM_COMPONENT_IDS,
  resolveBrowserComponentRuntimeState,
} from "../../runtime/composition/browserProduction";
import {
  assistantExplanationFromRun,
  assistantTextFromRun,
  type CandidateCommand,
  type DueCandidateItem,
  DesktopRuntimeProvider,
  type DesktopRuntimePort,
  type KnowledgeContext,
  type KnowledgeNode,
  type ModelProviderSettings,
  type RuntimeServiceState,
  type SchedulerOutboxItem,
  useDesktopRuntime,
} from "../../runtime/host";
import {
  buildBrowserProjection,
  candidateStateOf,
  isCandidateNode,
} from "./browserProjection";
import { BrowserCompositionDialog } from "./BrowserCompositionDialog";
import { useDesktopContent } from "./useDesktopContent";
import { projectPublishedDesktop } from "./publishedDesktopProjection";
import { PersonaSettings } from "./PersonaSettings";
import { SettingsFrame } from "../../dimension/settings/SettingsFrame";
import { useAgentRun } from "../../runtime/host/useAgentRun";
import type { AgentRunResult } from "../../runtime/host/agentClient";
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
const BROWSER_CONTEXT_KINDS = [
  "evidence_event",
  "observation",
  "claim",
  "tension",
  "decision",
  "experiment",
  "action",
  "outcome",
  "topic",
  "goal",
  "project",
  "method",
  "interest",
  "value",
  "boundary",
  "resource",
  "question",
  "insight",
] as const;

type BrowserMessage = Pick<ChatMessageRow, "id" | "role" | "content" | "createdAt"> & {
  explanation?: AssistantExplanation;
};
type BrowserWindowId = "thread" | "outcome" | "node" | "settings" | "data-safety" | "composition";

const ACTIVE_WINDOW_Z_INDEX = 230;
const BACKGROUND_WINDOW_Z_INDEX = 170;
const DEFAULT_THREAD_Z_INDEX = 180;
const DEFAULT_DIALOG_Z_INDEX = 100;

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
  const [secretaryNoticeKind, setSecretaryNoticeKind] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [threadOpen, setThreadOpen] = useState(false);
  const [useComputerHistory,setUseComputerHistory]=useState(true);
  const [messages, setMessages] = useState<BrowserMessage[]>([]);
  const desktop = useDesktopContent(runtime.agent.desktop, String(messages.length));
  const [messageHydrationError, setMessageHydrationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcomeTarget, setOutcomeTarget] = useState<AnchorRow | null>(null);
  const [inspectedNode, setInspectedNode] = useState<KnowledgeNode | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (!nativePetAvailable()) return;
    let disposed = false; let cleanup: (() => void) | undefined;
    void listen("latitude://history-open", () => { setSettingsOpen(true); setTimeout(() => document.getElementById("computer-history-settings")?.scrollIntoView({block:"start"}), 100); }).then(fn => { if (disposed) fn(); else cleanup = fn; });
    return () => { disposed = true; cleanup?.(); };
  }, []);
  const [dataSafetyOpen, setDataSafetyOpen] = useState(false);
  const [compositionOpen, setCompositionOpen] = useState(false);
  const [frontWindow, setFrontWindow] = useState<BrowserWindowId | null>(null);
  const [domainBusy, setDomainBusy] = useState(false);
  const [candidateDueItems, setCandidateDueItems] = useState<DueCandidateItem[]>([]);
  const [outcomeCollectionActionId, setOutcomeCollectionActionId] = useState<string | null>(null);
  const submitInFlight = useRef(false);
  // Shared by the rail, floating thread and native pet. Read at submission time
  // so opening a chat cannot freeze the selected area for later turns.
  const desktopViewContext = useRef<DesktopViewContext | null>(null);
  const updateDesktopViewContext = useCallback((next: DesktopViewContext) => { desktopViewContext.current = next; }, []);
  const activeDueNotice = useRef<string | null>(null);
  const acknowledgedCandidateDue = useRef(new Set<string>());
  const [sessionId, setSessionId] = useState(getOrCreateBrowserSessionId);
  useEffect(()=>{try{setUseComputerHistory(localStorage.getItem(`latitude:history-use:${sessionId}`)!=="false");}catch{setUseComputerHistory(false);}},[sessionId]);
  const petInbox = usePetInbox();
  const { preferences: noticePreferences } = useNoticePreferences();
  const pet = useSecretaryPet(() => {
    if (pet.native && pet.state.mode === "floating") {
      void petCommand("pet_show_chat").catch((error) => setNotice(String(error)));
    } else {
      setFrontWindow("thread");
      setThreadOpen((open) => !open);
    }
  });
  const browserProfile = useMemo(
    () => new BrowserProfileCoordinator(runtime, () => sessionId, profileRecoveryStore),
    [profileRecoveryStore, runtime, sessionId],
  );

  const openWindowIds = useMemo<BrowserWindowId[]>(() => [
    ...(threadOpen ? ["thread" as const] : []),
    ...(outcomeTarget ? ["outcome" as const] : []),
    ...(inspectedNode ? ["node" as const] : []),
    ...(settingsOpen ? ["settings" as const] : []),
    ...(dataSafetyOpen ? ["data-safety" as const] : []),
    ...(compositionOpen ? ["composition" as const] : []),
  ], [
    compositionOpen,
    dataSafetyOpen,
    inspectedNode,
    outcomeTarget,
    settingsOpen,
    threadOpen,
  ]);

  useEffect(() => {
    if (frontWindow && openWindowIds.includes(frontWindow)) return;
    const fallback = openWindowIds[openWindowIds.length - 1] ?? null;
    if (fallback !== frontWindow) setFrontWindow(fallback);
  }, [frontWindow, openWindowIds]);

  const windowZIndex = (id: BrowserWindowId) => {
    if (openWindowIds.length <= 1) {
      return id === "thread" ? DEFAULT_THREAD_Z_INDEX : DEFAULT_DIALOG_Z_INDEX;
    }
    return frontWindow === id ? ACTIVE_WINDOW_Z_INDEX : BACKGROUND_WINDOW_Z_INDEX;
  };
  const stackedWindowMode = openWindowIds.length > 1;

  const domainReady = health?.domain.state === "ready";
  const agentReady = health?.agent.state === "ready";

  const refreshContext = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setContextLoading(true);
    try {
      const next = await runtime.getContext({
        kinds: [...BROWSER_CONTEXT_KINDS],
        evidenceTypes: ["activity"],
        sensitivityCeiling: "highest",
        limit: 500,
      }, { retries: 1 });
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
          ...(message.explanation ? { explanation: message.explanation } : {}),
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

  const effectiveState: RuntimeServiceState = contextError && context.nodes.length === 0
    ? "unavailable"
    : state;
  const browserProjection = useMemo(
    () =>
      buildBrowserProjection({
        context,
        runtimeState: effectiveState,
        domainState: health?.domain.state,
        agentState: health?.agent.state,
        now,
      }),
    [context, effectiveState, health?.agent.state, health?.domain.state, now],
  );
  const uiComposition = useBrowserUiComposition(browserProjection.layout);
  const projection = useMemo(() => projectPublishedDesktop(browserProjection.projection, desktop.state),
    [browserProjection.projection, desktop.state]);
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
      commandBar: state(BROWSER_SYSTEM_COMPONENT_IDS.commandBar),
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
    if (!dataSafetyCanOpen) setDataSafetyOpen(false);
    if (!inspectorCanOpen) setInspectedNode(null);
  }, [
    dataSafetyCanOpen,
    inspectorCanOpen,
    outcomeCanOpen,
    threadCanOpen,
  ]);

  useEffect(() => {
    if (!agentReady) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (!active || polling || (!pet.native && document.visibilityState !== "visible")) return;
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
          setSecretaryNoticeKind(latestOutcomeCollection.kind);
        }
        const item = response.items.find(
          (candidate) =>
            candidate.deliveryStatus === "pending" &&
            !deliveredSchedulerReceipts.current.has(candidate.receiptKey),
        );
        if (!item || !active) return;
        deliveredSchedulerReceipts.current.add(item.receiptKey);
        setSecretaryNotice(schedulerSecretaryNotice(item, context.nodes));
        setSecretaryNoticeKind(item.kind);
        petInbox.enqueue({ id: item.receiptKey, text: schedulerSecretaryNotice(item, context.nodes),
          kind: item.kind === "outcome_collection" ? "action" : "reminder", createdAt: Date.now() });
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
  }, [agentReady, context.nodes, runtime.agent, pet.native, petInbox.enqueue]);

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
      setSecretaryNoticeKind("outcome_collection");
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
          setSecretaryNoticeKind("candidate");
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
        content: message.role === "user" ? displayComposerMessage(message.content) : message.content,
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

  const appendMessage = useCallback((
    role: "user" | "assistant",
    content: string,
    explanation?: AssistantExplanation,
  ) => {
    const createdAt = new Date().toISOString();
    setMessages((current) => [
      ...current,
      {
        id: `browser-message-${createdAt}-${current.length}`,
        role,
        content,
        createdAt,
        ...(role === "assistant" && explanation ? { explanation } : {}),
      },
    ]);
  }, []);

  const refreshAll = useCallback(async () => {
    setNotice("正在重新连接本地服务…");
    try {
      await desktop.refresh();
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
  }, [refreshContext, refreshHealth, desktop.refresh]);

  const finishAgentRun = async (finished: AgentRunResult, recovered: boolean) => {
    if (recovered) {
      const history = await runtime.agent.listMessages(sessionId);
      setMessages(history.messages.map((message, index) => ({
        id: message.id ?? `host-message-${message.seq ?? index}`, role: message.role,
        content: message.content, createdAt: message.createdAt ?? new Date().toISOString(),
        ...(message.explanation ? { explanation: message.explanation } : {}),
      })));
    }
    if (finished.status === "failed") {
      appendMessage("assistant", finished.error?.message ? `这次没有完成：${finished.error.message}` : "这次没有完成，请再试一次。");
    } else if (finished.status === "cancelled") {
      appendMessage("assistant", "已停止。已完成的内容会保留。");
    } else if (!recovered) {
      appendMessage("assistant", assistantTextFromRun(finished).trim() ||
        (finished.status === "budget_exhausted" ? budgetExhaustedMessage(finished.result?.budgetStopReason) : "这轮没有生成回复，请再试一次。"),
        assistantExplanationFromRun(finished));
      if (finished.status === "completed" || finished.status === "succeeded") {
        petInbox.enqueue({ id: `run:${finished.runId}`, text: "这轮已经完成，点开看看结果。", kind: "completed", createdAt: Date.now() });
      }
    }
    const uiDraft = uiChangeSetFromAgentRun(finished as unknown as Record<string, unknown>);
    if (uiDraft && !recovered) { uiComposition.applyChangeSet(uiDraft); setNotice("桌面已更新。"); }
    await desktop.refresh();
    if (domainReady) await refreshContext();
  };
  const agentRun = useAgentRun(runtime.agent, sessionId, agentReady, finishAgentRun);
  const activeRunId = agentRun.activeRunId;
  const agentStatus = submitting ? "正在提交…" : agentRun.status;
  useEffect(() => { if (activeRunId) setThreadOpen(true); }, [activeRunId]);

  const sendAgentTurn = useCallback(
    async (text: string, submission?: ComposerSubmission, clientRequestId?: string): Promise<boolean> => {
      if (!agentReady) {
        setNotice("本地助手还没连上，请稍后再试。");
        return false;
      }
      if (activeRunId || submitInFlight.current) {
        setNotice("上一轮仍在本机执行；可以等待，或明确停止它。");
        return false;
      }
      setFrontWindow("thread");
      setThreadOpen(true);
      submitInFlight.current = true;
      setSubmitting(true);
      try {
        const accepted = await runtime.agent.startTurn(
          {
            sessionId,
            text,
            useHistory:useComputerHistory,
            clientRequestId,
            systemPrompt:
              `Current Latitude browser UiSurfaceV2 is ${uiComposition.document.id} revision ${uiComposition.document.revision}. ` +
              "For safe declarative adjustments grounded in the user's request or recorded friction, use ui_customize with this surfaceId and baseRevision. " +
              `Registered components in current order: ${uiComposition.document.components
                .slice()
                .sort((left, right) => left.order - right.order)
                .map((component) => `${component.id}:${component.type}`)
                .join(", ")}. ` +
              "Only visibility, move/order, registered spans, presentation props, and registered event-command bindings are allowed; never put Domain content in UI props.\n" +
              serializeDesktopViewContext(desktopViewContext.current),
          },
        );
        appendMessage("user", submission?.displayText ?? text);
        agentRun.follow(accepted.runId);
        return true;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setNotice(readableError(error, "消息没有成功提交"));
        }
        return false;
      } finally {
        submitInFlight.current = false;
        setSubmitting(false);
      }
    }, [
      activeRunId,
      agentReady,
      appendMessage,
      domainReady,
      refreshContext,
      runtime.agent,
      sessionId,
      useComputerHistory,
      uiComposition,
      agentRun.follow,
    ],
  );

  const cancelAgentTurn = useCallback(async () => {
    if (!activeRunId) return;
    try {
      await runtime.agent.cancelRun(activeRunId);
      setNotice("正在停止…");
    } catch (error) {
      setNotice(readableError(error, "停止请求没有送达"));
    }
  }, [activeRunId, runtime.agent]);

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
              "",
              item.why,
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
      refreshContext,
      runtime,
      sessionId,
    ],
  );

  const saveGoal = useCallback(async (change: GoalChange) => {
    if (!domainReady || domainBusy) throw new Error("本地服务暂不可用或正忙，请稍后重试。");
    if (!change.title.trim()) throw new Error("请填写目标名称。");
    if (change.remove && !change.id) throw new Error("找不到要删除的目标。");
    setDomainBusy(true);
    try {
      const audit = { actor: "user", sessionId, authorizationMode: "automatic" as const };
      await runtime.applyChange(change.remove
        ? { operation: "retract", id: change.id!, reason: "用户在线索板删除中期目标", audit }
        : change.id
          ? { operation: "update", id: change.id, label: change.title, statement: change.detail, audit }
          : { operation: "remember", kind: "goal", label: change.title, statement: change.detail,
              payload: { horizon: "medium-term", surfaceRole: "clue.theme" }, audit });
      // A committed mutation must not be submitted again just because readback failed.
      try {
        await refreshContext();
        setNotice(change.remove ? "中期目标已删除，关联记录已保留。" : "中期目标已保存。");
      } catch {
        setNotice("目标改动已保存，画面刷新失败，请刷新页面查看。");
      }
    } catch (error) {
      throw new Error(readableError(error, "目标改动没有保存，请重试"));
    } finally {
      setDomainBusy(false);
    }
  }, [domainReady, domainBusy, runtime, sessionId, refreshContext]);

  const editAction = useCallback(
    async (row: AnchorRow, nextText: string) => {
      if (row.lineage?.entityType === "todo") {
        try { await desktop.updateTodo(row.lineage.entityId, { title: nextText }); setNotice("待办名称已保存。"); }
        catch (error) { setNotice(readableError(error, "待办名称没有保存")); throw error; }
        return;
      }
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
    }, [domainReady, refreshContext, runtime, sessionId, desktop.updateTodo],
  );

  const recordActivity = useCallback(
    async (text: string) => {
      if (!domainReady || domainBusy) {
        setNotice("本地记录服务还没准备好，本次没有保存。");
        throw new Error("activity_capture_unavailable");
      }
      setDomainBusy(true);
      try {
        await runtime.recordActivity({
          content: text,
          occurredAt: new Date().toISOString(),
          sensitivity: "low",
          audit: { actor: "user", sessionId, authorizationMode: "automatic" },
        });
        await refreshContext();
        setNotice("记下了。这只是你的真实记录，还不是系统结论。");
      } catch (error) {
        setNotice(readableError(error, "这件事没有记下来"));
        throw error;
      } finally {
        setDomainBusy(false);
      }
    }, [domainBusy, domainReady, refreshContext, runtime, sessionId],
  );

  const editActivity = useCallback(
    async (entry: ActivityEntry, nextText: string) => {
      if (!domainReady || domainBusy) {
        setNotice("本地记录服务正忙，这条记录还没有改动。");
        throw new Error("activity_edit_unavailable");
      }
      setDomainBusy(true);
      try {
        await runtime.applyChange({
          operation: "update",
          id: entry.id,
          statement: nextText,
          audit: { actor: "user", sessionId, authorizationMode: "automatic" },
        });
        await refreshContext();
        setNotice("这条记录已改好。");
      } catch (error) {
        setNotice(readableError(error, "这条记录没有改动"));
        throw error;
      } finally {
        setDomainBusy(false);
      }
    }, [domainBusy, domainReady, refreshContext, runtime, sessionId],
  );

  const retractActivity = useCallback(
    async (entry: ActivityEntry) => {
      if (!domainReady || domainBusy) {
        setNotice("本地记录服务正忙，这条记录还没有撤下。");
        throw new Error("activity_retract_unavailable");
      }
      setDomainBusy(true);
      try {
        await runtime.applyChange({
          operation: "retract",
          id: entry.id,
          reason: "用户从今天做过中撤下这条记录",
          audit: { actor: "user", sessionId, authorizationMode: "automatic" },
        });
        await refreshContext();
        setNotice("已从今天撤下；变更记录仍可追溯。");
      } catch (error) {
        setNotice(readableError(error, "这条记录没有撤下"));
        throw error;
      } finally {
        setDomainBusy(false);
      }
    }, [domainBusy, domainReady, refreshContext, runtime, sessionId],
  );

  const reflectOnToday = useCallback(() => {
    void sendAgentTurn(
      "请和我一起看看今天：只基于我今天标记为“做过”的真实记录，先复述事实，再提出一到两条待确认观察，并用自然的问题问我哪条更像我。不要把观察自动升级成已确认认知，也不要替我创建目标或行动。",
    );
  }, [sendAgentTurn]);

  const openLineage = useCallback(
    (lineage: LineageRef) => {
      if (lineage.entityType === "todo" || lineage.entityType === "calendar_event" || lineage.entityType === "digest") {
        const sources = lineage.entityType === "todo"
          ? desktop.state?.data?.todos.find(todo => todo.id === lineage.entityId)?.sourceNodeIds
          : desktop.state?.data?.digests.find(digest => digest.date === lineage.entityId)?.sourceNodeIds;
        const node = context.nodes.find(candidate => sources?.includes(candidate.id));
        if (node && inspectorCanOpen) { setFrontWindow("node"); setInspectedNode(node); }
        else setNotice("内容保存在本机业务记录中；当前没有可展开的图谱依据。每日整理可在便签中阅读全文。");
        return;
      }
      if (!inspectorCanOpen) {
        setNotice("来源检查器已在组件设置中关闭。");
        return;
      }
      const node = context.nodes.find((candidate) => candidate.id === lineage.entityId);
      if (node) {
        setFrontWindow("node");
        setInspectedNode(node);
      }
      else setNotice("当前投影能确认这条来源，但完整节点不在本次 context 窗口里。");
    },
    [context.nodes, inspectorCanOpen, desktop.state],
  );

  const cardHandlers = useMemo<CardHandlers>(
    () => ({
      ...(outcomeCanOpen || runtime.agent.desktop
        ? {
            onAnchorComplete: (row: AnchorRow) => {
              if (row.lineage?.entityType === "todo") {
                void desktop.updateTodo(row.lineage.entityId, { status: "done" }).then(
                  () => setNotice("待办已完成。"), error => setNotice(readableError(error, "待办没有保存")));
                return;
              }
              if (row.lineage?.entityType === "action" && outcomeCanOpen) {
                setFrontWindow("outcome");
                setOutcomeTarget(row);
              }
            },
          }
        : {}),
      onAnchorEdit: editAction,
      onActivityCapture: recordActivity,
      onActivityEdit: editActivity,
      onActivityRetract: retractActivity,
      onActivityReflect: reflectOnToday,
      ...(inspectorCanOpen || runtime.agent.desktop ? { onLineage: openLineage } : {}),
      onFeedFeedback: (itemId, feedback) => {
        if (itemId.startsWith("digest-")) {
          setNotice("这是已保存的每日整理；资讯反馈暂不适用于这条记录。");
          return;
        }
        void recordFeedFeedback(itemId, feedback);
      },
    }),
    [
      editAction,
      desktop.updateTodo,
      runtime.agent.desktop,
      editActivity,
      inspectorCanOpen,
      openLineage,
      outcomeCanOpen,
      recordActivity,
      recordFeedFeedback,
      reflectOnToday,
      retractActivity,
    ],
  );

  const closeThread = useCallback(() => {
    setThreadOpen(false);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>("[data-secretary-launcher]")?.focus();
    });
  }, []);

  const startNewConversation = useCallback(() => {
    if (activeRunId) {
      setNotice("当前回复完成后再新开对话，或先停止这一轮。");
      return;
    }
    const nextSessionId = createBrowserSessionId();
    persistBrowserSessionId(nextSessionId);
    setMessages([]);
    setMessageHydrationError(null);
    setSessionId(nextSessionId);
    setFrontWindow("thread");
    setThreadOpen(true);
    setNotice("已新开一段对话；上一段仍保留在本机。");
  }, [activeRunId]);

  const handleSecretaryInteract = useCallback((intent: SecretaryIntent) => {
    if (intent === "chat") {
      if (pet.native && pet.state.mode === "floating") {
        void petCommand("pet_show_chat").catch((error) => setNotice(String(error)));
        return;
      }
      if (threadCanOpen) {
        setFrontWindow("thread");
        setThreadOpen((open) => !open);
      }
      return;
    }
    if (intent === "review") {
      void createWeeklyReview();
      return;
    }
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
      setFrontWindow("outcome");
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
  }, [
    context.nodes,
    createWeeklyReview,
    now,
    outcomeCanOpen,
    outcomeCollectionActionId,
    threadCanOpen,
    pet.native,
    pet.state.mode,
  ]);

  const openPetNotice = (item: PetNotice) => {
    setSecretaryNotice(item.text);
    if (pet.native && pet.state.mode === "floating") void petCommand("pet_show_chat");
    else { setThreadOpen(true); setFrontWindow("thread"); }
  };
  const openContextConversation = (contextText: string) => {
    if (!threadCanOpen) {
      setNotice("对话已在组件设置中关闭，请先开启对话。");
      return;
    }
    // Keep unfinished text and attachments; context actions prepare a draft, never send it.
    const persisted = updateDraft(sessionId, draft => ({
      ...draft,
      text: draft.text.includes(contextText) ? draft.text
        : [draft.text.trim(), contextText].filter(Boolean).join("\n\n"),
    }));
    if (!persisted) setNotice("草稿已放入对话，暂时无法保存到本机，请保持窗口打开。");
    if (pet.native && pet.state.mode === "floating") {
      void petCommand("pet_show_chat").catch(error => setNotice(readableError(error, "对话窗口未打开，草稿已保留")));
    } else {
      setFrontWindow("thread");
      setThreadOpen(true);
    }
  };
  const petActionHandler = useRef<(action: PetAction) => Promise<void>>(async () => undefined);
  petActionHandler.current = async (action) => {
    switch (action.type) {
      case "send": {
        const ok = await sendAgentTurn(action.text, action.submission, action.requestId);
        await emitTo("chatbar", "latitude://pet-send-result", { requestId: action.requestId, ok,
          ...(!ok ? { error: "消息暂未提交，请查看连接和任务状态。草稿已保留。" } : {}) });
        break;
      }
      case "cancel": await cancelAgentTurn(); break;
      case "reconnect": await agentRun.reconnect(); break;
      case "new-conversation": startNewConversation(); break;
      case "open-main": await petCommand("show_main"); break;
      case "settings": await petCommand("show_main"); setSettingsOpen(true); setFrontWindow("settings"); break;
      case "handle-prompt": await petCommand("show_main"); handleSecretaryInteract("decide"); break;
      case "open-notice": openPetNotice(action.notice); break;
      case "dismiss-notice": petInbox.dismiss(action.id); break;
    }
  };
  useEffect(() => {
    if (!pet.native) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<PetAction>("latitude://pet-action", (event) => {
      void petActionHandler.current(event.payload).catch((error) => setNotice(String(error)));
    }).then((dispose) => { if (disposed) dispose(); else unlisten = dispose; });
    return () => { disposed = true; unlisten?.(); };
  }, [pet.native]);
  const petSnapshot: PetSnapshot = {
    secretary: { ...projection.secretary, ...(activeRunId ? { state: "thinking", stateCn: "思考中" } : {}) },
    sessionId, messages: deskMessages, conversation, loading: Boolean(activeRunId) || submitting,
    progress: agentRun.progress, progressRunId: agentRun.progressRunId, status: agentStatus,
    error: agentRun.connectionError ?? messageHydrationError,
    sendEnabled: agentReady && livingUi.commandBar.visible && livingUi.commandBar.actions.send === true,
    notice: petInbox.notice, noticePreferences, proactivePrompt: secretaryNotice,
    proactiveActionEnabled: secretaryNoticeKind === "outcome_collection" && outcomeCanOpen,
  };
  useEffect(() => {
    if (pet.native) void petCommand("pet_sync", { snapshot: petSnapshot }).catch((error) => setNotice(String(error)));
  }, [pet.native, petSnapshot.secretary.state, petSnapshot.secretary.stateCn, sessionId, deskMessages, conversation, activeRunId, submitting,
    agentRun.progress, agentRun.progressRunId, agentStatus, petSnapshot.error, petSnapshot.sendEnabled, petInbox.notice, noticePreferences, secretaryNotice, petSnapshot.proactiveActionEnabled]);
  const bubblePosition = besidePet({ x: pet.state.x, y: pet.state.y, width: 180, height: 220 },
    { x: 12, y: 12, width: window.innerWidth - 24, height: window.innerHeight - 24 });

  return (
    <>
      <DimensionPresetApp
        onDesktopContextChange={updateDesktopViewContext}
        secretaryPortrait={(interaction) => <SecretaryDock pet={pet} secretary={petSnapshot.secretary} notice={petInbox.notice} preferences={noticePreferences} {...interaction} />}
        secretaryInvitation={livingUi.candidates.visible && context.nodes.some(isCandidateNode) ? (
          <SecretaryInvitation count={context.nodes.filter((node) =>
            isCandidateNode(node) && ["proposed", "touched", "shaping"].includes(candidateStateOf(node)),
          ).length}>
            <CandidateInterventionCards
              candidates={context.nodes.filter(isCandidateNode)}
              dueItems={candidateDueItems}
              busy={domainBusy || !domainReady}
              actionAvailability={{
                touch: livingUi.candidates.actions.touch === true,
                shape: livingUi.candidates.actions.shape === true,
                conclude: livingUi.candidates.actions.conclude === true,
                park: livingUi.candidates.actions.park === true,
              }}
              onCommand={(candidateId, command) => void applyCandidateCommand(candidateId, command)}
            />
          </SecretaryInvitation>
        ) : undefined}
        projection={projection}
        layout={layout}
        composition={{
          document: uiComposition.document,
          registry: uiComposition.registry,
        }}
        paperHandlers={cardHandlers}
        localCardEditing="disabled"
        secretaryPresentation="rail"
        secretaryChatOpen={threadOpen}
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
        composerSessionId={sessionId}
        onSendMessage={sendAgentTurn}
        thread={
          <AnimatePresence initial={false}>
            {threadOpen && threadCanOpen && !(pet.native && pet.state.mode === "floating") && (
              <DeskThread
                key="secretary-thread"
                useComputerHistory={useComputerHistory}
                onComputerHistoryChange={enabled=>{setUseComputerHistory(enabled);try{localStorage.setItem(`latitude:history-use:${sessionId}`,String(enabled));}catch{/* request still carries the explicit choice */}}}
                messages={deskMessages}
                conversations={[conversation]}
                currentId={sessionId}
                streaming=""
                loading={Boolean(activeRunId) || submitting}
                progress={agentRun.progress}
                progressRunId={agentRun.progressRunId}
                onSelectConversation={() => undefined}
                onNewConversation={startNewConversation}
                onClose={closeThread}
                closeEnabled={livingUi.thread.actions.close === true}
                newConversationEnabled={!activeRunId && !submitting}
                variant="floating"
                onSend={(text, submission) => sendAgentTurn(text, submission)}
                sendEnabled={agentReady &&
                  livingUi.commandBar.visible &&
                  livingUi.commandBar.actions.send === true}
                status={agentStatus}
                historyError={agentRun.connectionError ?? messageHydrationError}
                onCancel={cancelAgentTurn}
                onReconnect={agentRun.reconnect}
                proactivePrompt={secretaryNotice}
                onProactivePromptAction={secretaryNoticeKind === "outcome_collection" && outcomeCanOpen
                  ? () => handleSecretaryInteract("decide")
                  : undefined}
                zIndex={windowZIndex("thread")}
                onActivate={() => setFrontWindow("thread")}
              />
            )}
          </AnimatePresence>
        }
        onOpenReview={() => void createWeeklyReview()}
        onReconnect={refreshAll}
        onOpenSettings={() => {
          setFrontWindow("settings");
          setSettingsOpen(true);
        }}
        onAdjustDesktop={() => {
          setFrontWindow("composition");
          setCompositionOpen(true);
        }}
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
        onSecretaryInteract={handleSecretaryInteract}
        onRequestCardHelp={({ title, content }) => openContextConversation(
          `请帮我修改主页上的卡片「${title}」。\n\n当前内容：\n${content}\n\n我想调整的是：`,
        )}
        layerHandlers={{
          onDiscussNode: node => openContextConversation(
            `我想和你聊聊星图里的「${node.label}」。\n\n${node.detail}\n\n我想聊的是：`,
          ),
          onSaveGoal: saveGoal,
          onFeedFeedback: cardHandlers.onFeedFeedback,
          onLineage: openLineage,
          onRelationInspect: (metric) => {
            const lineage = metric.lineage?.[0];
            if (lineage) openLineage(lineage);
          },
          onCompleteAnchor: (row) => {
            if (row.lineage?.entityType === "todo") { cardHandlers.onAnchorComplete?.(row); return; }
            if (row.lineage?.entityType === "action" && outcomeCanOpen) {
              setFrontWindow("outcome");
              setOutcomeTarget(row);
            }
          },
          onNodeOpen: (node) => {
            if (!inspectorCanOpen) return;
            const source = context.nodes.find((candidate) => candidate.id === node.id);
            if (source) {
              setFrontWindow("node");
              setInspectedNode(source);
            }
          },
        }}
      />

      <div className="dimension-root" style={{ display: "contents" }}>
        <DimToast message={notice ?? desktop.state?.error ?? contextError} />
        <BrowserPet pet={pet} secretary={petSnapshot.secretary} notice={petInbox.notice} preferences={noticePreferences} />
        {petInbox.notice && !pet.state.dragging && !(pet.native && pet.state.mode === "floating") && (
          <div className="latitude-pet-bubble" style={pet.state.mode === "floating"
            ? { left: bubblePosition.x, top: bubblePosition.y } : { left: 24, bottom: 24 }}>
            <PetNoticeBubble notice={petInbox.notice} preferences={noticePreferences}
              onOpen={openPetNotice} onDismiss={(item) => petInbox.dismiss(item.id)} />
          </div>
        )}
      </div>

      <AnimatePresence initial={false}>
      {outcomeTarget && outcomeCanOpen && (
        <OutcomeDialog
          key="outcome"
          row={outcomeTarget}
          action={context.nodes.find((node) => node.id === outcomeTarget.lineage?.entityId)}
          busy={domainBusy}
          closeEnabled={livingUi.outcome.actions.close === true}
          submitEnabled={livingUi.outcome.actions.submit === true}
          zIndex={windowZIndex("outcome")}
          onActivate={() => setFrontWindow("outcome")}
          windowMode={stackedWindowMode}
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
          key="node"
          node={inspectedNode}
          closeEnabled={livingUi.inspector.actions.close === true}
          zIndex={windowZIndex("node")}
          onActivate={() => setFrontWindow("node")}
          windowMode={stackedWindowMode}
          onClose={() => setInspectedNode(null)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          key="settings"
          onHistoryAsk={(text) => { setSettingsOpen(false); void sendAgentTurn(text); }}
          sessionId={sessionId}
          health={health}
          contextLoading={contextLoading}
          onRefresh={() => void refreshAll()}
          refreshEnabled={livingUi.control.actions.refresh === true}
          messageHydrationError={messageHydrationError}
          actionAvailability={{
            dataSafety: livingUi.diagnostics.actions.data_safety === true && dataSafetyCanOpen,
            close: true,
          }}
          zIndex={windowZIndex("settings")}
          onActivate={() => setFrontWindow("settings")}
          windowMode={stackedWindowMode}
          onDataSafety={() => {
            if (!dataSafetyCanOpen) return;
            setSettingsOpen(false);
            setFrontWindow("data-safety");
            setDataSafetyOpen(true);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {dataSafetyOpen && dataSafetyCanOpen && (
        <BrowserDataSafetyDialog
          key="data-safety"
          actions={resolvedDataSafetyActions}
          actionAvailability={dataSafetyAvailability}
          zIndex={windowZIndex("data-safety")}
          onActivate={() => setFrontWindow("data-safety")}
          windowMode={stackedWindowMode}
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
          zIndex={windowZIndex("composition")}
          onActivate={() => setFrontWindow("composition")}
          windowMode={stackedWindowMode}
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
      </AnimatePresence>
    </>
  );
}

function CandidateInterventionCards({
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
    });
  if (visible.length === 0) return null;

  return (
    <section
      className="dim-cocreation-cards"
      aria-label="候选共创"
    >
      {visible.map((candidate) => {
        const state = candidateStateOf(candidate);
        const due = dueByCandidate.get(candidate.id);
        const actions = candidateActions(state);
        return (
          <article
            key={candidate.id}
            className="dim-cocreation-card"
            data-candidate-id={candidate.id}
            data-candidate-state={state}
          >
            <h3>{nodeLabel(candidate)}</h3>
            <p className="dim-cocreation-card__body">
              {candidateStateLabel(state)} · {optionalText(candidate.statement)
                || optionalText(candidate.content)
                || "还在整理这个想法"}
            </p>
            {due && (
              <p className="dim-cocreation-card__reminder" role="status">
                {due.prompt}
              </p>
            )}
            {actions.length > 0 && (
              <div className="dim-cocreation-card__actions">
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
              </div>
            )}
          </article>
        );
      })}
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
  zIndex = 100,
  onActivate,
  windowMode = false,
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
  zIndex?: number;
  onActivate?: () => void;
  windowMode?: boolean;
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
    <MotionSurface
      className="dimension-root"
      style={{
        ...dialogBackdropStyle,
        zIndex,
        ...(windowMode ? dialogWindowStyle : {}),
      }}
      role="dialog"
      aria-modal={!windowMode}
      aria-label="回收行动结果"
      onPointerDown={onActivate}
    >
      <form
        className="dim-paper"
        style={{
          ...dialogPaperStyle,
          ...(windowMode ? dialogWindowPaperStyle : {}),
        }}
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
    </MotionSurface>
  );
}

function NodeDialog({
  node,
  closeEnabled,
  onClose,
  zIndex = 100,
  onActivate,
  windowMode = false,
}: {
  node: KnowledgeNode;
  closeEnabled: boolean;
  onClose: () => void;
  zIndex?: number;
  onActivate?: () => void;
  windowMode?: boolean;
}) {
  return (
    <MotionSurface
      className="dimension-root"
      style={{
        ...dialogBackdropStyle,
        zIndex,
        ...(windowMode ? dialogWindowStyle : {}),
      }}
      role="dialog"
      aria-modal={!windowMode}
      aria-label="图谱来源详情"
      onPointerDown={onActivate}
    >
      <section
        className="dim-paper"
        style={{
          ...dialogPaperStyle,
          ...(windowMode ? dialogWindowPaperStyle : {}),
        }}
      >
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
    </MotionSurface>
  );
}

function SettingsDialog({
  onHistoryAsk,
  sessionId,
  health,
  contextLoading,
  onRefresh,
  refreshEnabled,
  messageHydrationError,
  actionAvailability,
  onDataSafety,
  onClose,
  zIndex = 100,
  onActivate,
  windowMode = false,
}: {
  onHistoryAsk: (text: string) => void;
  sessionId: string;
  health: ReturnType<typeof useDesktopRuntime>["health"];
  contextLoading: boolean;
  onRefresh: () => void;
  refreshEnabled: boolean;
  messageHydrationError: string | null;
  actionAvailability: { dataSafety: boolean; close: boolean };
  onDataSafety: () => void;
  onClose: () => void;
  zIndex?: number;
  onActivate?: () => void;
  windowMode?: boolean;
}) {
  const { runtime, refreshHealth } = useDesktopRuntime();
  const [providerSettings, setProviderSettings] = useState<ModelProviderSettings | null>(null);
  const [providerDraft, setProviderDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerNotice, setProviderNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void runtime.agent.getProviderSettings({ retries: 1 })
      .then((settings) => {
        if (!active) return;
        setProviderSettings(settings);
        setProviderDraft(settings.active.provider);
        setModelDraft(settings.active.model);
        setProviderError(null);
      })
      .catch((error) => {
        if (active) setProviderError(readableError(error, "模型服务设置暂时读取失败"));
      });
    return () => {
      active = false;
    };
  }, [runtime.agent]);

  const selectedProvider = providerSettings?.options.find(
    (option) => option.id === providerDraft,
  );
  const selectionChanged = providerSettings !== null && (
    providerSettings.active.provider !== providerDraft ||
    providerSettings.active.model !== modelDraft
  );

  const saveProvider = async () => {
    if (!selectedProvider?.configured || !selectionChanged || providerBusy) return;
    setProviderBusy(true);
    setProviderError(null);
    setProviderNotice(null);
    try {
      const next = await runtime.agent.updateProviderSettings({
        provider: providerDraft,
        model: modelDraft,
      });
      setProviderSettings(next);
      setProviderDraft(next.active.provider);
      setModelDraft(next.active.model);
      setProviderNotice("已切换；下一次对话会使用这个 Provider 和模型。");
      await refreshHealth();
    } catch (error) {
      setProviderError(readableError(error, "模型服务没有切换"));
    } finally {
      setProviderBusy(false);
    }
  };

  return (
    <MotionSurface
      className="dimension-root"
      style={{
        ...dialogBackdropStyle,
        zIndex,
        ...(windowMode ? dialogWindowStyle : {}),
      }}
      role="dialog"
      aria-modal={!windowMode}
      aria-label="设置"
      onPointerDown={onActivate}
    >
      <SettingsFrame
        onClose={onClose}
        closeEnabled={actionAvailability.close}
        onDataSafety={onDataSafety}
        dataSafetyEnabled={actionAvailability.dataSafety}
      >
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <span className="dim-meta" aria-label="本地服务状态">
            数据 {serviceLabel(health?.domain.state ?? "starting")} · 助手 {agentServiceLabel(
              health?.agent.state ?? "starting",
              optionalText(recordOf(health?.agent.details?.model)?.authentication),
            )}
            {contextLoading ? " · 读取中" : ""}
          </span>
          <button type="button" className="dim-btn dim-btn--quiet"
            onClick={onRefresh} disabled={!refreshEnabled || contextLoading}>刷新</button>
        </div>
        <section id="settings-persona" tabIndex={-1} aria-label="人设与相处方式">
          <PersonaSettings agent={runtime.agent} />
        </section>
        <section id="settings-model" tabIndex={-1} aria-label="对话模型" className="dim-paper" style={{ padding: "12px 14px" }}>
          <p className="dim-eyebrow">对话模型</p>
          <p className="dim-meta" style={{ marginTop: 4 }}>
            这里切换 Agent 对话模型；联网搜索仍使用单独配置的 DeepSeek 搜索服务。
          </p>
          {!providerSettings && !providerError && (
            <p role="status" className="dim-body">正在读取当前 Provider…</p>
          )}
          {providerSettings && (
            <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
              <label className="dim-meta">
                Provider
                <select
                  aria-label="Provider"
                  value={providerDraft}
                  disabled={providerBusy}
                  onChange={(event) => {
                    const provider = providerSettings.options.find(
                      (option) => option.id === event.target.value,
                    );
                    setProviderDraft(event.target.value);
                    setModelDraft(provider?.models[0]?.id ?? "");
                    setProviderNotice(null);
                    setProviderError(null);
                  }}
                  style={dialogFieldStyle}
                >
                  {providerSettings.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}{option.configured ? "" : "（未配置）"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="dim-meta">
                模型
                <select
                  aria-label="模型"
                  value={modelDraft}
                  disabled={providerBusy || !selectedProvider}
                  onChange={(event) => {
                    setModelDraft(event.target.value);
                    setProviderNotice(null);
                    setProviderError(null);
                  }}
                  style={dialogFieldStyle}
                >
                  {(selectedProvider?.models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>{model.label}</option>
                  ))}
                </select>
              </label>
              {!selectedProvider?.configured && selectedProvider && (
                <p className="dim-meta">
                  先在本机 <code>.env.local</code> 配置 {selectedProvider.credentialName}，
                  然后重启 Agent Host。密钥不会进入浏览器。
                </p>
              )}
              {providerError && <p role="alert" className="dim-body">{providerError}</p>}
              {providerNotice && <p role="status" className="dim-body">{providerNotice}</p>}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="dim-btn"
                  disabled={
                    providerBusy ||
                    !selectionChanged ||
                    !selectedProvider?.configured ||
                    !modelDraft
                  }
                  onClick={() => void saveProvider()}
                >
                  {providerBusy ? "正在切换…" : "保存模型设置"}
                </button>
              </div>
            </div>
          )}
        </section>
        <section id="settings-history" tabIndex={-1} aria-label="电脑记录设置">
          <ComputerHistoryPanel onAsk={onHistoryAsk} />
        </section>
        <section id="settings-notices" tabIndex={-1} aria-label="提醒显示">
          <NoticeSettings />
        </section>
        <section id="settings-status" tabIndex={-1} aria-label="运行状态" className="dim-settings-status">
          <p className="dim-eyebrow">运行状态</p>
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
        </section>
      </SettingsFrame>
    </MotionSurface>
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
  overflow: "auto",
  resize: "both",
  minWidth: "min(300px, calc(100vw - 48px))",
  minHeight: 220,
  maxWidth: "calc(100vw - 48px)",
  boxSizing: "border-box",
  padding: 22,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  color: "var(--dim-ink)",
} as const;

const dialogWindowStyle = {
  inset: "auto",
  top: "50%",
  left: "50%",
  width: "max-content",
  maxWidth: "calc(100vw - 48px)",
  padding: 0,
  display: "block",
  background: "transparent",
  transform: "translate(-50%, -50%)",
} as const;

const dialogWindowPaperStyle = {
  width: "min(560px, calc(100vw - 48px))",
  boxShadow: "0 26px 64px rgb(55 48 34 / 24%), 0 3px 10px rgb(55 48 34 / 12%)",
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
  if (state === "parked") return [{ command: "touch", label: "继续共创" }];
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
    queued: "准备中",
    running: "正在理解、核对并整理…",
    completed: "已完成",
    succeeded: "已完成",
    budget_exhausted: "未完成",
    failed: "失败",
    cancelled: "已停止",
  }[status] ?? status;
}

function budgetExhaustedMessage(reason: string | undefined): string {
  if (reason === "wall_clock") {
    return "这轮读取和整理的内容太多，超过了等待时间，因此没有生成最终回答。我没有把它算作完成。";
  }
  if (reason === "tool") {
    return "这轮查询次数达到上限，还没有形成最终回答。我没有把它算作完成。";
  }
  return "这轮在形成最终回答前达到了处理上限，因此没有完成。";
}

function readableError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return `${fallback}：${error.message}`;
  return fallback;
}

function getOrCreateBrowserSessionId(): string {
  try {
    const existing = window.localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)?.trim();
    if (existing) return existing;
    const sessionId = createBrowserSessionId();
    persistBrowserSessionId(sessionId);
    return sessionId;
  } catch {
    return createBrowserSessionId();
  }
}

function createBrowserSessionId(): string {
  const suffix = typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `latitude-browser-${suffix}`;
}

function persistBrowserSessionId(sessionId: string): void {
  try {
    window.localStorage.setItem(BROWSER_SESSION_STORAGE_KEY, sessionId);
  } catch {
    // The new session still works for this page even when storage is unavailable.
  }
}
