import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEED_DESKTOP_PROJECTION } from "../../projections/desktop/seedProjection";
import type { DesktopProjection } from "../../projections/desktop/types";
import {
  BROWSER_PRODUCT_LAYOUT_DOCUMENT,
  createBrowserCompositionRegistry,
  layoutV1ToUiSurfaceV2,
} from "../../runtime/composition/browserProduction";
import { SEED_LAYOUT_DOCUMENT } from "../../runtime/layout/seedLayout";
import {
  buildClueThreads,
  ClueBoardPreset,
  CONNECTION_STORAGE_KEY
} from "./ClueBoardPreset";
import { DimensionPresetApp } from "./DimensionPresetApp";
import { areaReferenceCardId, readDesktopWorkspace, reconcileDesktopWorkspace } from "../desktopWorkspace";

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

function paperOf(container: HTMLElement) { return container.querySelector<HTMLElement>("[data-deck-layer='paper']")!; }
function cardOf(container: HTMLElement, id: string) { return container.querySelector<HTMLElement>(`[data-layout-card-id="${id}"]`)!; }
function openThread(title: string) { fireEvent.doubleClick(screen.getByRole("button", { name: new RegExp(`线索 \\d+：${title}.*双击进入主页板块`) })); }
function editThread(title: string) {
  fireEvent.click(screen.getByRole("button", { name: "线索板桌面" }));
  fireEvent.contextMenu(screen.getByRole("button", { name: new RegExp(`线索 \\d+：${title}.*右键打开卡片设置`) }), { clientX: 240, clientY: 180 });
  fireEvent.click(screen.getByRole("menuitem", { name: "编辑内容" }));
  return screen.getByRole("dialog", { name: "编辑卡片" });
}
const EDITS_KEY = "dim-card-edits-dimension-seed-desktop";

