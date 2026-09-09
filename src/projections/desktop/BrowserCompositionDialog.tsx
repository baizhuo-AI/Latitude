import { MotionSurface } from "../../dimension/SurfaceMotion";
import { useMemo, useRef, useState } from "react";
import "./composition-dialog.css";
import type { CardPresentation } from "../../dimension/types";
import {
  BROWSER_COMPANION_COMPONENT_ID,
  BROWSER_SYSTEM_COMPONENT_IDS,
  BROWSER_SYSTEM_COMPONENT_SPECS,
} from "../../runtime/composition/browserProduction";
import type { CompositionRegistry } from "../../runtime/composition/registry";
import type { UiComponentInstance, UiSurfaceDocumentV2 } from "../../runtime/composition/types";
import type { LayoutDocumentV1 } from "../../runtime/layout/types";
import type {
  BrowserUiCardPatch,
  BrowserUiChangeSet,
  BrowserUiChangeSetDraft,
} from "./browserUiComposition";

export function BrowserCompositionDialog({
  layout,
  document,
  registry,
  history,
  onApply,
  onRollback,
  onReset,
  onClose,
  zIndex = 100,
  onActivate,
  windowMode = false,
}: {
  layout: LayoutDocumentV1<string, CardPresentation>;
  document: UiSurfaceDocumentV2;
  registry: CompositionRegistry;
  history: BrowserUiChangeSet[];
  onApply: (draft: BrowserUiChangeSetDraft) => void;
  onRollback: (id: string) => void;
  onReset: () => void;
  onClose: () => void;
  zIndex?: number;
  onActivate?: () => void;
  windowMode?: boolean;
}) {
  const cardsById = useMemo(
    () => new Map(layout.cards.map((card) => [card.id, card])),
    [layout.cards],
  );
  const [order, setOrder] = useState([...layout.arrangement.orderedCardIds]);
  // The weekly review remains stored for dialogue/runtime use, but has no card settings entry.
  const editableOrder = order.filter((id) => {
    const card = cardsById.get(id);
    return card && card.region !== "review-plan";
  });
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
      const visible = current.filter((cardId) => {
        const card = cardsById.get(cardId);
        return card && card.region !== "review-plan";
      });
      const visibleIndex = visible.indexOf(id);
      const targetId = visible[visibleIndex + delta];
      if (visibleIndex < 0 || !targetId) return current;
      // Swap actual document slots so omitted source cards keep their original position.
      const index = current.indexOf(id);
      const target = current.indexOf(targetId);
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  return (
    <MotionSurface
      className="dimension-root dim-composition-dialog"
      style={{
        ...backdropStyle,
        zIndex,
        ...(windowMode ? windowStyle : {}),
      }}
      role="dialog"
      aria-modal={!windowMode}
      aria-label="桌面设置"
      onPointerDown={onActivate}
    >
      <section
        className="dim-paper dim-composition-paper"
        style={{
          ...paperStyle,
          ...(windowMode ? windowPaperStyle : {}),
        }}
      >
        <header className="dim-composition-header">
          <div>
            <p className="dim-eyebrow">YOUR CARDS</p>
            <h2>桌面设置</h2>
            <p className="dim-composition-description">整理卡片名称、显示与顺序。大小可回到主页拖动调整。</p>
          </div>
          <button type="button" className="dim-btn dim-btn--quiet" onClick={onClose}>关闭</button>
        </header>

        <div className="dim-composition-card-list">
          {editableOrder.map((id, index) => {
            const card = cardsById.get(id);
            if (!card) return null;
            const patch = patches[id] ?? {};
            const component = document.components.find((candidate) => candidate.id === id);
            const label = regionLabel(card.region);
            return (
              <article key={id} className="dim-composition-card" aria-label={`${label}设置`}>
                <div className="dim-composition-card-heading">
                  <span className="dim-composition-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <label className="dim-composition-title">
                    <span className="dim-eyebrow">{label}</span>
                    <input
                      aria-label={`${label} 标题`}
                      className="dim-input"
                      value={patch.title ?? ""}
                      onChange={(event) => updateCard(id, { title: event.target.value })}
                    />
                  </label>
                  <VisibilityToggle
                    label={label}
                    hidden={patch.hidden === true}
                    onChange={(hidden) => updateCard(id, { hidden })}
                  />
                  <div className="dim-composition-order" role="group" aria-label={`${label}顺序`}>
                    <button
                      type="button"
                      className="dim-btn dim-btn--quiet"
                      aria-label={`上移 ${label}`}
                      disabled={index === 0}
                      onClick={() => move(id, -1)}
                    >↑</button>
                    <button
                      type="button"
                      className="dim-btn dim-btn--quiet"
                      aria-label={`下移 ${label}`}
                      disabled={index === editableOrder.length - 1}
                      onClick={() => move(id, 1)}
                    >↓</button>
                  </div>
                </div>
                {component && (
                  <ActionSettings
                    label={label}
                    component={component}
                    registry={registry}
                    actions={patch.actions ?? {}}
                    onChange={(actions) => updateCard(id, { actions })}
                  />
                )}
              </article>
            );
          })}
        </div>

        <details className="dim-composition-section">
          <summary>秘书与其他功能</summary>
          <div className="dim-composition-module-list">
            {[BROWSER_COMPANION_COMPONENT_ID, ...BROWSER_SYSTEM_COMPONENT_SPECS.map((spec) => spec.id)].map((id) => {
              const component = document.components.find((candidate) => candidate.id === id);
              if (id === BROWSER_SYSTEM_COMPONENT_IDS.commandBar || !component || !registry.component(component.type)) return null;
              const patch = patches[id] ?? {};
              const label = id === BROWSER_COMPANION_COMPONENT_ID ? "秘书栏" : moduleLabel(id);
              return (
                <section key={id} className="dim-composition-module" aria-label={`${label}设置`}>
                  <div className="dim-composition-module-heading">
                    <h3>{label}</h3>
                    <VisibilityToggle
                      label={label}
                      hidden={patch.hidden === true}
                      onChange={(hidden) => updateCard(id, { hidden })}
                    />
                  </div>
                  <ActionSettings
                    label={label}
                    component={component}
                    registry={registry}
                    actions={patch.actions ?? {}}
                    onChange={(actions) => updateCard(id, { actions })}
                    summary="功能开关"
                  />
                </section>
              );
            })}
          </div>
        </details>



        <details className="dim-composition-section">
          <summary>变更记录</summary>
          <p className="dim-body">
            这里可以撤销最近的桌面调整。
          </p>
          {history.length === 0 ? (
            <p className="dim-meta">还没有桌面变更。</p>
          ) : (
            <div className="dim-composition-history">
              {[...history].reverse().slice(0, 8).map((entry) => (
                <div key={entry.id} className="dim-composition-history-row">
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
        {error && <p role="alert" className="dim-composition-error">{error}</p>}
        <footer className="dim-composition-footer">
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
                  reason: "调整卡片与功能设置",
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
        </footer>
      </section>
    </MotionSurface>
  );
}

function VisibilityToggle({ label, hidden, onChange }: {
  label: string;
  hidden: boolean;
  onChange: (hidden: boolean) => void;
}) {
  return (
    <label className="dim-composition-visibility">
      <input
        type="checkbox"
        role="switch"
        aria-label={`${label} 显示`}
        checked={!hidden}
        onChange={(event) => onChange(!event.target.checked)}
      />
      <span>{hidden ? "已隐藏" : "显示"}</span>
    </label>
  );
}

function ActionSettings({ label, component, registry, actions, onChange, summary = "卡片功能" }: {
  label: string;
  component: UiComponentInstance;
  registry: CompositionRegistry;
  actions: Record<string, string | null>;
  onChange: (actions: Record<string, string | null>) => void;
  summary?: string;
}) {
  const definition = registry.component(component.type);
  // Turning a function off and back on restores the user's chosen authorized binding.
  const lastBindings = useRef({ ...component.actions });
  const events = definition?.events.filter((event) => event !== "review") ?? [];
  if (!events.length) return null;
  const enabledCount = events.filter((event) => Boolean(actions[event])).length;

  return (
    <details className="dim-composition-actions">
      <summary aria-label={`${label} ${summary}`}>
        <span>{summary}</span>
        <span className="dim-composition-action-count">{enabledCount} 项已开启</span>
      </summary>
      <div className="dim-composition-action-list">
        {events.map((event) => {
          const allowed = registry.allowedCommands(component.type, event);
          const binding = actions[event];
          const enabled = Boolean(binding);
          return (
            <div key={event} className="dim-composition-action-row">
              <label className="dim-composition-action-toggle">
                <span>{eventLabel(event)}</span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`${label} ${eventLabel(event)}`}
                  checked={enabled}
                  disabled={!enabled && allowed.length === 0}
                  onChange={(changeEvent) => {
                    if (binding) lastBindings.current[event] = binding;
                    const remembered = lastBindings.current[event];
                    const nextBinding = allowed.find((command) => command.id === remembered)?.id ?? allowed[0]?.id ?? null;
                    onChange({ ...actions, [event]: changeEvent.target.checked ? nextBinding : null });
                  }}
                />
              </label>
              {enabled && allowed.length > 1 && (
                <fieldset className="dim-composition-binding-options">
                  <legend>使用方式</legend>
                  {allowed.map((command) => (
                    <label key={command.id}>
                      <input
                        type="radio"
                        name={`${component.id}-${event}-binding`}
                        checked={binding === command.id}
                        onChange={() => {
                          lastBindings.current[event] = command.id;
                          onChange({ ...actions, [event]: command.id });
                        }}
                      />
                      {commandLabel(command.id, command.description)}
                    </label>
                  ))}
                </fieldset>
              )}
            </div>
          );
        })}
      </div>
    </details>
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
  overflow: "auto",
  resize: "both",
  minWidth: "min(300px, calc(100vw - 48px))",
  minHeight: 220,
  maxWidth: "calc(100vw - 48px)",
  boxSizing: "border-box",
  padding: 22,
  display: "flex",
  flexDirection: "column",
  gap: 14,
  color: "var(--dim-ink)",
} as const;

const windowStyle = {
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

const windowPaperStyle = {
  width: "min(760px, calc(100vw - 48px))",
  boxShadow: "0 26px 64px rgb(55 48 34 / 24%), 0 3px 10px rgb(55 48 34 / 12%)",
} as const;

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function regionLabel(region: string): string {
  return {
    activity: "今天做过",
    feed: "今日资讯",
    schedule: "今天的锚点",
    "review-plan": "周回顾",
    rhythm: "结果时间窗",
    flex: "当前观察",
  }[region] ?? region;
}

function eventLabel(event: string): string {
  return {
    feedback: "资讯反馈",
    capture: "记下一件事",
    retract: "撤下记录",
    reflect: "一起看今天",
    lineage: "查看来源",
    complete: "回收结果",
    edit: "修改内容",
    chat: "打开对话",
    review: "周回顾",
    outcome: "回收到期结果",
    search: "搜索",
    refresh: "刷新",
    cancel: "停止",
    touch: "继续讨论",
    shape: "补充或修改",
    conclude: "形成结论",
    park: "先搁置",
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
    paper: "主页",
    clue: "线索版",
    constellation: "星图",
  }[event] ?? event;
}

function commandLabel(commandId: string, description: string): string {
  return {
    "latitude.feed.feedback": "记录资讯反馈",
    "latitude.activity.capture": "记下一件已经做过的事",
    "latitude.activity.edit": "修改活动记录",
    "latitude.activity.retract": "撤下活动记录",
    "latitude.activity.reflect": "请秘书一起看今天",
    "latitude.lineage.open": "打开真实来源",
    "latitude.anchor.complete": "回收行动结果",
    "latitude.anchor.edit": "修改真实行动",
    "latitude.companion.chat": "打开秘书对话",
    "latitude.companion.review": "生成周回顾",
    "latitude.companion.outcome": "回收到期行动结果",
    "latitude.control.search-web": "搜索",
    "latitude.control.refresh": "刷新",
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
  }[commandId] ?? description;
}

function moduleLabel(componentId: string): string {
  return {
    "browser-control-strip": "搜索与任务操作",
    "candidate-intervention-strip": "与你有关的想法",
    "browser-thread": "与秘书的对话",
    "outcome-dialog": "结果回收",
    "diagnostics-dialog": "本地服务诊断",
    "data-safety-dialog": "数据与安全",
    "command-bar": "底部对话条",
    "dimension-navigation": "视图切换",
    "source-inspector-dialog": "来源检查器",
  }[componentId] ?? componentId;
}
