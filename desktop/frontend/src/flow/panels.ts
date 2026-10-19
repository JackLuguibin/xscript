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

export type InspectorMode = LibraryMode;

/** At or below this width "auto" keeps the inspector folded until something is selected. Mirrors components.css. */
export const COMPACT_QUERY = "(max-width: 1100px)";

/** "auto" shows the inspector on wide windows, and on compact ones only while a node (or note, group…) is picked. */
export function inspectorShown(mode: InspectorMode, compact: boolean, picking: boolean): boolean {
  return mode === "open" || (mode === "auto" && (!compact || picking));
}

/** Flip what the user currently sees, like toggleLibrary. */
export function toggleInspector(mode: InspectorMode, compact: boolean, picking: boolean): InspectorMode {
  return inspectorShown(mode, compact, picking) ? "closed" : "open";
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

export function matchesNarrow(query: string = NARROW_QUERY): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export interface FieldIssue {
  kind: "required" | "number" | "integer" | "min";
  min?: number;
}

/**
 * Why a number field's draft cannot be stored yet, or null when it can. A number input reports text it cannot
 * parse as "", so an empty draft is the "type a number" case.
 */
export function numberIssue(raw: string, type: string, min?: number): FieldIssue | null {
  const text = raw.trim();
  if (!text) return { kind: "required" };
  const value = Number(text);
  if (!Number.isFinite(value)) return { kind: "number" };
  if (type === "int" && !Number.isInteger(value)) return { kind: "integer" };
  if (min !== undefined && value < min) return { kind: "min", min };
  return null;
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

/** Nodes to bring into view once they are measured, such as the ones the control tree just added. */
export interface CanvasFocus {
  key: number;
  ids: readonly string[];
}

/**
 * The node ids to frame for `focus`, or null when it was already framed (`done` is its key)
 * or any of its nodes is missing or not measured yet.
 */
export function focusTargets(
  nodes: ReadonlyArray<{ id: string; measured?: { width?: number } }>,
  focus: CanvasFocus | null,
  done: number,
): string[] | null {
  if (!focus || !focus.ids.length || focus.key === done) return null;
  const wanted = new Set(focus.ids);
  const hits = nodes.filter((node) => wanted.has(node.id));
  if (hits.length !== wanted.size || hits.some((node) => !node.measured?.width)) return null;
  return hits.map((node) => node.id);
}
