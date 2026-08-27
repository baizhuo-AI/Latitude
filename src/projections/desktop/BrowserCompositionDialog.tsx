import { useMemo, useState } from "react";
import type { CardPresentation } from "../../dimension/types";
import {
  BROWSER_COMPANION_COMPONENT_ID,
  BROWSER_SYSTEM_COMPONENT_SPECS,
} from "../../runtime/composition/browserProduction";
import type { CompositionRegistry } from "../../runtime/composition/registry";
import type { UiSurfaceDocumentV2 } from "../../runtime/composition/types";
import type { LayoutDocumentV1, LayoutSpan } from "../../runtime/layout/types";
import type {
  BrowserUiCardPatch,
  BrowserUiChangeSet,
  BrowserUiChangeSetDraft,
} from "./browserUiComposition";

const SPANS: LayoutSpan[] = [4, 5, 7, 12];

export function BrowserCompositionDialog({
  layout,
  document,
  registry,
  history,
  onApply,
  onRollback,
  onReset,
  onClose,
}: {
  layout: LayoutDocumentV1<string, CardPresentation>;
  document: UiSurfaceDocumentV2;
  registry: CompositionRegistry;
  history: BrowserUiChangeSet[];
  onApply: (draft: BrowserUiChangeSetDraft) => void;
  onRollback: (id: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const cardsById = useMemo(
    () => new Map(layout.cards.map((card) => [card.id, card])),
    [layout.cards],
  );
  const [order, setOrder] = useState([...layout.arrangement.orderedCardIds]);
  const [patches, setPatches] = useState<Record<string, BrowserUiCardPatch>>(() =>
    Object.fromEntries(
      [
        ...layout.cards.map((card) => [
          card.id,
          {
            hidden: card.hidden === true,
            span: card.span,
            title: card.presentation?.title ?? card.id,
            actions: { ...(document.components.find((component) => component.id === card.id)?.actions ?? {}) },
          },
        ] as const),
        ...[
          BROWSER_COMPANION_COMPONENT_ID,
          ...BROWSER_SYSTEM_COMPONENT_SPECS.map((spec) => spec.id),
        ].map((componentId) => [
          componentId,
          {
            hidden: document.components.find(
              (component) => component.id === componentId,
            )?.visible === false,
            actions: {
              ...(document.components.find(
                (component) => component.id === componentId,
              )?.actions ?? {}),
            },
          },
        ] as const),
      ],
    ),
  );
  const [error, setError] = useState<string | null>(null);

  function updateCard(id: string, patch: BrowserUiCardPatch) {
    setPatches((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }

  function move(id: string, delta: -1 | 1) {
    setOrder((current) => {
      const index = current.indexOf(id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  return (
    <div
      className="dimension-root"
      style={backdropStyle}
      role="dialog"
      aria-modal="true"
      aria-label="桌面设置"
    >
      <section className="dim-paper" style={paperStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <p className="dim-eyebrow">桌面</p>
            <h2 style={{ margin: "5px 0 0", fontSize: 21 }}>桌面设置</h2>
            <p className="dim-body" style={{ marginTop: 7 }}>
              调整卡片的名称、宽度和顺序。
            </p>
          </div>
          <button type="button" className="dim-btn" onClick={onClose}>关闭</button>
        </div>

        <details>
          <summary className="dim-eyebrow">高级设置</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          {(() => {
          const companion = document.components.find(
            (component) => component.id === BROWSER_COMPANION_COMPONENT_ID,
          );
          const definition = companion ? registry.component(companion.type) : undefined;
          const patch = patches[BROWSER_COMPANION_COMPONENT_ID] ?? {};
          if (!companion || !definition) return null;
          return (
            <div className="dim-paper" style={{ padding: "10px", marginTop: 8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div>
                  <p className="dim-eyebrow">SIDEBAR · SECRETARY RAIL</p>
                  <p className="dim-body">左侧秘书栏（可收起，状态与动作仍由同一组件契约管理）</p>
                </div>
                <label className="dim-meta" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <input
                    type="checkbox"
                    aria-label="隐藏秘书栏"
                    checked={patch.hidden === true}
                    onChange={(event) => updateCard(
                      BROWSER_COMPANION_COMPONENT_ID,
                      { hidden: event.target.checked },
                    )}
                  />
                  隐藏
                </label>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                  gap: 8,
                  marginTop: 8,
                }}
              >
                {definition.events.map((event) => (
                  <label key={event} className="dim-meta">
                    {eventLabel(event)}
                    <select
                      aria-label={`秘书栏 ${eventLabel(event)}动作`}
                      value={patch.actions?.[event] ?? ""}
                      onChange={(changeEvent) => updateCard(
                        BROWSER_COMPANION_COMPONENT_ID,
                        {
                          actions: {
                            ...(patch.actions ?? {}),
                            [event]: changeEvent.target.value || null,
                          },
                        },
                      )}
                      style={{ display: "block", width: "100%", marginTop: 4 }}
                    >
                      <option value="">关闭动作</option>
                      {registry.allowedCommands(companion.type, event).map((command) => (
                        <option key={command.id} value={command.id}>
                          {commandLabel(command.id)}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          );
        })()}

        <details>
          <summary className="dim-eyebrow">其他功能</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            {BROWSER_SYSTEM_COMPONENT_SPECS.map((spec) => {
              const component = document.components.find((candidate) => candidate.id === spec.id);
              const definition = component ? registry.component(component.type) : undefined;
              const patch = patches[spec.id] ?? {};
              if (!component || !definition) return null;
              const label = moduleLabel(spec.id);
              return (
                <div key={spec.id} className="dim-paper" style={{ padding: "9px 10px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div>
                      <p className="dim-eyebrow">{spec.slot}</p>
                      <p className="dim-body">{label}</p>
                    </div>
                    <label className="dim-meta" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <input
                        type="checkbox"
                        aria-label={`隐藏${label}`}
                        checked={patch.hidden === true}
                        onChange={(event) => updateCard(spec.id, { hidden: event.target.checked })}
                      />
                      隐藏
                    </label>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                      gap: 8,
                      marginTop: 8,
                    }}
                  >
                    {definition.events.map((event) => (
                      <label key={event} className="dim-meta">
                        {eventLabel(event)}
                        <select
                          aria-label={`${label} ${eventLabel(event)}动作`}
                          value={patch.actions?.[event] ?? ""}
                          onChange={(changeEvent) => updateCard(spec.id, {
                            actions: {
                              ...(patch.actions ?? {}),
                              [event]: changeEvent.target.value || null,
                            },
                          })}
                          style={{ display: "block", width: "100%", marginTop: 4 }}
                        >
                          <option value="">关闭动作</option>
                          {registry.allowedCommands(component.type, event).map((command) => (
                            <option key={command.id} value={command.id}>
                              {commandLabel(command.id)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
          </div>
        </details>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {order.map((id, index) => {
            const card = cardsById.get(id);
            if (!card) return null;
            const patch = patches[id] ?? {};
            const component = document.components.find((candidate) => candidate.id === id);
            const definition = component ? registry.component(component.type) : undefined;
            return (
              <div
                key={id}
                className="dim-paper"
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(130px, 1fr) auto auto auto",
                  alignItems: "center",
                  gap: 8,
                  padding: "9px 10px",
                }}
              >
                <label className="dim-body" style={{ minWidth: 0 }}>
                  <span className="dim-eyebrow">{card.region}</span>
                  <input
                    aria-label={`${card.region} 标题`}
                    className="dim-input"
                    value={patch.title ?? ""}
                    onChange={(event) => updateCard(id, { title: event.target.value })}
                    style={{ display: "block", width: "100%", marginTop: 4 }}
                  />
                </label>
                <label className="dim-meta">
                  宽度
                  <select
                    aria-label={`${card.region} 宽度`}
                    value={patch.span ?? card.span}
                    onChange={(event) => updateCard(id, { span: Number(event.target.value) as LayoutSpan })}
                    style={{ display: "block", marginTop: 4 }}
                  >
                    {SPANS.map((span) => <option key={span} value={span}>{span}/12</option>)}
                  </select>
                </label>
                <label className="dim-meta" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <input
                    type="checkbox"
                    aria-label={`${card.region} 隐藏`}
                    checked={patch.hidden === true}
                    onChange={(event) => updateCard(id, { hidden: event.target.checked })}
                  />
                  隐藏
                </label>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    type="button"
                    className="dim-btn dim-btn--quiet"
                    aria-label={`上移 ${card.region}`}
                    disabled={index === 0}
                    onClick={() => move(id, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="dim-btn dim-btn--quiet"
                    aria-label={`下移 ${card.region}`}
                    disabled={index === order.length - 1}
                    onClick={() => move(id, 1)}
                  >
                    ↓
                  </button>
                </div>
                {component && definition && definition.events.length > 0 && (
                  <details style={{ gridColumn: "1 / -1" }}>
                    <summary className="dim-meta">高级动作</summary>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                        gap: 8,
                        marginTop: 8,
                      }}
                    >
                      {definition.events.map((event) => (
                        <label key={event} className="dim-meta">
                          {eventLabel(event)}
                          <select
                            aria-label={`${card.region} ${eventLabel(event)}动作`}
                            value={patch.actions?.[event] ?? ""}
                            onChange={(changeEvent) =>
                              updateCard(id, {
                                actions: {
                                  ...(patch.actions ?? {}),
                                  [event]: changeEvent.target.value || null,
                                },
                              })
                            }
                            style={{ display: "block", width: "100%", marginTop: 4 }}
                          >
                            <option value="">关闭动作</option>
                            {registry.allowedCommands(component.type, event).map((command) => (
                              <option key={command.id} value={command.id}>
                                {commandLabel(command.id)}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>

        {error && <p role="alert" className="dim-body">{error}</p>}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="dim-btn dim-btn--quiet" onClick={onReset}>
            恢复产品默认
          </button>
          <button
            type="button"
            className="dim-btn dim-btn--accent"
            onClick={() => {
              try {
                onApply({
                  cards: patches,
                  orderedCardIds: order,
                  reason: "用户在组件控制面板调整桌面",
                  actor: "user",
                });
                onClose();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "桌面变更没有通过校验");
              }
            }}
          >
            保存
          </button>
        </div>

        <details>
          <summary className="dim-eyebrow">变更记录</summary>
          <p className="dim-body">
            这里可以撤销最近的桌面调整。
          </p>
          {history.length === 0 ? (
            <p className="dim-meta">还没有桌面变更。</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[...history].reverse().slice(0, 8).map((entry) => (
                <div key={entry.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="dim-meta" style={{ flex: 1 }}>
                    {entry.actor === "model" ? "AI" : "你"} · {entry.reason} · {formatTime(entry.appliedAt)}
                    {entry.rolledBackBy ? " · 曾被反转" : entry.rollbackOf ? " · 反转记录" : ""}
                  </span>
                  <button
                    type="button"
                    className="dim-btn dim-btn--quiet"
                    disabled={Boolean(entry.rolledBackBy)}
                    onClick={() => onRollback(entry.id)}
                  >
                    {entry.rolledBackBy ? "已被反转" : "反转这条操作"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </details>
      </section>
    </div>
  );
}

const backdropStyle = {
  position: "fixed",
  inset: 0,
  // The control plane stays above the workspace and global secretary rail.
  zIndex: 100,
  display: "grid",
  placeItems: "center",
  padding: 24,
  background: "rgb(43 39 31 / 46%)",
} as const;

const paperStyle = {
  width: "min(760px, 100%)",
  maxHeight: "min(820px, 92vh)",
  overflowY: "auto",
  padding: 22,
  display: "flex",
  flexDirection: "column",
  gap: 14,
  color: "var(--dim-ink)",
} as const;

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function eventLabel(event: string): string {
  return {
    feedback: "资讯反馈",
    lineage: "查看来源",
    complete: "回收结果",
    edit: "修改行动",
    chat: "打开对话",
    review: "真实周回顾",
    outcome: "回收到期结果",
    search: "Web Search",
    refresh: "刷新事实",
    cancel: "停止",
    touch: "触碰候选",
    shape: "塑形候选",
    conclude: "形成结论",
    park: "搁置候选",
    close: "合上",
    submit: "提交结果",
    data_safety: "打开数据与安全",
    export: "完整导出",
    integrity: "完整性检查",
    restore: "完整恢复",
    delete: "可恢复清空",
    purge: "永久删除",
    rollback: "撤销变更",
    send: "发送消息",
    paper: "纸面桌面",
    clue: "线索板桌面",
    constellation: "星图桌面",
  }[event] ?? event;
}

function commandLabel(commandId: string): string {
  return {
    "latitude.feed.feedback": "记录资讯反馈",
    "latitude.lineage.open": "打开真实来源",
    "latitude.anchor.complete": "回收行动结果",
    "latitude.anchor.edit": "修改真实行动",
    "latitude.companion.chat": "打开秘书对话",
    "latitude.companion.review": "发起真实周回顾",
    "latitude.companion.outcome": "回收到期行动结果",
    "latitude.control.search-web": "执行真实 Web Search",
    "latitude.control.refresh": "刷新事实投影",
    "latitude.agent.cancel": "停止当前任务",
    "latitude.candidate.touch": "触碰候选",
    "latitude.candidate.shape": "继续塑形",
    "latitude.candidate.conclude": "形成候选结论",
    "latitude.candidate.park": "搁置候选",
    "latitude.thread.close": "合上对话",
    "latitude.outcome.submit": "写入真实结果",
    "latitude.outcome.close": "合上结果回收",
    "latitude.diagnostics.data-safety": "打开数据与安全",
    "latitude.diagnostics.close": "合上诊断",
    "latitude.data-safety.export": "完整导出",
    "latitude.data-safety.integrity": "完整性检查",
    "latitude.data-safety.restore": "两阶段完整恢复",
    "latitude.data-safety.delete": "两阶段可恢复清空",
    "latitude.data-safety.purge": "两阶段永久删除",
    "latitude.data-safety.rollback": "撤销变更",
    "latitude.data-safety.close": "合上数据与安全",
    "latitude.agent.send": "发送消息",
    "latitude.navigation.paper": "切到纸面桌面",
    "latitude.navigation.clue": "切到线索板桌面",
    "latitude.navigation.constellation": "切到星图桌面",
    "latitude.inspector.close": "合上来源检查器",
  }[commandId] ?? commandId;
}

function moduleLabel(componentId: string): string {
  return {
    "browser-control-strip": "本地产品闭环控制",
    "candidate-intervention-strip": "候选共创",
    "browser-thread": "与秘书的对话",
    "outcome-dialog": "结果回收",
    "diagnostics-dialog": "本地服务诊断",
    "data-safety-dialog": "数据与安全",
    "command-bar": "底部对话条",
    "dimension-navigation": "三层桌面导航",
    "source-inspector-dialog": "来源检查器",
  }[componentId] ?? componentId;
}
