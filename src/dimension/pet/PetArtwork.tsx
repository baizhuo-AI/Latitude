import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import type { Secretary, SecretaryGesture, SecretaryState } from "../types";
import { DEFAULT_NOTICE_PREFERENCES, type NoticePreferences, type PetNotice } from "../pet-notices";
import { usePetActivity } from "./usePetActivity";
import type { DailyArt, PetActivityId } from "./petActivities";
import { PetActionAnimation } from "./PetActionAnimation";
import { actionForArtwork, PET_ACTION_CLIPS } from "./petActionClips";
import readyPortrait from "../../assets/secretary/portrait/window-v1/idle_breathe.png";
import thinkingPortrait from "../../assets/secretary/portrait/window-v1/thinking.png";
import presentingPortrait from "../../assets/secretary/portrait/window-v1/offering.png";
import wavingPortrait from "../../assets/secretary/portrait/window-v1/wave_small.png";

export const PET_ASSET_EXPRESSIONS = [
  "idle_breathe", "idle_blink", "idle_look_left", "idle_look_right", "idle_stretch", "idle_hair_fix",
  "walk_left", "walk_right", "lifted", "landing", "returning", "sleepy_nod",
  "listening", "speaking_soft", "speaking_happy", "thinking", "idea", "writing", "typing", "reading",
  "searching", "offering", "task_done", "confused",
  "wave_small", "celebrate", "proud", "surprised", "worried", "apologetic", "encourage",
  "urgent_notice", "gentle_notice", "waiting_patient", "pout", "relieved",
] as const;

export const PET_EXPRESSIONS = ["ready", "wave", "waiting", "sleepy", ...PET_ASSET_EXPRESSIONS] as const;

export type PetExpression = typeof PET_EXPRESSIONS[number];

const artwork = import.meta.glob<string>("../../assets/secretary/pet/*.png", { eager: true, query: "?url", import: "default" });
const dailyArtwork = import.meta.glob<string>("../../assets/secretary/pet/daily/*.png", { eager: true, query: "?url", import: "default" });
const DAILY_ARTWORK: Record<DailyArt, string> = {
  notes_sort: dailyArtwork["../../assets/secretary/pet/daily/notes_sort.png"],
  sitting_write: dailyArtwork["../../assets/secretary/pet/daily/sitting_write.png"],
  read_book: artwork["../../assets/secretary/pet/reading.png"],
  tea: dailyArtwork["../../assets/secretary/pet/daily/tea.png"],
  tidy: dailyArtwork["../../assets/secretary/pet/daily/tidy.png"],
  doze: artwork["../../assets/secretary/pet/sleepy_nod.png"],
  // The caring response keeps the same seated character and notebook.
  peek: dailyArtwork["../../assets/secretary/pet/daily/sitting_write.png"],
};
const PORTRAIT_ARTWORK: Record<SecretaryState, string> = {
  ready: readyPortrait,
  thinking: thinkingPortrait,
  presenting: presentingPortrait,
};

const ASSET_ALIASES: Partial<Record<PetExpression, PetExpression>> = {
  ready: "idle_breathe",
  wave: "wave_small",
  waiting: "waiting_patient",
  sleepy: "sleepy_nod",
  idle_look_left: "idle_breathe",
  idle_look_right: "idle_breathe",
};

const DEFAULT_EXPRESSION: Record<SecretaryState, PetExpression> = {
  ready: "idle_breathe",
  thinking: "thinking",
  presenting: "offering",
};

const GESTURE_EXPRESSION: Record<SecretaryState, Partial<Record<SecretaryGesture, PetExpression>>> = {
  ready: { idle: "idle_breathe", listening: "listening", organizing: "reading" },
  thinking: { pondering: "thinking", writing: "writing", comparing: "searching" },
  presenting: { offering: "offering", reminding: "gentle_notice", acknowledging: "speaking_soft" },
};

const RESTING_SEQUENCE: ReadonlyArray<{ expression?: PetExpression; duration: number }> = [
  // Start with the actual work/result pose, then rest while waiting for the user.
  { duration: 6_000 },
  { expression: "idle_breathe", duration: 3_000 },
  { expression: "idle_blink", duration: 180 },
  { expression: "idle_breathe", duration: 5_000 },
  { expression: "idle_breathe", duration: 2_400 },
  { expression: "idle_breathe", duration: 6_500 },
  { expression: "idle_breathe", duration: 2_400 },
  { expression: "idle_breathe", duration: 3_000 },
  { expression: "idle_blink", duration: 180 },
  { expression: "idle_breathe", duration: 2_800 },
  { expression: "idle_breathe", duration: 7_000 },
  { expression: "idle_breathe", duration: 3_000 },
];

