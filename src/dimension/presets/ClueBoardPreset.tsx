import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent
} from "react";
import type { DesktopProjection } from "../../projections/desktop/types";
import type { ClueThemeModel } from "../../projections/desktop/types";
import { ClueBoardViewport } from "./ClueBoardViewport";
import { CardContextMenu } from "../CardContextMenu";
import type {
  AnchorCardPayload,
  AnchorRow,
  LineageRef,
  NativeCardPayload,
  ProposalCardPayload,
  ProposalVerdict
} from "../types";
import "./clue-board.css";
import { GoalEditorDialog, type GoalChange } from "./GoalEditorDialog";

export interface ClueBoardPresetProps {
  projection: DesktopProjection;
  /**
   * 双击线索纸：定位到同一张主页上的对应板块。
   */
  onEnterThread?: (thread: ClueThread) => void;
  selectedThreadId?: string | null;
  onTraceLineage?: (lineage: LineageRef) => void;
  onAcceptProposal?: (bindingId: string, payload: ProposalCardPayload) => void;
  onRejectProposal?: (bindingId: string, payload: ProposalCardPayload) => void;
  /** 完整裁决集出口；存在时提案纸片直接渲染五态裁决（与桌面同一语义）。 */
  onVerdict?: (verdict: ProposalVerdict) => void;
  /** 行动锚点的真实完成出口（详情抽屉里也能收口）。 */
  onCompleteAnchor?: (row: AnchorRow) => void;
  /** 直接编辑这张线索纸背后的卡片 binding。 */
  onEditBinding?: (bindingId: string) => void;
  /** 编辑某个线索节点自己的标题与 anchors 子集。 */
  onEditThread?: (thread: ClueThread) => void;
  onSaveGoal?: (change: GoalChange) => Promise<void>;
  /** 点击当前方向，返回同一桌面的常用区。 */
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

const BOARD_ITEM_IDS = {
  thesis: "board:thesis",
  proposal: "board:proposal"
} as const;

type BoardPos = { x: number; y: number };
type BoardBounds = { minX: number; maxX: number; minY: number; maxY: number };

const THREAD_BOUNDS: BoardBounds = { minX: 21, maxX: 79, minY: 6, maxY: 90 };
const WIDE_PAPER_BOUNDS: BoardBounds = { minX: 20, maxX: 80, minY: 5, maxY: 88 };

const POS_STORAGE_KEY = "dim-clue-positions-v1";
export const SIZE_STORAGE_KEY = "dim-clue-sizes-v1";
type PaperSize = { width: number; height: number };

function readSizes(): Record<string, PaperSize> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SIZE_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, PaperSize] => {
      const size = entry[1];
      return size && Number.isFinite(size.width) && Number.isFinite(size.height)
        && size.width >= 208 && size.width <= 640 && size.height >= 132 && size.height <= 720;
    }));
  } catch { return {}; }
}

function saveSize(id: string, size: PaperSize) {
  try { localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify({ ...readSizes(), [id]: size })); }
  catch { /* 保存不可用时，本次会话仍保留尺寸。 */ }
}

const clampPaperSize = (width: number, height: number): PaperSize => ({
  width: Math.max(208, Math.min(640, Math.round(width))),
  height: Math.max(132, Math.min(720, Math.round(height))),
});
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
  const thesis = threadMapThesisPoint(thesisPosition);
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
        const d = threadPath(thesisPosition, position);
        return (
          <g
            key={thread.id}
            className={`clue-thread clue-thread-${relation}`}
            data-clue-thread-id={thread.id}
          >
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
        <g className="clue-thread clue-thread-red" data-clue-proposal-thread>
          <path className="clue-thread-stroke"
            d={proposalPath(thesisPosition, proposalPosition)}
          />
        </g>
      )}
      <circle className="clue-knot" cx={thesis.x} cy={thesis.y} r="5" />
    </svg>
  );
}

function threadMapThesisPoint(position: BoardPos) {
  return { x: position.x * 10, y: position.y * 6.8 + 66 };
}

function threadPath(thesisPosition: BoardPos, paperPosition: BoardPos): string {
  const thesis = threadMapThesisPoint(thesisPosition);
  const paper = { x: paperPosition.x * 10, y: paperPosition.y * 6.8 };
  return `M ${thesis.x} ${thesis.y} Q ${(thesis.x + paper.x) / 2} ${(thesis.y + paper.y) / 2 - 24} ${paper.x} ${paper.y}`;
}

