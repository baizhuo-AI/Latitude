import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../lib/i18n";
import { FieldValueSelect } from "./FieldValueSelect";
import type { FieldDefinition } from "../lib/db";

const singleField: FieldDefinition = {
  id: "fld_p",
  name: "项目",
  type: "single_select",
  options: [{ id: "opt_a", label: "项目A", color: "#ef4444" }],
  sortOrder: 0,
  createdAt: "",
};
const multiField: FieldDefinition = { ...singleField, type: "multi_select" };

describe("FieldValueSelect 单选", () => {
  it("输入不存在的值→出现新建项，点击触发 onCreateOption + onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCreateOption = vi.fn(async () => "opt_new");
    render(
      <FieldValueSelect field={singleField} value="" onChange={onChange} onCreateOption={onCreateOption} />,
    );
    await user.click(screen.getByTestId("fvs-trigger"));
    await user.type(screen.getByTestId("fvs-input"), "项目B");
    expect(screen.getByTestId("fvs-create")).toBeInTheDocument();
    await user.click(screen.getByTestId("fvs-create"));
    expect(onCreateOption).toHaveBeenCalledWith("项目B");
    expect(onChange).toHaveBeenCalledWith("opt_new");
  });

  it("输入已存在的值（空格变体）→不出现新建项，命中已有候选", async () => {
    const user = userEvent.setup();
    render(<FieldValueSelect field={singleField} value="" onChange={vi.fn()} onCreateOption={vi.fn()} />);
    await user.click(screen.getByTestId("fvs-trigger"));
    await user.type(screen.getByTestId("fvs-input"), "项目 A");
    expect(screen.queryByTestId("fvs-create")).not.toBeInTheDocument();
    expect(screen.getByTestId("fvs-option-opt_a")).toBeInTheDocument();
  });

  it("点击已有候选→onChange(optId)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FieldValueSelect field={singleField} value="" onChange={onChange} onCreateOption={vi.fn()} />);
    await user.click(screen.getByTestId("fvs-trigger"));
    await user.click(screen.getByTestId("fvs-option-opt_a"));
    expect(onChange).toHaveBeenCalledWith("opt_a");
  });
});

describe("FieldValueSelect 多选", () => {
  it("已选项显示为 chip；新建追加到数组", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCreateOption = vi.fn(async () => "opt_new");
    render(
      <FieldValueSelect
        field={multiField}
        value={["opt_a"]}
        onChange={onChange}
        onCreateOption={onCreateOption}
      />,
    );
    expect(screen.getByTestId("fvs-chip-opt_a")).toBeInTheDocument();
    await user.click(screen.getByTestId("fvs-input"));
    await user.type(screen.getByTestId("fvs-input"), "新项目");
    await user.click(screen.getByTestId("fvs-create"));
    expect(onCreateOption).toHaveBeenCalledWith("新项目");
    expect(onChange).toHaveBeenCalledWith(["opt_a", "opt_new"]);
  });

  it("点 chip 的 × 移除该项", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FieldValueSelect
        field={multiField}
        value={["opt_a"]}
        onChange={onChange}
        onCreateOption={vi.fn()}
      />,
    );
    const chip = screen.getByTestId("fvs-chip-opt_a");
    await user.click(chip.querySelector("button")!);
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
