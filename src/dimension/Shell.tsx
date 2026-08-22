import { SecretaryPortrait } from "./SecretaryPortrait";
import type { Secretary } from "./types";

/**
 * 桌面的四个稳定区:应用头 / 秘书栏 / 标题区 / 对话条。
 *
 * 「稳定」是产品承诺的一部分 —— 桌面上的纸片每天会变,这四个区不变,
 * 用户的空间记忆挂在它们身上。设计稿里的顶部三阶段分段和底部三栏
 * 是给看稿人的注释层,不是 UI,这里没有。
 */

/* ---------- A 应用头 ---------- */

export function AppHeader({
  runtimeLabel = "运行状态未知",
  onSettings
}: {
  runtimeLabel?: string;
  onSettings?: () => void;
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

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        {/* 状态必须来自运行时投影。没有 adapter 时诚实地显示未知。 */}
        <span className="dim-eyebrow">{runtimeLabel}</span>
        <button type="button" className="dim-btn dim-btn--quiet" onClick={onSettings}>
          设置
        </button>
      </div>
    </header>
  );
}

/* ---------- B 秘书栏 ---------- */

export function SecretaryRail({
  secretary,
  onReview
}: {
  secretary: Secretary;
  onReview?: () => void;
}) {
  return (
    <aside
      className="dim-rail"
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "18px 16px 16px",
        overflowY: "auto"
      }}
    >
      <p className="dim-eyebrow">{secretary.eyebrow}</p>

      <div style={{ marginTop: 10 }}>
        <SecretaryPortrait secretary={secretary} />
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
        style={{
          margin: "8px 0 0",
          fontSize: 11,
          lineHeight: 1.7,
          color: "var(--dim-ink-soft)"
        }}
      >
        {secretary.note}
      </p>

      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{secretary.stageLabel}</span>
      </div>

      {/*
        熟悉 / 默契 / 权能仍会驱动立绘的体量、微动和工具页签，
        但实验期不把内部裸值或近似百分比暴露给用户（总纲 §5.5）。
      */}

      {/* 这个按钮就是「30 天」和「我们」的入口 —— 关系本来就是随时间长出来的 */}
      <button
        type="button"
        className="dim-btn"
        style={{ marginTop: "auto", width: "100%" }}
        onClick={onReview}
      >
        看看我们是怎么熟起来的
      </button>
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

export function CommandBar({ onSend }: { onSend?: (text: string) => void }) {
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
      />
      <span className="dim-meta" style={{ flexShrink: 0 }}>
        ⌘K
      </span>
      <button type="submit" className="dim-send" aria-label="发送">
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
