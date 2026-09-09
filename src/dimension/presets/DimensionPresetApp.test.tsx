import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEED_DESKTOP_PROJECTION } from "../../projections/desktop/seedProjection";
import {
  BROWSER_PRODUCT_LAYOUT_DOCUMENT,
  createBrowserCompositionRegistry,
  layoutV1ToUiSurfaceV2,
} from "../../runtime/composition/browserProduction";
import { SEED_LAYOUT_DOCUMENT } from "../../runtime/layout/seedLayout";
import { DimensionPresetApp } from "./DimensionPresetApp";
import { resolveDimensionPreset } from "./presetQuery";

describe("共享桌面的视图导航", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { window.localStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("解析分享链接，非法值稳定回退纸面", () => {
    expect(resolveDimensionPreset("?dimension=1&preset=clue-board")).toBe("clue-board");
    expect(resolveDimensionPreset("?preset=constellation")).toBe("constellation");
    expect(resolveDimensionPreset("?preset=unknown")).toBe("paper");
    expect(resolveDimensionPreset("")).toBe("paper");
  });

  it("切换时保留其他查询参数和 hash，回到纸面会移除 preset", () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, "", "/?dimension=1&debug=1#today");
      render(<DimensionPresetApp initialPreset="paper" />);

      fireEvent.click(screen.getByRole("button", { name: "线索板桌面" }));
      expect(window.location.search).toBe("?dimension=1&debug=1&preset=clue-board");
      expect(window.location.hash).toBe("#today");

      // rail 允许在过渡中直接改向，URL 立即以最后意图为准。
      fireEvent.click(screen.getByRole("button", { name: "纸面桌面" }));
      expect(window.location.search).toBe("?dimension=1&debug=1");
      expect(window.location.hash).toBe("#today");
    } finally {
      act(() => vi.runOnlyPendingTimers());
      vi.useRealTimers();
    }
  });

  it("默认落在纸面桌面，线索板与星图常驻挂载但不露出来", () => {
    const { container } = render(
      <DimensionPresetApp initialPreset="paper" syncUrl={false} />
    );

    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-active", "paper");
    expect(screen.getByRole("heading", { name: "今天的锚点" })).toBeInTheDocument();
    expect(container.querySelectorAll("[data-layout-card-id]")).toHaveLength(7);
    // 三层常驻（状态不丢），非激活层对读屏与 Tab 隐藏
    expect(container.querySelector("[data-deck-layer='clue-board']")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    expect(container.querySelector("[data-deck-layer='constellation']")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
  });

  it("不再有顶部形态预览条，右缘层标按空间顺序排列", () => {
    render(<DimensionPresetApp initialPreset="paper" syncUrl={false} />);

    expect(screen.queryByText("形态预览")).not.toBeInTheDocument();
    const rail = screen.getByRole("navigation", { name: "桌面视图" });
    const stops = [...rail.querySelectorAll("button")].map((b) => b.textContent);
    expect(stops).toEqual(["星图", "线索版", "主页"]); // 上星图 · 中线索 · 下主页
  });

  it("视图只由明确导航切换，桌面滚轮和捏合不再触发换层", () => {
    const { container } = render(<DimensionPresetApp initialPreset="paper" syncUrl={false} />);
    const deck = container.querySelector(".dim-deck")!;
    for (let i = 0; i < 5; i++) {
      fireEvent.wheel(deck, { deltaY: -120 });
      fireEvent.wheel(deck, { deltaY: 120, ctrlKey: true });
    }
    expect(deck).toHaveAttribute("data-active", "paper");
    fireEvent.click(screen.getByRole("button", { name: "线索板桌面" }));
    expect(deck).toHaveAttribute("data-active", "clue-board");
    expect(deck).toHaveAttribute("data-transition", "passage");
    fireEvent.click(screen.getByRole("button", { name: "星图桌面" }));
    expect(deck).toHaveAttribute("data-active", "constellation");
    expect(deck).toHaveAttribute("data-transition", "depth");
    fireEvent.click(screen.getByRole("button", { name: "纸面桌面" }));
    expect(deck).toHaveAttribute("data-active", "paper");
    expect(container.querySelector("[data-deck-layer='clue-board']")).not.toHaveAttribute("data-motion");
  });

  it("PageUp 抬头 / PageDown 回落，并可在过渡中及时改向", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <DimensionPresetApp initialPreset="clue-board" syncUrl={false} />
      );
      const deck = container.querySelector(".dim-deck")!;

      fireEvent.keyDown(window, { key: "PageUp" });
      expect(deck).toHaveAttribute("data-active", "constellation");

      fireEvent.keyDown(window, { key: "PageDown" });
      expect(deck).toHaveAttribute("data-active", "clue-board");

      fireEvent.keyDown(window, { key: "PageDown" });
      expect(deck).toHaveAttribute("data-active", "paper");
    } finally {
      act(() => vi.runOnlyPendingTimers());
      vi.useRealTimers();
    }
  });

  it("三种形态始终消费传入的同一份投影", () => {
    const schedule = SEED_DESKTOP_PROJECTION.bindings["desktop.schedule"];
    if (schedule?.kind !== "anchors") throw new Error("seed schedule missing");
    const projection = {
      ...SEED_DESKTOP_PROJECTION,
      header: {
        ...SEED_DESKTOP_PROJECTION.header,
        title: "同一份投影里的今日方向"
      },
      bindings: {
        ...SEED_DESKTOP_PROJECTION.bindings,
        "desktop.schedule": {
          ...schedule,
          rows: schedule.rows.map((row, index) => index === 0
            ? { ...row, text: "同一份投影里的今日行动" }
            : row)
        }
      },
      constellation: {
        ...SEED_DESKTOP_PROJECTION.constellation,
        northStar: {
          ...SEED_DESKTOP_PROJECTION.constellation.northStar,
          title: "同一份投影里的长期方向"
        }
      }
    };
    const { container } = render(
      <DimensionPresetApp
        projection={projection}
        initialPreset="paper"
        syncUrl={false}
      />
    );

    // 桌面和线索板共享行动内容，命题只留在线索板；星图读取同一投影的长期方向。
    const paper = container.querySelector("[data-deck-layer='paper']");
    const clue = container.querySelector("[data-deck-layer='clue-board']");
    const constellation = container.querySelector("[data-deck-layer='constellation']");
    expect(paper).toHaveTextContent("同一份投影里的今日行动");
    expect(paper).not.toHaveTextContent("同一份投影里的今日方向");
    expect(clue).toHaveTextContent("同一份投影里的今日行动");
    expect(clue).toHaveTextContent("同一份投影里的今日方向");
    expect(constellation).toHaveTextContent("同一份投影里的长期方向");
    expect(constellation).not.toHaveTextContent("TO BE AGI");
  });

  it("线索入口定位同一桌面板块，常用区与其他板块内容保留", () => {
    const { container } = render(<DimensionPresetApp initialPreset="clue-board" syncUrl={false} />);
    expect(screen.getByRole("heading", { name: "线索版" })).toBeInTheDocument();
    const desk = container.querySelector("[data-deck-layer='paper']")!;
    const rootLayout = desk.querySelector("[data-layout-document]");
    const work = screen.getByRole("button", { name: /线索 1：工作现状.*双击进入主页板块/ });
    expect(screen.getByRole("button", { name: /线索 2：个人项目进度/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /线索 3：短期规划/ })).toBeInTheDocument();
    fireEvent.click(work, { detail: 1 });
    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-active", "clue-board");
    fireEvent.doubleClick(work);
    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-active", "paper");
    expect(desk.querySelector("[data-layout-document]")).toBe(rootLayout);
    expect(rootLayout).toHaveAttribute("data-layout-document", SEED_LAYOUT_DOCUMENT.id);
    expect(desk.querySelector(".dim-desktop-location-tools")).toHaveTextContent("工作现状");
    expect(desk).toHaveTextContent("newsletter 选题草稿：AI 时代的判断力");
    expect(desk.querySelectorAll(".dim-anchor-row")).toHaveLength(8);
    fireEvent.click(container.querySelector(".dim-deck-home")!);
    expect(desk.querySelector("[aria-label='当前桌面板块']")).toHaveTextContent("桌面");
    expect(desk.querySelector("[data-layout-document]")).toBe(rootLayout);
    expect(desk.querySelectorAll(".dim-anchor-row")).toHaveLength(8);
  });

  it("线索纸右键查看详情，抽屉里保留原行动记录", () => {
    render(<DimensionPresetApp initialPreset="clue-board" syncUrl={false} />);

    fireEvent.contextMenu(screen.getByRole("button", { name: /线索 1：工作现状.*右键打开卡片设置/ }), { clientX: 240, clientY: 180 });
    fireEvent.click(screen.getByRole("menuitem", { name: "查看详情" }));
    const drawer = screen.getByRole("complementary", { name: /线索详情：工作现状/ });
    expect(drawer).toHaveTextContent("给客户 1 准备日报");
    expect(drawer).toHaveTextContent("修改客户 2 的 agent badcase");
    expect(drawer).toHaveTextContent("2 件在走");

    fireEvent.click(screen.getByRole("button", { name: "合上详情" }));
    expect(
      screen.queryByRole("complementary", { name: /线索详情/ })
    ).not.toBeInTheDocument();
  });

  it("桌面便签可以拖散，右键编辑保留位置且 Shift 双击仍可归位", () => {
    window.localStorage.clear();
    const { container } = render(
      <DimensionPresetApp initialPreset="paper" syncUrl={false} />
    );
    const dragLayer = container.querySelector(
      "[data-layout-card-id='seed-flex'] .dim-drag"
    )!;

    fireEvent.pointerDown(dragLayer, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(dragLayer, { pointerId: 1, clientX: 160, clientY: 140 });
    fireEvent.pointerUp(dragLayer, { pointerId: 1, clientX: 160, clientY: 140 });

    expect(dragLayer).toHaveStyle({ translate: "60px 40px" });
    const stored = JSON.parse(
      window.localStorage.getItem("dim-desk-offsets-dimension-seed-desktop") ?? "{}"
    );
    expect(stored["seed-flex"]).toEqual({ x: 60, y: 40 });

    fireEvent.contextMenu(dragLayer, { clientX: 240, clientY: 180 });
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑内容" }));
    fireEvent.click(screen.getByRole("button", { name: "修改标题与内容" }));
    expect(screen.getByRole("dialog", { name: "编辑卡片" })).toBeInTheDocument();
    expect(dragLayer).toHaveStyle({ translate: "60px 40px" });
    fireEvent.click(screen.getByRole("button", { name: "关闭卡片编辑器" }));

    fireEvent.doubleClick(dragLayer, { shiftKey: true });
    expect(dragLayer).not.toHaveStyle({ translate: "60px 40px" });
    expect(screen.queryByRole("dialog", { name: "编辑卡片" })).not.toBeInTheDocument();
    window.localStorage.clear();
  });

  it("桌面卡片可以跨过旧边界并在拿起时自动置顶", () => {
    window.localStorage.clear();
    const { container } = render(
      <DimensionPresetApp initialPreset="paper" syncUrl={false} />
    );
    const first = container.querySelector(
      "[data-layout-card-id='seed-flex'] .dim-drag"
    ) as HTMLElement;
    const second = container.querySelector(
      "[data-layout-card-id='seed-feed'] .dim-drag"
    ) as HTMLElement;

    fireEvent.pointerDown(first, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(first, { pointerId: 1, clientX: 590, clientY: 470 });
    fireEvent.pointerUp(first, { pointerId: 1, clientX: 590, clientY: 470 });

    expect(first).toHaveStyle({ translate: "580px 460px" });
    expect(Number(first.style.zIndex)).toBeGreaterThan(Number(second.style.zIndex));
    expect(JSON.parse(
      window.localStorage.getItem("dim-desk-offsets-dimension-seed-desktop") ?? "{}"
    )["seed-flex"]).toEqual({ x: 580, y: 460 });
    window.localStorage.clear();
  });

  it("卡片可以移除，并从添加卡片入口恢复", () => {
    const { container } = render(
      <DimensionPresetApp initialPreset="paper" syncUrl={false} />
    );
    expect(container.querySelectorAll("[data-layout-card-id]")).toHaveLength(7);

    fireEvent.contextMenu(container.querySelector("[data-layout-card-id='seed-flex'] .dim-drag")!, { clientX: 240, clientY: 180 });
    fireEvent.click(screen.getByRole("menuitem", { name: /移除卡片/ }));
    expect(container.querySelectorAll("[data-layout-card-id]")).toHaveLength(6);
    expect(screen.getByText(/已移除「核心记忆点」/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /卡片总览/ }));
    fireEvent.click(screen.getByRole("button", { name: "放回桌面：核心记忆点" }));
    expect(container.querySelectorAll("[data-layout-card-id]")).toHaveLength(7);
    expect(screen.getByText("已放回桌面")).toBeInTheDocument();
  });

  it("线索纸可以在板上拖动重排，墨线跟着走，钉法记进本地", () => {
    window.localStorage.clear();
    const { container } = render(
      <DimensionPresetApp initialPreset="clue-board" syncUrl={false} />
    );
    const surface = container.querySelector(".clue-surface")!;
    // jsdom 没有布局，补一个板面尺寸
    surface.getBoundingClientRect = () =>
      ({ width: 1000, height: 680, left: 0, top: 0 }) as DOMRect;

    const paper = container.querySelector(".clue-thread-paper")!;
    expect(paper).toHaveStyle({ left: "22%", top: "26%" });

    fireEvent.pointerDown(paper, { button: 0, pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(paper, { pointerId: 1, clientX: 300, clientY: 268 });
    fireEvent.pointerUp(paper, { pointerId: 1, clientX: 300, clientY: 268 });

    expect(paper).toHaveStyle({ left: "32%", top: "36%" });
    const stored = JSON.parse(
      window.localStorage.getItem("dim-clue-positions-v1") ?? "{}"
    );
    expect(stored["thread-工作现状"]).toEqual({ x: 32, y: 36 });

    // 拖动伴随的点击被吞掉：不会误进聚焦桌面
    expect(container.querySelector(".dim-deck")).toHaveAttribute(
      "data-active",
      "clue-board"
    );
    window.localStorage.clear();
  });

  it("线索板的命题和提案都能拖动，连线随命题位置一起更新", () => {
    window.localStorage.clear();
    const projection = {
      ...SEED_DESKTOP_PROJECTION,
      bindings: {
        ...SEED_DESKTOP_PROJECTION.bindings,
        "desktop.flex": {
          kind: "proposal" as const,
          quote: "要不要把明早的第一个锚点留给主线？",
          accept: "好",
          reject: "先不",
        },
      },
    };
    const { container } = render(
      <DimensionPresetApp
        projection={projection}
        initialPreset="clue-board"
        syncUrl={false}
      />
    );
    const surface = container.querySelector(".clue-surface");
    if (!(surface instanceof HTMLElement)) throw new Error("clue surface missing");
    surface.getBoundingClientRect = () =>
      ({ width: 1000, height: 680, left: 0, top: 0 }) as DOMRect;

    const thesis = container.querySelector("[data-board-item-id='board:thesis']");
    const proposal = container.querySelector("[data-board-item-id='board:proposal']");
    const line = container.querySelector(".clue-thread-hit");
    if (!(thesis instanceof HTMLElement)) throw new Error("thesis missing");
    if (!(proposal instanceof HTMLElement)) throw new Error("proposal missing");
    if (!(line instanceof Element)) throw new Error("connection line missing");
    const beforeLine = line.getAttribute("d");

    fireEvent.pointerDown(thesis, { button: 0, pointerId: 1, clientX: 500, clientY: 100 });
    fireEvent.pointerMove(thesis, { pointerId: 1, clientX: 600, clientY: 168 });
    fireEvent.pointerUp(thesis, { pointerId: 1, clientX: 600, clientY: 168 });
    expect(thesis).toHaveStyle({ left: "60%", top: "25%" });
    expect(line.getAttribute("d")).not.toBe(beforeLine);
    fireEvent.click(thesis);
    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-active", "clue-board");

    fireEvent.pointerDown(proposal, { button: 0, pointerId: 3, clientX: 420, clientY: 540 });
    fireEvent.pointerMove(proposal, { pointerId: 3, clientX: 470, clientY: 506 });
    fireEvent.pointerUp(proposal, { pointerId: 3, clientX: 470, clientY: 506 });
    expect(proposal).toHaveStyle({ left: "47%", top: "75%" });

    const stored = JSON.parse(
      window.localStorage.getItem("dim-clue-positions-v1") ?? "{}"
    );
    expect(stored).toMatchObject({
      "board:thesis": { x: 60, y: 25 },
      "board:proposal": { x: 47, y: 75 },
    });
    window.localStorage.clear();
  });

  it("线索板上的提案带五态裁决，走 layerHandlers 出口", () => {
    const verdicts: string[] = [];
    const projection = {
      ...SEED_DESKTOP_PROJECTION,
      bindings: {
        ...SEED_DESKTOP_PROJECTION.bindings,
        "desktop.flex": {
          kind: "proposal" as const,
          quote: "要不要把明早的第一个锚点留给主线？",
          accept: "好",
          reject: "先不",
          verdicts: [
            { id: "interesting" as const, label: "有点意思" },
            { id: "holds" as const, label: "这对我成立" },
            { id: "try" as const, label: "要不试试" },
            { id: "reject" as const, label: "不太对" },
            { id: "park" as const, label: "先放着" }
          ]
        }
      }
    };
    render(
      <DimensionPresetApp
        projection={projection}
        initialPreset="clue-board"
        syncUrl={false}
        layerHandlers={{ onVerdict: (v) => verdicts.push(v.id) }}
      />
    );

    // 线索板激活层；提案纸钉在板上，裁决即真实出口
    fireEvent.click(screen.getByRole("button", { name: "要不试试" }));
    expect(verdicts).toEqual(["try"]);
  });

  it("星图保留长期方向与待确认状态，并将当前选中星带入对话", () => {
    const onDiscussNode = vi.fn();
    render(
      <DimensionPresetApp initialPreset="constellation" syncUrl={false} layerHandlers={{ onDiscussNode }} />
    );

    expect(screen.getByRole("heading", { name: "此刻星图" })).toBeInTheDocument();
    const north = screen.getByRole("button", {
      name: /北极星 · 长期方向：TO BE AGI/
    });
    expect(north).toBeInTheDocument();
    const cognition = screen.getByRole("button", {
      name: /认知星：证据优先（认知评价 · 待你确认）/
    });
    expect(cognition).toBeInTheDocument();

    fireEvent.click(north);
    const caption = screen.getByText(/这周到这里 · 60%/);
    expect(caption).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /星径：/ })).not.toBeInTheDocument();
    fireEvent.click(cognition);
    expect(cognition).toHaveAttribute("aria-pressed", "true");
    expect(north).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: /靠近看看/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "和维度聊聊" }));
    expect(onDiscussNode).toHaveBeenCalledWith(expect.objectContaining({
      label: "证据优先", meta: "认知评价 · 待你确认",
      detail: SEED_DESKTOP_PROJECTION.constellation.cognitions[1].detail,
    }));
  });

  it("点秘书立绘直接打开对话", () => {
    const intents: string[] = [];
    render(
      <DimensionPresetApp
        initialPreset="paper"
        syncUrl={false}
        onSecretaryInteract={(intent) => intents.push(intent)}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "打开对话" }));
    expect(intents).toEqual(["chat"]);
  });

  it("秘书栏全局常驻、可收起，收起后只占一条细边", () => {
    render(<DimensionPresetApp initialPreset="paper" syncUrl={false} />);

    fireEvent.click(screen.getByRole("button", { name: "收起秘书栏" }));
    expect(screen.getByRole("complementary", { name: "秘书栏（已收起）" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开秘书栏" }));
    expect(
      screen.queryByRole("complementary", { name: "秘书栏（已收起）" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开对话" })).toBeInTheDocument();
  });

  it.each(["0", "1"])("窄窗口临时收起秘书栏，展开和恢复宽屏不覆盖已保存的偏好 %s", (preference) => {
    let compact = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      get matches() { return query === "(max-width: 600px)" ? compact : false; },
      media: query,
      addEventListener: (_type: string, listener: () => void) => {
        if (query === "(max-width: 600px)") listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    })));
    window.localStorage.setItem("dim-rail-collapsed", preference);
    render(<DimensionPresetApp initialPreset="paper" syncUrl={false} />);

    expect(screen.getByRole("complementary", { name: "秘书栏（已收起）" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回常用区" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开秘书栏" }));
    expect(screen.getByRole("complementary", { name: "秘书栏" })).toBeInTheDocument();
    expect(window.localStorage.getItem("dim-rail-collapsed")).toBe(preference);
    fireEvent.click(screen.getByRole("button", { name: "收起秘书栏" }));
    expect(window.localStorage.getItem("dim-rail-collapsed")).toBe(preference);

    act(() => { compact = false; listeners.forEach(listener => listener()); });
    expect(screen.getByRole("complementary", {
      name: preference === "1" ? "秘书栏（已收起）" : "秘书栏"
    })).toBeInTheDocument();
    expect(window.localStorage.getItem("dim-rail-collapsed")).toBe(preference);
  });

  it("设置常驻整体左下角，秘书栏收起后仍可用", () => {
    const onOpenSettings = vi.fn();
    const { container } = render(
      <DimensionPresetApp
        initialPreset="constellation"
        syncUrl={false}
        onOpenSettings={onOpenSettings}
      />
    );

    const globalRail = container.querySelector(".dim-global-rail");
    if (!(globalRail instanceof HTMLElement)) throw new Error("missing global secretary rail");
    const expandedSettings = within(globalRail).getByRole("button", { name: "设置" });
    expect(container.querySelector("[data-deck-layer='paper'] header")).not.toContainElement(
      expandedSettings
    );
    fireEvent.click(expandedSettings);
    expect(onOpenSettings).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "收起秘书栏" }));
    const collapsedRail = screen.getByRole("complementary", { name: "秘书栏（已收起）" });
    const collapsedSettings = within(collapsedRail).getByRole("button", { name: "设置" });
    collapsedSettings.focus();
    expect(collapsedSettings).toHaveFocus();
    fireEvent.click(collapsedSettings);
    expect(onOpenSettings).toHaveBeenCalledTimes(2);
  });

  it("导航隐藏或任一 binding 解绑时强制回纸面，不让用户困在高层", () => {
    const layout = structuredClone(BROWSER_PRODUCT_LAYOUT_DOCUMENT);
    const hiddenNavigation = layoutV1ToUiSurfaceV2(layout);
    hiddenNavigation.components.find(
      (component) => component.id === "dimension-navigation",
    )!.visible = false;
    const first = render(
      <DimensionPresetApp
        initialPreset="constellation"
        syncUrl={false}
        layout={layout}
        composition={{
          document: hiddenNavigation,
          registry: createBrowserCompositionRegistry(),
        }}
      />,
    );
    expect(first.container.querySelector(".dim-deck")).toHaveAttribute("data-active", "paper");
    expect(screen.queryByRole("navigation", { name: "桌面视图" })).not.toBeInTheDocument();
    fireEvent.wheel(first.container.querySelector(".dim-deck")!, { deltaY: -120 });
    expect(first.container.querySelector(".dim-deck")).toHaveAttribute("data-active", "paper");
    first.unmount();

    const unboundNavigation = layoutV1ToUiSurfaceV2(layout);
    delete unboundNavigation.components.find(
      (component) => component.id === "dimension-navigation",
    )!.actions.clue;
    const second = render(
      <DimensionPresetApp
        initialPreset="constellation"
        syncUrl={false}
        layout={layout}
        composition={{
          document: unboundNavigation,
          registry: createBrowserCompositionRegistry(),
        }}
      />,
    );
    expect(second.container.querySelector(".dim-deck")).toHaveAttribute("data-active", "paper");
    expect(screen.getByRole("button", { name: "纸面桌面" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "线索板桌面" })).toBeDisabled();
  });
});
