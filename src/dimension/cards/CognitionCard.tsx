import { CardShell } from "./CardShell";
import type { CognitionCard as CognitionCardData } from "../types";

/**
 * 认知卡 —— 独占 `7` 主位,也是整张桌面唯一能被「打开」成手帐本内页的纸片。
 *
 * 三条设计约束(PRD 04 / 06.1):
 *  1. 盲点那句话是桌面上唯一的大字;
 *  2. 被挑战的判断用嵌入块,视觉上明确「这是你说过的,不是系统说的」;
 *  3. 底部必须露密度信号 —— 格子态和展开态的信息量差约 20 倍,
 *     不给信号,点开会有跳页的断裂感。
 */
export function CognitionCard({
  card,
  onOpen
}: {
  card: CognitionCardData;
  onOpen?: () => void;
}) {
  const { support, contradict } = card.density;

  return (
    <CardShell
      eyebrow={card.eyebrow}
      title={card.blindSpot}
      lead
      tilt={card.tilt}
      paper={card.paper}
      offsetY={card.offsetY}
      tape={card.tape}
      clip={card.clip}
      dogear={card.dogear}
      openable
      onOpen={onOpen}
      hint="摊开来看 →"
    >
      {/* 手绘下划线:压住主张的尾巴,像读的时候顺手划的 */}
      <svg
        width="182"
        height="9"
        viewBox="0 0 182 9"
        style={{ display: "block", margin: "3px 0 0 -2px" }}
        aria-hidden="true"
      >
        <path
          d="M3 6 Q 46 2, 90 5 T 179 4"
          fill="none"
          stroke="var(--dim-rust)"
          strokeWidth="1.7"
          strokeLinecap="round"
          opacity="0.5"
        />
      </svg>

      {/* 被挑战的那条判断 */}
      <div
        style={{
          marginTop: 16,
          padding: "11px 13px",
          background: "var(--dim-inset)",
          borderRadius: 1
        }}
      >
        <p className="dim-eyebrow" style={{ marginBottom: 4 }}>
          你说过 · {card.claimKind}
        </p>
        <p className="dim-body" style={{ color: "var(--dim-ink)" }}>
          {card.claim}
        </p>
      </div>

      {/* 替代视角提示,完整内容在内页 */}
      <p
        className="dim-body"
        style={{
          marginTop: 14,
          display: "flex",
          gap: 10,
          alignItems: "flex-start"
        }}
      >
        <span className="dim-diamond" style={{ marginTop: 7 }} aria-hidden="true" />
        <span>{card.alternativeHint}</span>
      </p>

      <div
        style={{
          marginTop: 16,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14
        }}
      >
        {/*
          反证为 0 不能只显示一个「0」—— 那读起来像「已确认」。
          没找到反证是证据薄弱的信号,必须说出来,否则就是在用 AI 茧房
          替代算法茧房(重构计划第 11 节)。
        */}
        <span
          className="dim-meta"
          style={contradict === 0 ? { color: "var(--dim-rust)" } : undefined}
        >
          {contradict === 0
            ? `支持 ${support} · 未找到反证`
            : `支持 ${support} · 反证 ${contradict}`}
        </span>
        <span className="dim-meta">◇ 可展开</span>
      </div>
    </CardShell>
  );
}
