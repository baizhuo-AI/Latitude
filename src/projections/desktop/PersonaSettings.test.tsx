import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentClient, PersonaState } from "../../runtime/host/agentClient";
import { PersonaSettings } from "./PersonaSettings";

const seed = { version: 0, persona: "理解人，利落做事。", preferences: "", reason: "默认", actor: "system" as const, createdAt: "2026-09-04T00:00:00Z" };
const initial: PersonaState = { current: seed, history: [seed] };

describe("persona settings", () => {
  it("saves user additions, displays version history and restores the default with the latest version", async () => {
    const saved = { ...seed, version: 1, preferences: "先说结论", actor: "user" as const, reason: "用户补充" };
    const agent = {
      getPersona: vi.fn().mockResolvedValue(initial),
      updatePersona: vi.fn().mockResolvedValueOnce({ current: saved, history: [seed, saved] }).mockResolvedValueOnce({ current: { ...seed, version: 2 }, history: [seed, saved, { ...seed, version: 2 }] }),
    } as unknown as AgentClient;
    render(<PersonaSettings agent={agent} />);
    fireEvent.click(screen.getByText("人设与相处方式"));
    fireEvent.change(await screen.findByLabelText("人设补充"), { target: { value: "先说结论" } });
    fireEvent.click(screen.getByRole("button", { name: "保存人设" }));
    await screen.findByText("已保存，后续对话会使用这份人设。");
    expect(agent.updatePersona).toHaveBeenCalledWith(expect.objectContaining({ baseVersion: 0, preferences: "先说结论" }));
    expect(screen.getByText("调整记录（1 次）")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    await waitFor(() => expect(agent.updatePersona).toHaveBeenLastCalledWith(expect.objectContaining({ baseVersion: 1, restoreVersion: 0 })));
    await waitFor(() => expect(screen.getByLabelText("人设补充")).toHaveValue(""));
  });

  it("does not report a failed save as success or discard the user's draft", async () => {
    const agent = { getPersona: vi.fn().mockResolvedValue(initial), updatePersona: vi.fn().mockRejectedValue(new Error("人设已经更新，请重新读取")) } as unknown as AgentClient;
    render(<PersonaSettings agent={agent} />);
    fireEvent.click(screen.getByText("人设与相处方式"));
    fireEvent.change(await screen.findByLabelText("人设补充"), { target: { value: "用户草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存人设" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("人设已经更新");
    expect(screen.queryByText("已保存，后续对话会使用这份人设。")).not.toBeInTheDocument();
    expect(screen.getByLabelText("人设补充")).toHaveValue("用户草稿");
  });
});
