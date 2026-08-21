/**
 * 维度桌面 — 数据契约
 *
 * 一张桌面 = 秘书状态 + 关系参数 + 一组纸片。形态定稿见 design/Opening.dc.html。
 *
 * 这是前端投影,不是数据库 schema。当前只定义「渲染这张桌面需要什么」,
 * 等版式跑顺了再倒推后端表。
 *
 * 值得注意的一点:每张卡的「性格」(歪多少度、什么纸、贴不贴胶带)写在数据里,
 * 不写在组件里。桌面之所以像桌面而不像仪表盘,靠的就是每张纸各不相同 ——
 * 那是内容的属性,不该由渲染组件随机生成(随机会导致每次刷新都重排,
 * 用户会失去空间记忆)。
 */

/** 秘书状态。语义对齐 AI Listener 的角色状态机。 */
export type SecretaryState = "ready" | "thinking" | "presenting";

/** 关系参数。四条,口径按设计稿(关系 / 节奏 / 默契 / 权能)。 */
export interface RelationMetric {
  label: string;
  /** 0—100 */
  value: number;
  /** 取 dimension.css 里的强调色变量名 */
  tone: "olive" | "blue" | "amber" | "rust";
}

export interface Secretary {
  /** 立绘上方的小标签,如 YOUR SECRETARY */
  eyebrow: string;
  state: SecretaryState;
  /** 徽章右半的中文,如「在岗」「在想」「有事说」 */
  stateCn: string;
  /** 立绘下方的人格文案,两行以内 */
  headline: string;
  /** 补充说明,三行以内 */
  note: string;
  /** 阶段标签,如「默契 · 74」 */
  stageLabel: string;
  /** 0—100,阶段进度条 */
  stageProgress: number;
  stageNote: string;
  metrics: RelationMetric[];
}

/** 行内强调色。用于 meta 标签这类小面积着色,不再用于卡片边框。 */
export type CardAccent = "olive" | "rust" | "amber" | "teal";

/** 和纸胶带。贴在纸片顶边,压住一角。 */
export interface Tape {
  /** 贴在左边还是右边 */
  side: "left" | "right";
  /** 距该侧的距离(px) */
  offset: number;
  width: number;
  /** rgba 字符串,半透明才像和纸 */
  color: string;
  /** 胶带自己的倾斜角,和纸片的 tilt 无关 */
  tilt: number;
}

/** 所有卡片共享的外壳字段。 */
interface CardBase {
  id: string;
  /** 等宽大写英文标签,如 COGNITION / WORTH RETHINKING */
  eyebrow: string;
  title: string;
  /** 12 栅格里占几列 */
  span: number;
  /**
   * 纸片倾斜角度(度)。规范:绝对值不超过 1.2 ——
   * 再大就从「自然摊在桌上」变成「刻意做旧」。
   */
  tilt?: number;
  /** 纸质。sticky = 便签黄,grid = 方格纸 */
  paper?: "plain" | "sticky" | "grid";
  /** 顶部错位(px),让同一排的纸不齐平 */
  offsetY?: number;
  tape?: Tape;
  /** 左上角的回形针 */
  clip?: boolean;
  /** 右下角折角(便签常用) */
  dogear?: boolean;
}

/**
 * 认知卡 —— 独占 `7` 主位,整张桌面唯一需要停下来读的卡片。
 *
 * 格子态只放「盲点一句话 + 被挑战的判断 + 替代视角提示 + 密度信号」。
 * 完整内容(证据、反证、适用边界、不确定性、验证动作、纠正入口)在展开态,
 * 见 PRD 06.1。density 是刻意设计的:格子和展开态的信息量差约 20 倍,
 * 不给密度信号用户就无法预判点开会看到什么。
 */
export interface CognitionCard extends CardBase {
  kind: "cognition";
  /** 盲点的一句话表述 —— 卡片上最重要的一行,也是整张桌面的主张 */
  blindSpot: string;
  /** 被挑战的那条判断,用用户自己的措辞复述,不用系统腔 */
  claim: string;
  /** 这条判断的类型:信念 / 假设 / 框架 / 价值 / 偏好 / 边界 */
  claimKind: string;
  /** 替代视角的一句话摘要,完整内容在展开态 */
  alternativeHint: string;
  /** 密度信号:展开后有多少支持证据、多少反证 */
  density: { support: number; contradict: number };
}

/** ◇ 锚点列表:左侧菱形 + 文字,右侧对齐时间或状态标 */
export interface AnchorCard extends CardBase {
  kind: "anchors";
  rows: { text: string; meta: string }[];
  /**
   * rows 为空时显示的说明。
   * 网格是等高的,空列表不给文案就会留下一个空盒子 —— 那看起来像加载失败,
   * 而不是「今天真的没有」。
   */
  emptyHint?: string;
  /** 右下角的虚线弧装饰(demo 里今日锚点卡有) */
  arc?: boolean;
}

/** 大数字卡:一个数 + 单位 + 一句说明 */
export interface CountCard extends CardBase {
  kind: "count";
  count: number;
  unit: string;
  body: string;
}

/** 便签卡:米黄底 + 左缘竖条 + 一句话 */
export interface NoteCard extends CardBase {
  kind: "note";
  body: string;
  /** 竖条引出的重点句 */
  quote: string;
}

/** 柱状图卡:一天的可用时段分布 */
export interface ChartCard extends CardBase {
  kind: "chart";
  /** 每根柱的高度比例 0—1 */
  bars: number[];
  /** 图下方的链接文案,可空 */
  link?: string;
}

/** 纯文字卡 */
export interface TextCard extends CardBase {
  kind: "text";
  body: string;
  link?: string;
}

/** 提案卡:等待用户回应,带两个动作 */
export interface ProposalCard extends CardBase {
  kind: "proposal";
  quote: string;
  accept: string;
  reject: string;
}

/** 进度卡:标题 + 说明 + 进度条 + 左右两个角标 */
export interface ProgressCard extends CardBase {
  kind: "progress";
  body: string;
  /** 0—100 */
  percent: number;
  leftMeta: string;
}

export type DeskCard =
  | CognitionCard
  | AnchorCard
  | CountCard
  | NoteCard
  | ChartCard
  | TextCard
  | ProposalCard
  | ProgressCard;

/** 一张完整的桌面。 */
export interface Desk {
  /** HOME / TEMPORARY CONTEXT */
  breadcrumb: string;
  title: string;
  subtitle: string;
  secretary: Secretary;
  cards: DeskCard[];
}

/**
 * 认知卡展开成手帐本内页时,格子态之外还需要的内容。
 *
 * 单独一个类型而不是塞进 CognitionCard:格子态渲染不该被迫加载这一坨,
 * 真接后端时它是一次单独的请求(点开才拉)。
 */
export interface JournalSpread {
  cardId: string;
  /** 为什么是今天(触发原因) */
  trigger: string;
  /** 这条判断被记录了多久 */
  recordedAgo: string;
  /** 支持与反对分列两栏,视觉平权是硬要求 */
  support: { text: string; origin?: string }[];
  contradict: { text: string; origin?: string }[];
  /** 什么情况下这条判断成立 */
  scope: string;
  /** 系统的不确定性,用第一人称写,页边手写体呈现 */
  uncertainty: string;
  /** 替代视角全文 + 什么时候别用它 */
  alternative: { body: string; limits: string };
  /** 验证动作,贴在页面右下的便签 */
  action: { meta: string; title: string; signal: string };
  /** 纠正入口的结构化选项 */
  corrections: string[];
}
