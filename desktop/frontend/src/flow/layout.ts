import type { FlowGraph } from "./dsl";
import { placeNodes } from "./place";

/** One bend on a semantic edge. It lives in the layout file and is not a node in the flow. */
export interface Reroute {
  id: string;
  at: [number, number];
  edge: string;
}

/** A colored box around nodes. It lives in the layout file and is not part of the flow. */
export interface LayoutGroup {
  id: string;
  title: string;
  color?: string;
  rect: [number, number, number, number];
}
/** A sticky note. It lives in the layout file and is not part of the flow. */
export interface LayoutComment {
  id: string;
  text: string;
  at: [number, number];
}

export interface FlowLayout {
  xflowLayout: 1;
  viewport: { x: number; y: number; zoom: number };
  nodes: Record<string, { x: number; y: number; collapsed?: boolean; title?: string }>;
  reroutes?: Reroute[];
  groups?: LayoutGroup[];
  comments?: LayoutComment[];
}

export interface VisualEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  semantic: string;
  segment: number;
}

/** Off-screen nodes stay unmounted once a flow passes the large-graph line in the design. */
export function clipOffscreen(count: number): boolean {
  return count > 300;
}

/** Bottom dock height. The design starts at 240 px and stays between 120 and 480. */
export function clampDock(height: number): number {
  if (!Number.isFinite(height)) return 240;
  return Math.min(480, Math.max(120, Math.round(height)));
}

export function layoutFromGraph(graph: FlowGraph): FlowLayout {
  const placed = placeNodes(graph);
  const nodes: FlowLayout["nodes"] = {};
  for (const [id, pos] of Object.entries(placed)) nodes[id] = { x: pos.x, y: pos.y };
  return { xflowLayout: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes, reroutes: [], groups: [], comments: [] };
}

/** Keep dragged positions for ids that are still in the graph. New ids get an automatic place. Reroutes stay only while their edge does. */
export function retainLayout(prev: FlowLayout, graph: FlowGraph): FlowLayout {
  const fresh = layoutFromGraph(graph);
  const nodes: FlowLayout["nodes"] = {};
  for (const [id, pos] of Object.entries(fresh.nodes)) nodes[id] = prev.nodes[id] ?? pos;
  const live = new Set(graph.edges.map((edge) => edge.from + "->" + edge.to));
  return {
    xflowLayout: 1,
    viewport: prev.viewport,
    nodes,
    reroutes: (prev.reroutes ?? []).filter((item) => live.has(item.edge)),
    groups: prev.groups ?? [],
    comments: prev.comments ?? [],
  };
}

function keptNode(pos: FlowLayout["nodes"][string] | undefined, x: number, y: number, collapsed: boolean): FlowLayout["nodes"][string] {
  const next: FlowLayout["nodes"][string] = { x, y };
  if (collapsed) next.collapsed = true;
  if (pos?.title !== undefined) next.title = pos.title;
  return next;
}

export function moveNode(layout: FlowLayout, id: string, x: number, y: number): FlowLayout {
  const prev = layout.nodes[id];
  return { ...layout, nodes: { ...layout.nodes, [id]: keptNode(prev, x, y, Boolean(prev?.collapsed)) } };
}

/** Store a display name on the layout node. `null` clears it so the canvas uses the spec title. */
export function renameNodeTitle(layout: FlowLayout, id: string, title: string | null): FlowLayout {
  const pos = layout.nodes[id];
  if (!pos) return layout;
  const next = keptNode(pos, pos.x, pos.y, Boolean(pos.collapsed));
  if (title === null) delete next.title;
  else next.title = title;
  return { ...layout, nodes: { ...layout.nodes, [id]: next } };
}

/** Keep a node's place when its id changes. Reroute edges that named it follow. */
export function rekeyNode(layout: FlowLayout, from: string, to: string): FlowLayout {
  if (from === to) return layout;
  const nodes = { ...layout.nodes };
  if (nodes[from]) {
    nodes[to] = nodes[from];
    delete nodes[from];
  }
  const swap = (ref: string) => {
    const dot = ref.indexOf(".");
    if (dot < 0) return ref;
    return (ref.slice(0, dot) === from ? to : ref.slice(0, dot)) + ref.slice(dot);
  };
  return {
    ...layout,
    nodes,
    reroutes: (layout.reroutes ?? []).map((hop) => {
      const parts = hop.edge.split("->");
      return { ...hop, edge: swap(parts[0] ?? "") + "->" + swap(parts[1] ?? "") };
    }),
  };
}

/** Collapse every selected node that is still open. When they are all collapsed, expand them. */
export function toggleCollapsed(layout: FlowLayout, ids: readonly string[]): FlowLayout {
  const present = ids.filter((id) => layout.nodes[id]);
  if (!present.length) return layout;
  const collapse = present.some((id) => !layout.nodes[id].collapsed);
  const nodes = { ...layout.nodes };
  for (const id of present) {
    const pos = nodes[id];
    nodes[id] = keptNode(pos, pos.x, pos.y, collapse);
  }
  return { ...layout, nodes };
}

