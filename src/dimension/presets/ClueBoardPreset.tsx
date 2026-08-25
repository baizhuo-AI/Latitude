import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent
} from "react";
import type { DesktopProjection } from "../../projections/desktop/types";
import type { ClueThemeModel } from "../../projections/desktop/types";
import { runtimeStatusLabel } from "../../projections/desktop/types";
import type {
  AnchorCardPayload,
  AnchorRow,
  FeedCardPayload,
  FeedFeedback,
  LineageRef,
  NativeCardPayload,
  ProposalCardPayload,
  ProposalVerdict
} from "../types";
import "./clue-board.css";

export interface ClueBoardPresetProps {
  projection: DesktopProjection;
  /**
   * 点按线索纸：进入这条线索的聚焦桌面（线索与桌面是层级关系，
   * 一个线索代表一张桌面，不同线索的桌面重点不同）。
   */
  onEnterThread?: (thread: ClueThread) => void;
  onTraceLineage?: (lineage: LineageRef) => void;
  onAcceptProposal?: (bindingId: string, payload: ProposalCardPayload) => void;
  onRejectProposal?: (bindingId: string, payload: ProposalCardPayload) => void;
  /** 完整裁决集出口；存在时提案纸片直接渲染五态裁决（与桌面同一语义）。 */
  onVerdict?: (verdict: ProposalVerdict) => void;
  /** 剪报的三键反馈出口。 */
  onFeedFeedback?: (itemId: string, feedback: FeedFeedback) => void;
  /** 行动锚点的真实完成出口（详情抽屉里也能收口）。 */
  onCompleteAnchor?: (row: AnchorRow) => void;
  /** 直接编辑这张线索纸背后的卡片 binding。 */
  onEditBinding?: (bindingId: string) => void;
  /** 编辑某个线索节点自己的标题与 anchors 子集。 */
  onEditThread?: (thread: ClueThread) => void;
  /** 点击中心命题；可用于打开解释、调整桌面或进入详情。 */
  onOpenThesis?: () => void;
  className?: string;
  style?: CSSProperties;
}

interface LocatedPayload<T extends NativeCardPayload> {
  id: string;
  payload: T;
}

function findBinding<T extends NativeCardPayload["kind"]>(
  projection: DesktopProjection,
  kind: T
): LocatedPayload<Extract<NativeCardPayload, { kind: T }>> | undefined {
  for (const [id, payload] of Object.entries(projection.bindings)) {
    if (payload?.kind === kind) {
      return { id, payload: payload as Extract<NativeCardPayload, { kind: T }> };
    }
  }
  return undefined;
}

/* ---------- 线索簇：按事件维度聚类 ---------- */

export interface ClueThread {
  id: string;
  /** 维度名，直接沿用记录里的标签（工作现状 / 个人项目 / 短期规划…） */
  title: string;
  rows: AnchorRow[];
  pending: number;
  done: number;
  detail?: string;
  lineage?: LineageRef;
}

const MAX_THREADS_ON_BOARD = 4;

/**
 * 聚类只认记录里真实存在的标签：没有标签的锚点留在桌面，
 * 不硬编分组、不虚构维度（图谱接入前，标签就是事件维度的全部真相）。
 */
export function buildClueThreads(
  anchors?: AnchorCardPayload,
  goalThemes?: readonly ClueThemeModel[]
): ClueThread[] {
  if (goalThemes) {
    return goalThemes.map((theme) => ({
      id: theme.id,
      title: theme.title,
      rows: theme.rows,
      pending: theme.pending,
      done: theme.done,
      detail: theme.detail,
      lineage: theme.lineage,
    }));
  }
  const rows = anchors?.rows ?? [];
  const byTag = new Map<string, AnchorRow[]>();
  for (const row of rows) {
    const tag = row.tags?.[0];
    if (!tag) continue;
    const list = byTag.get(tag) ?? [];
    list.push(row);
    byTag.set(tag, list);
  }
  return [...byTag.entries()]
    .map(([title, threadRows]) => ({
      id: `thread-${title}`,
      title,
      rows: threadRows,
      pending: threadRows.filter((row) => !row.done).length,
      done: threadRows.filter((row) => row.done).length
    }))
    .sort((a, b) => b.rows.length - a.rows.length);
}

type BoardSemanticMode = "goal" | "clue" | "tag";

function semanticNoun(mode: BoardSemanticMode): string {
  return mode === "goal" ? "中期目标" : mode === "clue" ? "线索" : "标签分组";
}

