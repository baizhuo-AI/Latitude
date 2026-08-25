import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { DesktopProjection } from "../../projections/desktop/types";
import { runtimeStatusLabel } from "../../projections/desktop/types";
import type { LineageRef } from "../types";
import "./constellation.css";

export type ConstellationNodeKind =
  | "focus"
  | "cognition"
  | "big-idea";

export interface ConstellationNode {
  id: string;
  kind: ConstellationNodeKind;
  label: string;
  meta: string;
  detail: string;
  x: number;
  y: number;
  size: number;
  color: string;
  labelSide?: "left" | "right" | "top" | "bottom";
  lineage?: LineageRef;
  feedItemId?: string;
  done?: boolean;
  domainNodeId?: string;
  orbitCenterId?: string;
  orbitRelation?: string;
}

export type ConstellationAction =
  | "select"
  | "open"
  | "lineage";

export interface ConstellationPresetProps {
  projection: DesktopProjection;
  onNodeSelect?: (node: ConstellationNode) => void;
  onNodeOpen?: (node: ConstellationNode) => void;
  onLineage?: (lineage: LineageRef) => void;
  onAction?: (action: ConstellationAction, node: ConstellationNode) => void;
}

type StarStyle = CSSProperties & {
  "--cst-x": string;
  "--cst-y": string;
  "--cst-size": string;
  "--cst-color": string;
  /** 汇聚进场：视线外初始位相对落点的位移（vw / vh），沿向径指向视野外 */
  "--gx": string;
  "--gy": string;
};

/** 北极星在正北高处；执行记录与阶段目标不进入这片天空。 */
const NORTH = { x: 50, y: 15 };

/** 汇聚进场的视点中心（天空构图的视觉重心，略高于几何中心）。 */
const GATHER_CENTER = { x: 50, y: 42 };
/** 主星位移系数：落点越靠边，起点越在视线外；再叠加 14 的基础外推，连中心星也赶路。 */
const STAR_GATHER_PUSH = 1.5;
const STAR_GATHER_BASE = 14;
/** 星尘更远更快：它们是前景的「流星群」，位移与失焦都比主星大一号。 */
const DUST_GATHER_PUSH = 1.9;
const DUST_GATHER_BASE = 22;

/** 沿「视点 → 落点」向径把起点推出视野；正好在重心上的点向正上方退场。 */
function gatherOffset(x: number, y: number, push: number, base: number): { gx: number; gy: number } {
  const dx = x - GATHER_CENTER.x;
  const dy = y - GATHER_CENTER.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    gx: dx * push + (dx / len) * base,
    gy: dy * push + (dy / len) * base
  };
}

const COGNITION_SLOTS = [
  { x: 16, y: 25, side: "left" },
  { x: 84, y: 23, side: "right" },
  { x: 10, y: 43, side: "left" },
  { x: 90, y: 41, side: "right" },
  { x: 20, y: 60, side: "left" },
  { x: 80, y: 59, side: "right" },
  { x: 31, y: 75, side: "bottom" },
  { x: 69, y: 74, side: "bottom" },
  { x: 37, y: 39, side: "top" },
  { x: 63, y: 44, side: "bottom" }
] as const;

