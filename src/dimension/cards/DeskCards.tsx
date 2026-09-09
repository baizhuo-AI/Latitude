import { useContext, useState } from "react";
import { CardReadingContext, CardShell } from "./CardShell";
import "./card-interactions.css";
import type {
  ActivityCard,
  ActivityEntry,
  AnchorCard,
  AnchorRow,
  CardAccent,
  ChartCard,
  CountCard,
  LineageRef,
  NoteCard,
  ProgressCard,
  ProposalCard,
  ProposalVerdict,
  TextCard
} from "../types";

/**
 * 七种扫读卡。
 *
 * 它们都很短 —— 这是刻意的:除了认知卡,桌面上其他纸片都应该「扫一眼就过」。
 * 一张需要停下来读的卡已经是极限,再多用户会开始跳过整张桌面。
 *
 * 每种卡只写内容,纸质 / 倾斜 / 点缀 / 标题全部交给 CardShell。
 */

const ACCENT: Record<CardAccent, string> = {
  olive: "var(--dim-olive)",
  rust: "var(--dim-rust)",
  amber: "var(--dim-amber)",
  teal: "var(--dim-teal)"
};

/** 浏览器双击会先派发两次 click；有副作用的按钮只接受第一次或键盘激活。 */
const isFirstActivation = (detail: number) => detail <= 1;

/** 把 CardBase 的外壳字段一次性摊给 CardShell,免得每种卡抄一遍 */
function shellProps(card: {
  eyebrow: string;
  title: string;
  tilt?: number;
  paper?: "plain" | "sticky" | "grid" | "newsprint";
  offsetY?: number;
  tape?: AnchorCard["tape"];
  clip?: boolean;
  dogear?: boolean;
}) {
  return {
    eyebrow: card.eyebrow,
    title: card.title,
    tilt: card.tilt,
    paper: card.paper,
    offsetY: card.offsetY,
    tape: card.tape,
    clip: card.clip,
    dogear: card.dogear
  };
}

/* ---------- 今天做过 ---------- */