export function expressionForSecretary(secretary: Secretary): PetExpression {
  if (!secretary.gesture) return DEFAULT_EXPRESSION[secretary.state];
  return GESTURE_EXPRESSION[secretary.state][secretary.gesture] ?? DEFAULT_EXPRESSION[secretary.state];
}

export function expressionForNotice(_notice: PetNotice): PetExpression {
  // The bubble explains the event; the character asks for attention by waving.
  return "wave_small";
}

function useRestingExpression(enabled: boolean, base: PetExpression, paused: boolean) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setIndex(0);
      return;
    }
    if (paused) return;
    const timer = window.setTimeout(() => setIndex((current) => (current + 1) % RESTING_SEQUENCE.length), RESTING_SEQUENCE[index].duration);
    return () => window.clearTimeout(timer);
  }, [enabled, index, paused]);
  return enabled ? RESTING_SEQUENCE[index].expression ?? base : base;
}

function useNoticeExpression(notice: PetNotice | null | undefined, preferences: NoticePreferences) {
  const [finishedId, setFinishedId] = useState<string>();
  const noticeId = notice?.id;
  useEffect(() => {
    if (!noticeId || preferences.animation === "loop") return;
    const timer = window.setTimeout(() => setFinishedId(noticeId), preferences.expressionSeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [noticeId, preferences.animation, preferences.expressionSeconds]);
  return notice && (preferences.animation === "loop" || finishedId !== noticeId) ? notice : null;
}

export function PetArtwork({ secretary, expression, notice, preferences = DEFAULT_NOTICE_PREFERENCES, onLoad, variant = "pet", activity, interactive = true }: {
  secretary: Secretary; expression?: PetExpression; notice?: PetNotice | null; preferences?: NoticePreferences;
  onLoad?: React.ReactEventHandler<HTMLImageElement>;
  variant?: "portrait" | "pet";
  /** Explicit playback for the motion preview; production uses the idle clock. */
  activity?: PetActivityId;
  /** A motion preview should keep playing while the user inspects it. */
  interactive?: boolean;
}) {
  const element = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    // Preload each scene so a state change never flashes an empty portrait frame.
    const sources = variant === "portrait"
      ? [...Object.values(PORTRAIT_ARTWORK), wavingPortrait]
      : Object.values(DAILY_ARTWORK);
    for (const source of new Set(sources)) {
      const image = new Image();
      image.src = source;
    }
  }, [variant]);
  const secretaryAction = expressionForSecretary(secretary);
  const reducedMotion = useReducedMotion();
  const activeNotice = useNoticeExpression(notice, preferences);
  const resting = variant === "pet" && !expression && !activeNotice && !reducedMotion &&
    secretary.state !== "thinking" && secretary.gesture !== "listening";
  const daily = usePetActivity(resting, element, activity, interactive);
  let action = useRestingExpression(resting && !daily.id, secretaryAction, daily.attending);
  if (variant === "portrait") action = activeNotice && !expression ? "wave_small" : DEFAULT_EXPRESSION[secretary.state];
  else if (expression) action = expression;
  else if (activeNotice) action = expressionForNotice(activeNotice);
  const playingNotice = activeNotice && !expression;
  const moving = action === "lifted" || action === "landing" || action === "returning";
  const asset = ASSET_ALIASES[action] ?? action;
  const clipId = variant === "pet" ? actionForArtwork(asset, daily.id) : undefined;
  const clip = clipId ? PET_ACTION_CLIPS[clipId] : undefined;
  const motion = !clip && !playingNotice && !moving && !daily.id && !daily.attending ? (secretary.state === "thinking" ? "thinking" : "breathe") : undefined;
  const waving = asset === "wave_small";
  const source = variant === "portrait" ? (waving ? wavingPortrait : PORTRAIT_ARTWORK[secretary.state])
    : clip ? clip.frames[0]
    : daily.beat ? DAILY_ARTWORK[daily.beat.art]
    : artwork[`../../assets/secretary/pet/${asset}.png`];
  return <span ref={element} className={`latitude-pet-art${playingNotice ? " pet-notice-expression" : ""}`}
    data-expression={action} data-art-variant={variant} data-motion={motion} data-animation={preferences.animation}
    data-action-clip={clipId}
    data-activity={daily.id} data-beat={daily.beat?.label} data-attending={daily.attending}
    data-source={source} role="img" aria-label={`秘书状态：${secretary.stateCn}`}
    style={{ "--pet-expression-duration": `${preferences.expressionSeconds}s` } as React.CSSProperties}
    >
    {clip ? <PetActionAnimation key={`${clip.id}-${playingNotice ? activeNotice.id : "activity"}`} clip={clip}
      paused={Boolean(reducedMotion) || daily.attending} loop={!playingNotice || preferences.animation === "loop"} onLoad={onLoad} />
      : <img key={`image-${source}`} className="latitude-pet-source" src={source} alt="" aria-hidden="true" draggable={false} onLoad={onLoad} />}
  </span>;
}
