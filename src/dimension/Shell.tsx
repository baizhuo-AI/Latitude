import { useCallback, useEffect, useId, useRef, useState } from "react";
import { SecretaryPortrait } from "./SecretaryPortrait";
import type {
  RelationMetric,
  Secretary,
  SecretaryIntent,
  SecretaryState
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
        <span className="dim-eyebrow" style={{ marginLeft: 4 }}>
          Personal Reality OS
        </span>
      </div>

      {/* 状态必须来自运行时投影。没有 adapter 时诚实地显示未知。 */}
      <span className="dim-eyebrow">{runtimeLabel}</span>
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
  { label: "熟悉", value: 0, tone: "olive", stage: "尚未形成" },
  { label: "默契", value: 0, tone: "blue", stage: "尚未形成" },
  { label: "权能", value: 0, tone: "rust", stage: "未授权" }
];

/**
 * 阶段词是三条独立语义，不合成一个「关系分」。
 * 权能的四档与用户显式授权的执行梯子保持一致。
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

interface PetReaction {
  emote: string;
  line: string;
}

/**
 * 小桌宠的反应仍然服从秘书当前状态：在岗时陪伴与整理，在想时琢磨与记录，
 * 有事说时递交与提醒。用户可以主动换表情，但不会因此伪造任务进度。
 */
const PET_REACTIONS: Record<SecretaryState, readonly PetReaction[]> = {
  ready: [
    { emote: "◕‿◕", line: "我在。今天想先收哪一小块？" },
    { emote: "(｡•̀ᴗ-)✧", line: "你说，我把重要的先接住。" },
    { emote: "☕", line: "不用一下做完，我们先往前挪一小步。" }
  ],
  thinking: [
    { emote: "…?", line: "我还在想，先陪你等一会儿。" },
    { emote: "( •́ ᴗ •̀ )", line: "这团线索还没排好，我不会拿半成品糊弄你。" },
    { emote: "✦", line: "有结果我会直接告诉你。" }
  ],
  presenting: [
    { emote: "✦", line: "桌上有一张纸，等你看看。" },
    { emote: "(｡•̀ᴗ-)✧", line: "要不要先从最关键的一处看？" },
    { emote: "◡‿◡", line: "我在这儿，决定权还在你手里。" }
  ]
};

/**
 * 点立绘的反应：她注意到你了。
 *
 * 反应语义保持诚实 —— 气泡里的话和动作都来自她当前的真实状态（在岗 / 在想 /
 * 有事说）。「换个表情」只轮换同一状态里的本地反应，不冒充外部动作；聊聊与
 * 要我定的仍然是两个真实出口。
 */
