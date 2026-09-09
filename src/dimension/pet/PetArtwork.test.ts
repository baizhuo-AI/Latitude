import { createElement } from "react";
import { useReducedMotion } from "motion/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Secretary } from "../types";
import { PET_ASSET_EXPRESSIONS, PetArtwork, expressionForNotice, expressionForSecretary } from "./PetArtwork";

const petAssets = import.meta.glob("../../assets/secretary/pet/*.png", { eager: true, query: "?url", import: "default" });

vi.mock("motion/react", () => ({ useReducedMotion: vi.fn(() => false) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(useReducedMotion).mockReturnValue(false);
});

const secretary = (state: Secretary["state"], gesture?: Secretary["gesture"]): Secretary => ({
  eyebrow: "YOUR SECRETARY",
  state,
  gesture,
  stateCn: "在岗",
  headline: "",
  note: "",
  stageLabel: "",
  stageProgress: 0,
  stageNote: "",
  metrics: [],
});

describe("desktop-pet expression selection", () => {
  it("maps the secretary's semantic gesture to the matching artwork", () => {
    expect(expressionForSecretary(secretary("ready", "listening"))).toBe("listening");
    expect(expressionForSecretary(secretary("thinking", "comparing"))).toBe("searching");
    expect(expressionForSecretary(secretary("presenting", "reminding"))).toBe("gentle_notice");
  });

  it("falls back to the current state's default when a gesture belongs to another state", () => {
    expect(expressionForSecretary(secretary("ready", "writing"))).toBe("idle_breathe");
    expect(expressionForSecretary(secretary("thinking", "offering"))).toBe("thinking");
  });

  it("uses a wave for attention, with the event described by its bubble", () => {
    const notice = { id: "notice-42", text: "完成", kind: "completed" as const, createdAt: 1 };
    const first = expressionForNotice(notice);
    expect(expressionForNotice(notice)).toBe(first);
    expect(first).toBe("wave_small");
  });

  it.each([
    ["ready", "idle_breathe", "idle"],
    ["thinking", "thinking", "thinking"],
    ["presenting", "offering", undefined],
  ] as const)("uses a dedicated %s portrait and the matching desktop artwork", (state, asset, clip) => {
    const current = secretary(state);
    const { rerender } = render(createElement(PetArtwork, { secretary: current, variant: "portrait" }));
    const portrait = screen.getByRole("img");
    const portraitSource = portrait.getAttribute("data-source");
    expect(portrait).toHaveAttribute("data-art-variant", "portrait");
    expect(portraitSource).toContain(`/secretary/portrait/window-v1/${asset}.png`);
    rerender(createElement(PetArtwork, { secretary: current, variant: "pet" }));
    const pet = screen.getByRole("img");
    expect(pet).toHaveAttribute("data-art-variant", "pet");
    expect(pet.getAttribute("data-source")).toContain(clip ? `/secretary/pet/animations/${clip}/00.png` : `/secretary/pet/${asset}.png`);
    expect(pet.getAttribute("data-source")).not.toBe(portraitSource);
    rerender(createElement(PetArtwork, { secretary: current, variant: "portrait", expression: "returning" }));
    expect(screen.getByRole("img").getAttribute("data-source")).toBe(portraitSource);
  });

  it("has a production cutout for every listed pet expression", () => {
    const available = new Set(Object.keys(petAssets).map((path) => path.split("/").pop()?.replace(/\.png$/, "")));
    expect(PET_ASSET_EXPRESSIONS.filter((expression) => !available.has(expression))).toEqual([]);
  });

  it.each([
    ["ready", "organizing", "reading"],
    ["presenting", "reminding", "gentle_notice"],
  ] as const)("keeps resting motions available during %s instead of freezing on the semantic gesture", (state, gesture, initial) => {
    vi.useFakeTimers();
    render(createElement(PetArtwork, { secretary: secretary(state, gesture) }));
    expect(screen.getByRole("img")).toHaveAttribute("data-expression", initial);
    expect(screen.getByRole("img")).not.toHaveAttribute("data-motion");
    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.getByRole("img")).toHaveAttribute("data-expression", "idle_breathe");
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByRole("img")).toHaveAttribute("data-expression", "idle_blink");
    act(() => vi.advanceTimersByTime(180));
    expect(screen.getByRole("img")).toHaveAttribute("data-expression", "idle_breathe");
  });

  it("interrupts resting poses for real work and dragging, then resumes after release", () => {
    vi.useFakeTimers();
    const current = secretary("ready");
    const { rerender } = render(createElement(PetArtwork, { secretary: current }));
    act(() => vi.advanceTimersByTime(6_000));
    rerender(createElement(PetArtwork, { secretary: secretary("thinking", "writing") }));
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByRole("img")).toHaveAttribute("data-expression", "writing");
    expect(screen.getByRole("img")).toHaveAttribute("data-action-clip", "plan");
    expect(screen.getByRole("img")).not.toHaveAttribute("data-motion");
    rerender(createElement(PetArtwork, { secretary: current, expression: "lifted" }));
    expect(screen.getByRole("img")).toHaveAttribute("data-expression", "lifted");
    expect(screen.getByRole("img")).not.toHaveAttribute("data-motion");
    rerender(createElement(PetArtwork, { secretary: current }));
    expect(screen.getByRole("img")).toHaveAttribute("data-action-clip", "idle");
  });

  it("returns to normal motions after a one-shot expression even while its bubble stays open", () => {
    vi.useFakeTimers();
    const notice = { id: "long-lived", kind: "completed" as const, text: "已完成", createdAt: 1 };
    const props = { secretary: secretary("ready"), notice,
      preferences: { animation: "once" as const, expressionSeconds: 4, dismissAfterSeconds: null } };
    const { rerender } = render(createElement(PetArtwork, props));
    expect(screen.getByRole("img")).toHaveClass("pet-notice-expression");
    act(() => vi.advanceTimersByTime(4_000));
    expect(screen.getByRole("img")).not.toHaveClass("pet-notice-expression");
    expect(screen.getByRole("img")).toHaveAttribute("data-action-clip", "idle");
    rerender(createElement(PetArtwork, { ...props, notice: { ...notice, id: "next-notice" } }));
    expect(screen.getByRole("img")).toHaveClass("pet-notice-expression");
  });

  it("keeps a looping notice active until the notice is removed", () => {
    vi.useFakeTimers();
    const props = { secretary: secretary("ready"),
      preferences: { animation: "loop" as const, expressionSeconds: 4, dismissAfterSeconds: null } };
    const { rerender } = render(createElement(PetArtwork, { ...props,
      notice: { id: "loop", kind: "reminder", text: "提醒", createdAt: 1 } }));
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole("img")).toHaveClass("pet-notice-expression");
    expect(screen.getByRole("img")).not.toHaveAttribute("data-motion");
    expect(screen.getByRole("img")).toHaveAttribute("data-expression", "wave_small");
    expect(screen.getByRole("img").querySelector('[data-pet-joint]')).toBeNull();
    rerender(createElement(PetArtwork, props));
    expect(screen.getByRole("img")).toHaveAttribute("data-action-clip", "idle");
  });

  it("uses the matte waving portrait for frame reminders and restores the normal portrait on dismissal", () => {
    const props = { secretary: secretary("ready"), variant: "portrait" as const };
    const { rerender } = render(createElement(PetArtwork, { ...props,
      notice: { id: "wave-in-frame", kind: "reminder", text: "提醒", createdAt: 1 } }));
    expect(screen.getByRole("img").getAttribute("data-source")).toContain("/portrait/window-v1/wave_small.png");
    expect(screen.getByRole("img").querySelector('[data-pet-joint]')).toBeNull();
    rerender(createElement(PetArtwork, props));
    expect(screen.getByRole("img").getAttribute("data-source")).toContain("/portrait/window-v1/idle_breathe.png");
  });

  it("pauses the current activity on a lingering hover, resumes on leave, and stops immediately for a click", () => {
    vi.useFakeTimers();
    render(createElement("button", { type: "button" }, createElement(PetArtwork,
      { secretary: secretary("ready"), activity: "plan" })));
    const art = screen.getByRole("img");
    expect(art).toHaveAttribute("data-activity", "plan");
    const originalSource = art.getAttribute("data-source");
    fireEvent.pointerEnter(screen.getByRole("button"));
    act(() => vi.advanceTimersByTime(650));
    expect(art).toHaveAttribute("data-attending", "true");
    expect(art.getAttribute("data-source")).toBe(originalSource);
    expect(art.querySelector('[data-pet-joint]')).toBeNull();
    act(() => vi.advanceTimersByTime(20_000));
    expect(art).toHaveAttribute("data-beat", "低头写一会儿");
    fireEvent.pointerLeave(screen.getByRole("button"));
    act(() => vi.advanceTimersByTime(22_000));
    expect(art).toHaveAttribute("data-beat", "停笔想一想");
    fireEvent.pointerDown(screen.getByRole("button"));
    expect(art).not.toHaveAttribute("data-activity");
  });

  it("keeps an inspection preview moving when the pointer or keyboard touches it", () => {
    vi.useFakeTimers();
    render(createElement("button", { type: "button" }, createElement(PetArtwork,
      { secretary: secretary("ready"), activity: "plan", interactive: false })));
    const button = screen.getByRole("button");
    const art = screen.getByRole("img");
    const originalSource = art.getAttribute("data-source");
    fireEvent.pointerEnter(button);
    fireEvent.focus(button);
    act(() => vi.advanceTimersByTime(1_000));
    fireEvent.pointerDown(button);
    fireEvent.keyDown(button, { key: "Enter" });
    expect(art).toHaveAttribute("data-attending", "false");
    expect(art).toHaveAttribute("data-activity", "plan");
    expect(art.getAttribute("data-source")).toBe(originalSource);
    act(() => vi.advanceTimersByTime(22_000));
    expect(art).toHaveAttribute("data-beat", "停笔想一想");
  });

  it("interrupts a long routine for a real task, a notice, dragging, or reduced motion", () => {
    vi.useFakeTimers();
    const props = { secretary: secretary("ready"), activity: "plan" as const };
    const { rerender } = render(createElement(PetArtwork, props));
    expect(screen.getByRole("img")).toHaveAttribute("data-activity", "plan");
    rerender(createElement(PetArtwork, { ...props, secretary: secretary("thinking", "writing") }));
    expect(screen.getByRole("img")).not.toHaveAttribute("data-activity");
    rerender(createElement(PetArtwork, { ...props, notice: { id: "urgent", kind: "reminder", text: "提醒", createdAt: 1 } }));
    expect(screen.getByRole("img")).toHaveAttribute("data-expression", "wave_small");
    expect(screen.getByRole("img")).not.toHaveAttribute("data-activity");
    rerender(createElement(PetArtwork, { ...props, expression: "lifted" }));
    expect(screen.getByRole("img")).toHaveAttribute("data-expression", "lifted");
    expect(screen.getByRole("img")).not.toHaveAttribute("data-activity");
    vi.mocked(useReducedMotion).mockReturnValue(true);
    rerender(createElement(PetArtwork, props));
    expect(screen.getByRole("img")).not.toHaveAttribute("data-activity");
  });

  it("cancels pending attention when pointer and keyboard focus overlap then leave", () => {
    vi.useFakeTimers();
    render(createElement("button", { type: "button" }, createElement(PetArtwork,
      { secretary: secretary("ready"), activity: "plan" })));
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.focus(button);
    fireEvent.pointerLeave(button);
    fireEvent.blur(button);
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("img")).toHaveAttribute("data-attending", "false");
  });

  it("keeps the framed artwork while giving it ambient motion", () => {
    vi.useFakeTimers();
    render(createElement(PetArtwork, { secretary: secretary("presenting", "reminding"), variant: "portrait" }));
    const source = screen.getByRole("img").getAttribute("data-source");
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("img")).toHaveAttribute("data-motion", "breathe");
    expect(screen.getByRole("img").getAttribute("data-source")).toBe(source);
  });

  it("keeps the current pose when reduced motion is enabled", () => {
    vi.useFakeTimers();
    vi.mocked(useReducedMotion).mockReturnValue(true);
    render(createElement(PetArtwork, { secretary: secretary("presenting", "reminding") }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("img")).toHaveAttribute("data-expression", "gentle_notice");
  });
});
