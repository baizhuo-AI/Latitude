import type { Story, StoryDefault } from "@ladle/react";
import "../styles/index.css";
import { SecretaryPortrait } from "./SecretaryPortrait";
import type { Secretary, SecretaryGesture, SecretaryState } from "./types";
import "./dimension.css";

export default {
  title: "Dimension/秘书立绘"
} satisfies StoryDefault;

const STATES: { state: SecretaryState; stateCn: string }[] = [
  { state: "ready", stateCn: "在岗" },
  { state: "thinking", stateCn: "在想" },
  { state: "presenting", stateCn: "有事说" }
];

const GROWTH = [
  { label: "初识", familiarity: 10, rapport: 10, authority: 0 },
  { label: "渐熟", familiarity: 52, rapport: 48, authority: 34 },
  { label: "熟稔", familiarity: 94, rapport: 88, authority: 82 }
];

const ACTIONS: {
  state: SecretaryState;
  stateCn: string;
  gestures: { gesture: SecretaryGesture; label: string }[];
}[] = [
  {
    state: "ready",
    stateCn: "在岗",
    gestures: [
      { gesture: "idle", label: "待机" },
      { gesture: "listening", label: "倾听" },
      { gesture: "organizing", label: "整理" }
    ]
  },
  {
    state: "thinking",
    stateCn: "在想",
    gestures: [
      { gesture: "pondering", label: "琢磨" },
      { gesture: "writing", label: "记录" },
      { gesture: "comparing", label: "对照" }
    ]
  },
  {
    state: "presenting",
    stateCn: "有事说",
    gestures: [
      { gesture: "offering", label: "递交" },
      { gesture: "reminding", label: "提醒" },
      { gesture: "acknowledging", label: "确认结果" }
    ]
  }
];

function secretary(
  state: SecretaryState,
  stateCn: string,
  familiarity: number,
  rapport: number,
  authority: number,
  gesture?: SecretaryGesture
): Secretary {
  return {
    eyebrow: "Your Secretary",
    state,
    stateCn,
    headline: "",
    note: "",
    stageLabel: "",
    stageProgress: familiarity,
    stageNote: "",
    ...(gesture ? { gesture } : {}),
    metrics: [
      { label: "熟悉", value: familiarity, tone: "olive" },
      { label: "默契", value: rapport, tone: "blue" },
      { label: "权能", value: authority, tone: "rust" }
    ]
  };
}

/**
 * 每个运行状态对应三种确定动作。这里保持养成参数一致，只检查动作语义、
 * 角色一致性和九张资源在固定画框里的裁切。
 */
export const ActionMatrix: Story = () => (
  <div
    className="dimension-root"
    style={{ minHeight: "100vh", padding: 28, boxSizing: "border-box" }}
  >
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "88px repeat(3, 176px)",
        gap: "18px 20px",
        alignItems: "center"
      }}
    >
      <span />
      <p className="dim-eyebrow" style={{ textAlign: "center" }}>
        DEFAULT
      </p>
      <p className="dim-eyebrow" style={{ textAlign: "center" }}>
        ACTIVE 01
      </p>
      <p className="dim-eyebrow" style={{ textAlign: "center" }}>
        ACTIVE 02
      </p>

      {ACTIONS.map(({ state, stateCn, gestures }) => (
        <div key={state} style={{ display: "contents" }}>
          <p className="dim-eyebrow">
            {state.toUpperCase()}
            <br />/{stateCn}
          </p>
          {gestures.map(({ gesture, label }) => (
            <div key={gesture}>
              <p className="dim-eyebrow" style={{ textAlign: "center", marginBottom: 8 }}>
                {label} · {gesture}
              </p>
              <SecretaryPortrait
                secretary={secretary(state, stateCn, 62, 58, 54, gesture)}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  </div>
);

/**
 * 横向看运行状态，纵向看养成变化。这里故意不显示裸数值：
 * Story 的目标是检查「看起来有没有长大」，不是把数值做成人物等级。
 */
export const GrowthMatrix: Story = () => (
  <div
    className="dimension-root"
    style={{ minHeight: "100vh", padding: 28, boxSizing: "border-box" }}
  >
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "72px repeat(3, 176px)",
        gap: "18px 20px",
        alignItems: "center"
      }}
    >
      <span />
      {STATES.map(({ state, stateCn }) => (
        <p key={state} className="dim-eyebrow" style={{ textAlign: "center" }}>
          {state.toUpperCase()} / {stateCn}
        </p>
      ))}

      {GROWTH.flatMap((growth) => [
        <p key={`${growth.label}-label`} className="dim-eyebrow">
          {growth.label}
        </p>,
        ...STATES.map(({ state, stateCn }) => (
          <SecretaryPortrait
            key={`${growth.label}-${state}`}
            secretary={secretary(
              state,
              stateCn,
              growth.familiarity,
              growth.rapport,
              growth.authority
            )}
          />
        ))
      ])}
    </div>
  </div>
);
