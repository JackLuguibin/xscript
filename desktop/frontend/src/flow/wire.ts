import { pinColor } from "./pins";

export type WireSide = "left" | "right" | "top" | "bottom";

type Point = { x: number; y: number };

const STUB = 24;
const GUTTER = 110;
const BEND = 14;

function sideOf(value: string | undefined, fallback: WireSide): WireSide {
  if (value === "left" || value === "right" || value === "top" || value === "bottom") return value;
  return fallback;
}

function signOf(side: WireSide): { x: number; y: number } {
  if (side === "left") return { x: -1, y: 0 };
  if (side === "right") return { x: 1, y: 0 };
  if (side === "top") return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Rounded orthogonal path. Corners shorter than the radius stay square. */
function rounded(points: Point[], radius: number): string {
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const at = points[i];
    const next = points[i + 1];
    const bend = Math.min(radius, dist(prev, at) / 2, dist(at, next) / 2);
    const straight = (prev.x === at.x && at.x === next.x) || (prev.y === at.y && at.y === next.y);
    if (bend < 1 || straight) {
      d += `L${at.x},${at.y}`;
      continue;
    }
    const spanIn = dist(prev, at);
    const spanOut = dist(at, next);
    const inX = at.x + ((prev.x - at.x) / spanIn) * bend;
    const inY = at.y + ((prev.y - at.y) / spanIn) * bend;
    const outX = at.x + ((next.x - at.x) / spanOut) * bend;
    const outY = at.y + ((next.y - at.y) / spanOut) * bend;
    d += `L${inX},${inY}Q${at.x},${at.y} ${outX},${outY}`;
  }
  const end = points[points.length - 1];
  d += `L${end.x},${end.y}`;
  return d;
}

function gutter(source: Point, start: Point, end: Point, target: Point, lane: number, horizontal: boolean): string {
  const mid = horizontal
    ? [
        { x: start.x, y: lane },
        { x: end.x, y: lane },
      ]
    : [
        { x: lane, y: start.y },
        { x: lane, y: end.y },
      ];
  return rounded([source, start, ...mid, end, target], BEND);
}

/**
 * Adjacent pins on one row get a short curve.
 * Anything that drops, skips a node, or turns back leaves the pin and runs in the gap, so it does not arc across the row.
 */
export function wirePath(sourceX: number, sourceY: number, targetX: number, targetY: number, sourceSide: string | undefined, targetSide: string | undefined): string {
  const from = sideOf(sourceSide, "right");
  const to = sideOf(targetSide, "left");
  const out = signOf(from);
  const into = signOf(to);
  const along = (targetX - sourceX) * out.x + (targetY - sourceY) * out.y;
  const across = Math.abs((targetX - sourceX) * out.y + (targetY - sourceY) * out.x);
  const source = { x: sourceX, y: sourceY };
  const target = { x: targetX, y: targetY };
  const start = { x: sourceX + out.x * STUB, y: sourceY + out.y * STUB };
  const end = { x: targetX + into.x * STUB, y: targetY + into.y * STUB };
  const horizontal = out.x !== 0;
  const ahead = horizontal ? end.x - start.x : end.y - start.y;
  if (along >= 16 && across <= 28 && along <= 220 && ahead > 0) {
    const lead = Math.min(32, along * 0.45);
    return `M${sourceX},${sourceY} C${sourceX + out.x * lead},${sourceY + out.y * lead} ${targetX + into.x * lead},${targetY + into.y * lead} ${targetX},${targetY}`;
  }
  if (along > 0 && across > 28 && ahead > 0) {
    const drop = horizontal ? { x: start.x, y: targetY } : { x: targetX, y: start.y };
    return rounded([source, start, drop, end, target], BEND);
  }
  const gap = GUTTER + (along > 0 ? 0 : 36);
  const lane = horizontal ? Math.max(sourceY, targetY) + gap : Math.max(sourceX, targetX) + gap;
  return gutter(source, start, end, target, lane, horizontal);
}

/** Exec wires follow the text color so they stay visible on the light canvas. Data wires keep the source pin color. */
export function wireStroke(kind: string | undefined, status?: "valid" | "invalid" | null): string {
  if (status === "invalid") return "var(--danger-dot)";
  if (!kind || kind === "exec") return "var(--text)";
  return pinColor(kind);
}