function buildNodes(projection: DesktopProjection): ConstellationNode[] {
  const northStar = projection.constellation?.northStar;
  const northStarStatus = northStar?.status ?? (northStar ? "single" : "empty");
  const northStarMeta = {
    single: "LONG HORIZON · YOUR GOAL",
    multiple: "LONG HORIZON · MULTIPLE GOALS",
    demo: "NORTH STAR · DEMO",
    loading: "LONG HORIZON · READING",
    unavailable: "LONG HORIZON · UNAVAILABLE",
    empty: "LONG HORIZON · NOT SET"
  }[northStarStatus];
  const nodes: ConstellationNode[] = [
    {
      id: "focus",
      kind: "focus",
      label: northStar?.title ?? "还没有设定长期方向",
      meta: northStarMeta,
      detail:
        northStar?.detail ??
        "这里会显示你明确记录的长期目标；没有目标时保持留白。",
      x: NORTH.x,
      y: NORTH.y,
      size: 38,
      color:
        northStarStatus === "empty" ||
        northStarStatus === "loading" ||
        northStarStatus === "unavailable"
          ? "#9aa0ad"
          : "#ffe9bd",
      lineage: northStar?.lineage,
      domainNodeId: northStar?.lineage?.entityId,
      labelSide: "bottom"
    }
  ];

  projection.constellation?.cognitions.slice(0, COGNITION_SLOTS.length).forEach(
    (cognition, index) => {
      const slot = COGNITION_SLOTS[index];
      nodes.push({
        id: `cognition-${cognition.id}`,
        kind: cognition.role === "big-idea" ? "big-idea" : "cognition",
        label: cognition.label,
        meta: cognition.starState
          ? `STARSTATE V${cognition.starState.version} · ${cognition.starState.role}`
          : cognition.role === "big-idea"
            ? cognition.epistemic === "confirmed"
              ? "大想法 · 你已确认"
              : "大想法 · 待现实检验"
            : cognition.epistemic === "confirmed"
              ? "认知评价 · 你已确认"
              : cognition.epistemic === "recorded"
                ? "认知评价 · 来自你的记录"
                : "认知评价 · 待你确认",
        detail: [
          cognition.detail,
          cognition.starState
            ? [
                `真实星态：重要性 ${cognition.starState.importance}`,
                cognition.starState.importanceAuthority
                  ? `重要性权限 ${cognition.starState.importanceAuthority}`
                  : "",
                `活跃度 ${cognition.starState.salience}`,
                cognition.starState.organizingPower
                  ? `组织力 ${cognition.starState.organizingPower}`
                  : "",
                `新鲜度 ${cognition.starState.freshness}`,
                cognition.starState.mass ? `证据质量 ${cognition.starState.mass}` : "",
                cognition.starState.radius ? `作用半径 ${cognition.starState.radius}` : "",
                cognition.starState.auraVersion !== undefined
                  ? `Aura v${cognition.starState.auraVersion}`
                  : "",
                cognition.starState.recomputeRequired ? "等待重算" : "",
              ].filter(Boolean).join("，") + "。"
            : "",
          cognition.orbit
            ? `正式轨道：${cognition.orbit.relationType} → ${cognition.orbit.centerLabel}${cognition.orbit.proximity ? `，距离 ${cognition.orbit.proximity}` : ""}${cognition.orbit.strength ? `，强度 ${cognition.orbit.strength}` : ""}。`
            : "",
        ].filter(Boolean).join(" "),
        x: slot.x,
        y: slot.y,
        size: cognition.starState
          ? { low: 7, medium: 9, high: 12 }[cognition.starState.importance] ?? 8
          : 7,
        color: cognition.starState
          ? { quiet: "#89a9bb", active: "#9fc7d8", hot: "#ffe1a3" }[
              cognition.starState.salience
            ] ?? "#9fc7d8"
          : cognition.role === "big-idea" ? "#f0c985" : "#9fc7d8",
        lineage: cognition.lineage,
        domainNodeId: cognition.id,
        orbitCenterId: cognition.orbit?.centerNodeId,
        orbitRelation: cognition.orbit?.relationType,
        labelSide: slot.side
      });
    }
  );

  return nodes;
}

const DUST = Array.from({ length: 232 }, (_, index) => {
  const x = (index * 47 + (index % 7) * 11 + 5) % 101;
  const y = (index * 67 + (index % 11) * 7 + 3) % 97;
  const gather = gatherOffset(x, y, DUST_GATHER_PUSH, DUST_GATHER_BASE);
  return {
    id: `dust-${index}`,
    x,
    y,
    size: index % 29 === 0 ? 2.8 : index % 11 === 0 ? 1.9 : index % 4 === 0 ? 1.25 : 0.72,
    opacity: 0.24 + ((index * 17) % 68) / 100,
    delay: (index * 0.43) % 7,
    bright: index % 19 === 0,
    depth: index % 3,
    gx: gather.gx,
    gy: gather.gy
  };
});

