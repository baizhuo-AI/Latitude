import type {
  AnchorRow,
  EpistemicState,
  JournalSpread,
  LineageRef,
  NativeCardPayload,
  Secretary
} from "../../dimension/types";

export type RuntimeStatus =
  | "starting"
  | "ready"
  | "unavailable"
  | "unknown"
  | "demo";

export interface DesktopHeader {
  breadcrumb: string;
  title: string;
  subtitle: string;
}

export interface ConstellationCognition {
  id: string;
  /** typed Domain surface role；大想法与认知评价共用星体语法但不混名。 */
  role?: "cognition" | "big-idea";
  /** 星图上常显的短语，避免把长段人格结论钉死在用户身上。 */
  label: string;
  /** 选中后才展开的依据或解释。 */
  detail: string;
  /** 推测必须显式标「待确认」；只有用户确认后才能升为 confirmed。 */
  epistemic: EpistemicState;
  lineage?: LineageRef;
  /** Present only when Domain returned a real persisted StarState. */
  starState?: {
    version: number;
    role: string;
    importance: string;
    importanceAuthority?: string;
    salience: string;
    organizingPower?: string;
    freshness: string;
    mass?: string;
    radius?: string;
    auraVersion?: number;
    stateStatus?: string;
    recomputeRequired: boolean;
  };
  /** A formal graph edge, never a visual inference. */
  orbit?: {
    centerNodeId: string;
    centerLabel: string;
    relationType: string;
    proximity?: string;
    strength?: string;
  };
}

export interface ConstellationModel {
  northStar: {
    title: string;
    detail: string;
    status?: "single" | "multiple" | "empty" | "loading" | "unavailable" | "demo";
    /** 只有明确对应一个真实目标时才存在；多目标合并态不伪造单一来源。 */
    lineage?: LineageRef;
  };
  cognitions: ConstellationCognition[];
  /** 仅在进度与长期方向有明确血缘时提供；不能拿全周完成率冒充目标进度。 */
  progress?: {
    percent: number;
    label: string;
  };
}

/**
 * 线索板只消费 Domain 已显式路由到 `clue.theme` 的中期目标。主题下的
 * 短期目标、行动、结果与资料仍保留各自 lineage；这里不靠关键词猜关系。
 */
export interface ClueThemeModel {
  id: string;
  title: string;
  detail: string;
  rows: AnchorRow[];
  pending: number;
  done: number;
  lineage: LineageRef;
}

export interface ClueBoardModel {
  title: string;
  subtitle: string;
  themes: ClueThemeModel[];
}

/**
 * 布局渲染器的业务输入。
 *
 * 真实 Todo / Calendar / 图谱接入时只替换 projection adapter；布局文档和
 * DimensionApp 不需要跟着改。当前批次使用 seedProjection 明确标注样例状态。
 */
export interface DesktopProjection {
  generatedAt: string;
  runtimeStatus: RuntimeStatus;
  header: DesktopHeader;
  secretary: Secretary;
  bindings: Record<string, NativeCardPayload | undefined>;
  journalSpreads?: Record<string, JournalSpread>;
  /** 长周期目标与认知星群；不和今天的执行命题混为一谈。 */
  constellation?: ConstellationModel;
  /** 中期目标主题；只由统一 Domain graph 的 typed payload 投影。 */
  clueBoard?: ClueBoardModel;
}

export function runtimeStatusLabel(status: RuntimeStatus): string {
  switch (status) {
    case "starting":
      return "本地服务 · 启动中";
    case "ready":
      return "本地服务 · 已连接";
    case "unavailable":
      return "本地服务 · 未连接";
    case "unknown":
      return "本地服务 · 状态未知";
    case "demo":
      return "演示模式";
  }
}
