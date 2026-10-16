// Pure helpers for the mirror: element pixels → device pixels, and click-vs-swipe classification.

export interface Size {
  w: number;
  h: number;
}

/**
 * Map a point on the displayed frame to device pixels. The frame may be downscaled and may be rotated relative to the
 * portrait size /status reports, so scale by the long sides: the result is in the frame's (= current) orientation.
 */
export function toDevice(x: number, y: number, shown: Size, frame: Size, device: Size | null): { x: number; y: number } {
  const fx = (x / Math.max(1, shown.w)) * frame.w;
  const fy = (y / Math.max(1, shown.h)) * frame.h;
  const scale = device ? Math.max(device.w, device.h) / Math.max(frame.w, frame.h) : 1;
  const maxX = Math.round(frame.w * scale) - 1;
  const maxY = Math.round(frame.h * scale) - 1;
  return { x: clamp(Math.round(fx * scale), 0, maxX), y: clamp(Math.round(fy * scale), 0, maxY) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/** Stream `scale` for a frame element of `displayPx` against a screen of `screenPx`. Device clamps to 0.2–1; 0.5 until both sizes are known. */
export function streamScale(displayPx: number, screenPx: number): number {
  if (!(displayPx > 0) || !(screenPx > 0)) return 0.5;
  const stepped = Math.round((displayPx / screenPx) * 10) / 10;
  return Math.min(1, Math.max(0.2, stepped));
}

/** Cache-busted latest-frame URL. The shell ignores `seq` and returns whatever JPEG it has now. */
export function frameUrl(deviceId: string, seq: number, nonce: number): string {
  return `/_frame/${encodeURIComponent(deviceId)}?seq=${seq}&n=${nonce}`;
}

export const TAP_SLOP_PX = 8; // element pixels: a smaller move is still a click
export const LONG_PRESS_MS = 500;

export type Gesture =
  | { type: "click"; x: number; y: number; dur: number }
  | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; dur: number };

/** Element-space press/release → the /action payload (coordinates already mapped by the caller). */
export function classify(
  down: { ex: number; ey: number; t: number; x: number; y: number },
  up: { ex: number; ey: number; t: number; x: number; y: number },
): Gesture {
  const dur = Math.round(up.t - down.t);
  if (Math.hypot(up.ex - down.ex, up.ey - down.ey) < TAP_SLOP_PX) {
    return { type: "click", x: down.x, y: down.y, dur: dur >= LONG_PRESS_MS ? Math.min(dur, 3000) : 20 };
  }
  return { type: "swipe", x1: down.x, y1: down.y, x2: up.x, y2: up.y, dur: Math.min(Math.max(dur, 50), 3000) };
}
