import { forwardRef } from "react";
import { motion, useIsPresent, useReducedMotion, type HTMLMotionProps } from "motion/react";

/** Short, interruptible surface motion; leaving surfaces stop accepting input immediately. */
export function useSurfaceMotion(lift = true) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  return {
    initial: { opacity: 0, y: lift && !reduced ? 6 : 0 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: lift && !reduced ? 3 : 0, transition: { duration: reduced ? 0 : 0.12 } },
    transition: { duration: reduced ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] as const },
    "aria-hidden": present ? undefined : true,
    "data-surface-present": present ? "true" : "false",
    ...(!present ? { inert: "" } : {}),
  };
}

/** Backdrops only fade so their existing positioning transform stays untouched. */
export const MotionSurface = forwardRef<HTMLDivElement, HTMLMotionProps<"div"> & { lift?: boolean }>(
  function MotionSurface({ lift = false, ...props }, ref) {
    const animation = useSurfaceMotion(lift);
    // A zero y still creates a Motion transform; omit it for centered window shells.
    const { initial, animate, exit, ...state } = animation;
    return <motion.div {...props} {...state} ref={ref}
      initial={lift ? initial : { opacity: initial.opacity }}
      animate={lift ? animate : { opacity: animate.opacity }}
      exit={lift ? exit : { opacity: exit.opacity, transition: exit.transition }}
    />;
  },
);