export interface SecretaryRailProps {
  secretary: Secretary;
  /** Durable scheduler / reality-loop delivery shown without changing her art. */
  notice?: string | null;
  onReview?: () => void;
  /** 查看 typed 依据来源；纠正需要独立 Domain 写回，不能复用周回顾。 */
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
  onReview,
  onRelationInspect,
  onInteract,
  onSettings,
  collapsed = false,
  onToggleCollapse,
  visible,
  onVisibilityChange,
  actionAvailability
}: SecretaryRailProps) {
  const [noticed, setNoticed] = useState(false);
  const [reactionStep, setReactionStep] = useState(0);
  const noticeTimer = useRef<number | undefined>(undefined);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const portraitButtonRef = useRef<HTMLButtonElement>(null);
  const bubbleId = useId();

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  useEffect(() => {
    window.clearTimeout(noticeTimer.current);
    if (bubbleRef.current?.contains(document.activeElement)) {
      // 新任务状态会直接刷新气泡内容；键盘用户正在操作时保留气泡和焦点。
      setReactionStep(0);
      scheduleNoticeDismiss();
      return;
    }
    setNoticed(false);
    setReactionStep(0);
  }, [secretary.state]);

  const reactions = PET_REACTIONS[secretary.state];
  const reaction = reactions[reactionStep % reactions.length];
  const chatEnabled = actionAvailability?.chat ?? Boolean(onInteract);
  const reviewEnabled = actionAvailability?.review ?? Boolean(onReview);
  const outcomeEnabled = actionAvailability?.outcome ?? Boolean(onInteract);
  const relationMetrics = secretary.metrics.length > 0
    ? secretary.metrics
    : EMPTY_RELATION_METRICS;

  function dismissNotice(restoreFocus = false) {
    window.clearTimeout(noticeTimer.current);
    if (restoreFocus) portraitButtonRef.current?.focus();
    setNoticed(false);
  }

  function scheduleNoticeDismiss() {
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => {
      // 键盘用户正在气泡里选择时不拆掉 focused node；离开后再开始一轮空闲计时。
      if (bubbleRef.current?.contains(document.activeElement)) {
        scheduleNoticeDismiss();
        return;
      }
      setNoticed(false);
    }, 7000);
  }

  function poke() {
    window.clearTimeout(noticeTimer.current);
    if (noticed) {
      setNoticed(false);
      setReactionStep((step) => (step + 1) % reactions.length);
      return;
    }
    setNoticed(true);
    scheduleNoticeDismiss();
  }

  function changeExpression() {
    setReactionStep((step) => (step + 1) % reactions.length);
    scheduleNoticeDismiss();
  }

  function interact(intent: SecretaryIntent) {
    if (intent === "chat" && !chatEnabled) return;
    if (intent === "decide" && !outcomeEnabled) return;
    dismissNotice(true);
    onInteract?.(intent);
  }

  function review() {
    if (!reviewEnabled) return;
    dismissNotice();
    onReview?.();
  }

  // 业务动作只由真实任务状态决定；桌宠轮换的是表情与陪伴话，不伪造进度。
  const shownSecretary = secretary;

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
          ref={portraitButtonRef}
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
      <div className="dim-rail-body">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <p className="dim-eyebrow">{secretary.eyebrow}</p>
          {onToggleCollapse && (
            <button
              type="button"
              className="dim-btn dim-btn--quiet dim-rail-collapse"
              onClick={() => {
                dismissNotice();
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
            className={`dim-portrait-btn${noticed ? " is-reacting" : ""}`}
            onClick={poke}
            aria-label="跟她说句话"
            aria-expanded={noticed}
            aria-controls={bubbleId}
            title="点一点，看她现在在做什么"
          >
            <SecretaryPortrait secretary={shownSecretary} />
            {noticed && (
              <span
                className="dim-pet-emote"
                key={`${secretary.state}-${reactionStep}`}
                aria-hidden="true"
              >
                {reaction.emote}
              </span>
            )}
          </button>

          {noticed && (
            <div className="dim-secretary-bubble" id={bubbleId} ref={bubbleRef}>
              <p className="dim-secretary-bubble-line" role="status">
                <span className="dim-secretary-bubble-emote" aria-hidden="true">
                  {reaction.emote}
                </span>
                {reaction.line}
              </p>
              <div className="dim-secretary-bubble-actions">
                {onInteract && (
                  <>
                    <button
                      type="button"
                      onClick={() => interact("chat")}
                      disabled={!chatEnabled}
                      aria-disabled={!chatEnabled}
                      title={chatEnabled ? undefined : "秘书对话已在组件设置中关闭"}
                    >
                      聊聊
                    </button>
                    <button
                      type="button"
                      onClick={() => interact("decide")}
                      disabled={!outcomeEnabled}
                      aria-disabled={!outcomeEnabled}
                      title={outcomeEnabled ? undefined : "结果回收已在组件设置中关闭"}
                    >
                      有什么要我定的？
                    </button>
                  </>
                )}
                <button type="button" className="dim-pet-expression-btn" onClick={changeExpression}>
                  换个表情
                </button>
              </div>
            </div>
          )}
        </div>

        <p
          style={{
            margin: "14px 0 0",
            fontSize: 13,
            fontWeight: 600,
            lineHeight: 1.55,
            letterSpacing: "-0.01em"
          }}
        >
          {secretary.headline}
        </p>
        <p
          role={notice ? "status" : undefined}
          style={{
            margin: "8px 0 0",
            fontSize: 11,
            lineHeight: 1.7,
            color: "var(--dim-ink-soft)"
          }}
        >
          {notice ?? secretary.note}
        </p>

        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>{secretary.stageLabel}</span>
          {secretary.stageNote && (
            <span className="dim-relation-note">{secretary.stageNote}</span>
          )}
        </div>

        <div className="dim-relation-list" aria-label="关系进度">
          {relationMetrics.map((metric) => {
            const value = Math.max(0, Math.min(100, metric.value));
            const stage = relationStage(metric);
            return (
              <div className="dim-relation-row" key={metric.label}>
                <div className="dim-relation-labels">
                  <span>{metric.label}</span>
                  <span>{stage}</span>
                </div>
                <div
                  className="dim-relation-meter"
                  role="progressbar"
                  aria-label={`${metric.label} · ${stage}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={value}
                >
                  <i
                    aria-hidden="true"
                    style={{ width: `${value}%`, background: RELATION_TONE[metric.tone] }}
                  />
                </div>
                {metric.basis && (
                  <details className="dim-relation-details">
                    <summary aria-label={`查看${metric.label}依据`}>查看依据</summary>
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
                        aria-label={`查看${metric.label}来源详情`}
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
      </div>

      <div className="dim-rail-footer">
        {/* 这个按钮就是「30 天」和「我们」的入口 —— 关系本来就是随时间长出来的 */}
        <button
          type="button"
          className="dim-btn dim-rail-footer-button"
          onClick={review}
          disabled={!reviewEnabled}
          aria-disabled={!reviewEnabled}
          title={reviewEnabled ? undefined : "真实周回顾已在组件设置中关闭"}
        >
          看看我们是怎么熟起来的
        </button>
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
  onWhy,
  onAdjust
}: {
  breadcrumb: string;
  title: string;
  subtitle: string;
  onWhy?: () => void;
  onAdjust?: () => void;
}) {
  return (
    <div
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

      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button type="button" className="dim-btn dim-btn--quiet" onClick={onWhy}>
          为什么这样排?
        </button>
        <button type="button" className="dim-btn" onClick={onAdjust}>
          调整桌面
        </button>
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
        placeholder="说点什么，或者让秘书改动这张桌面……"
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
