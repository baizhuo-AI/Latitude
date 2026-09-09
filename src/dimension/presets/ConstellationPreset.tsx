import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { DesktopProjection } from "../../projections/desktop/types";
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
  | "lineage"
  | "discuss";

export interface ConstellationPresetProps {
  projection: DesktopProjection;
  onNodeSelect?: (node: ConstellationNode) => void;
  onNodeOpen?: (node: ConstellationNode) => void;
  onDiscussNode?: (node: ConstellationNode) => void;
  onLineage?: (lineage: LineageRef) => void;
  onAction?: (action: ConstellationAction, node: ConstellationNode) => void;
}

type StarStyle = CSSProperties & {
  "--cst-x": string;
  "--cst-y": string;
  "--cst-size": string;
  "--cst-color": string;
  "--gx": string;
  "--gy": string;
  "--gather-delay": string;
  "--star-twinkle-delay": string;
};

/** 北极星在正北高处；执行记录与阶段目标不进入这片天空。 */
const NORTH = { x: 50, y: 15 };

/** Restore radial star travel while retaining the current star data and dust count. */
function gatherOffset(x: number, y: number, push: number, base: number) {
  const dx = x - 50;
  const dy = y - 42;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { gx: 0, gy: -base };
  return { gx: dx * push + dx / length * base, gy: dy * push + dy / length * base };
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
    single: "长期方向",
    multiple: "多个长期方向",
    demo: "长期方向 · 演示",
    loading: "正在读取",
    unavailable: "暂不可用",
    empty: "未设置"
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
          ? `${cognition.role === "big-idea" ? "大想法" : "认知评价"} · ${
              cognition.starState.role === "proto_star" ? "待你确认" : "已记录"
            }`
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
            ? cognition.starState.recomputeRequired
              ? "正在根据近期记录更新。"
              : "已根据近期记录更新。"
            : "",
          cognition.orbit
            ? `与「${cognition.orbit.centerLabel}」有已确认的关联。`
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

const DUST = Array.from({ length: 84 }, (_, index) => {
  const x = (index * 47 + (index % 7) * 11 + 5) % 101;
  const y = (index * 67 + (index % 11) * 7 + 3) % 97;
  const gather = gatherOffset(x, y, 1.9, 22);
  return {
    gx: gather.gx,
    gy: gather.gy,
    id: `dust-${index}`,
    x,
    y,
    size: index % 29 === 0 ? 2.8 : index % 11 === 0 ? 1.9 : index % 4 === 0 ? 1.25 : 0.72,
    opacity: 0.24 + ((index * 17) % 68) / 100,
    delay: (index * 0.43) % 7,
    bright: index % 19 === 0,
    depth: index % 3
  };
});

export function ConstellationPreset({
  projection,
  onNodeSelect,
  onDiscussNode,
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
                "--dust-opacity": dust.opacity,
                "--twinkle-delay": `${dust.delay}s`,
                "--gather-delay": `${.16 + dust.depth * .1}s`,
                "--gx": `${dust.gx}vw`,
                "--gy": `${dust.gy}vh`
              } as CSSProperties
            }
          />
        ))}
      </div>

      <header className="cst-header">
        <div>
          <h1>此刻星图</h1>
        </div>
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
        {nodes.map((node, index) => {
          const active = node.id === selected.id;
          const gather = gatherOffset(node.x, node.y, 1.5, 14);
          const style: StarStyle = {
            "--cst-x": `${node.x}%`,
            "--cst-y": `${node.y}%`,
            "--cst-size": `${node.size}px`,
            "--cst-color": node.color,
            "--gx": `${gather.gx}vw`,
            "--gy": `${gather.gy}vh`,
            "--gather-delay": `${Math.min(.66, .34 + Math.max(0, index - 1) * .08)}s`,
            "--star-twinkle-delay": `${-index * 0.83}s`
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
              {node.kind === "focus" ? (
                <span className="cst-north-sparkle" aria-hidden="true" />
              ) : (
                <span className="cst-star-core" aria-hidden="true" />
              )}
              <span className="cst-star-label">
                <small>{node.meta}</small>
                <strong>{node.label}</strong>
              </span>
            </button>
          );
        })}

        <p className="cst-sky-note">
          {orbitSegments.length > 0
            ? `${orbitSegments.length} 条已确认的轨道`
            : "这里只放北极星、认知评价与大想法"}
        </p>
      </section>

      {/* 观测只留一行 Caption：这层的职责是仰望，不是阅读 */}
      <footer className="cst-caption" aria-live="polite">
        {(onDiscussNode || onAction) && (
          <button
            type="button"
            className="cst-caption-discuss"
            onClick={() => {
              onDiscussNode?.(selected);
              onAction?.("discuss", selected);
            }}
            title={`聊聊「${selected.label}」`}
          >
            和维度聊聊 <span aria-hidden="true">↗</span>
          </button>
        )}
        <span className="cst-caption-spacer" />
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
        <span className="cst-caption-date">{projection.generatedAt.slice(0, 10)}</span>
      </footer>
    </main>
  );
}