describe("单张桌面的线索板块与可编辑连接", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { window.localStorage.clear(); vi.useRealTimers(); });

  it("三个板块分配不同位置，改名和重进不挪位，保留原 Todo lineage", () => {
    const threads = seedThreads();
    const first = reconcileDesktopWorkspace({ version: 1, areas: {}, activeAreaId: null }, threads, SEED_LAYOUT_DOCUMENT.id);
    expect(new Set(Object.values(first.areas).map(area => `${area.x}:${area.y}`)).size).toBe(3);
    const renamed = threads.map((thread, index) => index === 0 ? { ...thread, title: "工作改名" } : thread);
    const second = reconcileDesktopWorkspace(first, renamed, SEED_LAYOUT_DOCUMENT.id);
    expect(second.areas[threads[0].id]).toMatchObject({ x: first.areas[threads[0].id].x, y: first.areas[threads[0].id].y, title: "工作改名" });
    expect(reconcileDesktopWorkspace(second, renamed, SEED_LAYOUT_DOCUMENT.id)).toEqual(second);
    expect(threads.map(thread => thread.rows.map(row => row.text))).toEqual([
      ["给客户 1 准备日报", "修改客户 2 的 agent badcase"],
      ["newsletter 选题草稿：AI 时代的判断力"], ["周五前定下 Q3 学习计划"]
    ]);
    expect(threads[0].rows[0].lineage?.entityId).toBe("seed-todo-daily-report");
  });

  it.each([
    ["工作现状", "给客户 1 准备日报", "newsletter 选题草稿：AI 时代的判断力"],
    ["个人项目进度", "newsletter 选题草稿：AI 时代的判断力", "给客户 1 准备日报"],
    ["短期规划", "周五前定下 Q3 学习计划", "给客户 1 准备日报"]
  ])("从%s进入对应板块，根布局和已挂载卡片保持不变", (title, included, otherContent) => {
    const { container } = render(<DimensionPresetApp initialPreset="clue-board" syncUrl={false} />);
    const paper = paperOf(container);
    const layout = paper.querySelector("[data-layout-document]");
    const baseCard = cardOf(paper, "seed-schedule");
    const workspace = readDesktopWorkspace(SEED_LAYOUT_DOCUMENT.id);
    openThread(title);
    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-transition", "passage");
    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-direction", "down");
    expect(paper.querySelector("[data-layout-document]")).toBe(layout);
    expect(layout).toHaveAttribute("data-layout-document", SEED_LAYOUT_DOCUMENT.id);
    expect(cardOf(paper, "seed-schedule")).toBe(baseCard);
    expect(paper.querySelector(".dim-desktop-location-tools")).toHaveTextContent(title);
    expect(paper).toHaveTextContent(included);
    expect(paper).toHaveTextContent(otherContent);
    const thread = seedThreads().find(item => item.title === title)!;
    const area = cardOf(paper, areaReferenceCardId(thread.id));
    expect(area).toHaveTextContent(included);
    expect(area).not.toHaveTextContent(otherContent);
    fireEvent.click(container.querySelector(".dim-deck-home")!);
    expect(paper.querySelector("[aria-label='当前桌面板块']")).toHaveTextContent("桌面");
    expect(paper.querySelector("[data-layout-document]")).toBe(layout);
    expect(readDesktopWorkspace(SEED_LAYOUT_DOCUMENT.id).areas).toEqual(workspace.areas);
    expect(paper.querySelector(".dim-focus-capsule")).not.toBeInTheDocument();
  });

  it("typed 中期目标使用稳定板块身份，保留明确行动来源并通过原业务出口", () => {
    const browserLayout = structuredClone(BROWSER_PRODUCT_LAYOUT_DOCUMENT);
    const onLineage = vi.fn();
    const { container } = render(<DimensionPresetApp projection={typedGoalProjection()} layout={browserLayout}
      composition={{ registry: createBrowserCompositionRegistry(), document: layoutV1ToUiSurfaceV2(browserLayout) }}
      initialPreset="clue-board" syncUrl={false} localCardEditing="disabled" layerHandlers={{ onLineage }} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: /中期目标 1：完成客户交付.*双击进入主页板块/ }));
    const paper = paperOf(container);
    expect(paper.querySelector("[data-layout-document]")).toHaveAttribute("data-layout-document", browserLayout.id);
    expect(paper.querySelector(".dim-desktop-location-tools")).toHaveTextContent("完成客户交付");
    expect(paper).not.toHaveTextContent("布局文档有问题");
    const reference = cardOf(paper, areaReferenceCardId("goal-theme-client"));
    expect(reference).toHaveTextContent("建立产品闭环验收尺");
    expect(reference).toHaveTextContent("形成一页客户经营 POC 方案");
    expect(reference.querySelectorAll(".is-dimmed")).toHaveLength(0);
    fireEvent.contextMenu(reference.querySelector(".dim-drag")!, { clientX: 280, clientY: 240 });
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑内容" }));
    const content = screen.getByRole("dialog", { name: "编辑内容：完成客户交付 · 相关记录" });
    fireEvent.click(within(content).getAllByRole("button", { name: "查看来源：来自统一 Domain 的中期目标行动" })[0]);
    expect(onLineage).toHaveBeenCalledWith(expect.objectContaining({ entityType: "action", entityId: "action-acceptance" }));
  });

  it("连接可从支撑改为待验证，并在重新挂载后读回", () => {
    const first = render(<DimensionPresetApp initialPreset="clue-board" syncUrl={false} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑「工作现状」连接，当前为支撑" }));
    const editor = screen.getByRole("complementary", { name: "编辑连接：工作现状" });
    fireEvent.click(within(editor).getByRole("button", { name: "待验证" }));
    expect(JSON.parse(window.localStorage.getItem(CONNECTION_STORAGE_KEY) ?? "{}")).toEqual({ "thread-工作现状": "verify" });
    first.unmount();
    render(<DimensionPresetApp initialPreset="clue-board" syncUrl={false} />);
    expect(screen.getByRole("button", { name: "编辑「工作现状」连接，当前为待验证" })).toBeInTheDocument();
    expect(document.querySelector(".clue-paper-relation")).toBeNull();
  });

  it("线索编辑的标题只改变该板块，业务内容按 lineage 同步到常用区和关联卡", () => {
    const { container } = render(<DimensionPresetApp initialPreset="clue-board" syncUrl={false} />);
    const dialog = editThread("工作现状");
    const inputs = within(dialog).getAllByLabelText("内容");
    expect(inputs).toHaveLength(2);
    expect(within(dialog).queryByDisplayValue(/newsletter 选题草稿/)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("卡片标题"), { target: { value: "工作线索 · 交付桌" } });
    fireEvent.change(inputs[0], { target: { value: "给客户 1 发新版日报" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存到桌面" }));
    openThread("个人项目进度");
    const paper = paperOf(container);
    const work = cardOf(paper, areaReferenceCardId("thread-工作现状"));
    const personal = cardOf(paper, areaReferenceCardId("thread-个人项目进度"));
    expect(within(work).getByRole("heading", { name: "工作线索 · 交付桌" })).toBeInTheDocument();
    expect(work).toHaveTextContent("给客户 1 发新版日报");
    expect(personal).toHaveTextContent("newsletter 选题草稿：AI 时代的判断力");
    expect(personal).not.toHaveTextContent("给客户 1 发新版日报");
    const base = cardOf(paper, "seed-schedule");
    expect(within(base).getByRole("heading", { name: "今天的锚点" })).toBeInTheDocument();
    expect(base.querySelectorAll(".dim-anchor-row")).toHaveLength(4);
    expect(base).toHaveTextContent("给客户 1 发新版日报");
    fireEvent.click(container.querySelector(".dim-deck-home")!);
    expect(within(work).getByRole("heading", { name: "工作线索 · 交付桌" })).toBeInTheDocument();
  });

  it("板块整卡编辑按 lineage 合回，不删除其他线索，重新挂载仍读回标题与内容", () => {
    const first = render(<DimensionPresetApp initialPreset="clue-board" syncUrl={false} />);
    const dialog = editThread("个人项目进度");
    fireEvent.change(within(dialog).getByLabelText("卡片标题"), { target: { value: "我的 newsletter 桌" } });
    fireEvent.change(within(dialog).getByLabelText("内容"), { target: { value: "newsletter 写完第一段" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存到桌面" }));
    const stored = JSON.parse(window.localStorage.getItem(EDITS_KEY)!);
    expect(stored.bindings["desktop.schedule"].rows).toHaveLength(4);
    expect(stored.bindings["desktop.schedule"].rows.find((row: { text: string }) => row.text === "newsletter 写完第一段").lineage.entityId).toBe("seed-todo-newsletter");
    first.unmount();
    const second = render(<DimensionPresetApp initialPreset="paper" syncUrl={false} />);
    const paper = paperOf(second.container);
    expect(within(paper).getByRole("heading", { name: "我的 newsletter 桌" })).toBeInTheDocument();
    const base = cardOf(paper, "seed-schedule");
    expect(base).toHaveTextContent("newsletter 写完第一段");
    expect(base).toHaveTextContent("给客户 1 准备日报");
    expect(base).toHaveTextContent("周五前定下 Q3 学习计划");
    expect(within(base).getByRole("heading", { name: "今天的锚点" })).toBeInTheDocument();
  });

  it("旧板块的摘要与标题作为保留卡呈现，不覆盖真实早报，也不因导航消失", () => {
    const feed = SEED_DESKTOP_PROJECTION.bindings["desktop.feed"];
    if (feed?.kind !== "feed") throw new Error("seed feed missing");
    window.localStorage.setItem(EDITS_KEY, JSON.stringify({ bindings: {}, presentations: {},
      threadBindings: { "个人项目进度": { "desktop.feed": { ...feed, items: [{ ...feed.items[0], title: "newsletter 已经找到开头" }] } } },
      threadPresentations: { "个人项目进度": { "seed-feed": { ...SEED_LAYOUT_DOCUMENT.cards.find(card => card.id === "seed-feed")!.presentation, title: "个人项目情报角" } } }
    }));
    const { container } = render(<DimensionPresetApp initialPreset="clue-board" syncUrl={false} />);
    openThread("个人项目进度");
    const paper = paperOf(container);
    const saved = cardOf(paper, "area-edit:thread-个人项目进度:desktop.feed");
    expect(saved).toHaveTextContent("newsletter 已经找到开头");
    expect(within(saved).getByRole("heading", { name: "个人项目情报角" })).toBeInTheDocument();
    const base = cardOf(paper, "seed-feed");
    expect(base).toHaveTextContent("客户 1 的日报模板昨晚改版了");
    expect(base).toHaveTextContent("agent badcase 分类法有一篇新总结");
    expect(base).not.toHaveTextContent("newsletter 已经找到开头");
    fireEvent.click(container.querySelector(".dim-deck-home")!);
    expect(cardOf(paper, "area-edit:thread-个人项目进度:desktop.feed")).toBe(saved);
  });

  it("恢复来源只回滚当前线索，保留其他线索已有编辑", () => {
    const schedule = SEED_DESKTOP_PROJECTION.bindings["desktop.schedule"];
    if (schedule?.kind !== "anchors") throw new Error("seed schedule missing");
    window.localStorage.setItem(EDITS_KEY, JSON.stringify({ bindings: { "desktop.schedule": { ...schedule,
      rows: schedule.rows.map(row => row.tags?.includes("个人项目进度") ? { ...row, text: "个人项目已有自定义名称" } : row)
    } }, presentations: {}, threadBindings: {}, threadPresentations: {} }));
    const { container } = render(<DimensionPresetApp initialPreset="clue-board" syncUrl={false} />);
    let dialog = editThread("工作现状");
    fireEvent.change(within(dialog).getAllByLabelText("内容")[0], { target: { value: "工作日报临时改名" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存到桌面" }));
    expect(paperOf(container)).toHaveTextContent("工作日报临时改名");
    dialog = editThread("工作现状");
    fireEvent.click(within(dialog).getByRole("button", { name: "恢复来源内容" }));
    const paper = paperOf(container);
    expect(paper).toHaveTextContent("给客户 1 准备日报");
    expect(paper).not.toHaveTextContent("工作日报临时改名");
    expect(paper).toHaveTextContent("个人项目已有自定义名称");
  });

  it("卡片位置属于共享桌面，跨板块和回常用区保持同一DOM及拖拽偏移", () => {
    const { container } = render(<DimensionPresetApp initialPreset="clue-board" syncUrl={false} />);
    openThread("工作现状");
    const paper = paperOf(container);
    const card = cardOf(paper, "seed-flex").querySelector<HTMLElement>(".dim-drag")!;
    fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 130, clientY: 118 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 130, clientY: 118 });
    expect(card).toHaveStyle({ translate: "30px 18px" });
    const offsets = window.localStorage.getItem(`dim-desk-offsets-${SEED_LAYOUT_DOCUMENT.id}`);
    fireEvent.click(screen.getByRole("button", { name: "线索板桌面" }));
    openThread("个人项目进度");
    expect(cardOf(paper, "seed-flex").querySelector(".dim-drag")).toBe(card);
    expect(card).toHaveStyle({ translate: "30px 18px" });
    fireEvent.click(container.querySelector(".dim-deck-home")!);
    expect(card).toHaveStyle({ translate: "30px 18px" });
    expect(window.localStorage.getItem(`dim-desk-offsets-${SEED_LAYOUT_DOCUMENT.id}`)).toBe(offsets);
  });
});


it("keeps all goals on the unbounded board without pagination", () => {
  const projection = typedGoalProjection();
  const theme = projection.clueBoard!.themes[0];
  projection.clueBoard!.themes = Array.from({ length: 5 }, (_, i) => ({ ...theme, id: `goal-${i}`, title: `目标 ${i + 1}` }));
  const { rerender } = render(<ClueBoardPreset projection={projection} />);
  expect(screen.getByRole("heading", { name: "目标 5" })).toBeVisible();
  const next = structuredClone(projection);
  next.clueBoard!.themes.pop();
  rerender(<ClueBoardPreset projection={next} />);
  expect(screen.getByRole("heading", { name: "目标 1" })).toBeVisible();
  expect(screen.queryByRole("navigation", { name: "目标分页" })).not.toBeInTheDocument();
});
