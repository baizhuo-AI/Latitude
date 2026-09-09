import { describe, expect, it } from "vitest";
import { actionForArtwork, frameAtTime, PET_ACTION_CLIPS } from "./petActionClips";

describe("drawn desktop-pet actions", () => {
  it("ships complete HD animation sequences for all current activities", () => {
    expect(Object.keys(PET_ACTION_CLIPS)).toHaveLength(13);
    for (const clip of Object.values(PET_ACTION_CLIPS)) {
      expect(clip.frames).toHaveLength(8);
      expect(clip.frames.every(source => typeof source === "string" && source.endsWith(".png"))).toBe(true);
      expect(clip.beats.reduce((total, beat) => total + beat.ms, 0)).toBe(clip.duration);
    }
    expect(actionForArtwork("ready", "peek")).toBe("care");
    expect(actionForArtwork("lifted")).toBeUndefined();
  });

  it("holds the approved caring look and closes its loop at the original frame", () => {
    const clip = PET_ACTION_CLIPS.care;
    expect(frameAtTime(clip, 2400)).toBe(4);
    expect(frameAtTime(clip, 4599)).toBe(4);
    expect(frameAtTime(clip, 4600)).toBe(5);
    expect(frameAtTime(clip, 8000)).toBe(0);
    expect(frameAtTime(clip, 8000 + 2400)).toBe(4);
  });
});
