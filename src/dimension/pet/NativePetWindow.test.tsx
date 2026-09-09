import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativePetWindow } from "./PetWindows";
import { subscribePetSnapshot, subscribePetState } from "./nativePet";
import { INITIAL_PET_STATE, type PetSnapshot } from "./types";
import { DEFAULT_NOTICE_PREFERENCES } from "../pet-notices";

vi.mock("./nativePet", () => ({
  petCommand: vi.fn(async () => undefined),
  sendPetAction: vi.fn(),
  subscribePetSnapshot: vi.fn(),
  subscribePetState: vi.fn(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }),
}));
vi.mock("../DeskThread", () => ({ DeskThread: () => null }));
vi.mock("motion/react", () => ({ useReducedMotion: () => false }));

const offlineSnapshot: PetSnapshot = {
  secretary: {
    state: "ready", connectionState: "unavailable", stateCn: "未连接", eyebrow: "秘书",
    headline: "", note: "", stageLabel: "", stageProgress: 0, stageNote: "", metrics: [],
  },
  sessionId: "pet-test", messages: [],
  conversation: { id: "pet-test", title: "对话", createdAt: "", updatedAt: "" },
  loading: false, progress: [], status: null, error: "模型尚未配置", sendEnabled: false,
  notice: null, proactivePrompt: null, proactiveActionEnabled: false,
  noticePreferences: DEFAULT_NOTICE_PREFERENCES,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.mocked(subscribePetSnapshot).mockImplementation(async (update) => {
    update(offlineSnapshot);
    return () => undefined;
  });
  vi.mocked(subscribePetState).mockImplementation(async (update) => {
    update({ ...INITIAL_PET_STATE, mode: "floating" });
    return () => undefined;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("native desktop pet while the model is offline", () => {
  it("keeps its idle animation and starts a local routine after two minutes", async () => {
    await act(async () => { render(<NativePetWindow />); });
    expect(screen.getByRole("img")).toHaveAttribute("data-action-clip", "idle");
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByRole("img")).toHaveAttribute("data-action-clip", "notes");
  });

  it("still waves for a reminder instead of being pinned to an error portrait", async () => {
    vi.mocked(subscribePetSnapshot).mockImplementation(async (update) => {
      update({ ...offlineSnapshot, notice: { id: "reminder", kind: "reminder", text: "该休息一下了", createdAt: 1 } });
      return () => undefined;
    });
    await act(async () => { render(<NativePetWindow />); });
    expect(screen.getByRole("img")).toHaveAttribute("data-action-clip", "wave");
  });
});
