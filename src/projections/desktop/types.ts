import type {
  JournalSpread,
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
}

export function runtimeStatusLabel(status: RuntimeStatus): string {
  switch (status) {
    case "starting":
      return "本地内核 · 启动中";
    case "ready":
      return "本地内核 · 已连接";
    case "unavailable":
      return "本地内核 · 未连接";
    case "unknown":
      return "本地内核 · 状态未知";
    case "demo":
      return "演示模式";
  }
}
