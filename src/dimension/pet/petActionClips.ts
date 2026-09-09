import type { PetActivityId } from "./petActivities";
import type { PetExpression } from "./PetArtwork";

export type PetActionId = "wave" | "notes" | "plan" | "care" | "read" | "checklist" | "sketch" |
  "tea" | "tidy" | "doze" | "idle" | "listening" | "thinking";

export interface PetActionClip {
  id: PetActionId;
  frames: string[];
  beats: readonly { frame: number; ms: number }[];
  duration: number;
}

interface ActionSequence {
  id: PetActionId;
  frameCount: number;
  beats: PetActionClip["beats"];
  duration: number;
}

const sequences = import.meta.glob<ActionSequence>("../../assets/secretary/pet/animations/*/sequence.json", { eager: true, import: "default" });
const frames = import.meta.glob<string>("../../assets/secretary/pet/animations/*/*.png", { eager: true, query: "?url", import: "default" });

export const PET_ACTION_CLIPS = Object.fromEntries(Object.values(sequences).map(sequence => [sequence.id, {
  id: sequence.id,
  beats: sequence.beats,
  duration: sequence.duration,
  frames: Array.from({ length: sequence.frameCount }, (_, index) =>
    frames[`../../assets/secretary/pet/animations/${sequence.id}/${String(index).padStart(2, "0")}.png`]),
}])) as Record<PetActionId, PetActionClip>;

const EXPRESSION_ACTION: Partial<Record<PetExpression, PetActionId>> = {
  ready: "idle", idle_breathe: "idle", idle_blink: "idle", idle_look_left: "idle", idle_look_right: "idle",
  wave: "wave", wave_small: "wave", gentle_notice: "wave", urgent_notice: "wave",
  listening: "listening", thinking: "thinking", writing: "plan", reading: "read",
  sleepy: "doze", sleepy_nod: "doze",
};

export function actionForArtwork(expression: PetExpression, activity?: PetActivityId): PetActionId | undefined {
  return activity ? (activity === "peek" ? "care" : activity) : EXPRESSION_ACTION[expression];
}

export function frameAtTime(clip: Pick<PetActionClip, "beats" | "duration">, elapsed: number): number {
  let remaining = elapsed % clip.duration;
  for (const beat of clip.beats) {
    if (remaining < beat.ms) return beat.frame;
    remaining -= beat.ms;
  }
  return clip.beats[0].frame;
}