export function ConstellationPreset({
  projection,
  onNodeSelect,
  onNodeOpen,
  onLineage,
  onAction
}: ConstellationPresetProps) {
  const nodes = useMemo(() => buildNodes(projection), [projection]);
  const orbitSegments = useMemo(() => {
    const byDomainId = new Map(
      nodes.flatMap((node) => node.domainNodeId ? [[node.domainNodeId, node] as const] : [])
    );
    return nodes.flatMap((node) => {
      if (!node.orbitCenterId || !node.orbitRelation) return [];
      const center = byDomainId.get(node.orbitCenterId);
      return center ? [{ from: node, to: center, relation: node.orbitRelation }] : [];
    });
  }, [nodes]);
  const progress = projection.constellation?.progress;
  const [selectedId, setSelectedId] = useState("focus");
  const selected = nodes.find((node) => node.id === selectedId) ?? nodes[0];

  const percent = Math.max(0, Math.min(100, progress?.percent ?? 0));
  // 北极星外圈的进度环：R=34（相对 100x100 视野）的周长 2πr
  const RING_R = 34;
  const ringLength = 2 * Math.PI * RING_R;

  const selectNode = (node: ConstellationNode) => {
    setSelectedId(node.id);
    onNodeSelect?.(node);
    onAction?.("select", node);
  };

  return (
    <main className="cst-root">
      <div className="cst-dust" aria-hidden="true">
        {DUST.map((dust) => (
          <i
            key={dust.id}
            className={`cst-dust-point cst-dust-depth-${dust.depth}${
              dust.bright ? " is-bright" : ""
            }`}
            style={
              {
                left: `${dust.x}%`,
                top: `${dust.y}%`,
                width: dust.size,
                height: dust.size,
                opacity: dust.opacity,
                // 闪烁与汇聚是两条时间轴：闪烁的相位偏移植进变量，
                // 汇聚时由 deck.css 按 --gather-delay 错峰，互不覆盖
                "--twinkle-delay": `${dust.delay}s`,
                "--gather-delay": `${0.16 + dust.depth * 0.1}s`,
                "--gx": `${dust.gx}vw`,
                "--gy": `${dust.gy}vh`
              } as CSSProperties
            }
          />
        ))}
      </div>

      <header className="cst-header">
        <div>
          <p className="cst-kicker">LATITUDE · NIGHT SKY</p>
          <h1>此刻星图</h1>
        </div>
        <span className="cst-status">{runtimeStatusLabel(projection.runtimeStatus)}</span>
      </header>

      <section
        className="cst-sky"
        aria-label="夜空：北极星、认知评价与大想法"
      >
        {orbitSegments.length > 0 && (
          <svg
            className="cst-orbit-svg"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {orbitSegments.map((segment) => (
              <line
                key={`${segment.from.id}:${segment.to.id}:${segment.relation}`}
                x1={segment.from.x}
                y1={segment.from.y}
                x2={segment.to.x}
                y2={segment.to.y}
                data-relation={segment.relation}
              />
            ))}
          </svg>
        )}
        {/* 北极星 + 进度环 */}
        {progress && (
          <svg
            className="cst-ring-svg"
            viewBox="0 0 100 100"
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
          >
            <circle
              className="cst-ring-bg"
              cx={NORTH.x}
              cy={NORTH.y}
              r={RING_R / 4}
            />
            <circle
              className="cst-ring-fg"
              cx={NORTH.x}
              cy={NORTH.y}
              r={RING_R / 4}
              strokeDasharray={`${(percent / 100) * (ringLength / 4)} ${ringLength / 4}`}
            />
          </svg>
        )}

        {nodes.map((node) => {
          const active = node.id === selected.id;
          const gather = gatherOffset(node.x, node.y, STAR_GATHER_PUSH, STAR_GATHER_BASE);
          const style: StarStyle = {
            "--cst-x": `${node.x}%`,
            "--cst-y": `${node.y}%`,
            "--cst-size": `${node.size}px`,
            "--cst-color": node.color,
            "--gx": `${gather.gx}vw`,
            "--gy": `${gather.gy}vh`
          };
          return (
            <button
              key={node.id}
              type="button"
              className={`cst-star cst-star-${node.kind}${active ? " is-active" : ""}${
                node.done ? " is-done" : ""
              }`}
              style={style}
              onClick={() => selectNode(node)}
              aria-pressed={active}
              aria-label={
                node.kind === "focus"
                  ? `北极星 · 长期方向：${node.label}`
                  : node.kind === "cognition"
                    ? `认知星：${node.label}（${node.meta}）`
                    : node.kind === "big-idea"
                      ? `大想法：${node.label}（${node.meta}）`
                      : `${node.label}（${node.meta}）`
              }
            >
              {node.kind === "focus" && (
                <span className="cst-north-sparkle" aria-hidden="true" />
              )}
              <span className="cst-star-core" aria-hidden="true" />
              <span className="cst-star-label">
                <small>{node.meta}</small>
                <strong>{node.label}</strong>
              </span>
            </button>
          );
        })}

        {/* 地平线 */}
        <div className="cst-horizon" aria-hidden="true" />

        <p className="cst-sky-note">
          {orbitSegments.length > 0
            ? `${orbitSegments.length} 条来自 Domain 的正式轨道`
            : "这里只放北极星、认知评价与大想法"}
        </p>
      </section>

      {/* 观测只留一行 Caption：这层的职责是仰望，不是阅读 */}
      <footer className="cst-caption" aria-live="polite">
        <span className="cst-caption-kind">
          {selected.kind === "focus"
            ? "北极星"
            : selected.kind === "cognition"
              ? "认知评价"
              : selected.kind === "big-idea"
                ? "大想法"
                : "认知星"}
        </span>
        <strong>{selected.label}</strong>
        <span className="cst-caption-detail">{selected.detail}</span>
        {selected.kind === "focus" && progress && (
          <span className="cst-caption-progress">{progress.label} · {percent}%</span>
        )}
        {selected.lineage && (
          <button
            type="button"
            className="cst-caption-lineage"
            onClick={() => {
              onLineage?.(selected.lineage!);
              onAction?.("lineage", selected);
            }}
          >
            ◇ {selected.lineage.label}
          </button>
        )}
        {selected.kind === "focus" && onNodeOpen && (
          <button
            type="button"
            className="cst-caption-lineage"
            onClick={() => {
              onNodeOpen(selected);
              onAction?.("open", selected);
            }}
          >
            靠近看看 ↗
          </button>
        )}
        <span className="cst-caption-date">{projection.generatedAt.slice(0, 10)}</span>
      </footer>
    </main>
  );
}
