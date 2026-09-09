export type PetActivityId = "notes" | "plan" | "read" | "checklist" | "sketch" | "tea" | "tidy" | "doze" | "peek";
export type DailyArt = "notes_sort" | "sitting_write" | "read_book" | "tea" | "tidy" | "doze" | "peek";
export type DailyMotion = "sort" | "write" | "read" | "check" | "sketch" | "sip" | "tidy" | "nod" | "peek" | "hold";

export interface ActivityBeat {
  art: DailyArt;
  motion: DailyMotion;
  seconds: number;
  label: string;
}

export const PET_ACTIVITIES: Record<PetActivityId, { label: string; beats: readonly ActivityBeat[] }> = {
  notes: { label: "整理便笺", beats: [
    { art: "notes_sort", motion: "hold", seconds: 3, label: "拿出便笺" },
    { art: "notes_sort", motion: "sort", seconds: 22, label: "分好便笺，轻轻对齐" },
    { art: "tidy", motion: "tidy", seconds: 6, label: "把便笺夹回本子" },
  ] },
  plan: { label: "坐着写方案", beats: [
    { art: "sitting_write", motion: "hold", seconds: 4, label: "打开本子，想一想" },
    { art: "sitting_write", motion: "write", seconds: 22, label: "低头写一会儿" },
    { art: "sitting_write", motion: "hold", seconds: 6, label: "停笔想一想" },
    { art: "sitting_write", motion: "write", seconds: 20, label: "接着写几行" },
    { art: "tidy", motion: "tidy", seconds: 5, label: "收好本子" },
  ] },
  read: { label: "翻资料", beats: [
    { art: "read_book", motion: "hold", seconds: 4, label: "找到上次读的地方" },
    { art: "read_book", motion: "read", seconds: 24, label: "顺着文字读，轻轻翻页" },
    { art: "notes_sort", motion: "sort", seconds: 6, label: "夹一张书签" },
    { art: "tidy", motion: "hold", seconds: 4, label: "合上本子" },
  ] },
  checklist: { label: "核对清单", beats: [
    { art: "read_book", motion: "read", seconds: 7, label: "看一遍清单" },
    { art: "sitting_write", motion: "check", seconds: 18, label: "逐项打勾" },
    { art: "read_book", motion: "hold", seconds: 5, label: "回头再核对一下" },
    { art: "tidy", motion: "tidy", seconds: 4, label: "收好清单" },
  ] },
  sketch: { label: "画小草图", beats: [
    { art: "sitting_write", motion: "hold", seconds: 3, label: "想好从哪里画" },
    { art: "sitting_write", motion: "sketch", seconds: 20, label: "画几个框，再连起来" },
    { art: "sitting_write", motion: "hold", seconds: 6, label: "停下来看看" },
    { art: "sitting_write", motion: "sketch", seconds: 12, label: "补上最后几笔" },
    { art: "tidy", motion: "tidy", seconds: 5, label: "把草图收起来" },
  ] },
  tea: { label: "喝茶休息", beats: [
    { art: "tea", motion: "hold", seconds: 4, label: "捧起茶杯" },
    { art: "tea", motion: "sip", seconds: 16, label: "慢慢喝一口，歇一会儿" },
    { art: "tea", motion: "hold", seconds: 5, label: "捧着杯子放松一下" },
  ] },
  tidy: { label: "收拾随身物品", beats: [
    { art: "notes_sort", motion: "sort", seconds: 8, label: "把零散的纸收齐" },
    { art: "tidy", motion: "tidy", seconds: 9, label: "整理书签和本子" },
    { art: "tidy", motion: "hold", seconds: 4, label: "收好了" },
  ] },
  doze: { label: "抱本子打盹", beats: [
    { art: "tidy", motion: "hold", seconds: 5, label: "抱着本子歇一会儿" },
    { art: "doze", motion: "nod", seconds: 30, label: "脑袋慢慢垂下来" },
    { art: "tidy", motion: "hold", seconds: 5, label: "醒过来，把本子抱稳" },
  ] },
  peek: { label: "关心地看向你", beats: [
    { art: "sitting_write", motion: "write", seconds: 4, label: "本来正在写东西" },
    { art: "peek", motion: "peek", seconds: 4, label: "停笔，温和地看向你" },
    { art: "sitting_write", motion: "write", seconds: 7, label: "低头继续忙" },
  ] },
};

export const FIRST_ACTIVITY_DELAY = 120_000;
export const PEEK_COOLDOWN = 240_000;

export interface ActivityClock {
  idle: number;
  sincePeek: number;
  rest: number;
  previous?: PetActivityId;
  playing: { id: PetActivityId; elapsed: number } | null;
}

export function createActivityClock(preview?: PetActivityId): ActivityClock {
  // Direct playback starts with the first movement; automatic routines keep their quiet lead-in.
  const first = preview && PET_ACTIVITIES[preview].beats[0];
  const elapsed = first && first.motion === "hold" ? first.seconds * 1000 : 0;
  return { idle: 0, sincePeek: 0, rest: FIRST_ACTIVITY_DELAY, playing: preview ? { id: preview, elapsed } : null };
}

export function advanceActivityClock(state: ActivityClock, delta: number, rolls: [number, number], preview?: PetActivityId): ActivityClock {
  const next = { ...state, idle: state.idle + delta, sincePeek: state.sincePeek + delta };
  if (state.playing) {
    const elapsed = state.playing.elapsed + delta;
    if (elapsed < activityDuration(state.playing.id)) return { ...next, playing: { ...state.playing, elapsed } };
    return { ...next, previous: state.playing.id, rest: 12_000 + rolls[1] * 6000,
      playing: preview ? createActivityClock(preview).playing : null };
  }
  next.rest -= delta;
  if (next.rest > 0) return next;
  let roll = 0;
  const id = chooseActivity(next.idle, next.sincePeek, next.previous, () => rolls[roll++ % 2]);
  return { ...next, sincePeek: id === "peek" ? 0 : next.sincePeek, playing: id ? { id, elapsed: 0 } : null };
}

export function activityDuration(id: PetActivityId) {
  return PET_ACTIVITIES[id].beats.reduce((total, beat) => total + beat.seconds * 1000, 0);
}

export function activityBeat(id: PetActivityId, elapsed: number) {
  let remaining = elapsed;
  const beats = PET_ACTIVITIES[id].beats;
  for (const beat of beats) {
    if (remaining < beat.seconds * 1000) return beat;
    remaining -= beat.seconds * 1000;
  }
  return beats[beats.length - 1];
}

/** Cosmetic idle scenes never invoke the agent, inspect a screen, or create output. */
export function chooseActivity(idleMs: number, sincePeek: number, previous?: PetActivityId, random = Math.random): PetActivityId | null {
  if (idleMs < FIRST_ACTIVITY_DELAY) return null;
  if (sincePeek >= PEEK_COOLDOWN && previous !== "peek" && random() < 0.16) return "peek";
  const choices: PetActivityId[] = ["notes", "read", "tidy"];
  if (idleMs >= 300_000) choices.push("plan", "plan", "checklist", "sketch");
  if (idleMs >= 720_000) choices.push("tea");
  if (idleMs >= 1_800_000) choices.push("doze");
  const next = choices.filter((id) => id !== previous);
  return next[Math.floor(random() * next.length)];
}
