import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEED_DESKTOP_PROJECTION } from "../../projections/desktop/seedProjection";
import type { DesktopProjection } from "../../projections/desktop/types";
import {
  createBrowserCompositionRegistry,
  layoutV1ToUiSurfaceV2,
} from "../../runtime/composition/browserProduction";
import { SEED_LAYOUT_DOCUMENT } from "../../runtime/layout/seedLayout";
import {
  buildClueThreads,
  CONNECTION_STORAGE_KEY
} from "./ClueBoardPreset";
import { DimensionPresetApp } from "./DimensionPresetApp";
import { deriveThreadDesktop } from "./threadDesktop";

function seedThreads() {
  const anchors = SEED_DESKTOP_PROJECTION.bindings["desktop.schedule"];
  if (anchors?.kind !== "anchors") throw new Error("seed schedule missing");
  return buildClueThreads(anchors);
}

function typedGoalProjection() {
  const projection: DesktopProjection = structuredClone(SEED_DESKTOP_PROJECTION);
  projection.runtimeStatus = "ready";
  projection.clueBoard = {
    title: "1 个中期目标",
    subtitle: "按明确 goalId 血缘展开。",
    themes: [
      {
        id: "goal-theme-client",
        title: "完成客户交付",
        detail: "先完成可验收的业务结果。",
        pending: 2,
        done: 0,
        lineage: {
          entityType: "goal",
          entityId: "goal-medium-client",
          label: "来自统一 Domain 的中期目标",
        },
        rows: [
          {
            text: "建立产品闭环验收尺",
            meta: "关联行动",
            actionable: true,
            tags: ["客户交付"],
            lineage: {
              entityType: "action",
              entityId: "action-acceptance",
              label: "来自统一 Domain 的中期目标行动",
            },
          },
          {
            text: "形成一页客户经营 POC 方案",
            meta: "关联行动",
            actionable: true,
            tags: ["客户交付"],
            lineage: {
              entityType: "action",
              entityId: "action-poc",
              label: "来自统一 Domain 的中期目标行动",
            },
          },
        ],
      },
    ],
  };
  return projection;
}

