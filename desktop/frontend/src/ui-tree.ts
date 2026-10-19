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

/** A Selector() chain. Resource id, then text, then content-desc, then class + path. */
export function selectorCode(node: UiNode): string {
  return `from xscript.android import node\n${selectorChain(node, "node")}.find(timeout=5)`;
}

/** `<module>.Selector()…` without the find, so callers pick the module alias and timeout. */
export function selectorChain(node: UiNode, module: string): string {
  const calls: string[] = [];
  if (node.id) calls.push(`.id(${pyStr(node.id)})`);
  else if (node.text) calls.push(`.text(${pyStr(node.text)})`);
  else if (node.desc) calls.push(`.desc(${pyStr(node.desc)})`);
  else {
    if (node.type) calls.push(`.type(${pyStr(node.type)})`);
    if (node.path) calls.push(`.path(${pyStr(node.path)})`);
  }
  if (node.clickable) calls.push(".clickable()");
  const chain = calls.length ? calls.join("") : `.path(${pyStr(node.path || "0")})`;
  return `${module}.Selector()${chain}`;
}

/** One XPath that points at this node. Prefer resource-id, then text, then content-desc. */
export function nodeXPath(node: UiNode): string {
  const cls = shortType(node.type) || "*";
  if (node.id) return `//*[@resource-id=${xpathStr(node.id)}]`;
  if (node.text) return `//${cls}[@text=${xpathStr(node.text)}]`;
  if (node.desc) return `//${cls}[@content-desc=${xpathStr(node.desc)}]`;
  if (node.path) return `//*[@path=${xpathStr(node.path)}]`;
  return `//${cls}`;
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