/* ---------- 板上位置（百分比，线索纸与墨线共用同一套坐标） ---------- */

const THREAD_SLOTS = [
  { x: 22, y: 26 },
  { x: 78, y: 26 },
  { x: 22, y: 62 },
  { x: 78, y: 62 }
] as const;

const THESIS_POS = { x: 50, y: 15 };
const PROPOSAL_POS = { x: 42, y: 80 };
const CLIP_POS = { x: 80, y: 8 };

const BOARD_ITEM_IDS = {
  thesis: "board:thesis",
  proposal: "board:proposal",
  clipping: "board:clipping"
} as const;

type BoardPos = { x: number; y: number };
type BoardBounds = { minX: number; maxX: number; minY: number; maxY: number };

const THREAD_BOUNDS: BoardBounds = { minX: 21, maxX: 79, minY: 6, maxY: 90 };
const WIDE_PAPER_BOUNDS: BoardBounds = { minX: 20, maxX: 80, minY: 5, maxY: 88 };
const SMALL_PAPER_BOUNDS: BoardBounds = { minX: 14, maxX: 86, minY: 5, maxY: 88 };

const POS_STORAGE_KEY = "dim-clue-positions-v1";
export const CONNECTION_STORAGE_KEY = "dim-clue-connections-v1";

/** 板上命题与线索纸之间的关系；none 表示用户暂时拆掉了这根线。 */
export type ClueRelation = "support" | "verify" | "related" | "none";

const RELATION_META: Record<ClueRelation, { label: string; short: string }> = {
  support: { label: "支撑", short: "支撑" },
  verify: { label: "待验证", short: "待验证" },
  related: { label: "相关", short: "相关" },
  none: { label: "不连接", short: "未连接" }
};

function readConnections(): Record<string, ClueRelation> {
  try {
    const raw = window.localStorage.getItem(CONNECTION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, ClueRelation] =>
        ["support", "verify", "related", "none"].includes(String(entry[1]))
      )
    );
  } catch {
    return {};
  }
}

function writeConnections(connections: Record<string, ClueRelation>) {
  try {
    window.localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(connections));
  } catch {
    /* 私密窗口写不进就只在本次会话生效 */
  }
}

/** 线索纸可以在板上拖动重排；钉法是用户的长期状态，刷新不丢。 */
function readPositions(): Record<string, BoardPos> {
  try {
    const raw = window.localStorage.getItem(POS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, BoardPos>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writePositions(positions: Record<string, BoardPos>) {
  try {
    window.localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(positions));
  } catch {
    /* 私密窗口写不进就只在本次会话生效 */
  }
}

const clampPos = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/** 从命题钉孔出发的墨线；金线连线索簇（跟着纸片的实时位置走），暗红虚线连待验证的提案。 */
function ThreadMap({
  connections,
  hasProposal,
  thesisPosition,
  proposalPosition,
  onSelect
}: {
  connections: Array<{ thread: ClueThread; position: BoardPos; relation: ClueRelation }>;
  hasProposal: boolean;
  thesisPosition: BoardPos;
  proposalPosition: BoardPos;
  onSelect: (threadId: string) => void;
}) {
  const thesis = { x: thesisPosition.x * 10, y: thesisPosition.y * 6.8 + 66 };
  return (
    <svg
      className="clue-threads"
      viewBox="0 0 1000 680"
      preserveAspectRatio="none"
      role="group"
      aria-label="线索连接"
    >
      {connections.map(({ thread, position, relation }) => {
        if (relation === "none") return null;
        const d = `M ${thesis.x} ${thesis.y} Q ${(thesis.x + position.x * 10) / 2} ${
          (thesis.y + position.y * 6.8) / 2 - 24
        } ${position.x * 10} ${position.y * 6.8}`;
        return (
          <g key={thread.id} className={`clue-thread clue-thread-${relation}`}>
            <path className="clue-thread-stroke" d={d} />
            <path
              className="clue-thread-hit"
              d={d}
              role="button"
              tabIndex={0}
              aria-label={`编辑「${thread.title}」连接，当前为${RELATION_META[relation].label}`}
              onClick={() => onSelect(thread.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(thread.id);
                }
              }}
            />
          </g>
        );
      })}
      {hasProposal && (
        <g className="clue-thread clue-thread-red">
          <path className="clue-thread-stroke"
            d={`M ${thesis.x} ${thesis.y} Q ${(thesis.x + proposalPosition.x * 10) / 2 - 40} ${
              (thesis.y + proposalPosition.y * 6.8) / 2
            } ${proposalPosition.x * 10} ${proposalPosition.y * 6.8}`}
          />
        </g>
      )}
      <circle className="clue-knot" cx={thesis.x} cy={thesis.y} r="5" />
    </svg>
  );
}

function Pin({ tone }: { tone?: "gold" | "red" | "plain" }) {
  return <span className={`clue-pin${tone ? ` clue-pin-${tone}` : ""}`} aria-hidden="true" />;
}

function isPaperControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("button, a, input, textarea, select, [contenteditable='true']"))
  );
}

