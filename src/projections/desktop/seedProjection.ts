import type { DesktopProjection } from "./types";

/**
 * 可重复的种子投影：只为验证布局、信息密度和交互契约。
 * 所有内容都明确是样例，不冒充 SQLite 或秘书核心的真实输出。
 */
export const SEED_DESKTOP_PROJECTION = {
  generatedAt: "2026-08-21T09:00:00-07:00",
  runtimeStatus: "demo",
  header: {
    breadcrumb: "TODAY · FOCUS",
    title: "今天，把方案推进到可评审",
    subtitle: "上午收口主线，下午验证一个关键交互；其他事情先不抢注意力。"
  },
  secretary: {
    eyebrow: "YOUR SECRETARY",
    state: "presenting",
    gesture: "offering",
    stateCn: "今日整理好了",
    headline: "我把今天收成了三个锚点。",
    note: "先完成评审稿，再用一次小范围试跑换取真实反馈；晚饭前收工。",
    stageLabel: "默契 · 合拍",
    stageProgress: 74,
    stageNote: "我会记住你的取舍，但每一步都由你决定。",
    metrics: [
      { label: "熟悉", value: 78, tone: "olive" },
      { label: "默契", value: 71, tone: "blue" },
      { label: "权能", value: 46, tone: "rust" }
    ]
  },
  bindings: {
    "desktop.feed": {
      kind: "feed",
      items: [
        {
          id: "feed-reviewable-first",
          title: "先做可评审版本，再补完整版本",
          why: "你今天要确认的是方向是否成立；一份能走通的版本，比继续补材料更接近答案。",
          source: "产品决策手册 · 小步验证",
          lineage: {
            entityType: "plan",
            entityId: "seed-plan-review",
            label: "关联今天的评审"
          }
        }
      ]
    },
    "desktop.schedule": {
      kind: "anchors",
      rows: [
        {
          text: "完成评审稿：只收口核心路径",
          meta: "NOW",
          lineage: {
            entityType: "plan",
            entityId: "seed-plan-review",
            label: "来自今日重点"
          }
        },
        {
          text: "和设计走一遍关键交互",
          meta: "14:00",
          lineage: {
            entityType: "experiment",
            entityId: "seed-experiment-walkthrough",
            label: "来自小范围试跑"
          }
        },
        { text: "记下结论，按时收工", meta: "18:30" }
      ]
    },
    "desktop.reviewPlan": {
      kind: "progress",
      body: "本周已经确认：先看核心路径是否成立，再决定要不要投入完整版本。",
      percent: 60,
      leftMeta: "试跑中 · 周五回看"
    },
    "desktop.rhythm": {
      kind: "chart",
      bars: [0.18, 0.28, 0.72, 0.9, 0.82, 0.44, 0.32, 0.58],
      link: "看今天的节奏"
    },
    "desktop.flex": {
      kind: "proposal",
      quote: "用 25 分钟把核心路径走一遍；如果没有新信息，就保持原方案。",
      accept: "先这样试",
      reject: "晚点再说"
    }
  },
  journalSpreads: {}
} satisfies DesktopProjection;
