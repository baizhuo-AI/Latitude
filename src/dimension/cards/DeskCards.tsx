import { useState } from "react";
import { CardShell } from "./CardShell";
import "./card-interactions.css";
import type {
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
          · 秘书排的
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
            const editable = !done && row.actionable === true && Boolean(lineage) && Boolean(onEdit);
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
                        · 秘书排的
                      </span>
                    )}
                  </span>
                )}
                {done && (
                  <div className="dim-complete-celebration" aria-label="Complete，已完成">
                    <span className="dim-complete-seal">COMPLETE</span>
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
  return (
    <CardShell {...shellProps(card)} paper={card.paper ?? "grid"}>
      <div
        style={{
          marginTop: 16,
          display: "flex",
          alignItems: "flex-end",
          gap: 4,
          height: 50
        }}
      >
        {card.bars.map((h, i) => (
          <span
            key={i}
            style={{
              flex: 1,
              // 最矮也留 6%,否则空时段整根消失、读不出时间轴
              height: `${Math.max(6, Math.min(100, h * 100))}%`,
              // 高值用实色,低值退一档 —— 柱子本身就带出忙闲节奏
              background: h >= 0.8 ? "#5aa8ae" : h >= 0.4 ? "#6cb2b6" : "#8cc3c6"
            }}
          />
        ))}
      </div>
      {card.link && (
        <button
          type="button"
          className="dim-btn dim-btn--quiet"
          style={{ marginTop: 12, padding: "2px 0", color: "var(--dim-olive)" }}
        >
          {card.link} →
        </button>
      )}
    </CardShell>
  );
}

/* ---------- 纯文字 ---------- */

export function TextCardView({ card }: { card: TextCard }) {
  return (
    <CardShell {...shellProps(card)}>
      <p className="dim-body" style={{ marginTop: 11 }}>
        {card.body}
      </p>
      {card.link && (
        <button
          type="button"
          className="dim-btn dim-btn--quiet"
          style={{ marginTop: 12, padding: "2px 0", color: "var(--dim-olive)" }}
        >
          {card.link} →
        </button>
      )}
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
  return (
    <CardShell {...shellProps(card)} paper={card.paper ?? "sticky"}>
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
      {card.verdicts && card.verdicts.length > 0 ? (
        /* 裁决不是一个「接受」按钮（PRD §4.2）：五种回应各有合法结果 */
        <div
          style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}
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
        <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
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