/** 双击纸片时，内部真实动作只接收第一次 click；键盘激活的 detail=0 仍生效。 */
const isFirstActivation = (detail: number) => detail <= 1;

/* ---------- 线索纸（可拖动重排；点按进这条线的桌面） ---------- */

interface PaperDragHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
}

function ThreadPaper({
  thread,
  index,
  position,
  selected,
  dragging,
  dragHandlers,
  onEnter,
  onShowDetail,
  relation,
  onEditRelation,
  semanticMode,
  onEdit
}: {
  thread: ClueThread;
  index: number;
  position: BoardPos;
  selected: boolean;
  dragging: boolean;
  dragHandlers: PaperDragHandlers;
  onEnter: (thread: ClueThread) => void;
  onShowDetail: (thread: ClueThread) => void;
  relation: ClueRelation;
  onEditRelation?: (thread: ClueThread) => void;
  semanticMode: BoardSemanticMode;
  onEdit?: () => void;
}) {
  const preview = thread.rows.slice(0, 2);
  const enterTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(enterTimer.current), []);

  const handlePaperClick = (detail: number) => {
    if (!onEdit || detail === 0) {
      onEnter(thread);
      return;
    }
    window.clearTimeout(enterTimer.current);
    // 鼠标单击要留出双击判定窗；键盘 click 的 detail=0，仍立即进入。
    if (detail === 1) {
      enterTimer.current = window.setTimeout(() => onEnter(thread), 230);
    }
  };

  const handlePaperDoubleClick = () => {
    window.clearTimeout(enterTimer.current);
    onEdit?.();
  };

  return (
    <article
      className={`clue-paper clue-thread-paper${selected ? " is-selected" : ""}${
        dragging ? " is-dragging" : ""
      }`}
      style={{ left: `${position.x}%`, top: `${position.y}%` }}
      data-slip-index={index}
      {...dragHandlers}
    >
      <Pin tone="gold" />
      <header className="clue-paper-meta">
        <span>
          {semanticMode === "goal" ? "GOAL" : semanticMode === "clue" ? "CLUE" : "TAG"}{" "}
          <strong>{String(index + 1).padStart(2, "0")}</strong>
        </span>
        <span>{thread.done > 0 ? `${thread.pending} 在走 · ${thread.done} 收口` : `${thread.pending} 件在走`}</span>
      </header>
      <h3>{thread.title}</h3>
      <ul>
        {preview.map((row, i) => (
          <li key={i} className={row.done ? "is-done" : undefined}>
            <span className="clue-row-time">{row.meta}</span>
            {row.text}
          </li>
        ))}
        {thread.rows.length > preview.length && (
          <li className="clue-more">还有 {thread.rows.length - preview.length} 条</li>
        )}
      </ul>
      {/* 整纸主入口：点按 = 低头进这条线索的桌面 */}
      <button
        type="button"
        className="clue-paper-hit"
        onClick={(event) => handlePaperClick(event.detail)}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          handlePaperDoubleClick();
        }}
        aria-label={`${semanticNoun(semanticMode)} ${index + 1}：${thread.title}，${thread.pending} 件在走，单击进这张桌面，双击编辑`}
      >
        <span className="clue-paper-hit-label">
          {semanticMode === "tag" ? "进这组记录" : "进这张桌面"} →
        </span>
      </button>
      {onEdit && (
        <button
          type="button"
          className="clue-paper-edit-keyboard"
          data-no-drag
          aria-label={`编辑线索内容：${thread.title}`}
          onClick={(event) => {
            event.stopPropagation();
            onEdit();
          }}
        >
          编辑线索
        </button>
      )}
      <button
        type="button"
        className="clue-paper-detail"
        data-no-drag
        onClick={() => onShowDetail(thread)}
        aria-label={`展开${semanticNoun(semanticMode)}详情：${thread.title}`}
      >
        ⋯
      </button>
      {onEditRelation && (
        <button
          type="button"
          className={`clue-paper-relation is-${relation}`}
          data-no-drag
          onClick={(event) => {
            event.stopPropagation();
            onEditRelation(thread);
          }}
          aria-label={`调整「${thread.title}」连接，当前为${RELATION_META[relation].label}`}
        >
          <i aria-hidden="true" />
          {RELATION_META[relation].short}
        </button>
      )}
    </article>
  );
}

