import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { MemoryRouter } from "react-router-dom";
import { useActivityStore } from "../../lib/activityStore";
import { useCalendarEventsStore } from "../../lib/calendarEventsStore";
import { useChatStore } from "../../lib/chatStore";
import {
  dbGetRecentDigests,
  dbListMemoryFacts,
  type DailyDigestRow,
  type MemoryFact
} from "../../lib/db";
import { useGoalsStore } from "../../lib/goalsStore";
import { pendingProposalOf, useProposalsStore } from "../../lib/proposalsStore";
import { useTodoStore } from "../../lib/store";
import { onSync } from "../../lib/syncBus";
import { DimensionPresetApp } from "../../dimension/presets/DimensionPresetApp";
import type { DesktopViewContext } from "../../dimension/desktopWorkspace";
import { serializeDesktopViewContext } from "../../dimension/desktopViewContext";
import { DeskThread } from "../../dimension/DeskThread";
import { RealityTimeline } from "../../dimension/RealityTimeline";
import { DimToast, useDimToast } from "../../dimension/Shell";
import { SourceDetail } from "../../dimension/SourceDetail";
import type {
  AnchorRow,
  CardHandlers,
  LineageRef,
  ProposalVerdict,
  Secretary
} from "../../dimension/types";
import { buildLiveProjection } from "./liveProjection";
import { buildRealityTimeline } from "./realityTimeline";
import type { RuntimeStatus } from "./types";
import { BrowserLiveDimensionApp } from "./BrowserLiveDimensionApp";

/** zustand 选择器的稳定空引用，避免每次返回新数组触发重渲染。 */
const EMPTY_MESSAGES: never[] = [];

/** 设置页按需加载：不打开就不下载，也避免它的依赖链影响桌面启动。 */
const SettingsPage = lazy(async () => ({
  default: (await import("../../pages/SettingsPage")).SettingsPage
}));

const ConnectionsPage = lazy(async () => ({
  default: (await import("../../pages/ConnectionsPage")).ConnectionsPage
}));

const TelosPage = lazy(async () => ({
  default: (await import("../../pages/TelosPage")).TelosPage
}));

type ToolPage = "goals" | "connections" | "settings";

type OverlayState =
  | { kind: "tool"; page: ToolPage }
  | { kind: "timeline" }
  | {
      kind: "source";
      lineage: LineageRef;
      returnTo: "desktop" | "timeline";
    }
  | null;

/**
 * 维度桌面的真实数据入口。
 *
 * 订阅真实 store，把 todos / calendar_events / goals / activities /
 * proposals / daily_digest 投影成桌面；对话条接真秘书（chatStore → 引擎），
 * 提案裁决写回 proposals 表。后端未接入的能力（候选线索、策展、
 * 养成计算）保持诚实的「未接入」表达，不做占位。
 *
 * 环境边界：SQLite 只存在于 Tauri 桌面壳。纯浏览器（预览 / 开发）里
 * 没有本地内核，回退到**明确标注的演示桌面**（PRD §13.1：演示数据必须
 * 承认边界），而不是把「连不上」伪装成「一切正常」或「没有数据」。
 */
export function LiveDimensionApp() {
  // 外层先分流，避免浏览器分支挂载任何 Tauri store、飞书同步或旧秘书调度副作用。
  return isTauri() ? <TauriLiveDimensionApp /> : <BrowserLiveDimensionApp />;
}

