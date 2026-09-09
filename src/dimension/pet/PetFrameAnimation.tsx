import { useEffect, useRef } from "react";

export interface PetFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  anchorX: number;
}

export interface PetFrameSheet {
  source: string;
  frames: readonly PetFrame[];
  referenceHeight: number;
}

export type PetFrameMotion = "write" | "care" | "rest";
export interface PetFrameClip {
  sheet: PetFrameSheet;
  beats: readonly { frame: number; ms: number }[];
}
export type PetFrameClips = Record<PetFrameMotion, PetFrameClip>;

/** Play complete drawn cels. Pose changes come from the artwork, without fading or rotating body parts. */
export function PetFrameAnimation({ clips, motion, paused = false, playbackRate = 1, onReady }: {
  clips: PetFrameClips;
  motion: PetFrameMotion;
  paused?: boolean;
  playbackRate?: number;
  onReady?: (canvas: HTMLCanvasElement) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controls = useRef({ motion, paused, playbackRate });
  controls.current = { motion, paused, playbackRate };
  const ready = useRef(onReady);
  ready.current = onReady;

  useEffect(() => {
    const element = canvas.current!;
    const context = element.getContext("2d")!;
    const artwork = new Map<string, HTMLImageElement>();
    const timelines = Object.fromEntries(Object.entries(clips).map(([name, clip]) => [name, {
      ...clip, duration: clip.beats.reduce((sum, beat) => sum + beat.ms, 0),
    }])) as Record<PetFrameMotion, PetFrameClip & { duration: number }>;
    let request = 0;
    let last = 0;
    let elapsed = 0;
    let current = controls.current.motion;
    let painted = "";
    let disposed = false;

    const draw = (now: number) => {
      const delta = last ? now - last : 0;
      last = now;
      if (current !== controls.current.motion) {
        current = controls.current.motion;
        elapsed = 0;
      } else if (!document.hidden && !controls.current.paused) {
        elapsed += delta * controls.current.playbackRate;
      }
      const clip = timelines[current];
      let position = elapsed % clip.duration;
      let index = 0;
      while (position >= clip.beats[index].ms) { position -= clip.beats[index].ms; index++; }
      const frameNumber = clip.beats[index].frame;
      const key = `${current}:${frameNumber}`;
      if (key !== painted) {
        const frame = clip.sheet.frames[frameNumber];
        const scale = 728 / clip.sheet.referenceHeight;
        context.clearRect(0, 0, element.width, element.height);
        // Register whole frames at the feet; retain the small, intentional movement of the head.
        context.drawImage(artwork.get(clip.sheet.source)!, frame.x, frame.y, frame.width, frame.height,
          226 - (frame.anchorX - frame.x) * scale, 752 - frame.height * scale, frame.width * scale, frame.height * scale);
        element.dataset.frame = String(frameNumber);
        painted = key;
      }
      request = requestAnimationFrame(draw);
    };

    // Resuming a background tab continues the gesture from where it stopped.
    const resetClock = () => { last = performance.now(); };
    document.addEventListener("visibilitychange", resetClock);
    const sources = [...new Set(Object.values(clips).map((clip) => clip.sheet.source))];
    const loaded = sources.map((source) => {
      const image = new Image();
      artwork.set(source, image);
      image.src = source;
      return image.decode();
    });
    Promise.all(loaded).then(() => {
      if (disposed) return;
      draw(performance.now());
      ready.current?.(element);
    }).catch((error: unknown) => console.error("Pet animation artwork could not load", error));

    return () => {
      disposed = true;
      cancelAnimationFrame(request);
      document.removeEventListener("visibilitychange", resetClock);
    };
  }, [clips]);

  return <canvas ref={canvas} className="latitude-pet-frames" width="512" height="768" aria-hidden="true" data-frame-motion={motion} />;
}
