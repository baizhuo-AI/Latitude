import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
  dbDecideProposal: vi.fn(),
  dbInsertProposal: vi.fn(),
  dbListProposals: vi.fn(async () => [])
}));

vi.mock("./syncBus", () => ({ emitSync: vi.fn() }));

import { dbDecideProposal } from "./db";
import { useProposalsStore } from "./proposalsStore";
import { emitSync } from "./syncBus";

const proposal = {
  id: "proposal-1",
  quote: "要不要把判断变成一个小实验？",
  status: "proposed" as const,
  source: "secretary" as const,
  createdAt: "2026-08-24T08:00:00.000Z"
};

beforeEach(() => {
  vi.clearAllMocks();
  useProposalsStore.setState({
    proposals: [proposal],
    loaded: true,
    error: null
  });
});

describe("proposal decision CAS", () => {
  it("并发双击只有第一个裁决能改变状态并发出同步", async () => {
    vi.mocked(dbDecideProposal)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const [first, second] = await Promise.all([
      useProposalsStore.getState().decide("proposal-1", "try", "要不试试"),
      useProposalsStore.getState().decide("proposal-1", "try", "要不试试")
    ]);

    expect([first, second]).toEqual([true, false]);
    expect(dbDecideProposal).toHaveBeenCalledTimes(2);
    expect(useProposalsStore.getState().proposals[0]).toMatchObject({
      status: "try",
      verdictLabel: "要不试试"
    });
    expect(emitSync).toHaveBeenCalledTimes(1);
  });
});
