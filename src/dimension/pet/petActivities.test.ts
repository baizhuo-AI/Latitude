import { describe, expect, it } from "vitest";
import { activityBeat, activityDuration, advanceActivityClock, chooseActivity, createActivityClock, PET_ACTIVITIES, type PetActivityId } from "./petActivities";

describe("pet's quiet daily routines", () => {
  it("waits two minutes, adds longer work after five, and saves naps for long absences", () => {
    expect(chooseActivity(119_999, 0)).toBeNull();
    expect(chooseActivity(120_000, 0, undefined, () => 0)).toBe("notes");
    const available = (idle: number) => new Set(Array.from({ length: 100 }, (_, index) =>
      chooseActivity(idle, 0, undefined, () => index / 100)));
    expect(available(120_000)).toEqual(new Set(["notes", "read", "tidy"]));
    expect(available(300_000)).toContain("plan");
    expect(available(719_999)).not.toContain("tea");
    expect(available(720_000)).toContain("tea");
    expect(available(1_799_999)).not.toContain("doze");
    expect(available(1_800_000)).toContain("doze");
  });

  it("limits spontaneous peeks and does not repeat the last routine", () => {
    expect(chooseActivity(900_000, 239_999, undefined, () => 0)).not.toBe("peek");
    expect(chooseActivity(900_000, 240_000, undefined, () => 0)).toBe("peek");
    expect(chooseActivity(900_000, 240_000, "peek", () => 0)).not.toBe("peek");
    for (const previous of Object.keys(PET_ACTIVITIES) as PetActivityId[]) {
      for (let roll = 0; roll < 1; roll += 0.02) {
        expect(chooseActivity(3_600_000, 500_000, previous, () => roll)).not.toBe(previous);
      }
    }
  });

  it("writes, pauses to think, and returns to writing before putting the book away", () => {
    expect(activityBeat("plan", 5_000).motion).toBe("write");
    expect(activityBeat("plan", 27_000).motion).toBe("hold");
    expect(activityBeat("plan", 33_000).motion).toBe("write");
    expect(activityBeat("plan", 54_000).art).toBe("tidy");
    expect(activityDuration("plan")).toBe(57_000);
    expect(activityBeat("peek", 5_000).art).toBe("peek");
    expect(activityBeat("peek", 9_000).motion).toBe("write");
  });

  it("leaves a quiet interval between routines and preserves the peek cooldown", () => {
    let state = createActivityClock();
    state = advanceActivityClock(state, 120_000, [0.5, 0.5]);
    const id = state.playing!.id;
    state = advanceActivityClock(state, activityDuration(id), [0.5, 0.5]);
    expect(state.playing).toBeNull();
    expect(state.rest).toBe(15_000);
    state = advanceActivityClock(state, 14_000, [0.5, 0.5]);
    expect(state.playing).toBeNull();
    state = advanceActivityClock(state, 1_000, [0.5, 0.5]);
    expect(state.playing?.id).not.toBe(id);
  });

  it("advances immutably so React StrictMode cannot double-charge the idle clock", () => {
    const before = createActivityClock("plan");
    const a = advanceActivityClock(before, 500, [0.4, 0.6]);
    const b = advanceActivityClock(before, 500, [0.4, 0.6]);
    expect(a).toEqual(b);
    expect(before.idle).toBe(0);
    expect(before.playing?.elapsed).toBe(4_000);
  });

  it("starts direct previews on movement while automatic routines retain their lead-in", () => {
    for (const id of Object.keys(PET_ACTIVITIES) as PetActivityId[]) {
      const preview = createActivityClock(id);
      expect(activityBeat(id, preview.playing!.elapsed).motion).not.toBe("hold");
    }
    const automatic = advanceActivityClock(createActivityClock(), 120_000, [0.5, 0]);
    expect(automatic.playing?.elapsed).toBe(0);
  });
});
