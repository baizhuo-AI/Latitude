/**
 * 维度桌面布局文档 v1。
 *
 * 布局只描述三层信息：背景、卡、排布规则。排布保存语义顺序与策略，
 * 不保存 x / y / row / column 之类的渲染坐标。
 */

/** 三档渲染能力。实验期只点亮 native，其余两档先冻结协议。 */
export type LayoutRendererKind = "native" | "declarative" | "html";

/** 种子桌面的五个稳定内容区。 */
export type LayoutRegion =
  | "feed"
  | "schedule"
  | "review-plan"
  | "rhythm"
  | "flex";

/** 12 栅格当前允许的卡片宽度。 */
export type LayoutSpan = 4 | 5 | 7 | 12;

/**
 * 一张卡在布局层的定义。
 *
 * `binding` 只指向桌面投影里的数据，不把业务 payload 烘焙进布局文档；
 * `presentation` 留给 native 卡片的确定性外观配置。
 */
export interface LayoutCardDefinition<
  TKind extends string = string,
  TPresentation = unknown
> {
  id: string;
  region: LayoutRegion;
  renderer: LayoutRendererKind;
  kind: TKind;
  span: LayoutSpan;
  binding: string;
  /**
   * A composed desktop may temporarily hide a registered card without deleting
   * its binding or spatial identity.  The card remains in orderedCardIds so a
   * rollback can restore it exactly.
   */
  hidden?: boolean;
  presentation?: TPresentation;
}

export interface LayoutCompositionV1 {
  /** Only the trusted UiChangeSet adapter may emit this mode. */
  mode: "user-customized";
  /** Latest applied UiChangeSet receipt; keeps the rendered projection auditable. */
  changeSetId: string;
}

export interface LayoutBackgroundV1 {
  theme: "paper";
  texture: "linen" | "plain" | "grid";
  density: "comfortable" | "compact";
  tokenOverrides?: Record<string, string>;
}

export interface LayoutArrangementV1 {
  strategy: "frequency-weighted";
  /** 渲染顺序的唯一真相源。渲染器不得回退到 cards 数组顺序。 */
  orderedCardIds: string[];
  params: {
    /** 种子形态的治理规则：一次最多替换一个格子。 */
    maxChangesPerRefresh: 1;
  };
  /** 「为什么这样排」直接读取的确定性理由。 */
  rationale: string[];
}

export interface LayoutDocumentV1<
  TKind extends string = string,
  TPresentation = unknown
> {
  schemaVersion: 1;
  id: string;
  revision: number;
  composition?: LayoutCompositionV1;
  background: LayoutBackgroundV1;
  cards: Array<LayoutCardDefinition<TKind, TPresentation>>;
  arrangement: LayoutArrangementV1;
}
