import type { Desk, JournalSpread } from "./types";

/**
 * 桌面样例(前端先行阶段的唯一数据源)
 *
 * 为什么是写死的样例而不是接数据库:这一版要验证的不是「管道通不通」,
 * 而是「这张桌子上的话对不对得起用户的注意力」。先用够具体的内容把桌面撑起来,
 * 看清哪些字段真有人看,再倒推后端。
 *
 * 每张纸的倾斜角、纸质、胶带位置都写在数据里 —— 它们是内容的属性。
 * 交给组件随机生成的话,每次刷新桌面都会重排,用户会失去空间记忆。
 *
 * ⚠️ 证据里的日期和数字都是为演示编的,不是真实统计。
 */

export const DESK: Desk = {
  breadcrumb: "Home / Temporary Context",
  title: "今天，我们先一起把这件事做成",
  subtitle: "我知道什么该推到眼前，也知道什么不能因为忙就被牺牲。",

  secretary: {
    eyebrow: "Your Secretary",
    state: "presenting",
    stateCn: "递交",
    headline: "你先往前走，我替你守住节奏。",
    note: "该挡的提醒我先挡住，真正需要你拍板时再找你。",
    stageLabel: "默契 · 74",
    stageProgress: 74,
    stageNote: "我猜得到你的取舍：能替你判断一步，仍由你拍板。",
    metrics: [
      { label: "关系", value: 78, tone: "olive" },
      { label: "节奏", value: 82, tone: "blue" },
      { label: "默契", value: 71, tone: "amber" },
      { label: "权能", value: 46, tone: "rust" }
    ]
  },

  cards: [
    {
      kind: "cognition",
      id: "c-cognition",
      eyebrow: "Cognition / Worth Rethinking",
      title: "",
      span: 7,
      tilt: -0.5,
      tape: { side: "left", offset: 32, width: 84, color: "rgb(198 216 48 / 50%)", tilt: -2.5 },
      blindSpot:
        "你把「信息还不够」当成推迟的理由，但最近 6 次这样推迟的决定里，后来补到的信息只有 1 次真的改变了你的选择。",
      claim: "重要的决定要等信息足够了再做，不然会错。",
      claimKind: "假设",
      alternativeHint:
        "可逆的决定不需要等信息 —— 它自己就是最快的信息来源。真正需要等的是那些改不回来的。",
      density: { support: 2, contradict: 3 }
    },
    {
      kind: "anchors",
      id: "c-decisions",
      eyebrow: "Decisions / Waiting",
      title: "4 个待抉择",
      span: 5,
      tilt: 0.8,
      offsetY: 8,
      clip: true,
      arc: true,
      emptyHint: "手上的事都有下一步了。等有新的卡住的地方，我再放到这里。",
      rows: [
        { text: "主页自由度：模型能生成到什么程度", meta: "3D" },
        { text: "角色占比：秘书栏要不要可折叠", meta: "2D" },
        { text: "卡片权限：自定义 HTML 什么时候开", meta: "NEXT" },
        { text: "学习周期：多久重算一次关系参数", meta: "TODAY" }
      ]
    },
    {
      kind: "note",
      id: "c-gate",
      eyebrow: "Focus Gate / Temporary",
      title: "我先替你挡住低优先级提醒",
      span: 4,
      tilt: -1.1,
      paper: "sticky",
      dogear: true,
      body: "该挡的提醒我先挡住，真正需要你拍板时再找你。",
      quote: "直到 16:00 · 只放行会阻塞你的事"
    },
    {
      kind: "chart",
      id: "c-focus",
      eyebrow: "Today / Reshaped",
      title: "剩余 2 小时 10 分可深度工作",
      span: 4,
      tilt: 0.6,
      offsetY: 6,
      paper: "grid",
      bars: [0.25, 0.45, 0.62, 0.85, 0.5, 0.95, 0.55, 0.3, 0.7, 0.35],
      link: "打开日历"
    },
    {
      kind: "text",
      id: "c-anchor",
      eyebrow: "Life Anchor / Never Hidden",
      title: "18:30 下班",
      span: 4,
      tilt: -0.7,
      offsetY: 12,
      tape: { side: "right", offset: 24, width: 60, color: "rgb(195 94 74 / 32%)", tilt: 3 },
      body: "冲刺模式不会吞掉你设定的生活边界。"
    }
  ]
};

/**
 * 认知卡展开后的内页。
 *
 * 按 cardId 索引 —— 真接后端时这是点开才发的一次单独请求,
 * 格子态不该被迫把这一坨也加载进来。
 */
export const SPREADS: Record<string, JournalSpread> = {
  "c-cognition": {
    cardId: "c-cognition",
    recordedAgo: "109 天前",
    trigger:
      "这周有三件事停在「再看看」超过 4 天，其中两件的信息量从周一到现在没有变化。",
    support: [
      {
        text: "8/12—8/16 连续 5 天出现「再确认一下技术方案」类记录，方案文档没有新增修改。"
      },
      { text: "「定重构顺序」这条待办创建于 8/13，已顺延 3 次。" }
    ],
    contradict: [
      {
        text: "你说过「我的角色是出方案、定方向」—— 定方向本身就包含在信息不全时下判断。"
      },
      {
        text: "6 月定飞书入口方案时你半天就拍板，后续两个月没返工。那次信息量并不比现在多。"
      },
      {
        text: "可逆决策上，等信息的成本通常高于选错后改回来的成本。",
        origin: "外部材料"
      }
    ],
    scope: "信息可得、且补充信息的成本低于决策成本时。",
    uncertainty:
      "如果这几件事卡住是在等别人回复而不是等信息，这条对你不成立 —— 直接告诉我。",
    alternative: {
      body:
        "可逆的决定不需要等信息 —— 它自己就是最快的信息来源。真正需要等的是那些改不回来的。",
      limits: "涉及对外承诺、合同、招人辞人、公开发布这类，原来的谨慎是对的。"
    },
    action: {
      meta: "Verify / 25 min · 可逆",
      title: "挑一件卡了 3 天以上的事，25 分钟内定一个可逆版本",
      signal: "一周后回看：没改，或改了但只损失几天 —— 两种都算这个视角站得住。"
    },
    corrections: ["这个前提不成立", "这条证据不适用于我", "我早就这么想了", "现在不想谈这个"]
  }
};
