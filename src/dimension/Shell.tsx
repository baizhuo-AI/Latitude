import { useCallback, useEffect, useRef, useState } from "react";
import { SecretaryPortrait } from "./SecretaryPortrait";
import type {
  RelationMetric,
  Secretary,
  SecretaryIntent
} from "./types";

/* ---------- 桌面级轻反馈 ---------- */

/**
 * 桌面 toast。反馈必须诚实：只有动作真实发生后才确认，
 * 做不到的事直接说做不到，不用「演示模式」以外的包装话术。
 */
export function useDimToast(): { toast: string | null; say: (m: string) => void } {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const say = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { toast, say };
}

export function DimToast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="status"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 26,
        transform: "translateX(-50%)",
        background: "var(--dim-olive-deep)",
        color: "#f2f0dc",
        fontSize: 12,
        padding: "8px 16px",
        border: "1px solid var(--dim-line)",
        borderRadius: 2,
        zIndex: 20,
        maxWidth: "80%"
      }}
    >
      {message}
    </div>
  );
}

/**
 * 桌面的四个稳定区:应用头 / 秘书栏 / 标题区 / 对话条。
 *
 * 「稳定」是产品承诺的一部分 —— 桌面上的纸片每天会变,这四个区不变,
 * 用户的空间记忆挂在它们身上。设计稿里的顶部三阶段分段和底部三栏
 * 是给看稿人的注释层,不是 UI,这里没有。
 */

/* ---------- A 应用头 ---------- */