/* ---------- 提案纸（暗红线 · 待验证） ---------- */

function ProposalPaper({
  proposal,
  position,
  dragging,
  dragHandlers,
  onVerdict,
  onAccept,
  onReject,
  onEdit
}: {
  proposal: LocatedPayload<ProposalCardPayload>;
  position: BoardPos;
  dragging: boolean;
  dragHandlers: PaperDragHandlers;
  onVerdict?: ClueBoardPresetProps["onVerdict"];
  onAccept?: ClueBoardPresetProps["onAcceptProposal"];
  onReject?: ClueBoardPresetProps["onRejectProposal"];
  onEdit?: () => void;
}) {
  const payload = proposal.payload;
  return (
    <article
      className={`clue-paper clue-proposal-paper is-draggable${dragging ? " is-dragging" : ""}`}
      style={{ left: `${position.x}%`, top: `${position.y}%` }}
      data-board-item-id={BOARD_ITEM_IDS.proposal}
      data-slip-index={5}
      {...dragHandlers}
      data-card-editable={onEdit ? "true" : undefined}
      tabIndex={onEdit ? 0 : undefined}
      aria-label={onEdit ? "待验证提案。双击或按 Enter 编辑" : undefined}
      aria-keyshortcuts={onEdit ? "Enter F2" : undefined}
      title={onEdit ? "双击编辑线索纸" : undefined}
      onDoubleClick={(event) => {
        if (!onEdit || isPaperControl(event.target)) return;
        event.preventDefault();
        onEdit();
      }}
      onKeyDown={(event) => {
        if (
          !onEdit ||
          event.target !== event.currentTarget ||
          (event.key !== "Enter" && event.key !== "F2")
        ) {
          return;
        }
        event.preventDefault();
        onEdit();
      }}
    >
      <Pin tone="red" />
      <header className="clue-paper-meta">
        <span>提案 · 秘书推测</span>
        <span className="clue-pending-flag">待验证</span>
      </header>
      <blockquote>{payload.quote}</blockquote>
      {payload.consequence && <p className="clue-consequence">{payload.consequence}</p>}
      <footer className="clue-verdicts" data-no-drag>
        {payload.verdicts && payload.verdicts.length > 0 && onVerdict ? (
          payload.verdicts.map((verdict) => (
            <button
              key={verdict.id}
              type="button"
              className={
                verdict.id === "try" || verdict.id === "holds"
                  ? "clue-btn clue-btn-accent"
                  : "clue-btn"
              }
              onClick={(event) => {
                if (isFirstActivation(event.detail)) onVerdict(verdict);
              }}
            >
              {verdict.label}
            </button>
          ))
        ) : (
          <>
            <button
              type="button"
              className="clue-btn clue-btn-accent"
              onClick={(event) => {
                if (isFirstActivation(event.detail)) onAccept?.(proposal.id, payload);
              }}
            >
              {payload.accept}
            </button>
            <button
              type="button"
              className="clue-btn"
              onClick={(event) => {
                if (isFirstActivation(event.detail)) onReject?.(proposal.id, payload);
              }}
            >
              {payload.reject}
            </button>
          </>
        )}
      </footer>
    </article>
  );
}

/* ---------- 剪报（早报里值得留的一条） ---------- */

