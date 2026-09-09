import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { DesktopViewContext } from "../../dimension/desktopWorkspace";
import { describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  todo: {
    todos: [
      {
        id: "todo-1",
        title: "完成一次真实验证",
        priority: "none",
        tags: [],
        status: "done",
        createdAt: "2026-08-24T08:00:00Z",
        completedAt: "2026-08-24T12:00:00Z"
      }
    ],
    loaded: true,
    error: null,
    hydrate: vi.fn(async () => undefined),
    completeTodo: vi.fn(async () => undefined),
    renameTodo: vi.fn(async () => undefined),
    addTodo: vi.fn(async () => undefined)
  },
  calendar: {
    events: [],
    loaded: true,
    error: null,
    hydrate: vi.fn(async () => undefined)
  },
  activity: {
    activities: [],
    loaded: true,
    error: null,
    hydrate: vi.fn(async () => undefined),
    addActivity: vi.fn(async () => undefined)
  },
  goals: {
    goals: [],
    loaded: true,
    error: null,
    hydrate: vi.fn(async () => undefined)
  },
  proposals: {
    proposals: [],
    loaded: true,
    error: null,
    hydrate: vi.fn(async () => undefined),
    decide: vi.fn(async () => true)
  },
  chat: {
    conversations: [
      {
        id: "conv-1",
        title: "最近会话",
        createdAt: "2026-08-24T08:00:00Z",
        updatedAt: "2026-08-24T12:00:00Z"
      }
    ],
    loading: false,
    streaming: false,
    currentId: null,
    messagesByConv: {},
    hydrate: vi.fn(async () => undefined),
    selectConv: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined)
  }
}));

function selectable<T extends object>(state: T) {
  return Object.assign(
    (selector: (value: T) => unknown) => selector(state),
    { getState: () => state }
  );
}

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("../../lib/db", () => ({
  dbGetRecentDigests: vi.fn(async () => []),
  dbListMemoryFacts: vi.fn(async () => [])
}));
vi.mock("../../lib/store", () => ({ useTodoStore: selectable(storeMocks.todo) }));
vi.mock("../../lib/calendarEventsStore", () => ({
  useCalendarEventsStore: selectable(storeMocks.calendar)
}));
vi.mock("../../lib/activityStore", () => ({
  useActivityStore: selectable(storeMocks.activity)
}));
vi.mock("../../lib/goalsStore", () => ({
  useGoalsStore: selectable(storeMocks.goals)
}));
vi.mock("../../lib/proposalsStore", () => ({
  useProposalsStore: selectable(storeMocks.proposals),
  pendingProposalOf: () => null
}));
vi.mock("../../lib/chatStore", () => ({ useChatStore: selectable(storeMocks.chat) }));
vi.mock("../../lib/syncBus", () => ({ onSync: () => () => undefined }));

vi.mock("../../dimension/Shell", () => ({
  DimToast: () => null,
  useDimToast: () => ({ toast: null, say: vi.fn() })
}));
vi.mock("../../dimension/presets/DimensionPresetApp", () => ({
  DimensionPresetApp: (props: {
    onOpenReview?: () => void;
    onOpenSettings?: () => void;
    onDesktopContextChange?: (context: DesktopViewContext) => void;
    onSendMessage?: (text: string) => void;
    thread?: ReactNode;
  }) => (
    <div>
      <button type="button" onClick={props.onOpenReview}>打开共同变化</button>
      <button type="button" onClick={props.onOpenSettings}>打开工具</button>
      <button type="button" onClick={() => props.onDesktopContextChange?.({ view: "paper", area: { id: "goal-1", title: "客户交付" }, visibleCardIds: ["card-1"] })}>选交付板块</button>
      <button type="button" onClick={() => props.onDesktopContextChange?.({ view: "paper", area: null, visibleCardIds: ["card-home"] })}>回常用区</button>
      <button type="button" onClick={() => props.onSendMessage?.("桌面原始消息")}>从桌面发送</button>
      {props.thread}
    </div>
  )
}));
vi.mock("../../pages/SettingsPage", () => ({ SettingsPage: () => <div>设置工具页</div> }));
vi.mock("../../pages/ConnectionsPage", () => ({ ConnectionsPage: () => <div>外部连接工具页</div> }));
vi.mock("../../pages/TelosPage", () => ({ TelosPage: () => <div>长期目标工具页</div> }));

import { LiveDimensionApp } from "./LiveDimensionApp";

describe("LiveDimensionApp · Tauri 真实接线", () => {
  it("passes current UI context through both desktop and continuing DeskThread sends", async () => {
    storeMocks.chat.sendMessage.mockClear();
    render(<LiveDimensionApp />);
    fireEvent.click(screen.getByRole("button", { name: "选交付板块" }));
    fireEvent.click(screen.getByRole("button", { name: "从桌面发送" }));
    await waitFor(() => expect(storeMocks.chat.sendMessage).toHaveBeenCalledWith("桌面原始消息", {
      transientContext: expect.stringContaining('"area":{"id":"goal-1","title":"客户交付"}'),
    }));
    fireEvent.click(screen.getByRole("button", { name: "回常用区" }));
    fireEvent.change(screen.getByRole("textbox", { name: "给秘书发消息" }), { target: { value: "对话里接着说" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(storeMocks.chat.sendMessage).toHaveBeenLastCalledWith("对话里接着说", {
      transientContext: expect.stringContaining('"area":null,"visibleCardIds":["card-home"]'),
    }));
  });
  it("共同变化进入来源后，关闭来源回到时间线而不是丢失上下文", async () => {
    render(<LiveDimensionApp />);
    await waitFor(() => expect(storeMocks.todo.hydrate).toHaveBeenCalled());
    await waitFor(() =>
      expect(storeMocks.chat.selectConv).toHaveBeenCalledWith("conv-1", {
        reload: true
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "打开共同变化" }));
    expect(screen.getByRole("heading", { name: "共同变化" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "◇ 看来源" }));
    expect(screen.getByRole("heading", { name: "完成一次真实验证" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "← 回共同变化" }));
    expect(screen.getByRole("heading", { name: "共同变化" })).toBeInTheDocument();
  });

  it("现有外部连接页从 Dimension 工具层可达", async () => {
    render(<LiveDimensionApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开工具" }));
    fireEvent.click(screen.getByRole("button", { name: "外部连接" }));

    expect(await screen.findByText("外部连接工具页")).toBeInTheDocument();
  });
});
