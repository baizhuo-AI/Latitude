import type { DesktopProjection } from "./types";

/**
 * 可重复的种子投影：只为验证布局、信息密度和交互契约。
 * 所有内容都明确是样例，不冒充 SQLite 或秘书核心的真实输出。
 *
 * 场景设定：一个给客户做交付、同时在写自己 newsletter 的人的一天——
 * 早报摊在左上，工作待办散在中间，核心记忆点贴在右侧。
 */
export const SEED_DESKTOP_PROJECTION = {
  generatedAt: "2026-08-21T09:00:00-07:00",
  runtimeStatus: "demo",
  header: {
    breadcrumb: "TODAY · FOCUS",
    title: "上午先把客户 1 的日报发出去",
    subtitle: "两件客户的事排在下午前；newsletter 不抢注意力，写完日报再说。"
  },
  constellation: {
    northStar: {
      title: "TO BE AGI",
      detail: "把认知、行动与反馈收进同一个会持续进化的系统。",
      status: "demo"
    },
    // 仅供明确标注的演示桌面；真实桌面没有 Goal→Action 血缘时不显示目标进度。
    progress: {
      percent: 60,
      label: "这周到这里"
    },
    cognitions: [
      {
        id: "systems-thinking",
        label: "系统思维",
        detail: "AI 观察：你更愿意先看结构和约束，再讨论局部动作。",
        epistemic: "inferred"
      },
      {
        id: "evidence-first",
        label: "证据优先",
        detail: "AI 观察：比起漂亮框架，你更在意能否被代码和结果验证。",
        epistemic: "inferred"
      },
      {
        id: "high-agency",
        label: "高自主性",
        detail: "AI 观察：你偏好能主动推进、也清楚权限边界的协作者。",
        epistemic: "inferred"
      },
      {
        id: "long-horizon",
        label: "长期主义",
        detail: "AI 观察：你会把今天的交付放进更长的能力复利里看。",
        epistemic: "inferred"
      },
      {
        id: "anti-cliche",
        label: "反套路",
        detail: "AI 观察：你对空泛术语敏感，更喜欢直接、具体、有判断的表达。",
        epistemic: "inferred"
      },
      {
        id: "outcome-driven",
        label: "强结果感",
        detail: "AI 观察：完成不等于说过或写过，而是结果已经留下证据。",
        epistemic: "inferred"
      }
    ]
  },
  secretary: {
    eyebrow: "YOUR SECRETARY",
    state: "presenting",
    gesture: "offering",
    stateCn: "今日整理好了",
    headline: "我把今天收成了四个锚点。",
    note: "先发日报，再修 badcase；记忆里那两条工作习惯，今天也带着。",
    stageLabel: "关系 · 脱敏演示",
    stageProgress: 0,
    stageNote: "",
    metrics: [
      {
        label: "熟悉",
        value: 46,
        tone: "olive",
        stage: "初步熟悉",
        basis: "已整理目标层级与两类脱敏样本，尚未经过长期互动校准。",
        epistemicAuthority: "imported_unverified",
        correctable: true
      },
      {
        label: "默契",
        value: 32,
        tone: "blue",
        stage: "正在建立",
        basis: "已能复述部分偏好，但尚无真实行动结果闭环。",
        epistemicAuthority: "imported_unverified",
        correctable: true
      },
      {
        label: "权能",
        value: 0,
        tone: "rust",
        stage: "未授权",
        basis: "本演示没有授权记录。",
        epistemicAuthority: "system_recorded",
        correctable: false
      }
    ]
  },
  bindings: {
    "desktop.feed": {
      kind: "feed",
      items: [
        {
          id: "feed-daily-report-format",
          title: "客户 1 的日报模板昨晚改版了",
          why: "你今天上午要发的日报沿用旧格式；新模板把「风险」提到了第一栏。",
          source: "客户 1 交付群 · 记录显示",
          lineage: {
            entityType: "todo",
            entityId: "seed-todo-daily-report",
            label: "关联今天的日报"
          }
        },
        {
          id: "feed-badcase-taxonomy",
          title: "agent badcase 分类法有一篇新总结",
          why: "你下午要改客户 2 的 badcase；这篇把「答非所问」拆成了两类，可能省你半小时。",
          source: "方法论周刊 · 记录显示",
          lineage: {
            entityType: "todo",
            entityId: "seed-todo-badcase",
            label: "关联下午的修改"
          }
        }
      ]
    },
    "desktop.schedule": {
      kind: "anchors",
      rows: [
        {
          text: "给客户 1 准备日报",
          meta: "11:00 前",
          actionable: true,
          tags: ["工作现状"],
          lineage: {
            entityType: "todo",
            entityId: "seed-todo-daily-report",
            label: "来自你的待办"
          }
        },
        {
          text: "修改客户 2 的 agent badcase",
          meta: "14:00",
          actionable: true,
          tags: ["工作现状"],
          lineage: {
            entityType: "todo",
            entityId: "seed-todo-badcase",
            label: "来自你的待办"
          }
        },
        {
          text: "newsletter 选题草稿：AI 时代的判断力",
          meta: "16:00",
          actionable: true,
          tags: ["个人项目进度"],
          lineage: {
            entityType: "todo",
            entityId: "seed-todo-newsletter",
            label: "来自你的待办"
          }
        },
        {
          text: "周五前定下 Q3 学习计划",
          meta: "本周",
          actionable: true,
          tags: ["短期规划"],
          lineage: {
            entityType: "todo",
            entityId: "seed-todo-q3-plan",
            label: "来自你的待办"
          }
        }
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
      kind: "note",
      body: "工作时多盯一眼业务数据指标——数据变化先于结论。",
      quote: "方法论要沉淀成思考，写下来才算数。"
    }
  },
  journalSpreads: {}
} satisfies DesktopProjection;
