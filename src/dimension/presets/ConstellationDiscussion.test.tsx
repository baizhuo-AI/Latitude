import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SEED_DESKTOP_PROJECTION } from "../../projections/desktop/seedProjection";
import { ConstellationPreset } from "./ConstellationPreset";

it("replaces the repeated caption with a conversation action carrying the selected star context", () => {
  const onDiscussNode = vi.fn();
  const onNodeOpen = vi.fn();
  const { container } = render(<ConstellationPreset projection={SEED_DESKTOP_PROJECTION} onDiscussNode={onDiscussNode} onNodeOpen={onNodeOpen} />);
  const caption = container.querySelector<HTMLElement>(".cst-caption")!;
  expect(screen.queryByRole("button", { name: /靠近看看/ })).not.toBeInTheDocument();
  expect(within(caption).queryByText("TO BE AGI")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "和维度聊聊" }));
  expect(onDiscussNode).toHaveBeenLastCalledWith(expect.objectContaining({ id: "focus", label: "TO BE AGI", detail: SEED_DESKTOP_PROJECTION.constellation.northStar.detail }));
  fireEvent.click(screen.getByRole("button", { name: /认知星：系统思维/ }));
  fireEvent.click(screen.getByRole("button", { name: "和维度聊聊" }));
  expect(onDiscussNode).toHaveBeenLastCalledWith(expect.objectContaining({ id: "cognition-systems-thinking", domainNodeId: "systems-thinking", label: "系统思维", detail: SEED_DESKTOP_PROJECTION.constellation.cognitions[0].detail }));
  expect(onNodeOpen).not.toHaveBeenCalled();
});
