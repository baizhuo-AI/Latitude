/**
 * 维度桌面 — 数据契约
 *
 * 一张桌面 = 秘书状态 + 养成参数 + 一组纸片。形态定稿见 design/Opening.dc.html。
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

/**
 * 秘书动作。动作由当前任务语义明确选择，不做随机轮播：
 * - ready: idle / listening / organizing
 * - thinking: pondering / writing / comparing
 * - presenting: offering / reminding / acknowledging
 *
 * 组件会再次校验动作与状态的组合；不合法时回退到该状态的默认动作。
 */
export type SecretaryGesture =
  | "idle"
  | "listening"
  | "organizing"
  | "pondering"
  | "writing"
  | "comparing"
  | "offering"
  | "reminding"
  | "acknowledging";

/**
 * 养成参数。**三条**:熟悉 / 默契 / 权能(总纲 §5.5)。
 *
 * 「关系」本身不做数值 —— 那会被理解成情感好感度;数值与阶段一律挂在三参数上。
 * 设计稿里的第四条「节奏」已退役(它是内容节律,不是养成维度)。
 *
 * value 仅供内部排序与进度条,外显默认走阶段名(见 Secretary.stageLabel)。
 */
export interface RelationMetric {
  /** 只能是三者之一,口径见总纲 §5.5 */
  label: "熟悉" | "默契" | "权能";
  /** 0—100,内部值;不作为默认外显 */
  value: number;
  /** 取 dimension.css 里的强调色变量名 */
  tone: "olive" | "blue" | "rust";
}

export interface Secretary {
  /** 立绘上方的小标签,如 YOUR SECRETARY */
  eyebrow: string;
  state: SecretaryState;
  /** 当前任务语义对应的动作；省略时按 state 使用确定性默认值。 */
  gesture?: SecretaryGesture;
  /** 徽章右半的中文,如「在岗」「在想」「有事说」 */
  stateCn: string;
  /** 立绘下方的人格文案,两行以内 */
  headline: string;
  /** 补充说明,三行以内 */
  note: string;
  /** 阶段标签。默认显示**阶段名**而非裸数值,如「默契 · 合拍」(总纲 §5.5) */
  stageLabel: string;
  /** 0—100,阶段进度条 */
  stageProgress: number;
  stageNote: string;
  metrics: RelationMetric[];
}

/** 行内强调色。用于 meta 标签这类小面积着色,不再用于卡片边框。 */
export type CardAccent = "olive" | "rust" | "amber" | "teal";

/** 原生卡片的九种闭集。增加 kind 时必须同步注册表与渲染测试。 */
export type NativeCardKind =
  | "cognition"
  | "feed"
  | "anchors"
  | "count"
  | "note"
  | "chart"
  | "text"
  | "proposal"
  | "progress";

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

/**
 * 卡片的纸面表现，与业务 payload 分开。
 *
 * 这些字段可以随布局文档变化，不应回写进资讯、日程或提案本身。
 */
