import type { CSSProperties } from "react";
import readyPortrait from "../assets/secretary/secretary-ready.png";
import readyListeningPortrait from "../assets/secretary/secretary-ready-listening.png";
import readyOrganizingPortrait from "../assets/secretary/secretary-ready-organizing.png";
import thinkingPortrait from "../assets/secretary/secretary-thinking.png";
import thinkingWritingPortrait from "../assets/secretary/secretary-thinking-writing.png";
import thinkingComparingPortrait from "../assets/secretary/secretary-thinking-comparing.png";
import presentingPortrait from "../assets/secretary/secretary-presenting.png";
import presentingRemindingPortrait from "../assets/secretary/secretary-presenting-reminding.png";
import presentingAcknowledgingPortrait from "../assets/secretary/secretary-presenting-acknowledging.png";
import type {
  RelationMetric,
  Secretary,
  SecretaryGesture,
  SecretaryState
} from "./types";

const STATE_EN: Record<SecretaryState, string> = {
  ready: "READY",
  thinking: "THINKING",
  presenting: "PRESENTING"
};

const PORTRAIT_BY_GESTURE: Record<SecretaryGesture, string> = {
  idle: readyPortrait,
  listening: readyListeningPortrait,
  organizing: readyOrganizingPortrait,
  pondering: thinkingPortrait,
  writing: thinkingWritingPortrait,
  comparing: thinkingComparingPortrait,
  offering: presentingPortrait,
  reminding: presentingRemindingPortrait,
  acknowledging: presentingAcknowledgingPortrait
};

const DEFAULT_GESTURE: Record<SecretaryState, SecretaryGesture> = {
  ready: "idle",
  thinking: "pondering",
  presenting: "offering"
};

const GESTURES_BY_STATE: Record<SecretaryState, ReadonlySet<SecretaryGesture>> = {
  ready: new Set<SecretaryGesture>(["idle", "listening", "organizing"]),
  thinking: new Set<SecretaryGesture>(["pondering", "writing", "comparing"]),
  presenting: new Set<SecretaryGesture>(["offering", "reminding", "acknowledging"])
};

// ImageGen 当前批次有五张动作图稳定输出为暖纸底，而不是可验证的 alpha。
// 它们仍可用于本 PRD 明确限定的纸张主题；独立 class 让画框做融合，也为后续
// 替换成透明切图保留一个可删除的兼容点。
const PAPER_MATTE_GESTURES = new Set<SecretaryGesture>([
  "organizing",
  "writing",
  "comparing",
  "reminding",
  "acknowledging"
]);

const GESTURE_CN: Record<SecretaryGesture, string> = {
  idle: "待机",
  listening: "倾听",
  organizing: "整理",
  pondering: "琢磨",
  writing: "记录",
  comparing: "对照",
  offering: "递交",
  reminding: "提醒",
  acknowledging: "确认结果"
};

function metricValue(metrics: RelationMetric[], label: RelationMetric["label"]): number {
  return Math.max(0, Math.min(100, metrics.find((metric) => metric.label === label)?.value ?? 0));
}

/**
 * 立绘的三条养成映射彼此正交，不能合成一个「关系分」：
 * - 熟悉：角色在画框里的体量，连续生长；
 * - 默契：待机动作的呼吸幅度；
 * - 权能：已显式授予的工具层级，以页签数量表示。
 *
 * 这样「授权更多」不会被误画成「关系更亲密」，也不会因为数值变化把
 * 同一个成年角色画成不同年龄的人。
 */
export function SecretaryPortrait({ secretary }: { secretary: Secretary }) {
  const familiarity = metricValue(secretary.metrics, "熟悉");
  const rapport = metricValue(secretary.metrics, "默契");
  const authority = metricValue(secretary.metrics, "权能");

  // 低阶段仍能看清表情；高阶段接近撑满画框，但不会顶到状态徽章。
  const growthScale = 0.76 + (familiarity / 100) * 0.28;
  const ringScale = 0.74 + (familiarity / 100) * 0.26;
  const motion = 0.45 + (rapport / 100) * 1.35;
  // 权能只反映用户已经显式授予的工具，不根据熟悉或默契自动增长。
  const authorityTier = authority < 25 ? 0 : authority < 50 ? 1 : authority < 75 ? 2 : 3;

  // 动作必须来自业务语义，不随机轮播。状态与动作不匹配时使用状态默认动作。
  const requestedGesture = secretary.gesture ?? DEFAULT_GESTURE[secretary.state];
  const gesture = GESTURES_BY_STATE[secretary.state].has(requestedGesture)
    ? requestedGesture
    : DEFAULT_GESTURE[secretary.state];

  const style = {
    "--dim-portrait-growth": growthScale,
    "--dim-portrait-ring": ringScale,
    "--dim-portrait-motion": `${motion}px`
  } as CSSProperties;

  return (
    <div
      className={`dim-portrait dim-portrait-state-${secretary.state} dim-portrait-gesture-${gesture}`}
      style={style}
      role="img"
      aria-label={`秘书状态：${secretary.stateCn}；动作：${GESTURE_CN[gesture]}`}
    >
      <div className="dim-secretary-growth" aria-hidden="true">
        <img
          className={`dim-secretary-sprite${
            PAPER_MATTE_GESTURES.has(gesture) ? " dim-secretary-sprite-paper-matte" : ""
          }`}
          src={PORTRAIT_BY_GESTURE[gesture]}
          alt=""
          draggable={false}
        />
      </div>

      {authorityTier > 0 && (
        <span className="dim-authority-tabs" aria-hidden="true">
          {Array.from({ length: authorityTier }, (_, index) => (
            <i key={index} />
          ))}
        </span>
      )}

      <span className="dim-badge">
        {STATE_EN[secretary.state]} / {secretary.stateCn}
      </span>
    </div>
  );
}