function proposalPath(thesisPosition: BoardPos, paperPosition: BoardPos): string {
  const thesis = threadMapThesisPoint(thesisPosition);
  const paper = { x: paperPosition.x * 10, y: paperPosition.y * 6.8 };
  return `M ${thesis.x} ${thesis.y} Q ${(thesis.x + paper.x) / 2 - 40} ${(thesis.y + paper.y) / 2} ${paper.x} ${paper.y}`;
}

function applyBoardPosition(target: HTMLElement, position: BoardPos) {
  target.style.left = `${position.x}%`;
  target.style.top = `${position.y}%`;
}

function applyPath(group: SVGGElement | null | undefined, path: string) {
  group?.querySelectorAll("path").forEach((element) => element.setAttribute("d", path));
}

function releasePaperPointer(target: HTMLElement, pointerId: number) {
  try {
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  } catch {
    /* 系统已取消或测试环境没有指针捕获时无需再释放 */
  }
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
  onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  onDoubleClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
}

function ThreadPaper({
  thread, index, position, selected, dragging, dragHandlers, onEnter,
  semanticMode, onSettings, resizing, onFinishResize,
}: {
  thread: ClueThread;
  index: number;
  position: BoardPos;
  selected: boolean;
  dragging: boolean;
  dragHandlers: PaperDragHandlers;
  onEnter: (thread: ClueThread) => void;
  semanticMode: BoardSemanticMode;
  onSettings: (thread: ClueThread, anchor: { x: number; y: number }) => void;
  resizing: boolean;
  onFinishResize: () => void;
}) {
  const preview = thread.rows.slice(0, 2);
  const paperRef = useRef<HTMLElement>(null);
  const resizeHandle = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState<PaperSize | undefined>(() => readSizes()[thread.id]);
  const resizeSession = useRef<{
    pointerId: number; x: number; y: number; base: PaperSize; next: PaperSize; scale: number;
  } | null>(null);

  const commitSize = (next: PaperSize) => {
    setSize(next);
    saveSize(thread.id, next);
  };
  const restoreSize = () => {
    const paper = paperRef.current;
    if (!paper) return;
    paper.style.width = size ? `${size.width}px` : "";
    paper.style.height = size ? `${size.height}px` : "";
  };
  const cancelResize = () => {
    const active = resizeSession.current;
    resizeSession.current = null;
    if (active && resizeHandle.current) releasePaperPointer(resizeHandle.current, active.pointerId);
    restoreSize();
  };

  useEffect(() => {
    if (!resizing) return;
    resizeHandle.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { cancelResize(); onFinishResize(); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [resizing, onFinishResize, size]);

  const showSettings = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onSettings(thread, { x: event.clientX, y: event.clientY });
  };

  return (
    <article
      ref={paperRef}
      className={`clue-paper clue-thread-paper is-draggable${selected ? " is-selected" : ""}${
        dragging ? " is-dragging" : ""
      }${resizing ? " is-resizing" : ""}`}
      style={{ left: `${position.x}%`, top: `${position.y}%`, width: size?.width, height: size?.height }}
      data-slip-index={index}
      data-thread-id={thread.id}
      {...dragHandlers}
      onContextMenu={showSettings}
    >
      <Pin tone="gold" />
      <div className="clue-thread-content">
        <header className="clue-paper-meta">
          <span>
            {semanticMode === "goal" ? "目标" : semanticMode === "clue" ? "线索" : "标签"}{" "}
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
      </div>
      <button
        type="button"
        className="clue-paper-hit"
        onClick={(event) => { if (event.detail === 0 && !resizing) onEnter(thread); }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!resizing) onEnter(thread);
        }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10") || event.key === "F2") {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            onSettings(thread, { x: rect.left + 16, y: rect.top + 24 });
          }
        }}
        aria-label={`${semanticNoun(semanticMode)} ${index + 1}：${thread.title}，${thread.pending} 件在走，双击进入主页板块，右键打开卡片设置`}
        aria-keyshortcuts="Enter Shift+F10 F2"
      />
      {resizing && <>
        <button className="clue-resize-done" type="button" data-no-drag onClick={onFinishResize}>完成调整</button>
        <button
          ref={resizeHandle}
          type="button"
          className="clue-resize-handle"
          data-no-drag
          aria-label={`拖拽调整大小：${thread.title}`}
          title="拖动调整大小，也可用方向键调整"
          onPointerDown={(event) => {
            if (event.button !== 0 || !paperRef.current) return;
            event.preventDefault(); event.stopPropagation();
            const paper = paperRef.current;
            const viewport = paper.closest<HTMLElement>(".clue-surface");
            const base = { width: paper.offsetWidth || size?.width || 230, height: paper.offsetHeight || size?.height || 180 };
            resizeSession.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, base, next: base,
              scale: viewport && viewport.clientWidth ? viewport.getBoundingClientRect().width / viewport.clientWidth : 1 };
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 测试环境没有捕获。 */ }
          }}
          onPointerMove={(event) => {
            const active = resizeSession.current;
            if (!active || active.pointerId !== event.pointerId || !paperRef.current) return;
            event.stopPropagation();
            active.next = clampPaperSize(active.base.width + 2 * (event.clientX - active.x) / active.scale,
              active.base.height + (event.clientY - active.y) / active.scale);
            paperRef.current.style.width = `${active.next.width}px`;
            paperRef.current.style.height = `${active.next.height}px`;
          }}
          onPointerUp={(event) => {
            const active = resizeSession.current;
            if (!active || active.pointerId !== event.pointerId) return;
            event.stopPropagation();
            resizeSession.current = null;
            releasePaperPointer(event.currentTarget, event.pointerId);
            commitSize(active.next);
          }}
          onPointerCancel={cancelResize}
          onLostPointerCapture={() => { if (resizeSession.current) cancelResize(); }}
          onKeyDown={(event) => {
            const delta = event.shiftKey ? 24 : 8;
            const keys: Record<string, [number, number]> = { ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta] };
            const change = keys[event.key];
            if (!change) return;
            event.preventDefault(); event.stopPropagation();
            commitSize(clampPaperSize((size?.width ?? (paperRef.current?.offsetWidth || 230)) + change[0],
              (size?.height ?? (paperRef.current?.offsetHeight || 180)) + change[1]));
          }}
        >⌟</button>
      </>}
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
          {semanticMode === "goal" ? "中期目标" : semanticMode === "clue" ? "线索" : "标签组"} · 详情
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
          ? `这里只收明确属于「${thread.title}」的目标、行动、结果与资料。`
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
 * （钉法记在本地）；双击线索纸进入对应主页板块，右键管理纸片。
 * 没有标签维度时如实留空。
 */
