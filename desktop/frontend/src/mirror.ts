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

// ---- window fit (H3) ------------------------------------------------------------------------------------------------------------

/** "fit": the whole screen fits the window height; "actual": one device pixel per physical screen pixel (scrolls). */
export type FitMode = "fit" | "actual";

export function isLandscape(screen: Size | null): boolean {
  return !!screen && screen.w > screen.h;
}

/**
 * CSS width of the shown frame. `avail` is the room left in the window below the toolbar (w may be Infinity when the
 * column grows to the content). Fit keeps the aspect ratio and never exceeds the height; null until the screen size is known.
 */
export function fitWidth(avail: Size, screen: Size | null, mode: FitMode, dpr = 1): number | null {
  if (!screen || !(screen.w > 0) || !(screen.h > 0)) return null;
  if (mode === "actual") return Math.round(screen.w / Math.max(1, dpr));
  const byHeight = Math.max(1, avail.h) * (screen.w / screen.h);
  return Math.max(1, Math.floor(Math.min(avail.w > 0 ? avail.w : Infinity, byHeight)));
}

// ---- wheel → swipe (M9) ---------------------------------------------------------------------------------------------------------

export const WHEEL_SWIPE_MS = 250;

/** Wheel delta in element pixels (deltaMode 0 = pixels, 1 = lines, 2 = pages). */
export function wheelPixels(delta: number, deltaMode: number, pagePx: number): number {
  return deltaMode === 1 ? delta * 16 : deltaMode === 2 ? delta * pagePx : delta;
}

/**
 * Accumulated wheel movement at device point `at` → one swipe. Scrolling down moves the finger up (like a touch-pad).
 * `pxToDevice` converts element pixels to device pixels. Distance is 8–50 % of the screen along the dominant axis;
 * the start point shifts inward so a swipe near an edge still has its full length.
 */
export function wheelSwipe(at: { x: number; y: number }, delta: { dx: number; dy: number }, pxToDevice: number, screen: Size): Gesture | null {
  const vertical = Math.abs(delta.dy) >= Math.abs(delta.dx);
  const d = vertical ? delta.dy : delta.dx;
  if (Math.abs(d) < 1 || !(screen.w > 0) || !(screen.h > 0)) return null;
  const len = vertical ? screen.h : screen.w;
  const dist = Math.round(clamp(Math.abs(d) * Math.max(0.01, pxToDevice), len * 0.08, len * 0.5));
  let start = clamp(Math.round(vertical ? at.y : at.x), 0, len - 1);
  let end: number;
  if (d > 0) {
    start = Math.max(start, dist);
    end = start - dist;
  } else {
    start = Math.min(start, len - 1 - dist);
    end = start + dist;
  }
  const other = clamp(Math.round(vertical ? at.x : at.y), 0, (vertical ? screen.w : screen.h) - 1);
  return vertical
    ? { type: "swipe", x1: other, y1: start, x2: other, y2: end, dur: WHEEL_SWIPE_MS }
    : { type: "swipe", x1: start, y1: other, x2: end, y2: other, dur: WHEEL_SWIPE_MS };
}

// ---- remembered settings (M9) ---------------------------------------------------------------------------------------------------

export const MIRROR_FPS = [5, 8, 12, 15];
const PREFS_KEY = "xscript.mirror";

export interface MirrorPrefs {
  fps: number;
  fit: FitMode;
  /** Pause survives page visits in this session only: a restart always starts streaming. */
  playing: boolean;
}

let sessionPlaying = true;

export function loadMirrorPrefs(): MirrorPrefs {
  let fps = 12;
  let fit: FitMode = "fit";
  try {
    const raw = JSON.parse(window.localStorage.getItem(PREFS_KEY) || "{}") as Partial<MirrorPrefs>;
    if (typeof raw.fps === "number" && MIRROR_FPS.includes(raw.fps)) fps = raw.fps;
    if (raw.fit === "actual" || raw.fit === "fit") fit = raw.fit;
  } catch {
    /* unreadable storage: defaults */
  }
  return { fps, fit, playing: sessionPlaying };
}

export function saveMirrorPrefs(p: MirrorPrefs): void {
  sessionPlaying = p.playing;
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ fps: p.fps, fit: p.fit }));
  } catch {
    /* storage full or disabled: the session value still applies */
  }
}

/** Tests: forget the session-only pause state. */
export function resetMirrorSession(): void {
  sessionPlaying = true;
}
