import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DesktopProjection } from "../../projections/desktop/types";
import { SEED_DESKTOP_PROJECTION } from "../../projections/desktop/seedProjection";
import {
  BROWSER_COMPANION_COMPONENT_ID,
  BROWSER_SYSTEM_COMPONENT_IDS,
  resolveBrowserComponentRuntimeState,
} from "../../runtime/composition/browserProduction";
import { SEED_LAYOUT_DOCUMENT } from "../../runtime/layout/seedLayout";
import type { LayoutDocumentV1 } from "../../runtime/layout/types";
import type { LayoutCompositionSurface } from "../../runtime/layout/LayoutRenderer";
import { DimensionApp, type DimensionAppProps, type DesktopWorkspaceHandle } from "../DimensionApp";
import type { SendComposerMessage } from "../composer/MessageComposer";
import { CardEditorDialog, type CardEditorValue } from "../CardEditorDialog";
import { materializeDeskCard } from "../nativeRegistry";
import { SecretaryRail, type SecretaryRailProps } from "../Shell";
import { SecretaryCompanion } from "../SecretaryCompanion";
import type {
  AnchorRow,
  CardEditRequest,
  CardHandlers,
  CardPresentation,
  FeedFeedback,
  LineageRef,
  NativeCardPayload,
  ProposalVerdict,
  RelationMetric,
  SecretaryIntent
} from "../types";
import {
  buildClueThreads,
  ClueBoardPreset,
  type ClueThread
} from "./ClueBoardPreset";
import {
  ConstellationPreset,
  type ConstellationNode
} from "./ConstellationPreset";
import type { GoalChange } from "./GoalEditorDialog";
import { DimensionDeck } from "./DimensionDeck";
import {
  replaceDimensionPresetInUrl,
  resolveDimensionPreset,
  type DimensionPresetId
} from "./presetQuery";
import { readDesktopWorkspace, type DesktopViewContext } from "../desktopWorkspace";

/** 秘书栏收拢状态记在本地：她是常驻同伴，收不收起是用户的长期偏好。 */
const RAIL_STORAGE_KEY = "dim-rail-collapsed";

interface DeskEdits {
  bindings: Record<string, NativeCardPayload>;
  presentations: Record<string, CardPresentation>;
  /** 派生桌面的内容改动只属于这条线索，不能覆盖总 projection。 */
  threadBindings: Record<string, Record<string, NativeCardPayload>>;
  /** 同一 cardId 在线索桌面里也可以有自己的标题与纸张呈现。 */
  threadPresentations: Record<string, Record<string, CardPresentation>>;
}

function cardEditStorageKey(layoutId: string): string {
  return `dim-card-edits-${layoutId}`;
}

function readDeskEdits(layoutId: string): DeskEdits {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(cardEditStorageKey(layoutId)) ?? "{}") as Partial<DeskEdits>;
    return {
      bindings: parsed.bindings && typeof parsed.bindings === "object" ? parsed.bindings : {},
      presentations:
        parsed.presentations && typeof parsed.presentations === "object" ? parsed.presentations : {},
      threadBindings:
        parsed.threadBindings && typeof parsed.threadBindings === "object"
          ? parsed.threadBindings
          : {},
      threadPresentations:
        parsed.threadPresentations && typeof parsed.threadPresentations === "object"
          ? parsed.threadPresentations
          : {}
    };
  } catch {
    return {
      bindings: {},
      presentations: {},
      threadBindings: {},
      threadPresentations: {}
    };
  }
}

function writeDeskEdits(layoutId: string, edits: DeskEdits) {
  try {
    window.localStorage.setItem(cardEditStorageKey(layoutId), JSON.stringify(edits));
  } catch {
    /* 私密窗口写不进就只保留当前会话 */
  }
}

function anchorIdentity(row: AnchorRow): string | null {
  const lineage = row.lineage;
  return lineage ? `${lineage.entityType}:${lineage.entityId}` : null;
}

/**
 * 聚焦桌面的 anchors 只是全局 binding 的一个窗口。整卡编辑保存时必须按
 * lineage 合回去，不能拿这个子集覆盖全局，否则其他线索会被误删。
 */
