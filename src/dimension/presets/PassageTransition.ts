import type { DimensionPresetId } from "./presetQuery";

export const PASSAGE_MS = 820;
export const DEPTH_MS = 900;
export const STAR_GATHER_MS = 2800;
const VIRTUAL_DISTANCE = 6;
const IDS: DimensionPresetId[] = ["constellation", "clue-board", "paper"];
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;

/** Match the accepted preview's easing without reading computed styles each frame. */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
  return (progress: number) => {
    const x = clamp(progress);
    if (x === 0 || x === 1) return x;
    let low = 0;
    let high = 1;
    for (let i = 0; i < 16; i++) {
      const mid = (low + high) / 2;
      if (at(mid, x1, x2) < x) low = mid; else high = mid;
    }
    return at((low + high) / 2, y1, y2);
  };
}
const arrive = bezier(.16, 1, .3, 1);
const depart = bezier(.3, .04, .6, 1);
const depthEase = bezier(.18, .78, .16, 1);
const fadeOut = bezier(0, 0, .58, 1);

type Pose = { y: number; scale: number; blur: number; opacity: number };
const REST: Pose = { y: 0, scale: 1, blur: 0, opacity: 1 };
const mixPose = (from: Pose, to: Pose, progress: number): Pose => ({
  y: lerp(from.y, to.y, progress), scale: lerp(from.scale, to.scale, progress),
  blur: lerp(from.blur, to.blur, progress), opacity: lerp(from.opacity, to.opacity, progress)
});
type Backdrop = { blend: number; boardY: number; deskY: number };
type PaperEdge = { id: DimensionPresetId; x: number; y: number; width: number; height: number };
const particles = Array.from({ length: 48 }, (_, index) => ({
  x: ((index * 37 + 11) % 101) / 101,
  y: ((index * 61 + 7) % 103) / 103,
  depth: index % 3,
  width: 30 + (index * 17) % 96
}));

