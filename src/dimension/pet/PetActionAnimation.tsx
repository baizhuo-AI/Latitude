import { useEffect, useRef } from "react";
import { frameAtTime, type PetActionClip } from "./petActionClips";

/** Complete HD cels share one registration. No body transforms or interpolation. */
export function PetActionAnimation({ clip, paused, loop = true, onLoad }: {
  clip: PetActionClip;
  paused: boolean;
  loop?: boolean;
  onLoad?: React.ReactEventHandler<HTMLImageElement>;
}) {
  const image = useRef<HTMLImageElement>(null);
  const controls = useRef({ paused, loop });
  controls.current = { paused, loop };

  useEffect(() => {
    let disposed = false;
    let request = 0;
    let last = 0;
    let elapsed = 0;
    let currentFrame = 0;
    const element = image.current!;
    const draw = (now: number) => {
      const delta = last ? now - last : 0;
      last = now;
      if (!document.hidden && !controls.current.paused) elapsed += delta;
      const position = controls.current.loop ? elapsed : Math.min(elapsed, clip.duration - 1);
      const frame = frameAtTime(clip, position);
      if (frame !== currentFrame) {
        currentFrame = frame;
        element.src = clip.frames[frame];
        element.dataset.frame = String(frame);
      }
      request = requestAnimationFrame(draw);
    };
    const resetClock = () => { last = 0; };
    document.addEventListener("visibilitychange", resetClock);
    const loaded = clip.frames.map(source => {
      const preload = new Image();
      preload.src = source;
      return preload.decode();
    });
    Promise.all(loaded).then(() => {
      if (!disposed) request = requestAnimationFrame(draw);
    }).catch((error: unknown) => console.error("Pet action frames could not load", error));
    return () => {
      disposed = true;
      cancelAnimationFrame(request);
      document.removeEventListener("visibilitychange", resetClock);
    };
  }, [clip]);

  return <img ref={image} className="latitude-pet-source latitude-pet-action-frame" src={clip.frames[0]}
    data-frame="0" data-action-clip={clip.id} alt="" aria-hidden="true" draggable={false} onLoad={onLoad} />;
}