describe("线索节点内置桌面与可编辑连接", () => {
  afterEach(() => {
    window.localStorage.removeItem(CONNECTION_STORAGE_KEY);
    vi.useRealTimers();
  });

  it("工作、个人项目、短期规划派生三份不同桌面，同时保留原 Todo lineage", () => {
    const desktops = seedThreads().map((thread) =>
      deriveThreadDesktop(SEED_DESKTOP_PROJECTION, SEED_LAYOUT_DOCUMENT, thread)
    );
    expect(desktops.map((desk) => desk.projection.header.title)).toEqual([
      "工作现状 · 今日交付台",
      "个人项目进度 · 创作台",
      "短期规划 · 推演台"
    ]);
    expect(new Set(desktops.map((desk) => desk.layout.id)).size).toBe(3);
    expect(desktops.map((desk) => desk.layout.arrangement.orderedCardIds)).toEqual([
      ["seed-feed", "seed-schedule", "seed-review-plan", "seed-rhythm", "seed-flex"],
      ["seed-schedule", "seed-feed", "seed-flex", "seed-review-plan", "seed-rhythm"],
      ["seed-review-plan", "seed-schedule", "seed-feed", "seed-rhythm", "seed-flex"]
    ]);
    const spansByRegion = desktops.map((desk) =>
      Object.fromEntries(desk.layout.cards.map((card) => [card.region, card.span]))
    );
    expect(spansByRegion[0]).toMatchObject({ feed: 5, schedule: 7 });
    expect(spansByRegion[1]).toMatchObject({ schedule: 5, feed: 7 });
    expect(spansByRegion[2]).toMatchObject({ "review-plan": 12, schedule: 7, feed: 5 });

    const rows = desktops.map((desk) => {
      const binding = desk.projection.bindings["desktop.schedule"];
      if (binding?.kind !== "anchors") throw new Error("thread schedule missing");
      return binding.rows;
    });
    expect(rows.map((set) => set.map((row) => row.text))).toEqual([
      ["给客户 1 准备日报", "修改客户 2 的 agent badcase"],
      ["newsletter 选题草稿：AI 时代的判断力"],
      ["周五前定下 Q3 学习计划"]
    ]);
    expect(rows[0][0].lineage?.entityId).toBe("seed-todo-daily-report");
  });

  it.each([
    ["工作现状", "工作现状 · 今日交付台", "给客户 1 准备日报", "newsletter 选题草稿：AI 时代的判断力"],
    ["个人项目进度", "个人项目进度 · 创作台", "newsletter 选题草稿：AI 时代的判断力", "给客户 1 准备日报"],
    ["短期规划", "短期规划 · 推演台", "周五前定下 Q3 学习计划", "给客户 1 准备日报"]
  ])("点进%s后首屏是它自己的标题和内容", (thread, deskTitle, included, excluded) => {
    const { container } = render(
      <DimensionPresetApp initialPreset="clue-board" syncUrl={false} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`线索 \\d+：${thread}.*进这张桌面`) })
    );

    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-transition", "corner");
    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-direction", "down");
    const paperLayer = container.querySelector("[data-deck-layer='paper']");
    if (!(paperLayer instanceof HTMLElement)) throw new Error("paper layer missing");
    expect(within(paperLayer).getByRole("heading", { name: deskTitle })).toBeInTheDocument();
    expect(paperLayer).toHaveTextContent(included);
    expect(paperLayer).not.toHaveTextContent(excluded);

    fireEvent.click(within(paperLayer).getByRole("button", { name: "退出聚焦" }));
    expect(within(paperLayer).getByRole("heading", { name: "上午先把客户 1 的日报发出去" })).toBeInTheDocument();
  });

  it("typed 中期目标会进入真实的目标专属桌面，而不是只切换纸面层", () => {
    const browserLayout = structuredClone(SEED_LAYOUT_DOCUMENT);
    browserLayout.id = "latitude-browser-live";
    browserLayout.revision = 3;
    const composition = {
      registry: createBrowserCompositionRegistry(),
      document: layoutV1ToUiSurfaceV2(browserLayout),
    };
    const { container } = render(
      <DimensionPresetApp
        projection={typedGoalProjection()}
        layout={browserLayout}
        composition={composition}
        initialPreset="clue-board"
        syncUrl={false}
        localCardEditing="disabled"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: /中期目标 1：完成客户交付.*进这张桌面/ })
    );

    const paperLayer = container.querySelector("[data-deck-layer='paper']");
    if (!(paperLayer instanceof HTMLElement)) throw new Error("paper layer missing");
    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-active", "paper");
    expect(within(paperLayer).getByRole("heading", { name: "完成客户交付 · 专注桌面" }))
      .toBeInTheDocument();
    expect(within(paperLayer).queryByText("布局文档有问题")).not.toBeInTheDocument();
    expect(within(paperLayer).getByRole("status"))
      .toHaveTextContent("正在看线索 · 完成客户交付");
    expect(paperLayer).toHaveTextContent("建立产品闭环验收尺");
    expect(paperLayer).toHaveTextContent("形成一页客户经营 POC 方案");
    expect(paperLayer).not.toHaveTextContent("newsletter 选题草稿");
  });

  it("连接可从支撑改为待验证，并在重新挂载后读回", () => {
    const first = render(
      <DimensionPresetApp initialPreset="clue-board" syncUrl={false} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "调整「工作现状」连接，当前为支撑" })
    );
    const editor = screen.getByRole("complementary", { name: "编辑连接：工作现状" });
    fireEvent.click(within(editor).getByRole("button", { name: "待验证" }));
    expect(JSON.parse(window.localStorage.getItem(CONNECTION_STORAGE_KEY) ?? "{}")).toEqual({
      "thread-工作现状": "verify"
    });
    first.unmount();

    render(<DimensionPresetApp initialPreset="clue-board" syncUrl={false} />);
    expect(
      screen.getByRole("button", { name: "调整「工作现状」连接，当前为待验证" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "编辑「工作现状」连接，当前为待验证" })
    ).toBeInTheDocument();
  });

  it("线索纸节点编辑只作用当前节点，标题属于该桌面而 Todo 内容按 lineage 合回", () => {
    vi.useFakeTimers();
    window.localStorage.removeItem("dim-card-edits-dimension-seed-desktop");
    const { container } = render(
      <DimensionPresetApp initialPreset="clue-board" syncUrl={false} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "编辑线索内容：工作现状" })
    );
    const dialog = screen.getByRole("dialog", { name: "编辑卡片" });
    const contentInputs = within(dialog).getAllByLabelText("内容");
    expect(contentInputs).toHaveLength(2);
    expect(within(dialog).queryByDisplayValue(/newsletter 选题草稿/)).not.toBeInTheDocument();
    expect(within(dialog).queryByDisplayValue(/Q3 学习计划/)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("卡片标题"), {
      target: { value: "工作线索 · 交付桌" }
    });
    fireEvent.change(contentInputs[0], {
      target: { value: "给客户 1 发新版日报" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存到桌面" }));

    // 个人项目桌面有自己的标题与内容，不吃工作节点的 presentation。
    fireEvent.click(
      screen.getByRole("button", { name: /线索 \d+：个人项目进度.*进这张桌面/ })
    );
    const paperLayer = container.querySelector("[data-deck-layer='paper']");
    if (!(paperLayer instanceof HTMLElement)) throw new Error("paper layer missing");
    expect(
      within(paperLayer).getByRole("heading", { name: "个人项目进度 · 行动清单" })
    ).toBeInTheDocument();
    expect(paperLayer).toHaveTextContent("newsletter 选题草稿：AI 时代的判断力");
    expect(paperLayer).not.toHaveTextContent("给客户 1 发新版日报");

    act(() => vi.advanceTimersByTime(950));
    fireEvent.click(screen.getByRole("button", { name: "线索板桌面" }));
    fireEvent.click(
      screen.getByRole("button", { name: /线索 \d+：工作现状.*进这张桌面/ })
    );
    expect(
      within(paperLayer).getByRole("heading", { name: "工作线索 · 交付桌" })
    ).toBeInTheDocument();
    expect(paperLayer).toHaveTextContent("给客户 1 发新版日报");

    // 退出后 Todo 改名仍在总桌面，但总卡标题和其他三行保持原样。
    fireEvent.click(within(paperLayer).getByRole("button", { name: "退出聚焦" }));
    expect(within(paperLayer).getByRole("heading", { name: "今天的锚点" })).toBeInTheDocument();
    expect(paperLayer.querySelectorAll(".dim-anchor-row")).toHaveLength(4);
    expect(paperLayer).toHaveTextContent("给客户 1 发新版日报");
    expect(paperLayer).toHaveTextContent("newsletter 选题草稿：AI 时代的判断力");
    expect(paperLayer).toHaveTextContent("周五前定下 Q3 学习计划");
    window.localStorage.removeItem("dim-card-edits-dimension-seed-desktop");
  });

  it("聚焦桌面整卡编辑按 lineage 合回总桌面，不删除其他线索", () => {
    const { container } = render(
      <DimensionPresetApp initialPreset="clue-board" syncUrl={false} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: /线索 \d+：个人项目进度.*进这张桌面/ })
    );
    const paperLayer = container.querySelector("[data-deck-layer='paper']");
    if (!(paperLayer instanceof HTMLElement)) throw new Error("paper layer missing");
    fireEvent.doubleClick(
      within(paperLayer).getByLabelText(
        "卡片：个人项目进度 · 行动清单。双击或按 Enter 编辑"
      )
    );
    const dialog = screen.getByRole("dialog", { name: "编辑卡片" });
    fireEvent.change(within(dialog).getByLabelText("卡片标题"), {
      target: { value: "我的 newsletter 桌" }
    });
    fireEvent.change(within(dialog).getByLabelText("内容"), {
      target: { value: "newsletter 写完第一段" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存到桌面" }));
    expect(
      within(paperLayer).getByRole("heading", { name: "我的 newsletter 桌" })
    ).toBeInTheDocument();

    fireEvent.click(within(paperLayer).getByRole("button", { name: "退出聚焦" }));
    expect(paperLayer.querySelectorAll(".dim-anchor-row")).toHaveLength(4);
    expect(paperLayer).toHaveTextContent("newsletter 写完第一段");
    expect(paperLayer).toHaveTextContent("给客户 1 准备日报");
    expect(paperLayer).toHaveTextContent("周五前定下 Q3 学习计划");
    expect(within(paperLayer).queryByRole("heading", { name: "我的 newsletter 桌" })).not.toBeInTheDocument();
    expect(within(paperLayer).getByRole("heading", { name: "今天的锚点" })).toBeInTheDocument();

    const stored = JSON.parse(
      window.localStorage.getItem("dim-card-edits-dimension-seed-desktop") ?? "{}"
    );
    expect(stored.bindings["desktop.schedule"].rows).toHaveLength(4);
    window.localStorage.removeItem("dim-card-edits-dimension-seed-desktop");
  });

  it("个人项目的派生摘要只写在线索桌面，返回总桌面不覆盖真实 feed", () => {
    vi.useFakeTimers();
    window.localStorage.removeItem("dim-card-edits-dimension-seed-desktop");
    const { container } = render(
      <DimensionPresetApp initialPreset="clue-board" syncUrl={false} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: /线索 \d+：个人项目进度.*进这张桌面/ })
    );
    const paperLayer = container.querySelector("[data-deck-layer='paper']");
    if (!(paperLayer instanceof HTMLElement)) throw new Error("paper layer missing");
    fireEvent.doubleClick(
      within(paperLayer).getByLabelText(
        "卡片：个人项目进度的相关线索。双击或按 Enter 编辑"
      )
    );
    const dialog = screen.getByRole("dialog", { name: "编辑卡片" });
    fireEvent.change(within(dialog).getByLabelText("卡片标题"), {
      target: { value: "个人项目情报角" }
    });
    fireEvent.change(within(dialog).getByLabelText("标题"), {
      target: { value: "newsletter 已经找到开头" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存到桌面" }));
    expect(paperLayer).toHaveTextContent("newsletter 已经找到开头");
    expect(within(paperLayer).getByRole("heading", { name: "个人项目情报角" })).toBeInTheDocument();

    fireEvent.click(within(paperLayer).getByRole("button", { name: "退出聚焦" }));
    expect(paperLayer).toHaveTextContent("客户 1 的日报模板昨晚改版了");
    expect(paperLayer).toHaveTextContent("agent badcase 分类法有一篇新总结");
    expect(paperLayer).not.toHaveTextContent("newsletter 已经找到开头");
    expect(within(paperLayer).getByRole("heading", { name: "今日早报" })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(950));
    fireEvent.click(screen.getByRole("button", { name: "线索板桌面" }));
    fireEvent.click(
      screen.getByRole("button", { name: /线索 \d+：个人项目进度.*进这张桌面/ })
    );
    expect(paperLayer).toHaveTextContent("newsletter 已经找到开头");
    expect(within(paperLayer).getByRole("heading", { name: "个人项目情报角" })).toBeInTheDocument();
    window.localStorage.removeItem("dim-card-edits-dimension-seed-desktop");
  });

  it("聚焦 anchors 恢复时只回滚本线索，保留其他线索已有编辑", () => {
    const schedule = SEED_DESKTOP_PROJECTION.bindings["desktop.schedule"];
    if (schedule?.kind !== "anchors") throw new Error("seed schedule missing");
    window.localStorage.setItem(
      "dim-card-edits-dimension-seed-desktop",
      JSON.stringify({
        bindings: {
          "desktop.schedule": {
            ...schedule,
            rows: schedule.rows.map((row) =>
              row.tags?.includes("个人项目进度")
                ? { ...row, text: "个人项目已有自定义名称" }
                : row
            )
          }
        },
        presentations: {},
        threadBindings: {},
        threadPresentations: {}
      })
    );
    const { container } = render(
      <DimensionPresetApp initialPreset="clue-board" syncUrl={false} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: /线索 \d+：工作现状.*进这张桌面/ })
    );
    const paperLayer = container.querySelector("[data-deck-layer='paper']");
    if (!(paperLayer instanceof HTMLElement)) throw new Error("paper layer missing");
    const editWorkCard = () =>
      fireEvent.doubleClick(
        within(paperLayer).getByLabelText(
          "卡片：工作现状 · 行动清单。双击或按 Enter 编辑"
        )
      );
    editWorkCard();
    let dialog = screen.getByRole("dialog", { name: "编辑卡片" });
    fireEvent.change(within(dialog).getAllByLabelText("内容")[0], {
      target: { value: "工作日报临时改名" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存到桌面" }));
    expect(paperLayer).toHaveTextContent("工作日报临时改名");

    editWorkCard();
    dialog = screen.getByRole("dialog", { name: "编辑卡片" });
    fireEvent.click(within(dialog).getByRole("button", { name: "恢复来源内容" }));
    expect(paperLayer).toHaveTextContent("给客户 1 准备日报");
    expect(paperLayer).not.toHaveTextContent("工作日报临时改名");

    fireEvent.click(within(paperLayer).getByRole("button", { name: "退出聚焦" }));
    expect(paperLayer).toHaveTextContent("个人项目已有自定义名称");
    expect(paperLayer).toHaveTextContent("给客户 1 准备日报");
    window.localStorage.removeItem("dim-card-edits-dimension-seed-desktop");
  });

  it("总桌面、工作桌面、个人项目桌面的拖拽偏移互不串台", () => {
    vi.useFakeTimers();
    window.localStorage.clear();
    const { container } = render(
      <DimensionPresetApp initialPreset="clue-board" syncUrl={false} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: /线索 \d+：工作现状.*进这张桌面/ })
    );
    const paperLayer = container.querySelector("[data-deck-layer='paper']");
    if (!(paperLayer instanceof HTMLElement)) throw new Error("paper layer missing");
    const workCard = paperLayer.querySelector("[data-layout-card-id='seed-flex'] .dim-drag");
    if (!(workCard instanceof HTMLElement)) throw new Error("work flex card missing");
    fireEvent.pointerDown(workCard, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(workCard, { pointerId: 1, clientX: 130, clientY: 118 });
    fireEvent.pointerUp(workCard, { pointerId: 1, clientX: 130, clientY: 118 });
    expect(workCard).toHaveStyle({ translate: "30px 18px" });

    act(() => vi.advanceTimersByTime(950));
    fireEvent.click(screen.getByRole("button", { name: "线索板桌面" }));
    fireEvent.click(
      screen.getByRole("button", { name: /线索 \d+：个人项目进度.*进这张桌面/ })
    );
    const personalCard = paperLayer.querySelector("[data-layout-card-id='seed-flex'] .dim-drag");
    if (!(personalCard instanceof HTMLElement)) throw new Error("personal flex card missing");
    expect(personalCard).not.toHaveStyle({ translate: "30px 18px" });

    fireEvent.click(within(paperLayer).getByRole("button", { name: "退出聚焦" }));
    const totalCard = paperLayer.querySelector("[data-layout-card-id='seed-flex'] .dim-drag");
    if (!(totalCard instanceof HTMLElement)) throw new Error("total flex card missing");
    expect(totalCard).not.toHaveStyle({ translate: "30px 18px" });
    window.localStorage.clear();
  });
});
