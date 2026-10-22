// UI tree helpers (design §11.1). The tree shape is protocol/openapi.yaml UiNode, as dumped by NodeDumper.

export interface UiRect {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface UiNode {
  path?: string;
  id?: string;
  text?: string;
  desc?: string;
  type?: string;
  rect?: UiRect;
  clickable?: boolean;
  children?: UiNode[];
}

export interface UiTree {
  mode?: number;
  width?: number;
  height?: number;
  roots?: UiNode[];
}

export interface Size {
  w: number;
  h: number;
}

function contains(rect: UiRect, x: number, y: number): boolean {
  return rect.r > rect.l && rect.b > rect.t && x >= rect.l && x < rect.r && y >= rect.t && y < rect.b;
}

/** Deepest, then smallest, node whose rect contains the point. Later nodes win ties (they paint on top). */
export function hitTest(roots: readonly UiNode[], x: number, y: number): UiNode | null {
  const best: { node: UiNode | null; area: number; depth: number } = { node: null, area: Infinity, depth: -1 };
  const walk = (node: UiNode, depth: number) => {
    const rect = node.rect;
    if (rect && contains(rect, x, y)) {
      const area = (rect.r - rect.l) * (rect.b - rect.t);
      if (best.node === null || area < best.area || (area === best.area && depth >= best.depth)) {
        best.node = node;
        best.area = area;
        best.depth = depth;
      }
    }
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return best.node;
}

export function flattenTree(roots: readonly UiNode[], limit = 400): Array<{ node: UiNode; depth: number; truncated: boolean }> {
  const out: Array<{ node: UiNode; depth: number; truncated: boolean }> = [];
  const walk = (nodes: readonly UiNode[], depth: number) => {
    for (const node of nodes) {
      if (out.length >= limit) return;
      out.push({ node, depth, truncated: false });
      walk(node.children ?? [], depth + 1);
    }
  };
  walk(roots, 0);
  if (out.length >= limit) out.push({ node: {}, depth: 0, truncated: true });
  return out;
}

export function nodeLabel(node: UiNode): string {
  const text = (node.text || node.desc || node.id || shortType(node.type) || node.path || "").trim();
  return text || "(无名称)";
}

function shortType(type: string | undefined): string {
  if (!type) return "";
  const i = type.lastIndexOf(".");
  return i >= 0 ? type.slice(i + 1) : type;
}

/** Python string literal. Single-quoted, with backslash escapes. */
export function pyStr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n")}'`;
}

/** XPath string literal. Uses concat() when the text contains both quote styles. */
export function xpathStr(value: string): string {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  const parts = value.split('"').map((part) => `"${part}"`);
  return `concat(${parts.join(`, '"', `)})`;
}

type Field = "id" | "text" | "desc" | "type" | "path";

/** Clocks and timers rewrite their own text every second or minute, so a selector on it stops matching. */
export function volatileText(node: Pick<UiNode, "id" | "type">): boolean {
  return /:id\/clock$/.test(node.id ?? "") || /(^|\.)(TextClock|Chronometer)$/.test(node.type ?? "");
}

/** Fields the Selector / XPath filters on, in the order they are tried. A field is added only while the earlier ones
 *  still match other nodes of `roots` (every row of a settings list shares one resource id, for example), so the code
 *  finds the picked node rather than the first look-alike. Without `roots` the first field is enough; when none is
 *  unique the node's path pins it. Text and desc of a clock (volatileText) are never used. Same rule as the Web IDE node tool (android/app/src/main/assets/tools/editor-nodes.js). */
export function selectorFields(node: UiNode, roots?: UiNode[]): Field[] {
  const all: UiNode[] = [];
  const walk = (n: UiNode) => { all.push(n); (n.children ?? []).forEach(walk); };
  (roots ?? []).forEach(walk);
  const same = (fields: Field[]) =>
    all.filter((x) => fields.every((f) => (x[f] ?? "") === (node[f] ?? "")) && (!node.clickable || x.clickable)).length;
  const fields: Field[] = [];
  for (const f of ["id", "text", "desc"] as const) {
    if (!node[f] || (f !== "id" && volatileText(node))) continue;
    fields.push(f);
    if (!roots || same(fields) <= 1) return fields;
  }
  if (!fields.length && node.type) fields.push("type");
  if (node.path) fields.push("path");
  return fields;
}

/** Comment for code that only the node's path can pin (no unique id / text / desc): it breaks when the layout moves.
 *  Same text as the Web IDE node tool. */
export const FRAGILE_NOTE = "# 没有唯一的 id、文字或描述，只能靠路径定位：界面变了可能找不到\n";

/** True when the selector needs the node's path, i.e. it is tied to the current layout. */
export function selectorFragile(node: UiNode, roots?: UiNode[]): boolean {
  return selectorFields(node, roots).includes("path");
}

/** A Selector() chain: resource id, text, content-desc as needed to be unique in `roots`, else class + path. */
export function selectorCode(node: UiNode, roots?: UiNode[]): string {
  const note = selectorFragile(node, roots) ? FRAGILE_NOTE : "";
  return `from xscript.android import node\n${note}${selectorChain(node, "node", roots)}.find(timeout=5)`;
}

/** `<module>.Selector()…` without the find, so callers pick the module alias and timeout. */
export function selectorChain(node: UiNode, module: string, roots?: UiNode[]): string {
  const calls = selectorFields(node, roots).map((f) => `.${f}(${pyStr(node[f] ?? "")})`);
  if (node.clickable) calls.push(".clickable()");
  const chain = calls.length ? calls.join("") : `.path(${pyStr(node.path || "0")})`;
  return `${module}.Selector()${chain}`;
}

/** One XPath that points at this node: resource-id, text, content-desc as needed to be unique in `roots`, else path. */
export function nodeXPath(node: UiNode, roots?: UiNode[]): string {
  const cls = shortType(node.type) || "*";
  const fields = selectorFields(node, roots).filter((f) => f !== "type");
  if (!fields.length) return `//${cls}`;
  const attr: Record<string, string> = { id: "resource-id", text: "text", desc: "content-desc", path: "path" };
  const tag = fields[0] === "id" || fields[0] === "path" ? "*" : cls;
  return `//${tag}` + fields.map((f) => `[@${attr[f]}=${xpathStr(node[f] ?? "")}]`).join("");
}

/** Percent box over the displayed frame. `screen` is the tree's width/height (device pixels). */
export function rectPercent(rect: UiRect, screen: Size): { left: string; top: string; width: string; height: string } | null {
  if (!(screen.w > 0) || !(screen.h > 0)) return null;
  return {
    left: `${(rect.l / screen.w) * 100}%`,
    top: `${(rect.t / screen.h) * 100}%`,
    width: `${((rect.r - rect.l) / screen.w) * 100}%`,
    height: `${((rect.b - rect.t) / screen.h) * 100}%`,
  };
}
