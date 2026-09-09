import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SecretaryPortrait } from "./SecretaryPortrait";
import { AnimatePresence } from "motion/react";
import { MotionSurface } from "./SurfaceMotion";
import { compactSecretaryNotice } from "./secretaryNotice";
import { updateDraft, useComposerDraft } from "./composer/draftStore";
import type { SendComposerMessage } from "./composer/MessageComposer";
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
  return (
    <AnimatePresence initial={false}>
    {message && <MotionSurface
      key="desktop-toast"
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
    </MotionSurface>}
    </AnimatePresence>
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

export interface HeaderSecretaryLauncher {
  secretary: Secretary;
  notice?: string | null;
  open?: boolean;
  visible?: boolean;
  enabled?: boolean;
  outcomeEnabled?: boolean;
  onOpen: () => void;
  onOutcome?: () => void;
  onRestore?: () => void;
}

export function AppHeader({
  title = "维度",
  appearance = "paper",
  showRuntimeStatus = true,
  tools,
  runtimeLabel = "运行状态未知",
  secretaryLauncher,
  onSettings,
}: {
  title?: string;
  appearance?: "paper" | "page";
  showRuntimeStatus?: boolean;
  tools?: ReactNode;
  runtimeLabel?: string;
  secretaryLauncher?: HeaderSecretaryLauncher;
  onSettings?: () => void;
}) {
  const launcherNotice = secretaryLauncher?.notice?.trim()
    ? compactSecretaryNotice(secretaryLauncher.notice)
    : secretaryLauncher?.open
      ? "对话已打开"
      : secretaryLauncher?.secretary.state === "thinking"
        ? "正在处理"
        : "点我聊聊";

  return (
    <header
      className="dim-app-header"
      style={{
        height: 48,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 30px",
        background: appearance === "page" ? "transparent" : "var(--dim-paper)",
        borderBottom: appearance === "page" ? "none" : "1px solid var(--dim-line)",
        zIndex: 3
      }}
    >
      <div className="dim-app-header__left">
        <div className="dim-app-header__brand">
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
            {title}
          </span>
        </div>

        {secretaryLauncher && (
          <div className="dim-header-secretary-group" role="group" aria-label="秘书入口">
            {secretaryLauncher.visible === false ? (
              <button
                type="button"
                className="dim-header-secretary-return"
                onClick={secretaryLauncher.onRestore}
                disabled={!secretaryLauncher.onRestore}
                aria-label="唤回秘书"
              >
                <span aria-hidden="true" />
                唤回秘书
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="dim-header-secretary"
                  data-secretary-launcher
                  data-state={secretaryLauncher.secretary.state}
                  onClick={secretaryLauncher.onOpen}
                  disabled={secretaryLauncher.enabled === false}
                  aria-disabled={secretaryLauncher.enabled === false}
                  aria-expanded={secretaryLauncher.open === true}
                  aria-label={secretaryLauncher.open ? "收起秘书对话" : "打开秘书对话"}
                  title={secretaryLauncher.enabled === false
                    ? "秘书对话已在组件设置中关闭"
                    : "打开与秘书的对话"}
                >
                  <span className="dim-header-secretary__portrait" aria-hidden="true">
                    <SecretaryPortrait secretary={secretaryLauncher.secretary} />
                  </span>
                  <span className="dim-header-secretary__copy">
                    <strong>秘书</strong>
                    <small role={secretaryLauncher.notice ? "status" : undefined}>
                      {launcherNotice}
                    </small>
                  </span>
                </button>
                {((Boolean(secretaryLauncher.notice) || secretaryLauncher.enabled === false) &&
                  secretaryLauncher.outcomeEnabled !== false && secretaryLauncher.onOutcome) && (
                  <button
                    type="button"
                    className="dim-header-secretary-action"
                    onClick={secretaryLauncher.onOutcome}
                  >
                    查看
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {tools}
      <div className="dim-app-header__tools">
        {/* 状态必须来自运行时投影。没有 adapter 时诚实地显示未知。 */}
        {showRuntimeStatus && <span className="dim-eyebrow">{runtimeLabel}</span>}
        {onSettings && (
          <button
            type="button"
            className="dim-header-settings"
            onClick={onSettings}
            aria-label="设置"
            title="设置"
          >
            ⚙
          </button>
        )}
      </div>
    </header>
  );
}

/* ---------- B 秘书栏 ---------- */

const RELATION_TONE: Record<RelationMetric["tone"], string> = {
  olive: "var(--dim-olive)",
  blue: "var(--dim-teal)",
  rust: "var(--dim-rust)"
};

const EMPTY_RELATION_METRICS: readonly RelationMetric[] = [
  {
    label: "熟悉",
    value: 0,
    tone: "olive",
    stage: "尚未形成",
    basis: "还没有可确认的熟悉度记录。"
  },
  {
    label: "默契",
    value: 0,
    tone: "blue",
    stage: "尚未形成",
    basis: "还没有可确认的默契记录。"
  },
  {
    label: "权能",
    value: 0,
    tone: "rust",
    stage: "未授权",
    basis: "还没有有效授权记录。"
  }
];

/**
 * 三条关系指标各自表达不同事实，不能合成一个容易误解的“关系分”。
 * 视觉上给进度，文字上优先给阶段，避免让裸百分比冒充精确判断。
 */
function relationStage(metric: RelationMetric): string {
  if (metric.stage?.trim()) return metric.stage.trim();
  const value = Math.max(0, Math.min(100, metric.value));
  if (metric.label === "熟悉") {
    return value < 34 ? "初见" : value < 67 ? "看见模式" : "懂处境";
  }
  if (metric.label === "默契") {
    return value < 34 ? "磨合" : value < 67 ? "渐合" : "合拍";
  }
  return value < 25
    ? "只建议"
    : value < 50
      ? "代我准备"
      : value < 75
        ? "确认后调度"
        : "白名单自动";
}

export interface SecretaryRailProps {
  secretary: Secretary;
  portrait?: ReactNode | ((interaction: { label: string; onActivate: () => void }) => ReactNode);
  /** Quiet, expandable co-creation invitation placed above the portrait. */
  invitation?: ReactNode;
  /** Durable scheduler / reality-loop delivery shown without changing her art. */
  notice?: string | null;
  onReview?: () => void;
  /** 查看关系指标的可追溯来源；只有存在 lineage 时才显示入口。 */
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
  portrait,
  invitation,
  notice,
  onRelationInspect,
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
  const primaryIntent: SecretaryIntent = chatEnabled ? "chat" : "decide";
  const primaryEnabled = chatEnabled || outcomeEnabled;
  const primaryLabel = chatEnabled ? "打开对话" : "查看待处理";
  const relationMetrics = secretary.metrics.length > 0
    ? secretary.metrics
    : EMPTY_RELATION_METRICS;
  const shortLine = secretary.connectionState === "unavailable"
    ? "秘书暂时没连上。"
    : secretary.connectionState === "starting"
      ? "秘书正在连接。"
      : notice ? compactSecretaryNotice(notice) : (
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
        {invitation}
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

        {invitation}
        <div className="dim-pet-stage" style={{ marginTop: invitation ? 14 : 10 }}>
          {(typeof portrait === "function" ? portrait({ label: primaryLabel, onActivate: () => { if (primaryEnabled) onInteract?.(primaryIntent); } }) : portrait) ?? <button
            type="button"
            className="dim-portrait-btn"
            data-secretary-launcher
            onClick={() => primaryEnabled && onInteract?.(primaryIntent)}
            disabled={!primaryEnabled}
            aria-label={primaryLabel}
            title={chatEnabled ? "打开与秘书的对话" : "查看秘书待处理的提醒"}
          >
            <SecretaryPortrait secretary={secretary} />
          </button>}
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

        <section className="dim-relation-section" aria-label="了解你的进度">
          <div className="dim-relation-heading">
            <h2>了解你的进度</h2>
            <span>随真实记录变化</span>
          </div>

          <div className="dim-relation-list" aria-label="了解你的进度">
            {relationMetrics.map((metric) => {
              const value = Math.max(0, Math.min(100, metric.value));
              const stage = relationStage(metric);
              const label = metric.label === "熟悉" ? "关系" : metric.label;
              return (
                <div className="dim-relation-row" key={metric.label}>
                  <div className="dim-relation-labels">
                    <span>{label}</span>
                    <span>{stage}</span>
                  </div>
                  <div
                    className="dim-relation-meter"
                    role="progressbar"
                    aria-label={`${label} · ${stage}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={value}
                    aria-valuetext={stage}
                  >
                    <i
                      aria-hidden="true"
                      style={{ width: `${value}%`, background: RELATION_TONE[metric.tone] }}
                    />
                  </div>
                  {metric.basis && (
                    <details className="dim-relation-details">
                      <summary aria-label={`查看${label}依据`}>查看依据</summary>
                      <p className="dim-relation-basis">
                        {metric.basis}
                        {metric.epistemicAuthority === "imported_unverified" && (
                          <span className="dim-relation-authority"> · 脱敏导入，待核验</span>
                        )}
                      </p>
                      {Boolean(onRelationInspect && metric.lineage?.length) && (
                        <button
                          type="button"
                          className="dim-relation-source"
                          onClick={() => onRelationInspect?.(metric)}
                          aria-label={`查看${label}来源详情`}
                        >
                          查看来源详情
                        </button>
                      )}
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </section>
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
  sessionId,
  onOpenComposer,
}: {
  onSend?: SendComposerMessage;
  disabled?: boolean;
  sessionId?: string;
  onOpenComposer?: () => void;
}) {
  const shared = useComposerDraft(sessionId ?? "command-bar");
  const [localText, setLocalText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composing = useRef(false);
  const compositionEnded = useRef(0);
  const busy = useRef(false);
  const text = sessionId ? shared.text : localText;
  const hasAttachments = Boolean(sessionId && shared.attachments.length);
  async function send() {
    if (disabled || busy.current || !onSend) return;
    if (hasAttachments) { onOpenComposer?.(); return; }
    const sent = text;
    if (!sent.trim()) return;
    busy.current = true;
    setSending(true);
    setError(null);
    try {
      const accepted = await onSend(sent.trim());
      if (accepted === false) { setError("消息没有发送，草稿已保留。请稍后重试。"); return; }
      if (sessionId) updateDraft(sessionId, (latest) => latest.text === sent ? { ...latest, text: "" } : latest);
      else setLocalText((latest) => latest === sent ? "" : latest);
    } catch { setError("消息没有发送，草稿已保留。请稍后重试。"); }
    finally { busy.current = false; setSending(false); }
  }
  return (
    <form
      style={{
        position: "relative",
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
        if (composing.current || Date.now() - compositionEnded.current < 50) return;
        void send();
      }}
    >
      {/* 「让她改动这张桌面」是产品主张:桌面能用自然语言改,不是只能看 */}
      <textarea
        name="dim-say"
        className="dim-input"
        rows={1}
        style={{ height: 28, minHeight: 28, resize: "none", overflowY: "auto", lineHeight: "20px" }}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          if (sessionId) {
            if (!updateDraft(sessionId, (value) => ({ ...value, text: next }))) setError("草稿暂时只保留在当前窗口，请先发送或复制备份。");
          } else setLocalText(next);
        }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; compositionEnded.current = Date.now(); }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || Date.now() - compositionEnded.current < 50) return;
          if (!event.shiftKey) { event.preventDefault(); void send(); }
        }}
        placeholder="说点什么…"
        aria-label="跟秘书说话"
        disabled={disabled}
        title={disabled ? "发送动作已在组件设置中关闭" : undefined}
      />
      {hasAttachments && <button type="button" className="dim-btn dim-btn--quiet" onClick={onOpenComposer} title="打开对话查看并发送附件" style={{ flexShrink: 0, fontSize: 10 }}>附件 {shared.attachments.length}</button>}
      {error && <p role="alert" className="dim-composer__error" style={{ position: "absolute", bottom: "100%", left: 0, padding: 6, background: "var(--dim-paper)" }}>{error}</p>}
      <span className="dim-meta" style={{ flexShrink: 0 }}>
        ⌘K
      </span>
      <button
        type="submit"
        className="dim-send"
        aria-label="发送"
        disabled={disabled || sending}
        aria-disabled={disabled || sending}
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