function FeedClipping({
  feed,
  position,
  dragging,
  dragHandlers,
  onTrace,
  onFeedFeedback,
  onEdit
}: {
  feed: LocatedPayload<FeedCardPayload>;
  position: BoardPos;
  dragging: boolean;
  dragHandlers: PaperDragHandlers;
  onTrace?: ClueBoardPresetProps["onTraceLineage"];
  onFeedFeedback?: ClueBoardPresetProps["onFeedFeedback"];
  onEdit?: () => void;
}) {
  const item = feed.payload.items[0];
  if (!item) return null;
  return (
    <article
      className={`clue-paper clue-clipping is-draggable${dragging ? " is-dragging" : ""}`}
      style={{ left: `${position.x}%`, top: `${position.y}%` }}
      data-board-item-id={BOARD_ITEM_IDS.clipping}
      data-slip-index={4}
      {...dragHandlers}
      data-card-editable={onEdit ? "true" : undefined}
      tabIndex={onEdit ? 0 : undefined}
      aria-label={onEdit ? "剪报。双击或按 Enter 编辑" : undefined}
      aria-keyshortcuts={onEdit ? "Enter F2" : undefined}
      title={onEdit ? "双击编辑线索纸" : undefined}
      onDoubleClick={(event) => {
        if (!onEdit || isPaperControl(event.target)) return;
        event.preventDefault();
        onEdit();
      }}
      onKeyDown={(event) => {
        if (
          !onEdit ||
          event.target !== event.currentTarget ||
          (event.key !== "Enter" && event.key !== "F2")
        ) {
          return;
        }
        event.preventDefault();
        onEdit();
      }}
    >
      <Pin tone="plain" />
      <header className="clue-paper-meta">
        <span>剪报</span>
        <span>{item.source}</span>
      </header>
      <h3>{item.title}</h3>
      <p className="clue-clipping-why">{item.why}</p>
      <footer className="clue-verdicts" data-no-drag>
        {item.lineage && (
          <button
            type="button"
            className="clue-btn"
            onClick={(event) => {
              if (isFirstActivation(event.detail)) onTrace?.(item.lineage!);
            }}
          >
            ◇ {item.lineage.label}
          </button>
        )}
        {onFeedFeedback && (
          <>
            <button type="button" className="clue-btn" onClick={(event) => {
              if (isFirstActivation(event.detail)) onFeedFeedback(item.id, "new-angle");
            }}>
              有新角度
            </button>
            <button type="button" className="clue-btn" onClick={(event) => {
              if (isFirstActivation(event.detail)) onFeedFeedback(item.id, "known");
            }}>
              已知道
            </button>
            <button type="button" className="clue-btn" onClick={(event) => {
              if (isFirstActivation(event.detail)) onFeedFeedback(item.id, "not-useful");
            }}>
              没用
            </button>
          </>
        )}
      </footer>
    </article>
  );
}

/* ---------- 详情抽屉：点开一条线索，进它的桌面详情 ---------- */