export function moveReroute(layout: FlowLayout, id: string, x: number, y: number): FlowLayout {
  return { ...layout, reroutes: (layout.reroutes ?? []).map((item) => (item.id === id ? { ...item, at: [x, y] } : item)) };
}

export function pointOf(layout: FlowLayout, id: string): { x: number; y: number } | null {
  const note = (layout.comments ?? []).find((item) => item.id === id);
  if (note) return { x: note.at[0], y: note.at[1] };
  const box = (layout.groups ?? []).find((item) => item.id === id);
  if (box) return { x: box.rect[0], y: box.rect[1] };
  const hop = (layout.reroutes ?? []).find((item) => item.id === id);
  if (hop) return { x: hop.at[0], y: hop.at[1] };
  return layout.nodes[id] ?? null;
}

export function moveGroup(layout: FlowLayout, id: string, x: number, y: number): FlowLayout {
  return {
    ...layout,
    groups: (layout.groups ?? []).map((item) => (item.id === id ? { ...item, rect: [x, y, item.rect[2], item.rect[3]] } : item)),
  };
}

export function moveItem(layout: FlowLayout, id: string, x: number, y: number): FlowLayout {
  if ((layout.comments ?? []).some((item) => item.id === id)) return moveComment(layout, id, x, y);
  if ((layout.groups ?? []).some((item) => item.id === id)) return moveGroup(layout, id, x, y);
  if ((layout.reroutes ?? []).some((item) => item.id === id)) return moveReroute(layout, id, x, y);
  return moveNode(layout, id, x, y);
}

export function moveComment(layout: FlowLayout, id: string, x: number, y: number): FlowLayout {
  return { ...layout, comments: (layout.comments ?? []).map((item) => (item.id === id ? { ...item, at: [x, y] } : item)) };
}

/** Move selected nodes, bends, and comment boxes by `dx, dy`. A box takes the nodes inside it. */
export function nudgeSelection(layout: FlowLayout, ids: readonly string[], dx: number, dy: number): FlowLayout {
  if (dx === 0 && dy === 0) return layout;
  let next = layout;
  const moved = new Set<string>();
  for (const id of ids) {
    const box = (next.groups ?? []).find((item) => item.id === id);
    if (box) {
      const members = nodesInside(next, box).filter((member) => !moved.has(member));
      next = shiftGroup(next, id, box.rect[0] + dx, box.rect[1] + dy, members);
      for (const member of members) moved.add(member);
      continue;
    }
    if (moved.has(id)) continue;
    const pos = pointOf(next, id);
    if (!pos) continue;
    next = moveItem(next, id, pos.x + dx, pos.y + dy);
    moved.add(id);
  }
  return next;
}

/** Node ids whose top-left sits inside the box. */
export function nodesInside(layout: FlowLayout, group: LayoutGroup): string[] {
  const [x, y, w, h] = group.rect;
  return Object.entries(layout.nodes)
    .filter(([, pos]) => pos.x >= x && pos.x < x + w && pos.y >= y && pos.y < y + h)
    .map(([id]) => id);
}

/** Move a comment box to `x, y` and shift `members` by the same amount. */
export function shiftGroup(layout: FlowLayout, id: string, x: number, y: number, members: readonly string[]): FlowLayout {
  const box = (layout.groups ?? []).find((item) => item.id === id);
  if (!box) return layout;
  const dx = x - box.rect[0];
  const dy = y - box.rect[1];
  let next = moveGroup(layout, id, x, y);
  if (dx === 0 && dy === 0) return next;
  for (const member of members) {
    const pos = next.nodes[member];
    if (pos) next = moveNode(next, member, pos.x + dx, pos.y + dy);
  }
  return next;
}

function snap16(value: number): number {
  return Math.round(value / 16) * 16;
}

/** Box the given nodes. The id is `g1`, `g2`, … and the title defaults to 注释. */
export function addGroup(
  layout: FlowLayout,
  ids: readonly string[],
  title = "注释",
  size: Record<string, { width: number; height: number }> = {},
  reserved: readonly string[] = [],
): FlowLayout {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const pos = layout.nodes[id];
    if (!pos) continue;
    const width = size[id]?.width ?? 128;
    const height = size[id]?.height ?? 40;
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + width);
    maxY = Math.max(maxY, pos.y + height);
  }
  if (!Number.isFinite(minX)) return layout;
  const used = new Set([...(layout.groups ?? []).map((item) => item.id), ...(layout.reroutes ?? []).map((item) => item.id), ...reserved]);
  let n = 1;
  while (used.has("g" + n)) n += 1;
  const x = snap16(minX - 32);
  const y = snap16(minY - 48);
  const w = Math.max(64, snap16(maxX + 32 - x));
  const h = Math.max(64, snap16(maxY + 32 - y));
  const box: LayoutGroup = { id: "g" + n, title, color: "#4a90d9", rect: [x, y, w, h] };
  return { ...layout, groups: [...(layout.groups ?? []), box] };
}

