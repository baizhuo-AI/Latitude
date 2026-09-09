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
  /** Domain 明确给出的阶段词；缺省时沿用前端的确定性阶段梯子。 */
  stage?: string;
  /** 这条数值为何成立。Browser 真实投影不得用互动次数临时推导。 */
  basis?: string;
  /** 依据的认识权威，供界面诚实区分导入估计与系统记录。 */
  epistemicAuthority?: string;
  /** 可追溯到 typed relationship node，权能还可追加有效授权 receipt。 */
  lineage?: LineageRef[];
  /** 熟悉、默契允许用户查看并纠正其依据；权能由授权记录控制。 */
  correctable?: boolean;
}

export interface Secretary {
  /** 连接状态独立于任务状态，断线时不能显示仍在执行任务。 */
  connectionState?: "ready" | "starting" | "unavailable";
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

/** 原生卡片的十种闭集。增加 kind 时必须同步注册表与渲染测试。 */
export type NativeCardKind =
  | "cognition"
  | "feed"
  | "activity"
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
   * 纸片倾斜角度(度)。规范:正文纸绝对值不超过 1.2 ——
   * 再大就从「自然摊在桌上」变成「刻意做旧」；便签 / 报纸类可到 2 上下，
   * 配合胶带与错位做出「散铺在桌面」的感觉。
   */
  tilt?: number;
  /** 纸质。sticky = 便签黄,grid = 方格纸,newsprint = 报纸（早报卡专用） */
  paper?: "plain" | "sticky" | "grid" | "newsprint";
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
 * 认识来源三态（前端体验 PRD §2.2 的前端承诺）。
 *
 * 用户必须能分辨一条内容是谁的认识状态：
 * - recorded：带来源的原始记录（用户说过的话、同步来的日程），不保证已被证实；
 * - inferred：秘书注意到 / 猜测，可能不对，允许纠正或不回应；
 * - confirmed：用户已确认，能看到确认发生在何时、基于什么。
 *
 * 界面用日常语言表达这三态，不出现内部术语；任何视觉风格都不能抹平差异。
 */
export type EpistemicState = "recorded" | "inferred" | "confirmed";

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
  /** 上游明确给出的短标题；原始 title 仍用于溯源。 */
  shortTitle?: string;
  /** 部分搜索提供方把明确短标题命名为 headline。 */
  headline?: string;
  title: string;
  /** 为什么此刻给用户看。 */
  why: string;
  source: string;
  /** Real search evidence remains directly inspectable. */
  url?: string;
  publishedAt?: string;
  retrievedAt?: string;
  provider?: string;
  queryId?: string;
  contentHash?: string;
  evidenceRefId?: string;
  freshness?: "fresh" | "aging" | "stale";
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
  /**
   * 主题标签（如「客户 A」「个人项目」）。线索板按它把锚点聚成
   * 事件维度；没有标签的锚点不进线索簇，不硬编分组。
   */
  tags?: string[];
  /**
   * 认识来源。日程 / 待办这类用户自己的记录是 recorded；
   * 秘书排出的建议顺序是 inferred。省略时按 recorded 处理。
   */
  epistemic?: EpistemicState;
  /**
   * 行动对象标记：true 表示这一行可以直接在桌面上完成。
   * 只有已确认方向的用户待办才可以是行动对象；日历事件等外部事实不可。
   */
  actionable?: boolean;
  /** 已完成。完成的锚点仍留在桌面上，作为今天真实发生过的结果。 */
  done?: boolean;
  /**
   * 退焦标记：进入某条线索的聚焦桌面时，由容器投影派生——
   * 不属于该维度的行降为低饱和。纯表现层，投影与领域数据不变。
   */
  dimmed?: boolean;
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

/** 用户自己记下的一件已经发生的事。它是记录，不是系统对用户的判断。 */
export interface ActivityEntry {
  id: string;
  text: string;
  occurredAt: string;
  timeLabel: string;
  lineage: LineageRef;
}

/**
 * 「今天做过」卡：第一步只收真实记录，再邀请秘书从多条记录中提出待确认观察。
 * 可用性由 Browser 的 Domain / Agent 健康状态投影，不在卡片里猜测。
 */
export interface ActivityCardPayload {
  kind: "activity";
  entries: ActivityEntry[];
  emptyHint: string;
  capturePlaceholder: string;
  canCapture: boolean;
  captureUnavailableReason?: string;
  canReflect: boolean;
  reflectUnavailableReason?: string;
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
  /** 没有任何可画数据时显示的事实说明；空数组与真实的 0 值不同。 */
  emptyHint?: string;
  /** 图下方的链接文案,可空 */
  link?: string;
}

/** 纯文字卡 */
export interface TextCardPayload {
  kind: "text";
  body: string;
  link?: string;
}

/**
 * 裁决语义（前端体验 PRD §4.2）。裁决不能被一个「接受」按钮抹平。
 *
 * 五个稳定机器值：
 * - interesting「有点意思」：继续共同澄清，仍是未确认线索；
 * - holds「这对我成立」：有可追溯依据时才进入用户已确认的理解；
 * - try「要不试试」：转成一个小行动或实验，原假设保持未确认；
 * - reject「不太对」：记录纠正或拒绝，不静默生成新的偏好判断；
 * - park「先放着」：暂存并降低打扰，到期不响应不产生任何确认写入。
 */
export interface ProposalVerdict {
  id: "interesting" | "holds" | "try" | "reject" | "park";
  /** 日常语言标签，如「先放着」 */
  label: string;
}

/** 提案卡:等待用户回应,带两个动作 */
export interface ProposalCardPayload {
  kind: "proposal";
  quote: string;
  accept: string;
  reject: string;
  /**
   * 完整裁决集。存在时替代 accept / reject 两键渲染；
   * 省略时保持旧两键（向后兼容旧原型与 Story）。
   */
  verdicts?: ProposalVerdict[];
  /** 这条提案影响的范围说明 —— 接受前必须让用户知道会改变什么。 */
  consequence?: string;
}

/** 进度卡:标题 + 说明 + 进度条 + 左右两个角标 */
export interface ProgressCardPayload {
  kind: "progress";
  body: string;
  /** 0—100；数据源不可用、无法诚实计算时省略，卡片不渲染进度条。 */
  percent?: number;
  leftMeta: string;
}

/** 只包含业务内容，不带 id / span / 纸面表现。 */
export type NativeCardPayload =
  | CognitionCardPayload
  | FeedCardPayload
  | ActivityCardPayload
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
export type ActivityCard = MaterializedCard<ActivityCardPayload>;
export type AnchorCard = MaterializedCard<AnchorCardPayload>;
export type CountCard = MaterializedCard<CountCardPayload>;
export type NoteCard = MaterializedCard<NoteCardPayload>;
export type ChartCard = MaterializedCard<ChartCardPayload>;
export type TextCard = MaterializedCard<TextCardPayload>;
export type ProposalCard = MaterializedCard<ProposalCardPayload>;
export type ProgressCard = MaterializedCard<ProgressCardPayload>;

/** 旧桌面原型仍可传扁平卡片；新渲染器传 payload + layout。 */
export type DeskCard = NativeCardPayload & NativeCardLayout;

/**
 * 桌面呈现层的一次编辑请求。
 *
 * binding 指向投影内容，cardId 指向布局表现；两者刻意分开，避免把一张
 * 派生卡的文案编辑误当成对上游业务实体的全字段写入。
 */
export interface CardEditRequest {
  cardId: string;
  binding: string;
  card: DeskCard;
}

/** 卡片交互由桌面容器接管，原生卡只上报语义事件。 */
export interface CardHandlers {
  onOpen?: (card: DeskCard) => void;
  onAccept?: (card: DeskCard) => void;
  onReject?: (card: DeskCard) => void;
  /** 完整裁决集存在时的统一出口；onAccept / onReject 是两键形态的兼容出口。 */
  onVerdict?: (card: DeskCard, verdict: ProposalVerdict) => void;
  onFeedFeedback?: (itemId: string, feedback: FeedFeedback) => void;
  onLineage?: (lineage: LineageRef) => void;
  /** 记下一件已经发生的事；返回 Promise 时卡片会保持提交态直到写入完成。 */
  onActivityCapture?: (text: string) => void | Promise<void>;
  onActivityEdit?: (entry: ActivityEntry, nextText: string) => void | Promise<void>;
  onActivityRetract?: (entry: ActivityEntry) => void | Promise<void>;
  /** 只触发回看，不自动把观察升级成已确认认知。 */
  onActivityReflect?: () => void;
  /** 行动对象的真实完成动作。只由 actionable 的锚点行触发。 */
  onAnchorComplete?: (row: AnchorRow) => void;
  /**
   * 锚点文字的行内编辑出口。只有带来源（lineage）且可行动的锚点可编辑；
   * 接线方按 lineage 写回真实实体（如待办标题）。
   */
  onAnchorEdit?: (row: AnchorRow, nextText: string) => void;
  /** 双击卡片正文或在卡片聚焦时按 Enter/F2，打开可撤销的呈现编辑器。 */
  onCardEdit?: (request: CardEditRequest) => void;
}

/** 点秘书立绘时的意图闭集：聊聊 / 看看有什么要我定的 / 回顾关系。 */
export type SecretaryIntent = "chat" | "decide" | "review";

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
