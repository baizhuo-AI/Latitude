import type { CognitionCard, JournalSpread } from "./types";

/**
 * 手帐本内页 —— 认知卡被打开后的样子。
 *
 * 它不是模态。桌面层是后退淡出、不是被遮住,合上就原样回来 ——
 * 物理隐喻自己解释了为什么用户不会迷失:一本摊开的本子,合上就还在桌上。
 *
 * 装下了 PRD 6.1 要求的八段。其中两条是硬要求,不是排版偏好:
 *  - 支持与反证两栏同字号、同版式。哪一栏被弱化,系统就在替用户挑好听的听;
 *  - 不确定性必须露出来,且用第一人称写(页边手写体),不能藏进折叠区。
 */
export function JournalPage({
  card,
  spread,
  onClose,
  onCorrect
}: {
  card: CognitionCard;
  spread: JournalSpread;
  onClose?: () => void;
  onCorrect?: (choice: string) => void;
}) {
  return (
    <div style={{ display: "flex", height: "100%" }}>
      {/* 活页装订边 */}
      <div
        style={{
          width: 46,
          flexShrink: 0,
          borderRight: "1px solid rgb(195 94 74 / 28%)",
          background: "rgb(238 231 213 / 50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "space-around",
          padding: "42px 0"
        }}
        aria-hidden="true"
      >
        <span className="dim-punch" />
        <span className="dim-punch" />
        <span className="dim-punch" />
        <span className="dim-punch" />
      </div>

      <div style={{ flex: 1, minWidth: 0, padding: "20px 26px 22px", overflowY: "auto" }}>
        {/* 页头 */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16
          }}
        >
          <div>
            <p className="dim-eyebrow">摊开 · Cognition</p>
            <p className="dim-hand" style={{ margin: "2px 0 0", fontSize: 16 }}>
              这一页是同一张纸的里面
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="dim-stamp">
              <span
                className="dim-meta"
                style={{ fontSize: 10.5, letterSpacing: "0.18em", color: "rgb(195 94 74 / 85%)" }}
              >
                {stampDate()}
              </span>
            </span>
            <button type="button" className="dim-btn" onClick={onClose}>
              ← 合上，回桌面
            </button>
          </div>
        </div>

        {/* 1 主判断 */}
        <h2
          style={{
            margin: "16px 0 0",
            fontSize: 19,
            fontWeight: 600,
            lineHeight: 1.58,
            letterSpacing: "-0.012em",
            maxWidth: 660,
            textWrap: "pretty"
          }}
        >
          {card.blindSpot}
        </h2>
        <svg
          width="290"
          height="10"
          viewBox="0 0 290 10"
          style={{ display: "block", margin: "4px 0 0 -3px" }}
          aria-hidden="true"
        >
          <path
            d="M4 6 Q 74 2, 146 5 T 286 4"
            fill="none"
            stroke="var(--dim-rust)"
            strokeWidth="1.8"
            strokeLinecap="round"
            opacity="0.5"
          />
        </svg>

        {/* 2 被挑战的判断原话 */}
        <div
          style={{
            marginTop: 16,
            paddingLeft: 14,
            borderLeft: "2px solid rgb(124 138 62 / 45%)"
          }}
        >
          <p className="dim-eyebrow" style={{ marginBottom: 4 }}>
            你说过 · {card.claimKind} · 记录于 {spread.recordedAgo}
          </p>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7, color: "#4a463a" }}>
            {card.claim}
          </p>
        </div>

        {/* 3 为什么是今天 */}
        <p
          style={{
            margin: "14px 0 0",
            fontSize: 12,
            lineHeight: 1.75,
            color: "var(--dim-ink-soft)",
            maxWidth: 660
          }}
        >
          <span className="dim-eyebrow" style={{ display: "inline" }}>
            为什么是今天
          </span>
          {spread.trigger}
        </p>

        {/* 4 支持 / 反证:两栏平权 */}
        <div
          style={{
            marginTop: 20,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 26
          }}
        >
          <EvidenceColumn
            label={`支持这条判断　${spread.support.length}`}
            color="var(--dim-olive)"
            items={spread.support}
            empty="没找到支持它的证据 —— 这条判断可能只是习惯，不是结论。"
          />
          <EvidenceColumn
            label={`反对这条判断　${spread.contradict.length}`}
            color="var(--dim-rust)"
            items={spread.contradict}
            empty="没找到反证。不代表不存在，只代表我没找到 —— 别把它当成确认。"
          />
        </div>

        {/* 5+6 适用边界与不确定性 */}
        <div
          style={{
            marginTop: 20,
            padding: "13px 15px",
            background: "rgb(232 227 212 / 42%)",
            borderRadius: 1,
            maxWidth: 660
          }}
        >
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.7, color: "#5a5544" }}>
            <span className="dim-eyebrow" style={{ display: "inline" }}>
              什么情况下成立
            </span>
            {spread.scope}
          </p>
          <p className="dim-hand" style={{ margin: "8px 0 0", fontSize: 16, lineHeight: 1.4 }}>
            我可能哪里看错了：{spread.uncertainty}
          </p>
        </div>

        {/* 7 替代视角 */}
        <div
          style={{
            marginTop: 18,
            display: "flex",
            gap: 11,
            alignItems: "flex-start",
            maxWidth: 660
          }}
        >
          <svg
            width="24"
            height="28"
            viewBox="0 0 24 28"
            style={{ flexShrink: 0, marginTop: 2 }}
            aria-hidden="true"
          >
            <path
              d="M3 3 Q 4 17, 19 21"
              fill="none"
              stroke="var(--dim-olive)"
              strokeWidth="1.6"
              strokeLinecap="round"
              opacity="0.65"
            />
            <path
              d="M13 17 L 20 21.5 L 13 25"
              fill="none"
              stroke="var(--dim-olive)"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.65"
            />
          </svg>
          <div>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.72, color: "#4a463a" }}>
              {spread.alternative.body}
            </p>
            {/* 替代视角必须自带边界,否则只是把旧教条换成新教条 */}
            <p
              style={{
                margin: "6px 0 0",
                fontSize: 11.5,
                lineHeight: 1.6,
                color: "#a08b3e"
              }}
            >
              什么时候别用它：{spread.alternative.limits}
            </p>
          </div>
        </div>

        {/* 8 纠正入口 + 验证动作 */}
        <div style={{ marginTop: 22, display: "flex", gap: 20, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p className="dim-eyebrow" style={{ marginBottom: 8 }}>
              哪里不对
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {spread.corrections.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="dim-chip"
                  onClick={() => onCorrect?.(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {/* 验证动作贴在页面右下,像顺手贴上去的便签 */}
          <div
            className="dim-paper dim-paper--sticky"
            style={{
              width: 286,
              flexShrink: 0,
              padding: "15px 17px 14px",
              transform: "rotate(1.2deg)"
            }}
          >
            <span
              className="dim-tape"
              aria-hidden="true"
              style={{
                top: -9,
                left: "50%",
                marginLeft: -30,
                width: 60,
                backgroundColor: "rgb(198 216 48 / 50%)",
                transform: "rotate(-2deg)"
              }}
            />
            <p className="dim-eyebrow" style={{ color: "var(--dim-ink-sticky)" }}>
              {spread.action.meta}
            </p>
            <p style={{ margin: "8px 0 0", fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>
              {spread.action.title}
            </p>
            <p
              style={{
                margin: "8px 0 0",
                fontSize: 11.5,
                lineHeight: 1.65,
                color: "var(--dim-ink-soft)"
              }}
            >
              {spread.action.signal}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 证据栏。两栏共用同一个组件,保证版式不会偏心。 */
function EvidenceColumn({
  label,
  color,
  items,
  empty
}: {
  label: string;
  color: string;
  items: { text: string; origin?: string }[];
  empty: string;
}) {
  return (
    <div>
      <p className="dim-eyebrow" style={{ color, marginBottom: 10 }}>
        {label}
      </p>
      {items.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.65, color: "var(--dim-ink-faint)" }}>
          {empty}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          {items.map((it, i) => (
            <p
              key={i}
              style={{
                margin: 0,
                fontSize: 12,
                lineHeight: 1.65,
                color: "#5a5544",
                display: "flex",
                gap: 9,
                alignItems: "flex-start"
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  flexShrink: 0,
                  border: `1px solid ${color}`,
                  transform: "rotate(45deg)",
                  marginTop: 6
                }}
                aria-hidden="true"
              />
              <span>
                {it.text}
                {it.origin && (
                  <span className="dim-meta" style={{ marginLeft: 6 }}>
                    {it.origin}
                  </span>
                )}
              </span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** 页头的橡皮章日期,格式 MM · DD */
function stampDate(): string {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")} · ${String(d.getDate()).padStart(2, "0")}`;
}
