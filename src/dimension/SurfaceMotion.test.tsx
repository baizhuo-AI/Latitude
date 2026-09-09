import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { describe, expect, it } from "vitest";
import { MotionSurface } from "./SurfaceMotion";

function Example() {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen((value) => !value)}>切换纸张</button>
    <AnimatePresence initial={false}>
      {open && <MotionSurface key="paper" role="dialog" aria-label="纸张">
        <input aria-label="草稿" defaultValue="" />
      </MotionSurface>}
    </AnimatePresence>
  </>;
}

describe("surface motion", () => {
  it("makes a closing paper inert immediately and keeps the same draft when reopened mid-exit", async () => {
    const { container } = render(<Example />);
    const toggle = screen.getByRole("button", { name: "切换纸张" });
    fireEvent.click(toggle);
    fireEvent.change(screen.getByRole("textbox", { name: "草稿" }), { target: { value: "尚未提交" } });
    fireEvent.click(toggle);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(container.querySelector('[data-surface-present="false"]')).toHaveAttribute("inert");
    fireEvent.click(toggle);
    expect(screen.getByRole("textbox", { name: "草稿" })).toHaveValue("尚未提交");
    expect(screen.getByRole("dialog")).not.toHaveAttribute("inert");
    fireEvent.click(toggle);
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument());
  });
});