export function AppHeader({
  runtimeLabel = "运行状态未知"
}: {
  runtimeLabel?: string;
}) {
  return (
    <header
      style={{
        height: 48,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 20px",
        background: "var(--dim-paper)",
        borderBottom: "1px solid var(--dim-line)",
        zIndex: 3
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span
          style={{
            width: 13,
            height: 13,
            border: "1.5px solid var(--dim-olive)",
            transform: "rotate(45deg)",
            flexShrink: 0
          }}
          aria-hidden="true"
        />
        <span style={{ fontWeight: 600, fontSize: 14, letterSpacing: "-0.01em" }}>
          维度
        </span>
      </div>

      {/* 状态必须来自运行时投影。没有 adapter 时诚实地显示未知。 */}
      <span className="dim-eyebrow">{runtimeLabel}</span>
    </header>
  );
}

/* ---------- B 秘书栏 ---------- */

export interface SecretaryRailProps {
  secretary: Secretary;
  /** Durable scheduler / reality-loop delivery shown without changing her art. */
  notice?: string | null;
  onReview?: () => void;
  /** 保留兼容出口；依据不再常驻显示在秘书栏。 */
  onRelationInspect?: (metric: RelationMetric) => void;
  onInteract?: (intent: SecretaryIntent) => void;
  /** 设置是整体界面的工具入口，固定在秘书栏左下角。 */
  onSettings?: () => void;
  /** 收起成一条细边栏；她在不在场由一个状态点承担，不占内容宽度。 */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** UiSurfaceV2 is authoritative when provided; hidden keeps a safe rail restore tab. */
  visible?: boolean;
  onVisibilityChange?: (visible: boolean) => void;
  /** Event-level trusted bindings resolved by the host-owned production registry. */
  actionAvailability?: {
    chat: boolean;
    review: boolean;
    outcome: boolean;
  };
}

export function SecretaryRail({
  secretary,
  notice,
  onInteract,
  onSettings,
  collapsed = false,
  onToggleCollapse,
  visible,
  onVisibilityChange,
  actionAvailability
}: SecretaryRailProps) {
  const chatEnabled = actionAvailability?.chat ?? Boolean(onInteract);
  const outcomeEnabled = actionAvailability?.outcome ?? Boolean(onInteract);
  const primaryIntent: SecretaryIntent =
    (Boolean(notice) && outcomeEnabled) || (!chatEnabled && outcomeEnabled)
      ? "decide"
      : "chat";
  const primaryEnabled = primaryIntent === "decide" ? outcomeEnabled : chatEnabled;
  const primaryLabel = primaryIntent === "decide" ? "查看" : "打开对话";
  const shortLine = notice ?? (
    secretary.state === "thinking"
      ? "稍等…"
      : secretary.state === "presenting"
        ? "有件事需要你看看。"
        : "今天想先做什么？"
  );

  if (visible === false) {
    return (
      <aside className="dim-rail dim-rail--collapsed" aria-label="秘书栏（已隐藏）">
        <button
          type="button"
          className="dim-rail-expand"
          onClick={() => onVisibilityChange?.(true)}
          disabled={!onVisibilityChange}
          aria-label="唤回秘书"
          title="唤回左侧秘书栏"
        >
          <span className="dim-rail-expand-mark" aria-hidden="true" />
          <span className={`dim-rail-state-dot dim-rail-state-${secretary.state}`} aria-hidden="true" />
          <span className="dim-rail-collapsed-label">她在</span>
        </button>
      </aside>
    );
  }

  if (collapsed) {
    return (
      <aside className="dim-rail dim-rail--collapsed" aria-label="秘书栏（已收起）">
        <button
          type="button"
          className="dim-rail-expand"
          onClick={onToggleCollapse}
          aria-label="展开秘书栏"
          title="展开秘书栏"
        >
          <span className="dim-rail-expand-mark" aria-hidden="true" />
          <span className={`dim-rail-state-dot dim-rail-state-${secretary.state}`} aria-hidden="true" />
          <span className="dim-rail-collapsed-label">{secretary.stateCn}</span>
        </button>
        {onSettings && (
          <button
            type="button"
            className="dim-rail-settings dim-rail-settings-collapsed"
            onClick={onSettings}
            aria-label="设置"
            title="设置"
          >
            <span aria-hidden="true">⚙︎</span>
          </button>
        )}
      </aside>
    );
  }

  return (
    <aside
      className="dim-rail"
      aria-label="秘书栏"
      style={{
        display: "flex",
        flexDirection: "column",
        overflow: "hidden"
      }}
    >
      <div className="dim-rail-body dim-rail-body--simple">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <p className="dim-eyebrow">秘书</p>
          {onToggleCollapse && (
            <button
              type="button"
              className="dim-btn dim-btn--quiet dim-rail-collapse"
              onClick={() => {
                onToggleCollapse?.();
              }}
              aria-label="收起秘书栏"
              title="收起秘书栏"
            >
              ⇤
            </button>
          )}
        </div>

        <div className="dim-pet-stage" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="dim-portrait-btn"
            onClick={() => primaryEnabled && onInteract?.(primaryIntent)}
            disabled={!primaryEnabled}
            aria-label={primaryLabel}
            title={primaryLabel}
          >
            <SecretaryPortrait secretary={secretary} />
          </button>
        </div>

        <p
          role={notice ? "status" : undefined}
          style={{
            margin: "14px 0 0",
            fontSize: 13,
            fontWeight: 600,
            lineHeight: 1.55,
            letterSpacing: "-0.01em"
          }}
        >
          {shortLine}
        </p>
      </div>

      <div className="dim-rail-footer">
        {onSettings && (
          <button
            type="button"
            className="dim-btn dim-btn--quiet dim-rail-settings dim-rail-footer-button"
            onClick={onSettings}
          >
            <span aria-hidden="true">⚙︎</span>
            设置
          </button>
        )}
      </div>
    </aside>
  );
}

/* ---------- C 标题区 ---------- */

export function DeskHeader({
  breadcrumb,
  title,
  subtitle,
  onAdd,
  onAdjust
}: {
  breadcrumb: string;
  title: string;
  subtitle: string;
  onAdd?: () => void;
  onAdjust?: () => void;
}) {
  return (
    <div
      className="dim-desk-header"
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 20,
        marginBottom: 20
      }}
    >
      <div style={{ minWidth: 0 }}>
        {/* 面包屑标注的是「这张桌面此刻按什么逻辑组织」,不是路径 */}
        <p className="dim-eyebrow">{breadcrumb}</p>
        <h1
          style={{
            margin: "8px 0 0",
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.015em",
            lineHeight: 1.35,
            textWrap: "balance"
          }}
        >
          {title}
        </h1>
        <p
          style={{
            margin: "6px 0 0",
            fontSize: 12,
            color: "var(--dim-ink-soft)",
            lineHeight: 1.7
          }}
        >
          {subtitle}
        </p>
      </div>

      <div className="dim-desk-actions">
        {onAdd && (
          <button type="button" className="dim-btn" onClick={onAdd}>
            ＋ 添加卡片
          </button>
        )}
        {onAdjust && (
          <button
            type="button"
            className="dim-btn dim-btn--quiet dim-desk-more"
            onClick={onAdjust}
            aria-label="调整桌面"
            title="桌面设置"
          >
            •••
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- E 对话条 ---------- */

export function CommandBar({
  onSend,
  disabled = false,
}: {
  onSend?: (text: string) => void;
  disabled?: boolean;
}) {
  return (
    <form
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 12,
        height: 40,
        padding: "0 8px 0 16px",
        background: "var(--dim-paper)",
        borderRadius: 1,
        border: "1px solid var(--dim-line)"
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) return;
        const input = e.currentTarget.elements.namedItem("dim-say");
        if (input instanceof HTMLInputElement && input.value.trim()) {
          onSend?.(input.value.trim());
          input.value = "";
        }
      }}
    >
      {/* 「让她改动这张桌面」是产品主张:桌面能用自然语言改,不是只能看 */}
      <input
        name="dim-say"
        className="dim-input"
        placeholder="说点什么…"
        aria-label="跟秘书说话"
        disabled={disabled}
        title={disabled ? "发送动作已在组件设置中关闭" : undefined}
      />
      <span className="dim-meta" style={{ flexShrink: 0 }}>
        ⌘K
      </span>
      <button
        type="submit"
        className="dim-send"
        aria-label="发送"
        disabled={disabled}
        aria-disabled={disabled}
        title={disabled ? "发送动作已在组件设置中关闭" : undefined}
      >
        <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
          <path
            d="M3 10 L10 3 M5 3 h5 v5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </form>
  );
}
