import { create } from "zustand";
import {
  dbDecideProposal,
  dbInsertProposal,
  dbListProposals,
  type ProposalRecord,
  type ProposalStatus
} from "./db";
import { emitSync } from "./syncBus";

/**
 * 提案 store（提案—裁决语法的最小落地）。
 *
 * 真相源是 SQLite proposals 表，这里只做内存缓存；
 * 写路径统一：写库 → set 内存 → emitSync("proposals")，与 todos/activities 同范式。
 *
 * 产品语义（前端体验 PRD §4.2）：裁决五态各有合法结果，拒绝与搁置不追问；
 * 「先放着」到期不响应不产生任何确认写入（静默收起由后续生命周期逻辑做）。
 */

export function newProposalId(): string {
  return `p${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

interface ProposalsStore {
  proposals: ProposalRecord[];
  loaded: boolean;
  /** hydrate 失败时的错误；成功或尚未加载时为 null。 */
  error: string | null;
  hydrate: () => Promise<void>;
  /** 秘书递交一条新提案（等待裁决）。 */
  submit: (p: ProposalRecord) => Promise<void>;
  /**
   * 用户裁决。只在 proposed 状态上生效（db 层已保证一次性）；
   * 返回是否真实发生了状态转换。
   */
  decide: (
    id: string,
    status: Exclude<ProposalStatus, "proposed">,
    verdictLabel: string
  ) => Promise<boolean>;
}

export const useProposalsStore = create<ProposalsStore>((set, get) => ({
  proposals: [],
  loaded: false,
  error: null,

  hydrate: async () => {
    try {
      const proposals = await dbListProposals();
      set({ proposals, loaded: true, error: null });
    } catch (err) {
      console.error("[proposalsStore] hydrate failed:", err);
      set({ proposals: [], loaded: true, error: String(err) });
    }
  },

  submit: async (p) => {
    await dbInsertProposal(p);
    set((s) => ({ proposals: [p, ...s.proposals] }));
    emitSync("proposals");
  },

  decide: async (id, status, verdictLabel) => {
    const current = get().proposals.find((p) => p.id === id);
    if (!current || current.status !== "proposed") return false;
    // 数据库用 proposed 状态做 CAS；并发双击只有第一个裁决能真正改到一行。
    const changed = await dbDecideProposal(id, status, verdictLabel);
    if (!changed) return false;
    const decidedAt = new Date().toISOString();
    set((s) => ({
      proposals: s.proposals.map((p) =>
        p.id === id ? { ...p, status, verdictLabel, decidedAt } : p
      )
    }));
    emitSync("proposals");
    return true;
  }
}));

/** 当前等待裁决的提案（最新一条）。没有就是真的没有，UI 显示留白。 */
export function pendingProposalOf(proposals: ProposalRecord[]): ProposalRecord | null {
  return proposals.find((p) => p.status === "proposed") ?? null;
}