function TauriLiveDimensionApp() {
  // 只有经过外层环境分流后才会挂载这个组件；保留布尔量让旧 effect 的
  // 依赖形状稳定，同时浏览器永远不会执行下面的 hydrate / sync 逻辑。
  const tauriRuntime = true;

  const todos = useTodoStore((s) => s.todos);
  const todosLoaded = useTodoStore((s) => s.loaded);
  const todosError = useTodoStore((s) => s.error);
  const events = useCalendarEventsStore((s) => s.events);
  const eventsLoaded = useCalendarEventsStore((s) => s.loaded);
  const eventsError = useCalendarEventsStore((s) => s.error);
  const activities = useActivityStore((s) => s.activities);
  const activitiesLoaded = useActivityStore((s) => s.loaded);
  const activitiesError = useActivityStore((s) => s.error);
  const goals = useGoalsStore((s) => s.goals);
  const goalsLoaded = useGoalsStore((s) => s.loaded);
  const goalsError = useGoalsStore((s) => s.error);
  const proposals = useProposalsStore((s) => s.proposals);
  const proposalsLoaded = useProposalsStore((s) => s.loaded);
  const proposalsError = useProposalsStore((s) => s.error);

  // 对话状态（chatStore 是全局单例：桌面、悬浮条、飞书通道共享同一会话真相）
  const chatLoading = useChatStore((s) => s.loading);
  const chatStreaming = useChatStore((s) => s.streaming);
  const chatConversations = useChatStore((s) => s.conversations);
  const chatCurrentId = useChatStore((s) => s.currentId);
  const chatMessages = useChatStore((s) =>
    s.currentId ? (s.messagesByConv[s.currentId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  );

  const { toast, say } = useDimToast();
  const [now, setNow] = useState(() => new Date());
  const [threadOpen, setThreadOpen] = useState(false);
  const desktopViewContext = useRef<DesktopViewContext | null>(null);
  const updateDesktopViewContext = useCallback((next: DesktopViewContext) => { desktopViewContext.current = next; }, []);
  const sendDesktopMessage = useCallback(async (text: string) => {
    setThreadOpen(true);
    try {
      await useChatStore.getState().sendMessage(text, { transientContext: serializeDesktopViewContext(desktopViewContext.current) });
      return true;
    } catch { say("秘书这次没接上话，请再试一次。"); return false; }
  }, [say]);
  const [overlay, setOverlay] = useState<OverlayState>(null);
  const [digests, setDigests] = useState<DailyDigestRow[]>([]);
  const [memoryFacts, setMemoryFacts] = useState<MemoryFact[]>([]);
  const [supplementalStatus, setSupplementalStatus] = useState<{
    loading: boolean;
    unavailableSources: string[];
  }>({ loading: true, unavailableSources: [] });

  const refreshSupplementalData = useCallback(async () => {
    setSupplementalStatus((current) => ({ ...current, loading: true }));
    const [digestResult, memoryResult] = await Promise.allSettled([
      dbGetRecentDigests(30),
      // 共同变化是历史视图，过期记忆也必须保留为过去发生过的记录。
      dbListMemoryFacts()
    ]);
    if (digestResult.status === "fulfilled") setDigests(digestResult.value);
    if (memoryResult.status === "fulfilled") setMemoryFacts(memoryResult.value);
    setSupplementalStatus({
      loading: false,
      unavailableSources: [
        ...(digestResult.status === "rejected" ? ["每日整理"] : []),
        ...(memoryResult.status === "rejected" ? ["记忆历史"] : [])
      ]
    });
  }, []);

  const closeOverlay = useCallback(() => {
    setOverlay((current) =>
      current?.kind === "source" && current.returnTo === "timeline"
        ? { kind: "timeline" }
        : null
    );
  }, []);

  const hydrateChat = useCallback(async () => {
    await useChatStore.getState().hydrate();
    const current = useChatStore.getState();
    const currentStillExists = current.currentId
      ? current.conversations.some((conversation) => conversation.id === current.currentId)
      : false;
    const targetId = currentStillExists
      ? current.currentId
      : (current.conversations[0]?.id ?? null);
    // Dimension 没有独立历史选择器：启动时续接最近会话；同步时强制失效缓存，
    // 让飞书或其他窗口写入的消息真正出现在当前桌面对话里。
    await useChatStore.getState().selectConv(targetId, { reload: true });
  }, []);

  useEffect(() => {
    if (!tauriRuntime) return;
    void useTodoStore.getState().hydrate();
    void useCalendarEventsStore.getState().hydrate();
    void useActivityStore.getState().hydrate();
    void useGoalsStore.getState().hydrate();
    void useProposalsStore.getState().hydrate();
    void hydrateChat();
    void refreshSupplementalData();
  }, [tauriRuntime, hydrateChat, refreshSupplementalData]);

  // 跨窗口同步：浮窗里改的待办 / 速记 / 裁决，桌面这里实时反映。
  useEffect(() => {
    if (!tauriRuntime) return;
    const offs = [
      onSync("todos", () => void useTodoStore.getState().hydrate()),
      onSync("calendar_events", () =>
        void useCalendarEventsStore.getState().hydrate()
      ),
      onSync("activities", () => void useActivityStore.getState().hydrate()),
      onSync("goals", () => void useGoalsStore.getState().hydrate()),
      onSync("proposals", () => void useProposalsStore.getState().hydrate()),
      onSync("memory", () => void refreshSupplementalData()),
      onSync("digests", () => void refreshSupplementalData()),
      onSync("conversations", () => {
        void hydrateChat();
        void refreshSupplementalData();
      })
    ];
    return () => offs.forEach((off) => off());
  }, [tauriRuntime, hydrateChat, refreshSupplementalData]);

  // 「下一段完整时间」这类文案随时间变化，每分钟重算一次投影。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!overlay) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeOverlay();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlay, closeOverlay]);

  const todayDigest = useMemo(() => {
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return digests.find((digest) => digest.date === key) ?? null;
  }, [digests, now]);

  const timelineEntries = useMemo(
    () =>
      buildRealityTimeline({
        todos,
        activities,
        proposals,
        goals,
        memoryFacts,
        digests
      }),
    [todos, activities, proposals, goals, memoryFacts, digests]
  );
  const timelineUnavailableSources = useMemo(
    () => [
      ...(todosError ? ["待办历史"] : []),
      ...(activitiesError ? ["活动流水"] : []),
      ...(goalsError ? ["目标记录"] : []),
      ...(proposalsError ? ["提案裁决"] : []),
      ...supplementalStatus.unavailableSources
    ],
    [todosError, activitiesError, goalsError, proposalsError, supplementalStatus.unavailableSources]
  );

  const runtimeStatus: RuntimeStatus =
    !(todosLoaded && eventsLoaded && activitiesLoaded && goalsLoaded && proposalsLoaded)
      ? "starting"
      : todosError || eventsError || activitiesError || goalsError || proposalsError
        ? "unavailable"
        : "ready";

  const pending = useMemo(() => pendingProposalOf(proposals), [proposals]);

  const { projection, layout } = useMemo(() => {
    const built = buildLiveProjection({
      todos,
      todosStatus: !todosLoaded
        ? "starting"
        : todosError
          ? "unavailable"
          : "ready",
      calendarEvents: events,
      calendarStatus: !eventsLoaded
        ? "starting"
        : eventsError
          ? "unavailable"
          : "ready",
      goals,
      goalsStatus: !goalsLoaded
        ? "starting"
        : goalsError
          ? "unavailable"
          : "ready",
      activities,
      activitiesStatus: !activitiesLoaded
        ? "starting"
        : activitiesError
          ? "unavailable"
          : "ready",
      now,
      runtimeStatus,
      pendingProposal: pending,
      proposalsStatus: !proposalsLoaded
        ? "starting"
        : proposalsError
          ? "unavailable"
          : "ready",
      todayDigest,
      digestStatus: supplementalStatus.unavailableSources.includes("每日整理")
        ? "unavailable"
        : supplementalStatus.loading && !todayDigest
          ? "starting"
          : "ready"
    });
    return { ...built, projection: { ...built.projection, secretary: liveSecretary(built.projection.secretary, chatLoading, pending !== null) } };
  }, [
    todos,
    todosLoaded,
    todosError,
    events,
    eventsLoaded,
    eventsError,
    goals,
    goalsLoaded,
    goalsError,
    activities,
    activitiesLoaded,
    activitiesError,
    now,
    runtimeStatus,
    pending,
    proposalsLoaded,
    proposalsError,
    todayDigest,
    supplementalStatus.loading,
    supplementalStatus.unavailableSources,
    chatLoading
  ]);

  function openLineage(
    lineage: LineageRef,
    returnTo: "desktop" | "timeline" = "desktop"
  ) {
    setOverlay({ kind: "source", lineage, returnTo });
  }

  function handleAnchorComplete(row: AnchorRow) {
    if (row.lineage?.entityType !== "todo") return;
    useTodoStore
      .getState()
      .completeTodo(row.lineage.entityId)
      .then(() => say(`已完成：${row.text}`))
      .catch(() => say("没有写进去，请再试一次。"));
  }

  /** 行内改名：纸面上的字能改，写回真实待办（PRD：写入要落在真实实体上）。 */
  function handleAnchorEdit(row: AnchorRow, nextText: string) {
    if (row.lineage?.entityType !== "todo") return;
    useTodoStore
      .getState()
      .renameTodo(row.lineage.entityId, nextText)
      .then(() => say(`已改名：${nextText}`))
      .catch(() => say("没有写进去，请再试一次。"));
  }

  /**
   * 裁决五态写回（PRD §4.2）：
   * - 有点意思：仍是未确认提案，留在桌上继续澄清（不换文案追问）；
   * - 这对我成立：记一条用户确认的现实记录；
   * - 要不试试：落地成今天的待办（有行动面时），结果之后回收；
   * - 不太对 / 先放着：写回状态，不再出现；拒绝与沉默不产生确认写入。
   */
  function handleVerdict(verdict: ProposalVerdict) {
    const record = pending;
    if (!record) return;
    const decided = useProposalsStore.getState().decide;

    if (verdict.id === "interesting") {
      say("好，那它先在桌上放着，想聊了随时说。");
      return;
    }

    const run = async () => {
      switch (verdict.id) {
        case "holds": {
          const ok = await decided(record.id, "accepted", verdict.label);
          if (ok) {
            await useActivityStore
              .getState()
              .addActivity(`对一条提案明确确认：${record.quote}`);
            say("已记录这次明确裁决；正式认知结构还没有接入。");
          }
          break;
        }
        case "try": {
          const ok = await decided(record.id, "try", verdict.label);
          if (ok && record.actionTitle) {
            const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
            await useTodoStore.getState().addTodo({
              id: `t${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              title: record.actionTitle,
              reason: `来自提案：${record.quote}`,
              priority: "none",
              tags: [],
              status: "todo",
              scheduledDate: today,
              createdAt: new Date().toISOString()
            });
          }
          if (ok) {
            say(
              record.actionTitle
                ? "已放进今天的锚点；结构化结果回收还没有接入。"
                : "已记录“要不试试”；结构化结果回收还没有接入。"
            );
          }
          break;
        }
        case "reject": {
          const ok = await decided(record.id, "rejected", verdict.label);
          if (ok) say("收到，这条就到此为止。");
          break;
        }
        case "park": {
          const ok = await decided(record.id, "parked", verdict.label);
          if (ok) say("先放着。它不会再主动来烦你。");
          break;
        }
      }
    };
    void run().catch(() => say("没有写进去，请再试一次。"));
  }

  const cardHandlers: CardHandlers = {
    onAnchorComplete: handleAnchorComplete,
    onAnchorEdit: handleAnchorEdit,
    onLineage: openLineage,
    onVerdict: (_card, verdict) => handleVerdict(verdict),
    onFeedFeedback: (itemId, feedback) => {
      const label = {
        "new-angle": "有新角度",
        known: "已知道",
        "not-useful": "没用"
      }[feedback];
      useActivityStore
        .getState()
        .addActivity(`对一条内容的反馈（${itemId}）：${label}`)
        .then(() => say(`收到！${label}`))
        .catch(() => say("没有写进去，请再试一次。"));
    }
  };

  return (
    <>
      <DimensionPresetApp
        onDesktopContextChange={updateDesktopViewContext}
        projection={projection}
        layout={layout}
        paperHandlers={cardHandlers}
        onSendMessage={sendDesktopMessage}
        thread={
          threadOpen ? (
            <DeskThread
              onSend={sendDesktopMessage}
              messages={chatMessages}
              conversations={chatConversations}
              currentId={chatCurrentId}
              streaming={chatStreaming}
              loading={chatLoading}
              onSelectConversation={(id) =>
                void useChatStore.getState().selectConv(id, { reload: true })
              }
              onClose={() => setThreadOpen(false)}
            />
          ) : undefined
        }
        onOpenSettings={() => setOverlay({ kind: "tool", page: "settings" })}
        onOpenReview={() => setOverlay({ kind: "timeline" })}
        onAdjustDesktop={() =>
          say("直接在下面对话条里说想怎么改；形态提案的执行器还在接。")
        }
        onSecretaryInteract={(intent) => {
          if (intent === "chat") {
            setThreadOpen(true);
          } else if (intent === "decide") {
            say(
              pending
                ? "桌上弹性格有一张纸等你定；线索板和星图上也能直接裁决。"
                : "现在没有等你决定的事。"
            );
          } else {
            setOverlay({ kind: "timeline" });
          }
        }}
        layerHandlers={{
          // 线索板 / 星图与桌面共享同一套真实写回（PRD：触点可以换，语义不换）
          onVerdict: handleVerdict,
          onFeedFeedback: (itemId, feedback) =>
            cardHandlers.onFeedFeedback?.(itemId, feedback),
          onLineage: openLineage,
          onCompleteAnchor: handleAnchorComplete,
          onNodeOpen: (node) => {
            if (node.lineage) openLineage(node.lineage);
            else setOverlay({ kind: "tool", page: "goals" });
          }
        }}
      />
      <DimToast message={toast} />

      {/* 工具、时间线与来源都从桌面下钻；合上后原位返回（PRD §9.2）。 */}
      {overlay && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={
            overlay.kind === "timeline"
              ? "共同变化"
              : overlay.kind === "source"
                ? "来源详情"
                : "维度工具"
          }
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 30,
            background: "var(--dim-desk)",
            display: "flex",
            flexDirection: "column"
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "10px 16px",
              borderBottom: "1px solid var(--dim-line)"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {overlay.kind === "tool" && (
                <>
                  {([
                    ["goals", "长期目标"],
                    ["connections", "外部连接"],
                    ["settings", "设置"]
                  ] as const).map(([page, label]) => (
                    <button
                      key={page}
                      type="button"
                      className={`dim-btn${overlay.page === page ? "" : " dim-btn--quiet"}`}
                      aria-pressed={overlay.page === page}
                      onClick={() => setOverlay({ kind: "tool", page })}
                    >
                      {label}
                    </button>
                  ))}
                </>
              )}
              {overlay.kind === "timeline" && <span className="dim-eyebrow">共同变化 · 真实记录</span>}
              {overlay.kind === "source" && <span className="dim-eyebrow">来源 · 真实对象</span>}
            </div>
            <button
              type="button"
              className="dim-btn"
              onClick={closeOverlay}
            >
              {overlay.kind === "source" && overlay.returnTo === "timeline"
                ? "← 回共同变化"
                : "← 合上，回桌面"}
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            {overlay.kind === "timeline" && (
              <RealityTimeline
                entries={timelineEntries}
                loading={
                  supplementalStatus.loading ||
                  !(todosLoaded && activitiesLoaded && goalsLoaded && proposalsLoaded)
                }
                unavailableSources={timelineUnavailableSources}
                onLineage={(lineage) => openLineage(lineage, "timeline")}
              />
            )}
            {overlay.kind === "source" && (
              <SourceDetail
                lineage={overlay.lineage}
                todos={todos}
                events={events}
                goals={goals}
                activities={activities}
                proposals={proposals}
                memoryFacts={memoryFacts}
                digests={digests}
                onManageGoals={() => setOverlay({ kind: "tool", page: "goals" })}
              />
            )}
            {overlay.kind === "tool" && (
              // SettingsPage 用了 useSearchParams，桌面在 Router 外，统一补一个内存路由。
              <MemoryRouter>
                <Suspense fallback={<div role="status" style={{ padding: 24 }}>工具加载中…</div>}>
                  {overlay.page === "goals" ? (
                    <TelosPage />
                  ) : overlay.page === "connections" ? (
                    <ConnectionsPage />
                  ) : (
                    <SettingsPage />
                  )}
                </Suspense>
              </MemoryRouter>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * 秘书外显状态由真实运行语义决定（PRD §7.1，不随机表演）：
 * 在想 = 引擎正在生成；有事说 = 有提案等待裁决；其余时间在岗。
 */
function liveSecretary(
  base: Secretary,
  chatLoading: boolean,
  hasPendingProposal: boolean
): Secretary {
  if (chatLoading) {
    return {
      ...base,
      state: "thinking",
      gesture: "pondering",
      stateCn: "在想",
      headline: "我在想你刚说的。"
    };
  }
  if (hasPendingProposal) {
    return {
      ...base,
      state: "presenting",
      gesture: "offering",
      stateCn: "有事说",
      headline: "有一件事等你决定。"
    };
  }
  return base;
}
