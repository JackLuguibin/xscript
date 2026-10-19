// Pure helpers for the flow page chrome: when the node library is shown and how the toolbar reports overflow.

export type LibraryMode = "auto" | "open" | "closed";

/** Below this width "auto" hides the library so the canvas keeps a usable width. Mirrors components.css. */
export const NARROW_QUERY = "(max-width: 1280px)";

export function libraryShown(mode: LibraryMode, narrow: boolean): boolean {
  return mode === "open" || (mode === "auto" && !narrow);
}

/** Flip what the user currently sees, so the first press always does something even in "auto". */
export function toggleLibrary(mode: LibraryMode, narrow: boolean): LibraryMode {
  return libraryShown(mode, narrow) ? "closed" : "open";
}

/** Which edges of a horizontally scrolling strip hide content: "", "start", "end" or "start end". */
export function overflowEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): string {
  const edges: string[] = [];
  if (scrollLeft > 1) edges.push("start");
  if (scrollLeft + clientWidth < scrollWidth - 1) edges.push("end");
  return edges.join(" ");
}

/** A mouse wheel only moves vertically; turn that into a sideways scroll when it dominates. */
export function wheelShift(deltaX: number, deltaY: number): number {
  return Math.abs(deltaY) > Math.abs(deltaX) ? deltaY : 0;
}

export function matchesNarrow(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
  } catch {
    return false;
  }
}

/** First view of a flow: whole graph when it stays readable, never blown up past 100%. */
export const AUTO_FIT = { padding: 32, minZoom: 0.6, maxZoom: 1 } as const;

export type Box = { x: number; y: number; width: number; height: number };

/**
 * Viewport that frames `bounds` in a `width`×`height` pane. When fitting everything would need a zoom below
 * minZoom, keep minZoom and pin the graph's start (left edge) instead of shrinking it to an unreadable size.
 */
export function startViewport(bounds: Box, width: number, height: number, opts: { padding: number; minZoom: number; maxZoom: number } = AUTO_FIT): { x: number; y: number; zoom: number } {
  const pad = opts.padding;
  const room = { w: Math.max(1, width - 2 * pad), h: Math.max(1, height - 2 * pad) };
  const fit = Math.min(room.w / Math.max(1, bounds.width), room.h / Math.max(1, bounds.height));
  const zoom = Math.min(opts.maxZoom, Math.max(opts.minZoom, fit));
  const along = (size: number, start: number, extent: number) =>
    extent * zoom <= size - 2 * pad ? (size - extent * zoom) / 2 - start * zoom : pad - start * zoom;
  return { x: along(width, bounds.x, bounds.width), y: along(height, bounds.y, bounds.height), zoom };
}

/** Fit once per flow, after every node on the canvas has been measured. */
export function shouldAutoFit(fitted: string | null, name: string, ready: boolean): boolean {
  return ready && fitted !== name;
}