function ThreadDrawer({
  thread,
  semanticMode,
  onClose,
  onTrace,
  onComplete
}: {
  thread: ClueThread;
  semanticMode: BoardSemanticMode;
  onClose: () => void;
  onTrace?: ClueBoardPresetProps["onTraceLineage"];
  onComplete?: ClueBoardPresetProps["onCompleteAnchor"];
}) {
  return (
    <aside
      className="clue-drawer"
      aria-label={`${semanticNoun(semanticMode)}详情：${thread.title}`}
    >
      <header>
        <p className="clue-kicker">
          {semanticMode === "goal" ? "MEDIUM GOAL" : semanticMode === "clue" ? "CLUE" : "TAG GROUP"} · DETAIL
        </p>
        <h2>{thread.title}</h2>
        <p className="clue-drawer-sub">
          {thread.pending} 件在走{thread.done > 0 ? ` · ${thread.done} 件已收口` : ""}
        </p>
        <button type="button" className="clue-drawer-close" onClick={onClose} aria-label="合上详情">
          ×
        </button>
      </header>
      <ol className="clue-drawer-list">
        {thread.rows.map((row, index) => (
          <li key={index} className={row.done ? "is-done" : undefined}>
            <div className="clue-drawer-row-main">
              <span className="clue-row-time">{row.meta}</span>
              <span className="clue-drawer-row-text">{row.text}</span>
            </div>
            <div className="clue-drawer-row-tools">
              {row.actionable && !row.done && onComplete && (
                <button
                  type="button"
                  className="clue-btn clue-btn-accent"
                  onClick={() => onComplete(row)}
                  aria-label={`完成：${row.text}`}
                >
                  完成
                </button>
              )}
              {row.lineage && (
                <button
                  type="button"
                  className="clue-lineage"
                  onClick={() => onTrace?.(row.lineage!)}
                >
                  ◇ {row.lineage.label}
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
      <p className="clue-drawer-note">
        {semanticMode === "goal"
          ? `这一簇只收 Domain 明确归属于「${thread.title}」的目标、行动、结果与资料；不从关键词猜关系。`
          : <>这一簇只收标记了「{thread.title}」的真实记录；</>}
        {semanticMode === "clue"
          ? "图谱接入后，这里会长出更深的关系。"
          : semanticMode === "goal"
            ? ""
          : "当前只是标签分组，不代表已经建立认知线索或支撑关系。"}
      </p>
    </aside>
  );
}

/**
 * 桌面预设：线索板（v4）。
 *
 * 一块带框的板子：今日命题钉在顶梁，四周是**最近的各个事件维度**
 * （工作现状 / 个人项目进度 / 短期规划……按记录里的标签聚类），
 * 金线连线索簇，暗红虚线连待验证的提案。线索纸可以拖动重排
 * （钉法记在本地）；线索与桌面是层级关系 —— 点按线索纸低头进
 * 这条线的聚焦桌面，右上 ⋯ 展开详情抽屉。没有标签维度时如实留空。
 */
export function ClueBoardPreset({
  projection,
  onEnterThread,
  onTraceLineage,
  onAcceptProposal,
  onRejectProposal,
  onVerdict,
  onFeedFeedback,
  onCompleteAnchor,
  onEditBinding,
  onEditThread,
  onOpenThesis,
  className,
  style
}: ClueBoardPresetProps) {
  const anchors = findBinding(projection, "anchors");
  const feed = findBinding(projection, "feed");
  const proposal = findBinding(projection, "proposal");
  const typedGoalThemes = projection.clueBoard !== undefined;
  const semanticMode: BoardSemanticMode = typedGoalThemes
    ? "goal"
    : projection.runtimeStatus === "demo"
      ? "clue"
      : "tag";
  const threads = useMemo(
    () => buildClueThreads(anchors?.payload, projection.clueBoard?.themes).slice(0, MAX_THREADS_ON_BOARD),
    [anchors, projection.clueBoard?.themes]
  );
  // 真实图谱关系仍只来自 Domain；这里开放的是板面连线，方便用户组织视图，
  // 不把一条视觉线冒充知识图谱中的 canonical edge。
  const connectionEditingEnabled = threads.length > 0;
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const openThread = threads.find((thread) => thread.id === openThreadId) ?? null;
  const [connections, setConnections] = useState<Record<string, ClueRelation>>(readConnections);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const editingConnection =
    threads.find((thread) => thread.id === editingConnectionId) ?? null;

  const relationFor = useCallback(
    (threadId: string): ClueRelation =>
      connectionEditingEnabled ? (connections[threadId] ?? "support") : "none",
    [connections, connectionEditingEnabled]
  );

  const changeRelation = useCallback((threadId: string, relation: ClueRelation) => {
    setConnections((current) => {
      const next = { ...current, [threadId]: relation };
      writeConnections(next);
      return next;
    });
  }, []);

  /* 线索纸的钉法：百分比坐标，可拖动，记进 localStorage */
  const [positions, setPositions] = useState<Record<string, BoardPos>>(readPositions);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragSession = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    base: BoardPos;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef<string | null>(null);

  const positionForItem = useCallback(
    (id: string, fallback: BoardPos, bounds: BoardBounds): BoardPos => {
      const raw = positions[id] ?? fallback;
      // 旧版本允许纸片贴到边缘；读取时也做安全收边，避免窄窗口裁掉整张纸。
      return {
        x: clampPos(raw.x, bounds.minX, bounds.maxX),
        y: clampPos(raw.y, bounds.minY, bounds.maxY)
      };
    },
    [positions]
  );

  const positionFor = useCallback(
    (thread: ClueThread, index: number): BoardPos =>
      positionForItem(
        thread.id,
        THREAD_SLOTS[index] ?? THREAD_SLOTS[0],
        THREAD_BOUNDS
      ),
    [positionForItem]
  );

  const thesisPosition = positionForItem(
    BOARD_ITEM_IDS.thesis,
    THESIS_POS,
    WIDE_PAPER_BOUNDS
  );
  const proposalPosition = positionForItem(
    BOARD_ITEM_IDS.proposal,
    PROPOSAL_POS,
    WIDE_PAPER_BOUNDS
  );
  const clippingPosition = positionForItem(
    BOARD_ITEM_IDS.clipping,
    CLIP_POS,
    SMALL_PAPER_BOUNDS
  );

  const paperDrag = useCallback(
    (id: string, fallback: BoardPos, bounds: BoardBounds): PaperDragHandlers => ({
      onPointerDown: (event) => {
        if (event.button !== 0 || event.pointerType === "touch") return;
        const target = event.target;
        if (target instanceof HTMLElement && target.closest("[data-no-drag]")) return;
        dragSession.current = {
          id,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          base: positionForItem(id, fallback, bounds),
          moved: false
        };
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* jsdom 等环境没有指针捕获 */
        }
      },
      onPointerMove: (event) => {
        const active = dragSession.current;
        if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
        const dx = event.clientX - active.startX;
        const dy = event.clientY - active.startY;
        if (!active.moved) {
          if (Math.abs(dx) + Math.abs(dy) < 4) return;
          active.moved = true;
          setDraggingId(id);
        }
        const rect = surfaceRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return;
        const next = {
          x: clampPos(active.base.x + (dx / rect.width) * 100, bounds.minX, bounds.maxX),
          y: clampPos(active.base.y + (dy / rect.height) * 100, bounds.minY, bounds.maxY)
        };
        setPositions((prev) => ({ ...prev, [id]: next }));
      },
      onPointerUp: (event) => {
        const active = dragSession.current;
        if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
        dragSession.current = null;
        try {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        } catch {
          /* 同上 */
        }
        if (active.moved) {
          suppressClick.current = id;
          setDraggingId(null);
          setPositions((prev) => {
            writePositions(prev);
            return prev;
          });
        }
      },
      onPointerCancel: () => {
        dragSession.current = null;
        setDraggingId(null);
      },
      onClickCapture: (event) => {
        if (suppressClick.current !== id) return;
        suppressClick.current = null;
        event.preventDefault();
        event.stopPropagation();
      }
    }),
    [positionForItem]
  );

  const handleEnter = useCallback((thread: ClueThread) => {
    onEnterThread?.(thread);
  }, [onEnterThread]);

  return (
    <div
      className={`clue-board${className ? ` ${className}` : ""}`}
      style={style}
      data-deck-scroll
    >
      <header className="clue-topbar">
        <div>
          <p className="clue-kicker">
            {typedGoalThemes
              ? "LATITUDE / MEDIUM HORIZON"
              : projection.runtimeStatus === "demo"
                ? "LATITUDE / EVIDENCE ROOM"
                : "LATITUDE / TAG GROUPS"}
          </p>
          <h1>{typedGoalThemes ? "中期目标线索板" : projection.runtimeStatus === "demo" ? "今日线索板" : "今日标签分组"}</h1>
        </div>
        <div
          className="clue-legend"
          aria-label={typedGoalThemes ? "中期目标投影边界" : "板面连接线图例"}
        >
          {typedGoalThemes ? (
            <span>所有纸片可拖动 · 主题来自 Domain · 连线不改知识关系</span>
          ) : (
            <span>所有纸片可拖动 · 板面连线不会写成认知事实</span>
          )}
          <span><i className="clue-legend-line clue-legend-gold" />支撑</span>
          <span><i className="clue-legend-line clue-legend-red" />待验证</span>
          <span><i className="clue-legend-line clue-legend-related" />相关</span>
        </div>
        <div className="clue-status">
          <span className="clue-status-light" aria-hidden="true" />
          <span>{runtimeStatusLabel(projection.runtimeStatus)}</span>
          <span aria-hidden="true">·</span>
          <time>{projection.generatedAt.slice(0, 10)}</time>
        </div>
      </header>

      <div className="clue-frame">
        <div className="clue-surface" ref={surfaceRef}>
          <ThreadMap
            connections={threads.map((thread, index) => ({
              thread,
              position: positionFor(thread, index),
              relation: relationFor(thread.id)
            }))}
            hasProposal={Boolean(proposal)}
            thesisPosition={thesisPosition}
            proposalPosition={proposalPosition}
            onSelect={setEditingConnectionId}
          />

          {/* 中心命题钉在顶梁 */}
          <button
            type="button"
            className={`clue-thesis is-draggable${draggingId === BOARD_ITEM_IDS.thesis ? " is-dragging" : ""}`}
            style={{ left: `${thesisPosition.x}%`, top: `${thesisPosition.y}%` }}
            data-board-item-id={BOARD_ITEM_IDS.thesis}
            {...paperDrag(BOARD_ITEM_IDS.thesis, THESIS_POS, WIDE_PAPER_BOUNDS)}
            onClick={onOpenThesis}
          >
            <Pin tone="plain" />
            <span className="clue-thesis-number">
              {typedGoalThemes ? "HORIZON" : projection.runtimeStatus === "demo" ? "CASE" : "FOCUS"} <strong>00</strong> · {projection.runtimeStatus === "demo" ? "ACTIVE" : "RECORDED"}
            </span>
            <strong>{projection.clueBoard?.title ?? projection.header.title}</strong>
            <span className="clue-thesis-copy">{projection.clueBoard?.subtitle ?? projection.header.subtitle}</span>
          </button>

          {threads.map((thread, index) => (
            <ThreadPaper
              key={thread.id}
              thread={thread}
              index={index}
              position={positionFor(thread, index)}
              selected={openThreadId === thread.id}
              dragging={draggingId === thread.id}
              dragHandlers={paperDrag(
                thread.id,
                THREAD_SLOTS[index] ?? THREAD_SLOTS[0],
                THREAD_BOUNDS
              )}
              onEnter={handleEnter}
              onShowDetail={(t) => setOpenThreadId(t.id)}
              relation={relationFor(thread.id)}
              onEditRelation={(t) => setEditingConnectionId(t.id)}
              semanticMode={semanticMode}
              onEdit={
                onEditThread ? () => onEditThread(thread) : undefined
              }
            />
          ))}

          {connectionEditingEnabled && editingConnection && (
            <aside className="clue-line-editor" aria-label={`编辑连接：${editingConnection.title}`}>
              <button
                type="button"
                className="clue-line-editor-close"
                aria-label="关闭连接编辑"
                onClick={() => setEditingConnectionId(null)}
              >
                ×
              </button>
              <span className="clue-line-editor-kicker">
                {typedGoalThemes ? "HORIZON 00 → GOAL" : "CASE 00 → CLUE"}
              </span>
              <strong>{editingConnection.title}</strong>
              <p>这根线只组织当前板面，不会把视觉关系写成 Domain 事实。</p>
              <div className="clue-line-editor-options">
                {(Object.keys(RELATION_META) as ClueRelation[]).map((relation) => (
                  <button
                    key={relation}
                    type="button"
                    className={relationFor(editingConnection.id) === relation ? "is-active" : undefined}
                    aria-pressed={relationFor(editingConnection.id) === relation}
                    onClick={() => changeRelation(editingConnection.id, relation)}
                  >
                    <i className={`is-${relation}`} aria-hidden="true" />
                    {RELATION_META[relation].label}
                  </button>
                ))}
              </div>
            </aside>
          )}

          {threads.length === 0 && (
            <p className="clue-blank">
              {typedGoalThemes
                ? "Domain 里还没有明确的中期目标；系统不会拿短期目标或标签冒充线索板主题。"
                : "记录还没有标出事件维度——给待办带上标签（比如「工作」「个人项目」），它们会在这里形成标签分组；认知线索要等图谱接入。"}
            </p>
          )}

          {proposal && (
            <ProposalPaper
              proposal={proposal}
              position={proposalPosition}
              dragging={draggingId === BOARD_ITEM_IDS.proposal}
              dragHandlers={paperDrag(
                BOARD_ITEM_IDS.proposal,
                PROPOSAL_POS,
                WIDE_PAPER_BOUNDS
              )}
              onVerdict={onVerdict}
              onAccept={onAcceptProposal}
              onReject={onRejectProposal}
              onEdit={onEditBinding ? () => onEditBinding(proposal.id) : undefined}
            />
          )}

          {feed && (
            <FeedClipping
              feed={feed}
              position={clippingPosition}
              dragging={draggingId === BOARD_ITEM_IDS.clipping}
              dragHandlers={paperDrag(
                BOARD_ITEM_IDS.clipping,
                CLIP_POS,
                SMALL_PAPER_BOUNDS
              )}
              onTrace={onTraceLineage}
              onFeedFeedback={onFeedFeedback}
              onEdit={onEditBinding ? () => onEditBinding(feed.id) : undefined}
            />
          )}

          <p className="clue-margin-note">
            “{projection.secretary.headline}”
            <span>— {projection.secretary.eyebrow}</span>
          </p>
        </div>

        {openThread && (
          <ThreadDrawer
            thread={openThread}
            semanticMode={semanticMode}
            onClose={() => setOpenThreadId(null)}
            onTrace={onTraceLineage}
            onComplete={onCompleteAnchor}
          />
        )}
      </div>
    </div>
  );
}