/** One interruptible timeline owns content and texture travel; camera coordinates never enter it. */
export function createDeckMotion(root: HTMLElement, initial: DimensionPresetId) {
  const sections = Object.fromEntries(IDS.map(id => [id, root.querySelector<HTMLElement>(`[data-deck-layer="${id}"]`)!])) as Record<DimensionPresetId, HTMLElement>;
  const scenes = Object.fromEntries(IDS.map(id => [id, sections[id].querySelector<HTMLElement>(".dim-deck-layer-inner")!])) as Record<DimensionPresetId, HTMLElement>;
  const boardBackdrop = root.querySelector<HTMLElement>(".dim-deck-backdrop-board")!;
  const deskBackdrop = root.querySelector<HTMLElement>(".dim-deck-backdrop-desk")!;
  const canvas = root.querySelector<HTMLCanvasElement>(".dim-deck-passage")!;
  const poses = Object.fromEntries(IDS.map(id => [id, { ...REST, opacity: id === initial ? 1 : 0 }])) as Record<DimensionPresetId, Pose>;
  let backdrop: Backdrop = { blend: initial === "paper" ? 1 : 0, boardY: 0, deskY: 0 };
  let frame = 0;
  let moving = false;
  let target = initial;
  let completion: (() => void) | undefined;
  let ctx: CanvasRenderingContext2D | null = null;
  let width = 0;
  let height = 0;
  let edges: PaperEdge[] = [];
  let travelOffset = 0;
  const palette = { trail: "rgba(94,108,70,.68)", paper: "rgba(253,250,242,.7)", light: "rgba(252,250,230,.44)" };

  function paintPose(id: DimensionPresetId) {
    const pose = poses[id];
    scenes[id].style.transform = `translate3d(0, ${pose.y}px, 0) scale(${pose.scale})`;
    scenes[id].style.opacity = String(pose.opacity);
    scenes[id].style.filter = pose.blur > .001 ? `blur(${pose.blur}px)` : "none";
    sections[id].style.visibility = pose.opacity > .001 || id === target ? "visible" : "hidden";
  }
  function paintBackdrop() {
    deskBackdrop.style.opacity = String(backdrop.blend);
    boardBackdrop.style.setProperty("--deck-texture-y", `${backdrop.boardY}px`);
    deskBackdrop.style.setProperty("--deck-texture-y", `${backdrop.deskY}px`);
  }
  function clearCanvas() { ctx?.clearRect(0, 0, width, height); }
  function settle() {
    cancelAnimationFrame(frame);
    moving = false;
    IDS.forEach(id => { poses[id] = { ...REST, opacity: id === target ? 1 : 0 }; paintPose(id); });
    // Texture positions end at full periods, so normalizing them has no visible jump.
    backdrop = { blend: target === "paper" ? 1 : target === "clue-board" ? 0 : backdrop.blend, boardY: 0, deskY: 0 };
    paintBackdrop();
    clearCanvas();
    root.dataset.travelPhase = "idle";
    const finish = completion;
    completion = undefined;
    finish?.();
  }
  function prepareCanvas() {
    const bounds = root.getBoundingClientRect();
    width = bounds.width;
    height = bounds.height;
    if (width > 0 && height > 0) {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx = canvas.getContext("2d");
      ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    edges = [];
    for (const id of ["paper", "clue-board"] as const) {
      const origin = scenes[id].getBoundingClientRect();
      const scale = poses[id].scale || 1;
      const papers = scenes[id].querySelectorAll<HTMLElement>("[data-layout-card-id], .clue-paper, .clue-thesis");
      for (const paper of Array.from(papers).slice(0, 24)) {
        const box = paper.getBoundingClientRect();
        const x = (box.left - origin.left) / scale;
        const y = (box.top - origin.top) / scale;
        if (x + box.width < 0 || x > width || y + box.height < 0 || y > height) continue;
        edges.push({ id, x, y, width: box.width / scale, height: box.height / scale });
      }
    }
  }
  function drawPassage(progress: number, direction: number, backgroundStart: Backdrop, carry: number, offsetStart: number) {
    const braking = clamp((progress - .43) / .57);
    const distance = progress < .43 ? progress / .43 * .72 : .72 + .28 * (1 - (1 - braking) ** 3);
    const speed = progress < .43 ? 1 : (1 - braking) ** 2;
    const fade = Math.max(carry * (1 - smooth(progress / .32)), smooth((progress - .04) / .2)) * (1 - smooth((progress - .39) / .39));
    canvas.style.opacity = String(fade);
    const offset = offsetStart + direction * distance * height * VIRTUAL_DISTANCE;
    travelOffset = offset;
    const blend = smooth((progress - .06) / .7);
    backdrop.blend = lerp(backgroundStart.blend, direction > 0 ? 1 : 0, blend);
    for (const [key, period] of [["boardY", 7], ["deskY", 27]] as const) {
      const end = Math.round((backgroundStart[key] - direction * height * VIRTUAL_DISTANCE * .23) / period) * period;
      backdrop[key] = lerp(backgroundStart[key], end, distance);
    }
    paintBackdrop();
    if (!ctx || width === 0 || height === 0) return;
    const context = ctx;
    clearCanvas();
    const glowY = height * .9 - offset * .09;
    const glow = context.createRadialGradient(width * .34, glowY, 0, width * .34, glowY, height * 1.1);
    glow.addColorStop(0, palette.light);
    glow.addColorStop(1, "transparent");
    context.globalAlpha = .6;
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);
    particles.forEach((particle, index) => {
      const depth = [.26, .57, 1][particle.depth];
      const span = height * 1.8;
      const y = ((particle.y * span - offset * depth) % span + span) % span - height * .4;
      const x = particle.x * width;
      const length = 18 + speed * height * (.14 + depth * .25);
      const tailY = y + direction * length;
      const trail = context.createLinearGradient(x, y, x, tailY);
      trail.addColorStop(0, palette.trail);
      trail.addColorStop(1, "transparent");
      context.globalAlpha = .1 + depth * .22;
      context.strokeStyle = trail;
      context.lineWidth = particle.depth === 2 ? 2.4 : 1;
      context.beginPath(); context.moveTo(x, y); context.lineTo(x, tailY); context.stroke();
      if (index % 4 === 0) {
        const paperTrail = context.createLinearGradient(x, y, x, tailY);
        paperTrail.addColorStop(0, palette.paper); paperTrail.addColorStop(1, "transparent");
        context.globalAlpha = .32; context.fillStyle = paperTrail;
        context.fillRect(x, Math.min(y, tailY), particle.width, length);
        context.strokeStyle = palette.trail; context.globalAlpha = .22;
        context.beginPath(); context.moveTo(x, y); context.lineTo(x + particle.width, y); context.stroke();
      }
    });
    // Paper edges join the actual content to the passing textures, without duplicate text.
    edges.forEach(box => {
      const pose = poses[box.id];
      const stretch = Math.min(1, Math.abs(pose.y) / (height * .34));
      if (pose.opacity < .01 || stretch < .01) return;
      const length = height * .24 * stretch;
      const edgeY = box.y + pose.y + (direction > 0 ? box.height : 0);
      const tailY = edgeY + direction * length;
      const trail = context.createLinearGradient(0, edgeY, 0, tailY);
      trail.addColorStop(0, palette.paper); trail.addColorStop(1, "transparent");
      context.fillStyle = trail; context.globalAlpha = pose.opacity * stretch * .34;
      context.fillRect(box.x, Math.min(edgeY, tailY), box.width, length);
    });
    context.globalAlpha = 1;
  }

  const resize = () => { if (moving) settle(); };
  window.addEventListener("resize", resize);
  IDS.forEach(paintPose);
  paintBackdrop();
  return {
    go(from: DimensionPresetId, to: DimensionPresetId, reduced: boolean, onFinish: () => void) {
      const interrupted = moving;
      const carry = Number(canvas.style.opacity) || 0;
      cancelAnimationFrame(frame);
      target = to;
      completion = onFinish;
      if (reduced) { settle(); return; }
      const kind = from === "constellation" || to === "constellation" ? "depth" : "passage";
      const direction = IDS.indexOf(to) > IDS.indexOf(from) ? 1 : -1;
      const duration = kind === "passage" ? interrupted ? 460 : PASSAGE_MS : DEPTH_MS;
      prepareCanvas();
      moving = true;
      const starts = Object.fromEntries(IDS.map(id => [id, { ...poses[id] }])) as Record<DimensionPresetId, Pose>;
      if (!interrupted || poses[to].opacity < .001) {
        starts[to] = kind === "passage"
          ? { y: direction * height * .84, scale: 1, blur: 7, opacity: 0 }
          : to === "constellation" ? { ...REST, opacity: 0 } : { y: 0, scale: .64, blur: 38, opacity: .06 };
      }
      const backgroundStart = { ...backdrop };
      const offsetStart = interrupted ? travelOffset : 0;
      if (kind === "depth") {
        clearCanvas(); canvas.style.opacity = "0";
        if (to !== "constellation") { backdrop.blend = to === "paper" ? 1 : 0; paintBackdrop(); }
      }
      const started = performance.now();
      const tick = (now: number) => {
        const progress = clamp((now - started) / duration);
        for (const id of IDS) {
          if (kind === "passage") {
            const delay = interrupted ? 0 : .36;
            const arrivalProgress = clamp((progress - delay) / (1 - delay));
            poses[id] = id === to
              ? { ...mixPose(starts[id], REST, arrive(arrivalProgress)), opacity: lerp(starts[id].opacity, 1, fadeOut(arrivalProgress / .56)) }
              : mixPose(starts[id], { ...REST, y: -direction * height * 1.1, blur: 7, opacity: 0 }, depart(progress / .24));
          } else if (id === to) {
            if (to === "constellation") poses[id] = mixPose(starts[id], REST, fadeOut(progress / (.55 / .9)));
            else poses[id] = mixPose(starts[id], REST, depthEase(progress));
          } else poses[id] = mixPose(starts[id], { y: 0, scale: to === "constellation" ? .64 : 2.05, blur: to === "constellation" ? 24 : 46, opacity: 0 }, depthEase(progress));
          paintPose(id);
        }
        if (kind === "passage") {
          root.dataset.travelPhase = progress < .24 ? "departure" : progress < .36 ? "passage" : "arrival";
          drawPassage(progress, direction, backgroundStart, interrupted ? carry : 0, offsetStart);
        }
        if (progress < 1) frame = requestAnimationFrame(tick); else settle();
      };
      tick(started);
    },
    finish: settle,
    dispose() {
      completion = undefined;
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(frame);
      clearCanvas();
    }
  };
}
