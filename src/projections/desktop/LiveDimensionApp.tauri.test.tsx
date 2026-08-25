import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  }) => (
    <div>
      <button type="button" onClick={props.onOpenReview}>打开共同变化</button>
      <button type="button" onClick={props.onOpenSettings}>打开工具</button>
    </div>
  )
}));
vi.mock("../../pages/SettingsPage", () => ({ SettingsPage: () => <div>设置工具页</div> }));
vi.mock("../../pages/ConnectionsPage", () => ({ ConnectionsPage: () => <div>外部连接工具页</div> }));
vi.mock("../../pages/TelosPage", () => ({ TelosPage: () => <div>长期目标工具页</div> }));

import { LiveDimensionApp } from "./LiveDimensionApp";

describe("LiveDimensionApp · Tauri 真实接线", () => {
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
