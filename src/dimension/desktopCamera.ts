export interface DesktopBounds { left: number; top: number; width: number; height: number }
export interface DesktopCameraPosition { x: number; y: number; zoom: number }
export type DesktopCameraReason = "pan" | "zoom" | "focus" | "home" | "back" | "restore";
export interface DesktopCameraSnapshot {
  version: 1;
  camera: DesktopCameraPosition;
  home: DesktopCameraPosition;
  previous?: DesktopCameraPosition;
}

export const DESKTOP_FOCUS_BOUNDS_EVENT = "latitude:desktop-focus-bounds";
export const DESKTOP_CAMERA_PREFIX = "dim-desk-camera-";
export const MIN_DESKTOP_ZOOM = 0.25;
export const MAX_DESKTOP_ZOOM = 2;
export const clampDesktopZoom = (value: number) => Math.min(MAX_DESKTOP_ZOOM, Math.max(MIN_DESKTOP_ZOOM, value));

export function validDesktopCamera(value: unknown): value is DesktopCameraPosition {
  if (!value || typeof value !== "object") return false;
  const camera = value as DesktopCameraPosition;
  return Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.zoom)
    && camera.zoom >= MIN_DESKTOP_ZOOM && camera.zoom <= MAX_DESKTOP_ZOOM;
}

export function validDesktopBounds(value: DesktopBounds): boolean {
  return [value.left, value.top, value.width, value.height].every(Number.isFinite)
    && value.width >= 0 && value.height >= 0;
}

export function readDesktopCamera(key: string): DesktopCameraSnapshot | null {
  try {
    return validateDesktopCameraSnapshot(JSON.parse(window.localStorage.getItem(key) ?? "null"));
  } catch { return null; }
}

export function validateDesktopCameraSnapshot(value: unknown): DesktopCameraSnapshot {
  if (!value || typeof value !== "object") throw new TypeError("Desktop camera state is invalid");
  const snapshot = value as DesktopCameraSnapshot;
  if (snapshot.version !== 1 || !validDesktopCamera(snapshot.camera) || !validDesktopCamera(snapshot.home)
    || (snapshot.previous !== undefined && !validDesktopCamera(snapshot.previous))) throw new TypeError("Desktop camera geometry is invalid");
  return { version: 1, camera: { ...snapshot.camera }, home: { ...snapshot.home },
    ...(snapshot.previous ? { previous: { ...snapshot.previous } } : {}) };
}