export function renameGroup(layout: FlowLayout, id: string, title: string): FlowLayout {
  return { ...layout, groups: (layout.groups ?? []).map((item) => (item.id === id ? { ...item, title } : item)) };
}

export function deleteGroups(layout: FlowLayout, ids: readonly string[]): FlowLayout {
  const drop = new Set(ids);
  return { ...layout, groups: (layout.groups ?? []).filter((item) => !drop.has(item.id)) };
}

/** A point comment. The id is `c1`, `c2`, …. The text stays in the layout file. */
export function addComment(layout: FlowLayout, x: number, y: number, text = "备注", reserved: readonly string[] = []): FlowLayout {
  const used = new Set([
    ...(layout.comments ?? []).map((item) => item.id),
    ...(layout.groups ?? []).map((item) => item.id),
    ...(layout.reroutes ?? []).map((item) => item.id),
    ...reserved,
  ]);
  let n = 1;
  while (used.has("c" + n)) n += 1;
  const note: LayoutComment = { id: "c" + n, text, at: [x, y] };
  return { ...layout, comments: [...(layout.comments ?? []), note] };
}

export function renameComment(layout: FlowLayout, id: string, text: string): FlowLayout {
  return { ...layout, comments: (layout.comments ?? []).map((item) => (item.id === id ? { ...item, text } : item)) };
}

export function deleteComments(layout: FlowLayout, ids: readonly string[]): FlowLayout {
  const drop = new Set(ids);
  return { ...layout, comments: (layout.comments ?? []).filter((item) => !drop.has(item.id)) };
}

/** Insert a bend on `edge` at segment `segment` (0 is the first stretch). The id is `r1`, `r2`, … */
export function insertReroute(
  layout: FlowLayout,
  edge: string,
  x: number,
  y: number,
  segment?: number,
  reserved: readonly string[] = [],
): FlowLayout {
  const used = new Set([...(layout.reroutes ?? []).map((item) => item.id), ...reserved]);
  let n = 1;
  while (used.has("r" + n)) n += 1;
  const item: Reroute = { id: "r" + n, at: [x, y], edge };
  const at = segment ?? (layout.reroutes ?? []).filter((hop) => hop.edge === edge).length;
  const reroutes: Reroute[] = [];
  let seen = 0;
  let placed = false;
  for (const hop of (layout.reroutes ?? [])) {
    if (!placed && hop.edge === edge && seen === at) {
      reroutes.push(item);
      placed = true;
    }
    if (hop.edge === edge) seen += 1;
    reroutes.push(hop);
  }
  if (!placed) reroutes.push(item);
  return { ...layout, reroutes };
}

export function deleteReroutes(layout: FlowLayout, ids: readonly string[]): FlowLayout {
  const drop = new Set(ids);
  return { ...layout, reroutes: (layout.reroutes ?? []).filter((item) => !drop.has(item.id)) };
}

/** Split each semantic edge through its reroutes. The semantic `from -> to` stays one edge. */
export function visualEdges(graph: FlowGraph, layout: FlowLayout): VisualEdge[] {
  const out: VisualEdge[] = [];
  for (const edge of graph.edges) {
    const key = edge.from + "->" + edge.to;
    const source = edge.from.slice(0, edge.from.indexOf("."));
    const target = edge.to.slice(0, edge.to.indexOf("."));
    if (source === "start" || target === "start") continue;
    const hops = (layout.reroutes ?? []).filter((item) => item.edge === key);
    const chain = [source, ...hops.map((item) => item.id), target];
    const sourceHandle = edge.from.slice(edge.from.indexOf(".") + 1);
    const targetHandle = edge.to.slice(edge.to.indexOf(".") + 1);
    for (let i = 0; i < chain.length - 1; i += 1) {
      const from = chain[i] ?? source;
      const to = chain[i + 1] ?? target;
      out.push({
        id: key + "#" + i,
        source: from,
        target: to,
        sourceHandle: from === source ? sourceHandle : "out",
        targetHandle: to === target ? targetHandle : "in",
        semantic: key,
        segment: i,
      });
    }
  }
  return out;
}

/** Midpoint of one visual segment, before grid snap. */
export function segmentMidpoint(layout: FlowLayout, graph: FlowGraph, edge: string, segment: number): [number, number] {
  const semantic = graph.edges.find((item) => item.from + "->" + item.to === edge);
  if (!semantic) return [0, 0];
  const source = semantic.from.slice(0, semantic.from.indexOf("."));
  const target = semantic.to.slice(0, semantic.to.indexOf("."));
  const hops = (layout.reroutes ?? []).filter((item) => item.edge === edge);
  const chain = [source, ...hops.map((item) => item.id), target];
  const at = (id: string): [number, number] => {
    const hop = hops.find((item) => item.id === id);
    if (hop) return hop.at;
    const node = layout.nodes[id];
    return [node?.x ?? 0, node?.y ?? 0];
  };
  const a = at(chain[segment] ?? source);
  const b = at(chain[Math.min(segment + 1, chain.length - 1)] ?? target);
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}
