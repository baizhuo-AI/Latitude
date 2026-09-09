import { useEffect, useRef, useState } from "react";
import type { PetExpression } from "./PetArtwork";
import type { PetState } from "./types";

/** Short gesture feedback; reminder expressions have their own user settings. */
export function usePetPose(state: PetState): PetExpression | undefined {
  const previous = useRef(state);
  const [pose, setPose] = useState<PetExpression>();
  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    if (state.dragging) { setPose(undefined); return; }
    const next = before.dragging && state.mode === "floating" ? "landing"
      : before.mode === "floating" && state.mode === "docked" ? "returning" : undefined;
    if (!next) { setPose(undefined); return; }
    setPose(next);
    const timer = window.setTimeout(() => setPose(undefined), 1200);
    return () => window.clearTimeout(timer);
  }, [state.mode, state.dragging]);
  return state.dragging ? "lifted" : pose;
}
