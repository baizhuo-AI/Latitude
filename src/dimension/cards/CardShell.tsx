import { createContext, useContext, useEffect, useRef } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { Tape } from "../types";
import "./cardShell.css";

export const CardReadingContext = createContext(false);

/**
 * 纸片外壳 —— 九种卡片共用的容器。
 *
 * 承载这套语言的三个签名:暖调纸质与细边框、各自歪一点点、
 * 等宽大写英文标签压在中文标题之上。手帐点缀(胶带 / 回形针 / 折角)
 * 由数据描述,组件只管渲染 —— 见 types.ts 顶部关于「性格写在数据里」的说明。
 *
 * 具体卡片只负责 children,不重复实现纸质和标题。
 */

export function CardShell({
  eyebrow,
  title,
  lead = false,
  tilt = 0,
  paper = "plain",
  offsetY = 0,
  tape,
  clip = false,
  dogear = false,
  openable = false,
  onOpen,
  hint,
  headerExtra,
  headerContent,
  footer,
  children
}: {
  eyebrow: string;
  title: string;
  /** 主位卡:标题放大到 17px。整张桌面只应有一张开这个 */
  lead?: boolean;
  tilt?: number;
  paper?: "plain" | "sticky" | "grid" | "newsprint";
  offsetY?: number;
  tape?: Tape;
  clip?: boolean;
  dogear?: boolean;
  /** 可被「打开」成手帐本内页。目前只有认知卡 */
  openable?: boolean;
  onOpen?: () => void;
  /** 悬停时出现的提示语,配合 openable */
  hint?: string;
  /** 标题行右侧的附加内容(如密度信号) */
  headerExtra?: ReactNode;
  /** 输入等需随标题保持可见的操作；长列表留在 children 中。 */
  headerContent?: ReactNode;
  /** 主要操作留在纸片底部，不随长正文滚走。 */
  footer?: ReactNode;
  children?: ReactNode;
}) {
  const reading = useContext(CardReadingContext);
  openable = openable && !reading;
  const openTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current);
    },
    []
  );

  const cls = [
    "dim-paper",
    "dim-card-shell",
    paper === "sticky" && "dim-paper--sticky",
    paper === "grid" && "dim-paper--grid",
    paper === "newsprint" && "dim-paper--newsprint",
    dogear && "dim-dogear",
    openable && "dim-openable"
  ]
    .filter(Boolean)
    .join(" ");

  const style: CSSProperties = {
    transform: tilt ? `rotate(${tilt}deg)` : undefined,
    marginTop: offsetY || undefined
  };

  // 可打开的纸片要能用键盘操作 —— 它是这张桌面上唯一的主动作
  const interactive = openable
    ? {
        "data-card-primary-action": "true",
        role: "button" as const,
        tabIndex: 0,
        onClick: (event: ReactMouseEvent<HTMLElement>) => {
          window.clearTimeout(openTimer.current);
          // 鼠标单击要给整卡双击编辑留出判定窗；键盘 click(detail=0) 立即打开。
          if (event.detail === 0) {
            onOpen?.();
          } else if (event.detail === 1) {
            openTimer.current = window.setTimeout(() => onOpen?.(), 230);
          }
        },
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            window.clearTimeout(openTimer.current);
            onOpen?.();
          }
        }
      }
    : {};

  return (
    <section className={cls} style={style} {...interactive}>
      {tape && <TapeStrip tape={tape} />}
      {clip && <PaperClip />}

      <header className="dim-card-header">
        <div className="dim-card-heading-meta">
          <p className="dim-eyebrow">{eyebrow}</p>
          {hint && <span className="dim-hint dim-hand">{hint}</span>}
        </div>
        <h3 className={lead ? "dim-title dim-title--lead" : "dim-title"}>{title}</h3>
        {headerExtra}
        {headerContent && <div className="dim-card-header-content" data-no-drag>{headerContent}</div>}
      </header>
      <div className="dim-card-body" data-no-drag data-deck-scroll="contain" tabIndex={0} role="region" aria-label={`${title}正文`}>
        {children}
      </div>
      {!reading && footer && <footer className="dim-card-footer" data-no-drag>{footer}</footer>}
    </section>
  );
}

/** 和纸胶带。压住纸片顶边一角,自身还带一点角度 —— 手贴的不会正。 */
function TapeStrip({ tape }: { tape: Tape }) {
  return (
    <span
      className="dim-tape"
      aria-hidden="true"
      style={{
        top: -10,
        [tape.side]: tape.offset,
        width: tape.width,
        backgroundColor: tape.color,
        transform: `rotate(${tape.tilt}deg)`
      }}
    />
  );
}

/** 回形针。夹在左上角,一半探到纸外。 */
function PaperClip() {
  return (
    <svg
      width="20"
      height="44"
      viewBox="0 0 20 44"
      style={{ position: "absolute", top: -13, left: 18 }}
      aria-hidden="true"
    >
      <path
        d="M4.5 40 V9 a5.5 5.5 0 0 1 11 0 V34"
        fill="none"
        stroke="#9c9585"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M10 34 a4 4 0 0 1-8 0 V13"
        fill="none"
        stroke="#9c9585"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
