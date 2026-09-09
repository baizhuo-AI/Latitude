import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTICE_PREFERENCES,
  NOTICE_PREFERENCES_STORAGE_KEY,
  NoticeSettings,
  PetNoticeBubble,
  useNoticePreferences,
  useNoticeVisibility,
  type PetNotice,
} from "./index";

const first: PetNotice = { id: "notice-1", text: "方案已经整理好了。", kind: "completed", createdAt: 1000 };

describe("pet notices", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps the bubble for 30 seconds while the expression ends at 8, then stays dismissed on rerender", () => {
    const { result, rerender } = renderHook(
      ({ notice }) => useNoticeVisibility(notice, DEFAULT_NOTICE_PREFERENCES),
      { initialProps: { notice: first } },
    );
    act(() => vi.advanceTimersByTime(8000));
    expect(result.current.expressionActive).toBe(false);
    expect(result.current.visible).toBe(true);
    act(() => vi.advanceTimersByTime(22_000));
    expect(result.current.visible).toBe(false);
    rerender({ notice: { ...first, text: "方案已经整理好，随时可以查看。" } });
    expect(result.current.visible).toBe(false);
    rerender({ notice: { ...first, id: "notice-2" } });
    expect(result.current.visible).toBe(true);
    expect(result.current.expressionActive).toBe(true);
  });

  it("pauses the remaining lifetime for pointer and keyboard focus without changing the full text", () => {
    const onDismiss = vi.fn();
    const onOpen = vi.fn();
    const notice = { ...first, text: "成本估算还差一项。\n".repeat(35) };
    render(<PetNoticeBubble notice={notice} preferences={DEFAULT_NOTICE_PREFERENCES} onOpen={onOpen} onDismiss={onDismiss} />);
    expect(screen.getByRole("status").textContent).toBe(notice.text);
    act(() => vi.advanceTimersByTime(20_000));
    fireEvent.pointerEnter(screen.getByLabelText("秘书提醒"));
    fireEvent.focus(screen.getByRole("button", { name: "看全文" }));
    act(() => vi.advanceTimersByTime(50_000));
    fireEvent.pointerLeave(screen.getByLabelText("秘书提醒"));
    act(() => vi.advanceTimersByTime(50_000));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByRole("button", { name: "看全文" }), { relatedTarget: null });
    act(() => vi.advanceTimersByTime(9999));
    expect(screen.getByLabelText("秘书提醒")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByLabelText("秘书提醒")).not.toBeInTheDocument();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledWith(notice);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("starts a fresh lifetime for a different message without retaining the old timer", () => {
    const { result, rerender } = renderHook(
      ({ notice }) => useNoticeVisibility(notice, DEFAULT_NOTICE_PREFERENCES),
      { initialProps: { notice: first } },
    );
    act(() => vi.advanceTimersByTime(29_000));
    rerender({ notice: { ...first, id: "notice-2" } });
    act(() => vi.advanceTimersByTime(29_000));
    expect(result.current.visible).toBe(true);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.visible).toBe(false);
  });

  it("keeps a persistent bubble and looping expression until the user opens the original content", () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    const preferences = { ...DEFAULT_NOTICE_PREFERENCES, dismissAfterSeconds: null, animation: "loop" as const };
    const { result } = renderHook(() => useNoticeVisibility(first, preferences));
    render(<PetNoticeBubble notice={first} preferences={preferences} visibility={result.current} onOpen={onOpen} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(120_000));
    expect(result.current.visible).toBe(true);
    expect(result.current.expressionActive).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "看全文" }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(first);
    expect(result.current.visible).toBe(false);
  });

  it("notifies dismissal once even if its caller changes callbacks or message object", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<PetNoticeBubble notice={first} preferences={DEFAULT_NOTICE_PREFERENCES} onOpen={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "收起这条提醒" }));
    expect(onDismiss).toHaveBeenCalledOnce();
    const nextOnDismiss = vi.fn();
    rerender(<PetNoticeBubble notice={{ ...first }} preferences={DEFAULT_NOTICE_PREFERENCES} onOpen={vi.fn()} onDismiss={nextOnDismiss} />);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByLabelText("秘书提醒")).not.toBeInTheDocument();
    expect(nextOnDismiss).not.toHaveBeenCalled();
  });

  it("synchronizes preference edits between instances and storage events from another window", () => {
    const { result } = renderHook(() => useNoticePreferences());
    render(<NoticeSettings />);
    expect(result.current.preferences).toEqual(DEFAULT_NOTICE_PREFERENCES);
    fireEvent.change(screen.getByLabelText("气泡保留多久"), { target: { value: "keep" } });
    expect(result.current.preferences.dismissAfterSeconds).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(NOTICE_PREFERENCES_STORAGE_KEY)!)).toEqual(result.current.preferences);

    const fromOtherWindow = { dismissAfterSeconds: 60, animation: "loop", expressionSeconds: 15 };
    act(() => {
      window.localStorage.setItem(NOTICE_PREFERENCES_STORAGE_KEY, JSON.stringify(fromOtherWindow));
      window.dispatchEvent(new StorageEvent("storage", { key: NOTICE_PREFERENCES_STORAGE_KEY }));
    });
    expect(result.current.preferences).toEqual(fromOtherWindow);
    expect(screen.getByLabelText("提醒时的动作")).toHaveValue("loop");
    expect(screen.getByLabelText("每次动作的时长")).toHaveValue("15");
  });

  it("saves a custom dismissal duration without changing the expression timing", () => {
    const { result } = renderHook(useNoticePreferences);
    render(<NoticeSettings />);
    fireEvent.change(screen.getByLabelText("气泡保留多久"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("消退前等待（秒）"), { target: { value: "45" } });
    expect(result.current.preferences.dismissAfterSeconds).toBe(45);
    expect(result.current.preferences.expressionSeconds).toBe(8);
  });
});