function mergeFocusedAnchors(
  source: Extract<NativeCardPayload, { kind: "anchors" }>,
  editedSubset: Extract<NativeCardPayload, { kind: "anchors" }>,
  focusTag: string
): Extract<NativeCardPayload, { kind: "anchors" }> {
  const byIdentity = new Map(
    editedSubset.rows.flatMap((row) => {
      const identity = anchorIdentity(row);
      return identity ? ([[identity, row]] as const) : [];
    })
  );
  const withoutIdentity = editedSubset.rows.filter((row) => !anchorIdentity(row));
  let fallbackIndex = 0;

  return {
    ...source,
    rows: source.rows.map((row) => {
      const identity = anchorIdentity(row);
      const replacement = identity
        ? byIdentity.get(identity)
        : row.tags?.includes(focusTag)
          ? withoutIdentity[fallbackIndex++]
          : undefined;
      if (!replacement) return row;
      return {
        ...row,
        ...replacement,
        // lineage 是 Todo 写回身份，聚焦编辑不能把它换掉。
        lineage: row.lineage,
        tags: replacement.tags ?? row.tags
      };
    })
  };
}

function readRailCollapsed(): boolean {
  try {
    return window.localStorage.getItem(RAIL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export interface DimensionPresetAppProps {
  projection?: DesktopProjection;
  layout?: LayoutDocumentV1<string, CardPresentation>;
  initialPreset?: DimensionPresetId;
  /** Story / 测试可关闭 URL 同步；产品预览默认生成可分享链接。 */
  syncUrl?: boolean;
  /** 纸面预设的真实交互出口。 */
  paperHandlers?: CardHandlers;
  /** Browser-only trusted V2 surface; all other shells keep their current path. */
  composition?: LayoutCompositionSurface;
  onSendMessage?: SendComposerMessage;
  onDesktopContextChange?: (context: DesktopViewContext) => void;
  composerSessionId?: string;
  /** 对话层节点，透传给纸面桌面。 */
  thread?: ReactNode;
  onOpenSettings?: () => void;
  onOpenReview?: () => void;
  onAdjustDesktop?: () => void;
  onReconnect?: () => Promise<void>;
  /** User-owned card visibility commits through the host composition boundary. */
  onCardVisibilityChange?: (cardId: string, visible: boolean) => void;
  onRequestCardHelp?: DimensionAppProps["onRequestCardHelp"];
  /** 点秘书立绘的出口（聊聊 / 看看有什么要定 / 回顾）。 */
  onSecretaryInteract?: (intent: SecretaryIntent) => void;
  /** Browser product can place her in the rail, as a desk companion, or in the app header. */
  secretaryPresentation?: "rail" | "companion" | "header";
  secretaryPortrait?: SecretaryRailProps["portrait"];
  /** Controlled state for the header launcher so it can announce the open chat window. */
  secretaryChatOpen?: boolean;
  /** Event-clock delivery for the detached companion. */
  secretaryNotice?: string | null;
  /** Co-creation stays next to the secretary until the user opens it. */
  secretaryInvitation?: ReactNode;
  /** User visibility changes commit through the same Browser UiSurfaceV2 CAS engine. */
  onCompanionVisibilityChange?: (visible: boolean) => void;
  /**
   * The legacy desktop lets a user locally override a whole native-card payload.
   * Live browser projections must disable that path because Domain is their only
   * semantic source of truth; presentation remains adjustable through UiChangeSet.
   */
  localCardEditing?: "full" | "disabled";
  /**
   * 线索板与星图的真实出口。省略时两层保持演示提示；
   * LiveDimensionApp 注入与桌面同一套写回实现。
   */
  layerHandlers?: {
    onVerdict?: (verdict: ProposalVerdict) => void;
    onFeedFeedback?: (itemId: string, feedback: FeedFeedback) => void;
    onLineage?: (lineage: LineageRef) => void;
    onRelationInspect?: (metric: RelationMetric) => void;
    onCompleteAnchor?: (row: AnchorRow) => void;
    onNodeOpen?: (node: ConstellationNode) => void;
    onDiscussNode?: (node: ConstellationNode) => void;
    onSaveGoal?: (change: GoalChange) => Promise<void>;
  };
}

/**
 * 同一份今日内容的三层外壳：桌面（执行）/ 线索板（结构）/ 星图（全貌）。
 *
 * 上下滑动换层（见 DimensionDeck）；层只是 projection 的视觉解释，
 * 不写入布局文档或用户数据。纸面层仍走受校验的 LayoutRenderer。
 */
export function DimensionPresetApp({
  projection = SEED_DESKTOP_PROJECTION,
  layout = SEED_LAYOUT_DOCUMENT,
  initialPreset,
  syncUrl = true,
  paperHandlers,
  composition,
  onSendMessage,
  onDesktopContextChange,
  composerSessionId,
  thread,
  onOpenSettings,
  onOpenReview,
  onAdjustDesktop,
  onReconnect,
  onCardVisibilityChange,
  onRequestCardHelp,
  onSecretaryInteract,
  secretaryPresentation = "rail",
  secretaryPortrait,
  secretaryChatOpen = false,
  secretaryNotice,
  secretaryInvitation,
  onCompanionVisibilityChange,
  localCardEditing = "full",
  layerHandlers
}: DimensionPresetAppProps = {}) {
  const [preset, setPreset] = useState<DimensionPresetId>(
    () => initialPreset ?? resolveDimensionPreset()
  );
  const browserModules = useMemo(() => {
    if (!composition || composition.registry.validateDocument(composition.document).length > 0) {
      return undefined;
    }
    const companion = resolveBrowserComponentRuntimeState(
      composition.document,
      composition.registry,
      BROWSER_COMPANION_COMPONENT_ID,
    );
    const commandBar = resolveBrowserComponentRuntimeState(
      composition.document,
      composition.registry,
      BROWSER_SYSTEM_COMPONENT_IDS.commandBar,
    );
    const navigation = resolveBrowserComponentRuntimeState(
      composition.document,
      composition.registry,
      BROWSER_SYSTEM_COMPONENT_IDS.navigation,
    );
    const threadModule = resolveBrowserComponentRuntimeState(
      composition.document,
      composition.registry,
      BROWSER_SYSTEM_COMPONENT_IDS.thread,
    );
    const outcome = resolveBrowserComponentRuntimeState(
      composition.document,
      composition.registry,
      BROWSER_SYSTEM_COMPONENT_IDS.outcome,
    );
    const diagnostics = resolveBrowserComponentRuntimeState(
      composition.document,
      composition.registry,
      BROWSER_SYSTEM_COMPONENT_IDS.diagnostics,
    );
    return {
      companion: companion && {
        visible: companion.visible,
        actionAvailability: {
          chat: companion.actions.chat === true &&
            threadModule?.visible === true && threadModule.actions.close === true,
          review: companion.actions.review === true,
          outcome: companion.actions.outcome === true &&
            outcome?.visible === true && outcome.actions.close === true,
        },
      },
      commandBar,
      navigation,
      diagnostics,
    };
  }, [composition]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const [railCollapsed, setRailCollapsed] = useState(readRailCollapsed);
  const [compactViewport, setCompactViewport] = useState(() => window.matchMedia?.("(max-width: 600px)").matches ?? false);
  const [compactRailExpanded, setCompactRailExpanded] = useState(false);
  const visibleRailCollapsed = compactViewport ? !compactRailExpanded : railCollapsed;
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 600px)");
    if (!query) return;
    const changed = () => { setCompactViewport(query.matches); setCompactRailExpanded(false); };
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  const [deskEdits, setDeskEdits] = useState<DeskEdits>(() => readDeskEdits(layout.id));
  const [editingCard, setEditingCard] = useState<CardEditRequest | null>(null);
  /** 记录打开编辑器时所在的线索；null 表示编辑总桌面/线索板源卡。 */
  const [editingFocus, setEditingFocus] = useState<string | null>(null);
  /** 正在聚焦的线索节点；保存稳定 id，避免同名目标或 typed 主题重建失败。 */
  const [focusThreadId, setFocusThreadId] = useState<string | null>(() => readDesktopWorkspace(layout.id).activeAreaId);
  const desktopWorkspace = useRef<DesktopWorkspaceHandle>(null);
  const [visibleDesktopCards, setVisibleDesktopCards] = useState<string[]>([]);

  const editedProjection = useMemo<DesktopProjection>(
    () => ({
      ...projection,
      bindings:
        localCardEditing === "full"
          ? { ...projection.bindings, ...deskEdits.bindings }
          : projection.bindings
    }),
    [projection, deskEdits.bindings, localCardEditing]
  );

  const editedLayout = useMemo<LayoutDocumentV1<string, CardPresentation>>(
    () => ({
      ...layout,
      cards: layout.cards.map((card) => {
        const override =
          localCardEditing === "full" ? deskEdits.presentations[card.id] : undefined;
        if (!override) return card;
        return {
          ...card,
          presentation: { ...(card.presentation ?? override), ...override }
        };
      })
    }),
    [layout, deskEdits.presentations, localCardEditing]
  );

  const desktopForThread = useCallback((targetThread: ClueThread) => {
    const scopedPresentations =
      localCardEditing === "full"
        ? deskEdits.threadPresentations[targetThread.title] ?? {}
        : {};
    const scopedLayout = {
      ...editedLayout,
      cards: editedLayout.cards.map((card) => ({
        ...card,
        presentation: scopedPresentations[card.id] ?? (card.kind === "anchors" && card.presentation
          ? { ...card.presentation, title: `${targetThread.title} · 相关记录` }
          : card.presentation)
      }))
    };
    const bindings = Object.fromEntries(Object.entries(editedProjection.bindings).map(([id, payload]) =>
      [id, payload?.kind === "anchors" ? { ...payload, rows: targetThread.rows } : payload]));
    return {
      layout: scopedLayout,
      projection: { ...editedProjection, bindings }
    };
  }, [
    deskEdits.presentations,
    deskEdits.threadBindings,
    deskEdits.threadPresentations,
    editedLayout,
    editedProjection,
    localCardEditing
  ]);

  const availableClueThreads = useMemo(() => {
    const anchorPayload = Object.values(editedProjection.bindings).find(
      (payload) => payload?.kind === "anchors"
    );
    return buildClueThreads(anchorPayload, editedProjection.clueBoard?.themes);
  }, [editedProjection.bindings, editedProjection.clueBoard?.themes]);
  const focusedThread = availableClueThreads.find(
    (candidate) => candidate.id === focusThreadId
  ) ?? null;
  const focusThread = focusedThread?.title ?? null;
  useEffect(() => {
    onDesktopContextChange?.({ view: preset,
      area: focusedThread ? { id: focusedThread.id, title: focusedThread.title } : null,
      visibleCardIds: preset === "paper" ? visibleDesktopCards : [],
    });
  }, [preset, focusedThread, visibleDesktopCards, onDesktopContextChange]);

  const say = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  useEffect(() => {
    if (initialPreset || typeof window === "undefined") return;
    const onPopState = () => setPreset(resolveDimensionPreset());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [initialPreset]);

  function choosePreset(nextPreset: DimensionPresetId) {
    setPreset(nextPreset);
    if (syncUrl) replaceDimensionPresetInUrl(nextPreset);
  }

  function toggleRail() {
    if (compactViewport) { setCompactRailExpanded(current => !current); return; }
    setRailCollapsed((prev) => {
      try {
        window.localStorage.setItem(RAIL_STORAGE_KEY, prev ? "0" : "1");
      } catch {
        /* 私密窗口写不进就只在本次会话生效 */
      }
      return !prev;
    });
  }

  const updateDemoAnchor = useCallback(
    (row: AnchorRow, patch: Partial<AnchorRow>) => {
      const entityId = row.lineage?.entityId;
      if (!entityId) return;
      setDeskEdits((current) => {
        const bindings = { ...projection.bindings, ...current.bindings };
        const nextBindings = { ...current.bindings };
        for (const [bindingId, binding] of Object.entries(bindings)) {
          if (binding?.kind !== "anchors") continue;
          nextBindings[bindingId] = {
            ...binding,
            rows: binding.rows.map((entry) =>
              entry.lineage?.entityId === entityId ? { ...entry, ...patch } : entry
            )
          };
        }
        const next = { ...current, bindings: nextBindings };
        writeDeskEdits(layout.id, next);
        return next;
      });
    },
    [layout.id, projection.bindings]
  );

  const demoComplete = useCallback(
    (row: AnchorRow) => {
      updateDemoAnchor(row, { done: true });
      say(`完成了「${row.text}」——今天这一步留下来了。`);
    },
    [say, updateDemoAnchor]
  );

  const demoEdit = useCallback(
    (row: AnchorRow, nextText: string) => {
      updateDemoAnchor(row, { text: nextText });
      say(`已改成「${nextText}」`);
    },
    [say, updateDemoAnchor]
  );

  const resolvedPaperHandlers = useMemo<CardHandlers>(() => {
    const resolved: CardHandlers = {
      ...paperHandlers,
      onAnchorComplete: paperHandlers?.onAnchorComplete ?? demoComplete,
      onAnchorEdit: paperHandlers?.onAnchorEdit ?? demoEdit
    };
    if (localCardEditing === "full") {
      resolved.onCardEdit =
        paperHandlers?.onCardEdit ??
        ((request) => {
          setEditingFocus(null);
          setEditingCard(request);
        });
    } else {
      // Browser Live owns semantic edits through typed Domain commands. Even an
      // old dim-card-edits-* document must never make this projection lie.
      delete resolved.onCardEdit;
    }
    return resolved;
  }, [paperHandlers, demoComplete, demoEdit, focusThread, localCardEditing]);

  const openBindingEditor = useCallback(
    (bindingId: string) => {
      const definition = editedLayout.cards.find(
        (card) => card.binding === bindingId && card.renderer === "native"
      );
      const payload = editedProjection.bindings[bindingId];
      const presentation = definition?.presentation;
      if (!definition || !payload || !presentation || payload.kind !== definition.kind) {
        say("这张线索暂时没有可编辑的来源卡片。");
        return;
      }
      setEditingCard({
        cardId: definition.id,
        binding: bindingId,
        card: materializeDeskCard(payload, {
          ...presentation,
          id: definition.id,
          span: definition.span
        })
      });
      setEditingFocus(null);
    },
    [editedLayout.cards, editedProjection.bindings, say]
  );

  const openThreadEditor = useCallback(
    (targetThread: ClueThread) => {
      const desktop = desktopForThread(targetThread);
      const definition = desktop.layout.cards.find(
        (card) => card.renderer === "native" && card.kind === "anchors"
      );
      const payload = definition
        ? desktop.projection.bindings[definition.binding]
        : undefined;
      const presentation = definition?.presentation;
      if (
        !definition ||
        !presentation ||
        payload?.kind !== "anchors"
      ) {
        say("这条线索暂时没有可编辑的桌面内容。");
        return;
      }
      setEditingFocus(targetThread.title);
      setEditingCard({
        cardId: definition.id,
        binding: definition.binding,
        card: materializeDeskCard(payload, {
          ...presentation,
          id: definition.id,
          span: definition.span
        })
      });
    },
    [desktopForThread, say]
  );

  function saveCardEdit(value: CardEditorValue) {
    if (!editingCard) return;
    const savingFocusedAnchors = Boolean(
      editingFocus && value.payload.kind === "anchors"
    );
    setDeskEdits((current) => {
      const currentSource = {
        ...projection.bindings,
        ...current.bindings
      }[editingCard.binding];
      let nextPayload = value.payload;
      let editingFocusedAnchors = false;
      if (
        editingFocus &&
        currentSource?.kind === "anchors" &&
        value.payload.kind === "anchors"
      ) {
        nextPayload = mergeFocusedAnchors(currentSource, value.payload, editingFocus);
        editingFocusedAnchors = true;
      }
      const nextBindings =
        editingFocus && !editingFocusedAnchors
          ? current.bindings
          : { ...current.bindings, [editingCard.binding]: nextPayload };
      const nextThreadBindings =
        editingFocus && !editingFocusedAnchors
          ? {
              ...current.threadBindings,
              [editingFocus]: {
                ...(current.threadBindings[editingFocus] ?? {}),
                [editingCard.binding]: value.payload
              }
            }
          : current.threadBindings;
      const nextPresentations = editingFocus
        ? current.presentations
        : {
            ...current.presentations,
            [editingCard.cardId]: value.presentation
          };
      const nextThreadPresentations = editingFocus
        ? {
            ...current.threadPresentations,
            [editingFocus]: {
              ...(current.threadPresentations[editingFocus] ?? {}),
              [editingCard.cardId]: value.presentation
            }
          }
        : current.threadPresentations;
      const next = {
        bindings: nextBindings,
        presentations: nextPresentations,
        threadBindings: nextThreadBindings,
        threadPresentations: nextThreadPresentations
      };
      writeDeskEdits(layout.id, next);
      return next;
    });
    setEditingCard(null);
    setEditingFocus(null);
    say(
      savingFocusedAnchors
        ? "锚点修改已按来源合回；其他线索仍然保留。"
        : editingFocus
          ? "内容已留在这条线索对应的桌面板块。"
        : "这张卡已经按你的版本留在桌面和线索板上。"
    );
  }

  function resetCardEdit() {
    if (!editingCard) return;
    setDeskEdits((current) => {
      const bindings = { ...current.bindings };
      const presentations = { ...current.presentations };
      const threadBindings = { ...current.threadBindings };
      const threadPresentations = { ...current.threadPresentations };
      if (editingFocus) {
        const currentSource = {
          ...projection.bindings,
          ...current.bindings
        }[editingCard.binding];
        const originalSource = projection.bindings[editingCard.binding];
        if (currentSource?.kind === "anchors" && originalSource?.kind === "anchors") {
          bindings[editingCard.binding] = mergeFocusedAnchors(
            currentSource,
            {
              ...originalSource,
              rows: originalSource.rows.filter((row) =>
                row.tags?.includes(editingFocus)
              )
            },
            editingFocus
          );
        } else {
          const scoped = { ...(threadBindings[editingFocus] ?? {}) };
          delete scoped[editingCard.binding];
          if (Object.keys(scoped).length > 0) threadBindings[editingFocus] = scoped;
          else delete threadBindings[editingFocus];
        }

        const scopedPresentation = {
          ...(threadPresentations[editingFocus] ?? {})
        };
        delete scopedPresentation[editingCard.cardId];
        if (Object.keys(scopedPresentation).length > 0) {
          threadPresentations[editingFocus] = scopedPresentation;
        } else {
          delete threadPresentations[editingFocus];
        }
      } else {
        delete bindings[editingCard.binding];
        delete presentations[editingCard.cardId];
      }
      const next = {
        bindings,
        presentations,
        threadBindings,
        threadPresentations
      };
      writeDeskEdits(layout.id, next);
      return next;
    });
    setEditingCard(null);
    setEditingFocus(null);
    say("已恢复来源内容。");
  }

  // 秘书栏是全局常驻的（§5.1 桌面是唯一常驻界面）：三层都在场，层级在甲板之上。
  const railReview =
    onOpenReview ?? (() => say("演示模式：这里会打开你们共同变化的时间线"));
  const railInteract =
    onSecretaryInteract ??
    ((intent: SecretaryIntent) => {
      if (intent === "chat") say("演示模式：在下面对话条里直接说就行");
      else if (intent === "decide") say("演示模式：等你决定的事会出现在桌上");
      else railReview();
    });

  return (
    <div className="dim-preset-shell" data-preset={preset} style={{ height: "100%" }}>
      {secretaryPresentation === "rail" ? (
        <div className="dim-global-rail">
          <SecretaryRail
            secretary={editedProjection.secretary}
            portrait={secretaryPortrait}
            invitation={secretaryInvitation}
            notice={secretaryNotice}
            onReview={railReview}
            onRelationInspect={layerHandlers?.onRelationInspect}
            onInteract={railInteract}
            onSettings={(!composition || (browserModules?.diagnostics?.visible === true &&
              browserModules.diagnostics.actions.close === true))
              ? (onOpenSettings ?? (() => say("演示模式：设置页暂未接入")))
              : undefined}
            collapsed={visibleRailCollapsed}
            onToggleCollapse={toggleRail}
            visible={browserModules?.companion?.visible}
            onVisibilityChange={onCompanionVisibilityChange}
            actionAvailability={browserModules?.companion?.actionAvailability}
          />
        </div>
      ) : secretaryPresentation === "companion" ? (
        <SecretaryCompanion
          secretary={editedProjection.secretary}
          notice={secretaryNotice}
          onReview={railReview}
          onInteract={railInteract}
          onSettings={(!composition || (browserModules?.diagnostics?.visible === true &&
            browserModules.diagnostics.actions.close === true))
            ? onOpenSettings
            : undefined}
          visible={browserModules?.companion?.visible}
          onVisibilityChange={onCompanionVisibilityChange}
          actionAvailability={browserModules?.companion?.actionAvailability}
        />
      ) : null}

      <div
        className="dim-deck-wrap"
        style={{
          paddingLeft:
            secretaryPresentation !== "rail"
              ? 0
              : compactViewport || visibleRailCollapsed || browserModules?.companion?.visible === false
                ? 44
                : 176,
        }}
      >
        <DimensionDeck
          active={preset}
          onChange={choosePreset}
          onSetHome={() => { desktopWorkspace.current?.setHome(); setFocusThreadId(null); }}
          onGoHome={() => {
            desktopWorkspace.current?.goHome();
            setFocusThreadId(null);
            choosePreset("paper");
          }}
          desk={
            <DimensionApp
              ref={desktopWorkspace}
              key={editedLayout.id}
              layout={editedLayout}
              projection={editedProjection}
              handlers={resolvedPaperHandlers}
              composition={composition}
              workspaceThreads={availableClueThreads}
              activeAreaId={focusThreadId}
              onActiveAreaChange={setFocusThreadId}
              onVisibleCardsChange={setVisibleDesktopCards}
              onCompleteAreaAnchor={layerHandlers?.onCompleteAnchor ?? demoComplete}
              onAreaLineage={layerHandlers?.onLineage ?? paperHandlers?.onLineage}
              areaPresentations={localCardEditing === "full" ? deskEdits.threadPresentations : undefined}
              areaBindings={localCardEditing === "full" ? deskEdits.threadBindings : undefined}
              onSendMessage={onSendMessage}
              composerSessionId={composerSessionId}
              commandBarVisible={false}
              commandBarSendEnabled={browserModules?.commandBar?.actions.send}
              thread={thread}
              onOpenSettings={(!composition || (browserModules?.diagnostics?.visible === true &&
                browserModules.diagnostics.actions.close === true))
                ? onOpenSettings
                : undefined}
              onSecretaryInteract={railInteract}
              headerSecretary={secretaryPresentation === "header" ? {
                notice: secretaryNotice,
                open: secretaryChatOpen,
                visible: browserModules?.companion?.visible !== false,
                chatEnabled: browserModules?.companion?.actionAvailability.chat !== false,
                outcomeEnabled: browserModules?.companion?.actionAvailability.outcome !== false,
                onRestore: onCompanionVisibilityChange
                  ? () => onCompanionVisibilityChange(true)
                  : undefined,
              } : undefined}
              onOpenReview={onOpenReview}
              onAdjustDesktop={onAdjustDesktop}
              onReconnect={onReconnect}
              onCardVisibilityChange={onCardVisibilityChange}
              onRequestCardHelp={onRequestCardHelp}
              railMode="none"
            />
          }
          clueBoard={
            <ClueBoardPreset
              projection={editedProjection}
              selectedThreadId={focusThreadId}
              onEnterThread={(thread) => {
                // Prepare the camera before the deck reveals the single shared canvas.
                desktopWorkspace.current?.focusArea(thread.id);
                setFocusThreadId(thread.id);
                choosePreset("paper");
              }}
              onTraceLineage={
                layerHandlers?.onLineage ??
                ((lineage) => say(`来源线索：${lineage.label}`))
              }
              onVerdict={
                layerHandlers?.onVerdict ??
                (() => say("演示模式：已收到裁决，本次不会保存"))
              }
              onCompleteAnchor={layerHandlers?.onCompleteAnchor ?? demoComplete}
              onEditBinding={localCardEditing === "full" ? openBindingEditor : undefined}
              onSaveGoal={layerHandlers?.onSaveGoal}
              onEditThread={localCardEditing === "full" ? openThreadEditor : undefined}
              onOpenThesis={() => {
                desktopWorkspace.current?.goHome();
                setFocusThreadId(null);
                choosePreset("paper");
              }}
            />
          }
          constellation={
            <ConstellationPreset
              projection={editedProjection}
              onLineage={
                layerHandlers?.onLineage ??
                ((lineage) => say(`星源线索：${lineage.label}`))
              }
              onNodeOpen={(node) => {
                if (layerHandlers?.onNodeOpen) layerHandlers.onNodeOpen(node);
                else say(`星图：正在靠近“${node.label}”，详情下钻还在接`);
              }}
              onDiscussNode={layerHandlers?.onDiscussNode ?? (() => railInteract("chat"))}
            />
          }
          navigationVisible={browserModules?.navigation?.visible}
          actionAvailability={browserModules?.navigation ? {
            paper: browserModules.navigation.actions.paper === true,
            clue: browserModules.navigation.actions.clue === true,
            constellation: browserModules.navigation.actions.constellation === true,
          } : undefined}
        />
      </div>

      {toast && (
        <div className="dim-preset-toast" role="status">
          {toast}
        </div>
      )}

      {editingCard && (
        <CardEditorDialog
          key={`${editingCard.cardId}-${editingCard.binding}`}
          request={editingCard}
          onClose={() => {
            setEditingCard(null);
            setEditingFocus(null);
          }}
          onSave={saveCardEdit}
          onReset={resetCardEdit}
        />
      )}
    </div>
  );
}