function ActivityRowView({
  entry,
  onEdit,
  onRetract,
  onLineage
}: {
  entry: ActivityEntry;
  onEdit?: (entry: ActivityEntry, nextText: string) => void | Promise<void>;
  onRetract?: (entry: ActivityEntry) => void | Promise<void>;
  onLineage?: (lineage: LineageRef) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [busy, setBusy] = useState(false);

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === entry.text || !onEdit) {
      setDraft(entry.text);
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onEdit(entry, next);
      setEditing(false);
    } catch {
      // 接线方负责给出具体失败提示；保留输入让用户可以重试。
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="dim-activity-row">
      <span className="dim-activity-dot" aria-hidden="true" />
      <div className="dim-activity-main">
        {editing ? (
          <input
            className="dim-anchor-edit"
            value={draft}
            autoFocus
            disabled={busy}
            aria-label={`编辑做过的事：${entry.text}`}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.target.select()}
            onKeyDown={(event) => {
              if (event.key === "Enter") void commit();
              if (event.key === "Escape") {
                setDraft(entry.text);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="dim-activity-text">{entry.text}</span>
        )}
        <span className="dim-activity-meta">
          {entry.timeLabel} · 你记下的
        </span>
      </div>
      <div className="dim-activity-actions">
        {editing ? (
          <button type="button" className="dim-btn dim-btn--quiet" disabled={busy} onClick={() => void commit()}>
            {busy ? "保存中" : "保存"}
          </button>
        ) : (
          <button
            type="button"
            className="dim-btn dim-btn--quiet"
            disabled={!onEdit}
            aria-label={`修改：${entry.text}`}
            onClick={() => {
              setDraft(entry.text);
              setEditing(true);
            }}
          >
            修改
          </button>
        )}
        <button
          type="button"
          className="dim-btn dim-btn--quiet"
          disabled={busy || !onRetract}
          aria-label={`撤下：${entry.text}`}
          onClick={async () => {
            if (!onRetract) return;
            setBusy(true);
            try {
              await onRetract(entry);
            } catch {
              // 接线方负责给出具体失败提示；原记录保持可见。
            } finally {
              setBusy(false);
            }
          }}
        >
          撤下
        </button>
        <button
          type="button"
          className="dim-btn dim-btn--quiet"
          disabled={!onLineage}
          aria-label={`查看来源：${entry.lineage.label}`}
          onClick={() => onLineage?.(entry.lineage)}
        >
          来源
        </button>
      </div>
    </li>
  );
}

export function ActivityCardView({
  card,
  onCapture,
  onEdit,
  onRetract,
  onReflect,
  onLineage
}: {
  card: ActivityCard;
  onCapture?: (text: string) => void | Promise<void>;
  onEdit?: (entry: ActivityEntry, nextText: string) => void | Promise<void>;
  onRetract?: (entry: ActivityEntry) => void | Promise<void>;
  onReflect?: () => void;
  onLineage?: (lineage: LineageRef) => void;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const readyToSubmit = card.canCapture && Boolean(onCapture) && Boolean(draft.trim()) && !submitting;

  return (
    <CardShell {...shellProps(card)}
      headerContent={<>
        <p className="dim-activity-intro">这里只记已经发生的事，不是待办。</p>
        <form
          className="dim-activity-capture"
          onSubmit={async (event) => {
            event.preventDefault();
            const text = draft.trim();
            if (!text || !onCapture || !card.canCapture) return;
            setSubmitting(true);
            try {
              await onCapture(text);
              setDraft("");
            } catch {
              // 接线方负责给出具体失败提示；保留输入让用户可以重试。
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <input
            className="dim-input dim-activity-input"
            value={draft}
            disabled={!card.canCapture || submitting}
            aria-label="记下一件已经做过的事"
            placeholder={card.capturePlaceholder}
            title={!card.canCapture ? card.captureUnavailableReason : undefined}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="submit"
            className="dim-btn dim-btn--accent"
            disabled={!readyToSubmit}
            aria-disabled={!readyToSubmit}
          >
            {submitting ? "记下中…" : "记下"}
          </button>
        </form>
      </>}
      footer={<div className="dim-activity-reflect">
        <span className="dim-meta">
          {card.entries.length < 2 ? "记下两件后，就可以一起看今天。" : "观察会标成待确认，不会直接变成结论。"}
        </span>
        <button
          type="button"
          className="dim-btn"
          disabled={!card.canReflect || card.entries.length < 2 || !onReflect}
          aria-disabled={!card.canReflect || card.entries.length < 2 || !onReflect}
          title={!card.canReflect ? card.reflectUnavailableReason : undefined}
          onClick={onReflect}
        >
          帮我看看今天
        </button>
      </div>}
    >
      {card.entries.length > 0 ? (
        <ol className="dim-activity-list">
          {card.entries.map((entry) => (
            <ActivityRowView
              key={entry.id}
              entry={entry}
              onEdit={onEdit}
              onRetract={onRetract}
              onLineage={onLineage}
            />
          ))}
        </ol>
      ) : (
        <p className="dim-body dim-activity-empty">{card.emptyHint}</p>
      )}
    </CardShell>
  );
}

/* ---------- ◇ 锚点列表 ---------- */

/**
 * 行内编辑的一行锚点文字。Enter / 失焦提交，Escape 取消。
 * 编辑是桌面承诺的一部分：纸面上的字能改，且写回真实记录。
 */
function EditableAnchorText({
  row,
  done,
  onEdit
}: {
  row: AnchorRow;
  done: boolean;
  onEdit: (row: AnchorRow, nextText: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.text);

  if (editing) {
    return (
      <input
        className="dim-anchor-edit"
        value={draft}
        autoFocus
        aria-label={`编辑：${row.text}`}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            const next = draft.trim();
            setEditing(false);
            if (next && next !== row.text) onEdit(row, next);
          } else if (event.key === "Escape") {
            setDraft(row.text);
            setEditing(false);
          }
        }}
        onBlur={() => {
          const next = draft.trim();
          setEditing(false);
          if (next && next !== row.text) onEdit(row, next);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="dim-anchor-text"
      title="点一下改名"
      aria-label={`编辑：${row.text}`}
      onClick={() => {
        setDraft(row.text);
        setEditing(true);
      }}
      style={{
        color: done ? "var(--dim-ink-soft)" : "var(--dim-ink)",
        textDecoration: done ? "line-through" : undefined,
        textDecorationColor: "var(--dim-line)"
      }}
    >
      {row.text}
      {/* 秘书推测与用户记录必须可分辨（PRD §2.2），用日常语言标注 */}
      {row.epistemic === "inferred" && (
        <span
          className="dim-meta"
          style={{ marginLeft: 6, color: "var(--dim-olive)" }}
        >
          · 建议
        </span>
      )}
    </button>
  );
}

export function AnchorsCardView({
  card,
  onLineage,
  onComplete,
  onEdit
}: {
  card: AnchorCard;
  onLineage?: (lineage: LineageRef) => void;
  onComplete?: (row: AnchorRow) => void;
  onEdit?: (row: AnchorRow, nextText: string) => void;
}) {
  const reading = useContext(CardReadingContext);
  return (
    <CardShell {...shellProps(card)}>
      <div style={{ marginTop: 14, position: "relative" }}>
        {/* 空列表要说话。网格是等高的,不给文案就是一个空盒子,读起来像加载失败 */}
        {card.rows.length === 0 && (
          <p className="dim-body">{card.emptyHint ?? "今天这里是空的。"}</p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {card.rows.map((row, i) => {
            // 最后一行常是「今天到期」,用暗红标出来
            const urgent = row.meta === "TODAY";
            const lineage = row.lineage;
            const done = row.done === true;
            // 只有带来源的可行动行能改名：汇总行 / 折叠行没有可写回的实体
            const editable = !reading && !done && row.actionable === true && Boolean(lineage) && Boolean(onEdit);
            return (
              <div
                key={i}
                className={`dim-anchor-row${done ? " is-done" : ""}`}
                data-dimmed={row.dimmed === true || undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  opacity: row.dimmed ? 0.32 : undefined,
                  filter: row.dimmed ? "saturate(0.6)" : undefined,
                  transition: "opacity 0.3s ease, filter 0.3s ease"
                }}
              >
                <span
                  className="dim-diamond"
                  style={urgent ? { borderColor: ACCENT.rust } : undefined}
                  aria-hidden="true"
                />
                {editable ? (
                  <EditableAnchorText row={row} done={done} onEdit={onEdit!} />
                ) : (
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12.5,
                      lineHeight: 1.5,
                      color: done ? "var(--dim-ink-soft)" : "var(--dim-ink)",
                      textDecoration: done ? "line-through" : undefined,
                      textDecorationColor: "var(--dim-line)"
                    }}
                  >
                    {row.text}
                    {row.epistemic === "inferred" && (
                      <span
                        className="dim-meta"
                        style={{ marginLeft: 6, color: "var(--dim-olive)" }}
                      >
                        · 建议
                      </span>
                    )}
                  </span>
                )}
                {done && (
                  <div className="dim-complete-celebration" aria-label="已完成">
                    <span className="dim-complete-seal">完成</span>
                    <span className="dim-complete-treats" aria-hidden="true">
                      ✿ <i /> ✦
                    </span>
                  </div>
                )}
                {!done && row.actionable && (
                  <button
                    type="button"
                    className="dim-btn dim-btn--quiet"
                    style={{
                      flexShrink: 0,
                      padding: "2px 6px",
                      color: "var(--dim-olive)",
                      fontSize: 10
                    }}
                    aria-label={`完成：${row.text}`}
                    aria-disabled={!onComplete}
                    disabled={!onComplete}
                    title={onComplete ? undefined : "结果回收已在组件设置中关闭"}
                    onClick={(event) => {
                      if (isFirstActivation(event.detail)) onComplete?.(row);
                    }}
                  >
                    完成
                  </button>
                )}
                {lineage && (
                  <button
                    type="button"
                    className="dim-btn dim-btn--quiet"
                    style={{
                      flexShrink: 0,
                      padding: "2px 4px",
                      color: "var(--dim-olive)",
                      fontSize: 9
                    }}
                    aria-label={`查看来源：${lineage.label}`}
                    aria-disabled={!onLineage}
                    disabled={!onLineage}
                    title={onLineage ? undefined : "查看来源已在组件设置中关闭"}
                    onClick={(event) => {
                      if (isFirstActivation(event.detail)) onLineage?.(lineage);
                    }}
                  >
                    ◇ 来源
                  </button>
                )}
                <span
                  className="dim-meta"
                  style={{
                    flexShrink: 0,
                    color: urgent ? ACCENT.rust : undefined
                  }}
                >
                  {row.meta}
                </span>
              </div>
            );
          })}
        </div>

        {card.arc && <span className="dim-arc" aria-hidden="true" />}
      </div>
    </CardShell>
  );
}

/* ---------- 大数字 ---------- */

export function CountCardView({ card }: { card: CountCard }) {
  return (
    <CardShell {...shellProps(card)}>
      <div
        style={{
          marginTop: 14,
          display: "flex",
          alignItems: "baseline",
          gap: 8
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 32,
            lineHeight: 1,
            fontWeight: 500,
            color: "var(--dim-ink)",
            fontVariantNumeric: "tabular-nums"
          }}
        >
          {card.count}
        </span>
        <span className="dim-meta">{card.unit}</span>
      </div>
      <p className="dim-body" style={{ marginTop: 10 }}>
        {card.body}
      </p>
    </CardShell>
  );
}

/* ---------- 便签 ---------- */

export function NoteCardView({ card }: { card: NoteCard }) {
  return (
    <CardShell {...shellProps(card)} paper={card.paper ?? "sticky"}>
      <p className="dim-body" style={{ marginTop: 12 }}>
        {card.body}
      </p>
      {/* 重点句用手写体:便签上本来就是随手写的 */}
      <p
        className="dim-hand"
        style={{ margin: "12px 0 0", fontSize: 17, lineHeight: 1.35 }}
      >
        {card.quote}
      </p>
    </CardShell>
  );
}

/* ---------- 柱状图 ---------- */

export function ChartCardView({ card }: { card: ChartCard }) {
  const hasData = card.bars.length > 0;
  return (
    <CardShell {...shellProps(card)} paper={card.paper ?? "grid"}
      footer={hasData && card.link ? <button type="button" className="dim-btn dim-btn--quiet dim-chart-link">
        {card.link} →
      </button> : undefined}>
      <div className={`dim-chart-card${hasData ? "" : " dim-chart-card--empty"}`}>
        {hasData ? (
          <>
            <div className="dim-chart-bars" role="img" aria-label={`${card.bars.length} 个行动回看时段`}>
              {card.bars.map((height, index) => {
                const value = Math.max(0, Math.min(1, height));
                return (
                  <span
                    key={index}
                    data-chart-value={value}
                    style={{
                      height: `${value * 100}%`,
                      background: value >= 0.8 ? "#5aa8ae" : value >= 0.4 ? "#6cb2b6" : "#8cc3c6"
                    }}
                  />
                );
              })}
            </div>
          </>
        ) : (
          <p className="dim-chart-empty">{card.emptyHint ?? "还没有可展示的行动回看安排。"}</p>
        )}
      </div>
    </CardShell>
  );
}

/* ---------- 纯文字 ---------- */

export function TextCardView({ card }: { card: TextCard }) {
  return (
    <CardShell {...shellProps(card)}
      footer={card.link ? <button type="button" className="dim-btn dim-btn--quiet dim-text-card-link">
        {card.link} →
      </button> : undefined}>
      <p className="dim-body" style={{ marginTop: 11 }}>
        {card.body}
      </p>
    </CardShell>
  );
}

/* ---------- 提案 ---------- */

/**
 * 唯一需要用户回应的卡片,对应重构计划的 Proposal / Change Set。
 * 便签黄 + 两个动作键,视觉上必须和信息卡拉开距离 ——
 * 用户误以为它是普通信息卡而略过,等于闸门失效。
 */
export function ProposalCardView({
  card,
  onAccept,
  onReject,
  onVerdict
}: {
  card: ProposalCard;
  onAccept?: () => void;
  onReject?: () => void;
  onVerdict?: (verdict: ProposalVerdict) => void;
}) {
  const actions = card.verdicts && card.verdicts.length > 0 ? (
    /* 裁决不是一个「接受」按钮（PRD §4.2）：五种回应各有合法结果 */
    <div
      className="dim-card-footer-actions"
    >
      {card.verdicts.map((verdict) => (
        <button
          key={verdict.id}
          type="button"
          className={
            verdict.id === "try" || verdict.id === "holds"
              ? "dim-btn dim-btn--accent"
              : "dim-btn"
          }
          onClick={(event) => {
            if (isFirstActivation(event.detail)) onVerdict?.(verdict);
          }}
        >
          {verdict.label}
        </button>
      ))}
    </div>
  ) : (
    <div className="dim-card-footer-actions">
      <button
        type="button"
        className="dim-btn dim-btn--accent"
        onClick={(event) => {
          if (isFirstActivation(event.detail)) onAccept?.();
        }}
      >
        {card.accept}
      </button>
      <button
        type="button"
        className="dim-btn"
        onClick={(event) => {
          if (isFirstActivation(event.detail)) onReject?.();
        }}
      >
        {card.reject}
      </button>
    </div>
  );

  return (
    <CardShell {...shellProps(card)} paper={card.paper ?? "sticky"} footer={actions}>
      <p
        style={{
          margin: "12px 0 0",
          padding: "9px 12px",
          background: "rgb(124 138 62 / 8%)",
          borderLeft: "2px solid var(--dim-olive)",
          fontSize: 12,
          lineHeight: 1.6,
          color: "var(--dim-ink)"
        }}
      >
        {card.quote}
      </p>
      {/* 接受前必须知道会改变什么（PRD §2.2「要不要这样做」） */}
      {card.consequence && (
        <p className="dim-body" style={{ marginTop: 10, color: "var(--dim-ink-soft)" }}>
          {card.consequence}
        </p>
      )}
    </CardShell>
  );
}

/* ---------- 进度 ---------- */

export function ProgressCardView({ card }: { card: ProgressCard }) {
  return (
    <CardShell {...shellProps(card)}>
      <p className="dim-body" style={{ marginTop: 11 }}>
        {card.body}
      </p>
      {typeof card.percent === "number" && (
        <div
          className="dim-meter"
          style={{ marginTop: 16 }}
          role="progressbar"
          aria-label={card.leftMeta}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.max(0, Math.min(100, card.percent))}
        >
          <i style={{ width: `${Math.max(0, Math.min(100, card.percent))}%` }} />
        </div>
      )}
      <div
        style={{
          marginTop: 8,
          display: "flex",
          justifyContent: "flex-start",
          gap: 12
        }}
      >
        <span className="dim-meta">{card.leftMeta}</span>
      </div>
    </CardShell>
  );
}
