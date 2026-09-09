import { useEffect, useRef, useState, type RefObject } from "react";
import { activityBeat, advanceActivityClock, createActivityClock, type PetActivityId } from "./petActivities";

/** The idle clock measures time since interacting with her, not OS inactivity. */
export function usePetActivity(enabled: boolean, artwork: RefObject<HTMLElement>, preview?: PetActivityId, interactive = true) {
  const [clock, setClock] = useState(() => createActivityClock(enabled ? preview : undefined));
  const [attending, setAttending] = useState(false);
  const paused = useRef(false);

  useEffect(() => {
    setClock(createActivityClock(enabled ? preview : undefined));
    if (!enabled) { setAttending(false); return; }
    let last = Date.now();
    const tick = window.setInterval(() => {
      const now = Date.now(), delta = now - last;
      last = now;
      if (document.hidden || paused.current) return;
      const rolls: [number, number] = [Math.random(), Math.random()];
      setClock((current) => advanceActivityClock(current, delta, rolls, preview));
    }, 500);
    return () => window.clearInterval(tick);
  }, [enabled, preview]);

  useEffect(() => {
    const element = artwork.current;
    const target = element?.closest("button") ?? element?.parentElement;
    if (!target || !enabled || !interactive) return;
    let hoverTimer: number | undefined;
    const enter = () => {
      window.clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(() => { paused.current = true; setAttending(true); }, 650);
    };
    const leave = () => { window.clearTimeout(hoverTimer); paused.current = false; setAttending(false); };
    const interact = () => {
      setClock((current) => ({ ...createActivityClock(), sincePeek: current.sincePeek }));
      leave();
    };
    target.addEventListener("pointerenter", enter);
    target.addEventListener("pointerleave", leave);
    target.addEventListener("pointerdown", interact);
    target.addEventListener("keydown", interact);
    target.addEventListener("focus", enter);
    target.addEventListener("blur", leave);
    return () => {
      leave();
      target.removeEventListener("pointerenter", enter);
      target.removeEventListener("pointerleave", leave);
      target.removeEventListener("pointerdown", interact);
      target.removeEventListener("keydown", interact);
      target.removeEventListener("focus", enter);
      target.removeEventListener("blur", leave);
    };
  }, [enabled, artwork, interactive]);

  return {
    id: enabled ? clock.playing?.id : undefined,
    beat: enabled && clock.playing ? activityBeat(clock.playing.id, clock.playing.elapsed) : undefined,
    attending: enabled && attending,
  };
}