export interface CardPresentation {
  /** 等宽大写英文标签,如 COGNITION / WORTH RETHINKING */
  eyebrow: string;
  title: string;
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

/** 布局渲染一张原生卡所需的定位与表现字段。 */
export interface NativeCardLayout extends CardPresentation {
  id: string;
  /** 12 栅格里占几列 */
  span: number;
}

/** 卡片上可追溯的上游实体。 */
export interface LineageRef {
  entityType: string;
  entityId: string;
  label: string;
}

/**
 * 认知卡 —— 独占 `7` 主位,整张桌面唯一需要停下来读的卡片。
 *
 * 格子态只放「盲点一句话 + 被挑战的判断 + 替代视角提示 + 密度信号」。
 * 完整内容(证据、反证、适用边界、不确定性、验证动作、纠正入口)在展开态,
 * 见 PRD 06.1。density 是刻意设计的:格子和展开态的信息量差约 20 倍,
 * 不给密度信号用户就无法预判点开会看到什么。
 */
export interface CognitionCardPayload {
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

/** 资讯卡的单条内容。 */
export interface FeedItem {
  id: string;
  title: string;
  /** 为什么此刻给用户看。 */
  why: string;
  source: string;
  lineage?: LineageRef;
}

/** 资讯反馈的稳定机器值。 */
export type FeedFeedback = "new-angle" | "known" | "not-useful";

export interface FeedCardPayload {
  kind: "feed";
  items: FeedItem[];
  emptyHint?: string;
}

/** PRD 硬上限：资讯区每次最多展示三条。 */
export const FEED_ITEM_LIMIT = 3;

/**
 * 用纯函数在渲染边界再收一次上限。
 * 返回新数组，不修改投影层传入的原列表。
 */
export function limitFeedItems<T extends FeedItem>(items: readonly T[]): T[] {
  return items.slice(0, FEED_ITEM_LIMIT);
}

export interface AnchorRow {
  text: string;
  meta: string;
  lineage?: LineageRef;
}

/** ◇ 锚点列表:左侧菱形 + 文字,右侧对齐时间或状态标 */
export interface AnchorCardPayload {
  kind: "anchors";
  rows: AnchorRow[];
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
export interface CountCardPayload {
  kind: "count";
  count: number;
  unit: string;
  body: string;
}

/** 便签卡:米黄底 + 左缘竖条 + 一句话 */
export interface NoteCardPayload {
  kind: "note";
  body: string;
  /** 竖条引出的重点句 */
  quote: string;
}

/** 柱状图卡:一天的可用时段分布 */
export interface ChartCardPayload {
  kind: "chart";
  /** 每根柱的高度比例 0—1 */
  bars: number[];
  /** 图下方的链接文案,可空 */
  link?: string;
}

/** 纯文字卡 */
export interface TextCardPayload {
  kind: "text";
  body: string;
  link?: string;
}

/** 提案卡:等待用户回应,带两个动作 */
export interface ProposalCardPayload {
  kind: "proposal";
  quote: string;
  accept: string;
  reject: string;
}

/** 进度卡:标题 + 说明 + 进度条 + 左右两个角标 */
export interface ProgressCardPayload {
  kind: "progress";
  body: string;
  /** 0—100 */
  percent: number;
  leftMeta: string;
}

/** 只包含业务内容，不带 id / span / 纸面表现。 */
export type NativeCardPayload =
  | CognitionCardPayload
  | FeedCardPayload
  | AnchorCardPayload
  | CountCardPayload
  | NoteCardPayload
  | ChartCardPayload
  | TextCardPayload
  | ProposalCardPayload
  | ProgressCardPayload;

type MaterializedCard<P extends NativeCardPayload> = P & NativeCardLayout;

/** 以下别名保持旧组件和 Story 的 props 兼容。 */
export type CognitionCard = MaterializedCard<CognitionCardPayload>;
export type FeedCard = MaterializedCard<FeedCardPayload>;
export type AnchorCard = MaterializedCard<AnchorCardPayload>;
export type CountCard = MaterializedCard<CountCardPayload>;
export type NoteCard = MaterializedCard<NoteCardPayload>;
export type ChartCard = MaterializedCard<ChartCardPayload>;
export type TextCard = MaterializedCard<TextCardPayload>;
export type ProposalCard = MaterializedCard<ProposalCardPayload>;
export type ProgressCard = MaterializedCard<ProgressCardPayload>;

/** 旧桌面原型仍可传扁平卡片；新渲染器传 payload + layout。 */
export type DeskCard = NativeCardPayload & NativeCardLayout;

/** 卡片交互由桌面容器接管，原生卡只上报语义事件。 */
export interface CardHandlers {
  onOpen?: (card: DeskCard) => void;
  onAccept?: (card: DeskCard) => void;
  onReject?: (card: DeskCard) => void;
  onFeedFeedback?: (itemId: string, feedback: FeedFeedback) => void;
  onLineage?: (lineage: LineageRef) => void;
}

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