export function ClueBoardPreset({
  projection,
  onEnterThread,
  selectedThreadId,
  onTraceLineage,
  onAcceptProposal,
  onRejectProposal,
  onVerdict,
  onCompleteAnchor,
  onEditBinding,
  onEditThread,
  onSaveGoal,
  onOpenThesis,
  className,
  style
}: ClueBoardPresetProps) {
  const [editingGoal, setEditingGoal] = useState<ClueThread | null | undefined>(undefined);
  const [goalEditorMode, setGoalEditorMode] = useState<"edit" | "delete">("edit");
  const [contextMenu, setContextMenu] = useState<{ thread: ClueThread; anchor: { x: number; y: number } } | null>(null);
  const [resizingId, setResizingId] = useState<string | null>(null);
  const finishResize = useCallback(() => setResizingId(null), []);
  const anchors = findBinding(projection, "anchors");
  const proposal = findBinding(projection, "proposal");
  const typedGoalThemes = projection.clueBoard !== undefined;
  const semanticMode: BoardSemanticMode = typedGoalThemes
    ? "goal"
    : projection.runtimeStatus === "demo"
      ? "clue"
      : "tag";
  const allThreads = useMemo(
    () => buildClueThreads(anchors?.payload, projection.clueBoard?.themes),
    [anchors, projection.clueBoard?.themes]
  );
  const threads = allThreads;
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
  const positionsRef = useRef(positions);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragSession = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    base: BoardPos;
    before: BoardPos | undefined;
    next: BoardPos;
    bounds: BoardBounds;
    target: HTMLElement;
    moved: boolean;
  } | null>(null);
  if (!dragSession.current) positionsRef.current = positions;
  const suppressClick = useRef<string | null>(null);
  const suppressDoubleClick = useRef<{ id: string; until: number } | null>(null);

  const positionForItem = useCallback(
    (id: string, fallback: BoardPos, _bounds: BoardBounds): BoardPos => {
      const raw = positionsRef.current[id] ?? fallback;
      // 保留世界坐标；纸片可以位于当前视口之外。
      return {
        x: raw.x,
        y: raw.y
      };
    },
    []
  );

  const positionFor = useCallback(
    (thread: ClueThread, index: number): BoardPos =>
      positionForItem(
        thread.id,
        THREAD_SLOTS[index] ?? { x: index % 2 === 0 ? 22 : 78, y: 26 + Math.floor(index / 2) * 36 },
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
  const syncThreadMap = useCallback((movedId: string) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const thesis = positionForItem(
      BOARD_ITEM_IDS.thesis,
      THESIS_POS,
      WIDE_PAPER_BOUNDS
    );
    const syncThread = (thread: ClueThread, index: number) => {
      const group = [...surface.querySelectorAll<SVGGElement>("[data-clue-thread-id]")]
        .find((candidate) => candidate.dataset.clueThreadId === thread.id);
      if (group) applyPath(group, threadPath(thesis, positionFor(thread, index)));
    };
    if (movedId === BOARD_ITEM_IDS.thesis) {
      threads.forEach(syncThread);
      applyPath(
        surface.querySelector<SVGGElement>("[data-clue-proposal-thread]"),
        proposalPath(thesis, positionForItem(
          BOARD_ITEM_IDS.proposal,
          PROPOSAL_POS,
          WIDE_PAPER_BOUNDS
        ))
      );
      const knot = surface.querySelector<SVGCircleElement>(".clue-knot");
      const point = threadMapThesisPoint(thesis);
      knot?.setAttribute("cx", String(point.x));
      knot?.setAttribute("cy", String(point.y));
      return;
    }
    if (movedId === BOARD_ITEM_IDS.proposal) {
      applyPath(
        surface.querySelector<SVGGElement>("[data-clue-proposal-thread]"),
        proposalPath(thesis, positionForItem(
          BOARD_ITEM_IDS.proposal,
          PROPOSAL_POS,
          WIDE_PAPER_BOUNDS
        ))
      );
      return;
    }
    const index = threads.findIndex((thread) => thread.id === movedId);
    if (index >= 0) syncThread(threads[index], index);
  }, [positionFor, positionForItem, threads]);

  const cancelPaperDrag = useCallback(() => {
    const active = dragSession.current;
    if (!active) return;
    dragSession.current = null;
    releasePaperPointer(active.target, active.pointerId);
    active.target.classList.remove("is-pressed", "is-dragging");
    applyBoardPosition(active.target, active.base);
    const next = { ...positionsRef.current };
    if (active.before) next[active.id] = active.before;
    else delete next[active.id];
    positionsRef.current = next;
    syncThreadMap(active.id);
  }, [syncThreadMap]);

  const paperDrag = useCallback(
    (id: string, fallback: BoardPos, bounds: BoardBounds): PaperDragHandlers => ({
      onPointerDown: (event) => {
        if (event.button !== 0 || event.pointerType === "touch" || dragSession.current) return;
        const target = event.target;
        if (target instanceof HTMLElement && target.closest("[data-no-drag]")) return;
        dragSession.current = {
          id,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          base: positionForItem(id, fallback, bounds),
          before: positionsRef.current[id],
          next: positionForItem(id, fallback, bounds),
          bounds,
          target: event.currentTarget,
          moved: false
        };
        event.currentTarget.classList.add("is-pressed");
      },
      onPointerMove: (event) => {
        const active = dragSession.current;
        if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
        const dx = event.clientX - active.startX;
        const dy = event.clientY - active.startY;
        if (!active.moved) {
          if (Math.abs(dx) + Math.abs(dy) < 4) return;
          active.moved = true;
          try { active.target.setPointerCapture(event.pointerId); }
          catch { /* Pointer capture is absent in static test environments. */ }
          active.target.classList.remove("is-pressed");
          active.target.classList.add("is-dragging");
        }
        const rect = surfaceRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return;
        active.next = {
          x: active.base.x + (dx / rect.width) * 100,
          y: active.base.y + (dy / rect.height) * 100
        };
        positionsRef.current = { ...positionsRef.current, [id]: active.next };
        // 纸与线共享 ref 中的坐标；手势中直接更新这两个 DOM 局部，不重渲染整块板。
        applyBoardPosition(active.target, active.next);
        syncThreadMap(id);
      },
      onPointerUp: (event) => {
        const active = dragSession.current;
        if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
        dragSession.current = null;
        releasePaperPointer(active.target, active.pointerId);
        active.target.classList.remove("is-pressed", "is-dragging");
        if (active.moved) {
          suppressClick.current = id;
          suppressDoubleClick.current = { id, until: Date.now() + 350 };
          const next = positionsRef.current;
          setPositions(next);
          writePositions(next);
        }
      },
      onPointerCancel: (event) => {
        const active = dragSession.current;
        if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
        cancelPaperDrag();
      },
      onLostPointerCapture: (event) => {
        const active = dragSession.current;
        if (!active || active.id !== id || active.pointerId !== event.pointerId) return;
        cancelPaperDrag();
      },
      onClickCapture: (event) => {
        if (suppressClick.current !== id) return;
        suppressClick.current = null;
        event.preventDefault();
        event.stopPropagation();
      },
      onDoubleClickCapture: (event) => {
        if (suppressDoubleClick.current?.id !== id || Date.now() >= suppressDoubleClick.current.until) return;
        event.preventDefault();
        event.stopPropagation();
      }
    }),
    [cancelPaperDrag, positionForItem, syncThreadMap]
  );

  const draggingId = dragSession.current?.moved ? dragSession.current.id : null;

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
          <h1>线索版</h1>
        </div>
        <div
          className="clue-legend"
          aria-label={typedGoalThemes ? "中期目标投影边界" : "板面连接线图例"}
        >
          {typedGoalThemes ? (
            <span>拖动纸签 · 点击连线编辑</span>
          ) : (
            <span>所有纸片可拖动 · 板面连线不会写成认知事实</span>
          )}
          <span><i className="clue-legend-line clue-legend-gold" />支撑</span>
          <span><i className="clue-legend-line clue-legend-red" />待验证</span>
          <span><i className="clue-legend-line clue-legend-related" />相关</span>
        </div>
      </header>

      {editingGoal !== undefined && onSaveGoal && <GoalEditorDialog goal={editingGoal} initialMode={goalEditorMode} onSave={onSaveGoal} onClose={() => setEditingGoal(undefined)} />}
      <CardContextMenu
        title={contextMenu?.thread.title ?? "卡片设置"}
        anchor={contextMenu?.anchor ?? null}
        onClose={() => setContextMenu(null)}
        items={contextMenu ? [
          { id: "resize", label: "调整大小", hint: "拖动右下角", onSelect: () => setResizingId(contextMenu.thread.id) },
          ...((onSaveGoal && contextMenu.thread.lineage?.entityType === "goal") || onEditThread ? [{
            id: "edit", label: "编辑内容", onSelect: () => {
              if (onSaveGoal && contextMenu.thread.lineage?.entityType === "goal") {
                setGoalEditorMode("edit"); setEditingGoal(contextMenu.thread);
              } else { onEditThread?.(contextMenu.thread); }
            },
          }] : []),
          { id: "detail", label: "查看详情", onSelect: () => setOpenThreadId(contextMenu.thread.id) },
          ...(onSaveGoal && contextMenu.thread.lineage?.entityType === "goal" ? [{
            id: "delete", label: "删除", danger: true, onSelect: () => {
              setGoalEditorMode("delete"); setEditingGoal(contextMenu.thread);
            },
          }] : []),
        ] : []}
      />
      <div className="clue-frame">
        {onSaveGoal && <button className="clue-goal-create" type="button" onClick={() => { setGoalEditorMode("edit"); setEditingGoal(null); }}>＋ 新增目标</button>}
        <ClueBoardViewport viewportRef={surfaceRef} overlay={<>
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
                {typedGoalThemes ? "当前方向 → 目标" : "当前主题 → 线索"}
              </span>
              <strong>{editingConnection.title}</strong>
              <p>这根线只整理当前桌面，不会改变原始关系。</p>
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
</>}>
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
            title="回常用区"
          >
            <Pin tone="plain" />
            <span className="clue-thesis-number">
              {typedGoalThemes ? "当前方向" : projection.runtimeStatus === "demo" ? "当前主题" : "当前焦点"}
            </span>
            <strong>{projection.clueBoard?.title ?? projection.header.title}</strong>
            <span className="clue-thesis-copy">{projection.clueBoard?.subtitle ?? projection.header.subtitle}</span>
            {onOpenThesis && <span className="clue-thesis-home">回常用区 →</span>}
          </button>

          {threads.map((thread, index) => (
            <ThreadPaper
              key={thread.id}
              thread={thread}
              index={index}
              position={positionFor(thread, index)}
              selected={openThreadId === thread.id || selectedThreadId === thread.id}
              dragging={draggingId === thread.id}
              dragHandlers={paperDrag(
                thread.id,
                THREAD_SLOTS[index] ?? { x: index % 2 === 0 ? 22 : 78, y: 26 + Math.floor(index / 2) * 36 },
                THREAD_BOUNDS
              )}
              onEnter={handleEnter}
              semanticMode={semanticMode}
              onSettings={(target, anchor) => { setResizingId(null); setContextMenu({ thread: target, anchor }); }}
              resizing={resizingId === thread.id}
              onFinishResize={finishResize}
            />
          ))}

          {threads.length === 0 && (
            <p className="clue-blank">
              {typedGoalThemes
                ? "还没有明确的中期目标。"
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

          <p className="clue-margin-note">
            “{projection.secretary.headline}”
            <span>— {projection.secretary.eyebrow}</span>
          </p>
        </ClueBoardViewport>

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
