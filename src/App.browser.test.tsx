import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({
  bridgeDataChangedToSync: vi.fn(),
  setupOnlineReplay: vi.fn(),
  startSecretaryScheduler: vi.fn(() => vi.fn()),
  runStartupBackfill: vi.fn(),
  setupFeishuChatBridge: vi.fn(),
  windowRole: vi.fn(() => "main"),
  pushProactiveConfig: vi.fn(),
}));

vi.mock("./components/BoardShell", () => ({ BoardShell: () => null }));
vi.mock("./components/ChatBar", () => ({ ChatBar: () => null }));
vi.mock("./components/Launcher", () => ({ Launcher: () => null }));
vi.mock("./pages/TodoFloat", () => ({ TodoFloat: () => null }));
vi.mock("./components/ConfirmDialog", () => ({
  ConfirmDialogProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./components/Toaster", () => ({ Toaster: () => null }));
vi.mock("./lib/store", () => ({ useTodoStore: { getState: () => ({ hydrate: vi.fn() }) } }));
vi.mock("./lib/goalsStore", () => ({ useGoalsStore: { getState: () => ({ hydrate: vi.fn() }) } }));
vi.mock("./lib/activityStore", () => ({ useActivityStore: { getState: () => ({ hydrate: vi.fn() }) } }));
vi.mock("./lib/calendarEventsStore", () => ({ useCalendarEventsStore: { getState: () => ({ hydrate: vi.fn() }) } }));
vi.mock("./lib/fieldStore", () => ({ useFieldStore: { getState: () => ({ hydrate: vi.fn() }) } }));
vi.mock("./lib/chatStore", () => ({ useChatStore: { getState: () => ({ hydrate: vi.fn() }) } }));
vi.mock("./lib/syncBus", () => ({
  onSync: vi.fn(() => vi.fn()),
  bridgeDataChangedToSync: effects.bridgeDataChangedToSync,
}));
vi.mock("./lib/calendarSync", () => ({ setupOnlineReplay: effects.setupOnlineReplay }));
vi.mock("./lib/secretary/wiring", () => ({
  startSecretaryScheduler: effects.startSecretaryScheduler,
  runStartupBackfill: effects.runStartupBackfill,
}));
vi.mock("./lib/feishuChat", () => ({ setupFeishuChatBridge: effects.setupFeishuChatBridge }));
vi.mock("./lib/windowLayout", () => ({ windowRole: effects.windowRole }));
vi.mock("./lib/settings", () => ({
  pushProactiveConfig: effects.pushProactiveConfig,
  useSettingsStore: { getState: () => ({ shortcuts: {} }) },
}));
vi.mock("./projections/desktop/BrowserLiveDimensionApp", () => ({
  BrowserLiveDimensionApp: () => <main>浏览器本地闭环</main>,
}));

import BrowserApp from "./BrowserApp";

describe("App browser runtime isolation", () => {
  it("在应用根部进入 Browser P0，不挂载任何旧 Tauri/飞书/秘书副作用", async () => {
    render(<BrowserApp />);

    expect(await screen.findByText("浏览器本地闭环")).toBeInTheDocument();
    expect(effects.windowRole).not.toHaveBeenCalled();
    expect(effects.bridgeDataChangedToSync).not.toHaveBeenCalled();
    expect(effects.setupOnlineReplay).not.toHaveBeenCalled();
    expect(effects.startSecretaryScheduler).not.toHaveBeenCalled();
    expect(effects.runStartupBackfill).not.toHaveBeenCalled();
    expect(effects.setupFeishuChatBridge).not.toHaveBeenCalled();
    expect(effects.pushProactiveConfig).not.toHaveBeenCalled();
  });
});
