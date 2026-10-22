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
function matcher(node: UiNode, roots?: UiNode[]): (fields: Field[]) => number {
  const all: UiNode[] = [];
  const walk = (n: UiNode) => { all.push(n); (n.children ?? []).forEach(walk); };
  (roots ?? []).forEach(walk);
  return (fields) =>
    all.filter((x) => fields.every((f) => (x[f] ?? "") === (node[f] ?? "")) && (!node.clickable || x.clickable)).length;
}

export function selectorFields(node: UiNode, roots?: UiNode[]): Field[] {
  const same = matcher(node, roots);
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

const FIELD_NAME: Record<Field, string> = { id: "id", text: "文字", desc: "描述", type: "类名", path: "路径" };

/** A Python comment saying why the selector has the fields it has, e.g. `# id 'android:id/title' 有 5 个控件，加文字
 *  'Battery' 还有 2 个，再加路径 '0/3' 才是这一个`. Shown in the code node a dropped control becomes. Empty without `roots`. */
export function selectorWhy(node: UiNode, roots?: UiNode[]): string {
  if (!roots) return "";
  const same = matcher(node, roots);
  const fields = selectorFields(node, roots);
  const named = (f: Field) => `${FIELD_NAME[f]} ${pyStr(node[f] ?? "")}`;
  const scope = node.clickable ? "可点击的控件" : "控件";
  if (fields.length === 1 && fields[0] !== "path") return `# ${named(fields[0])} 在界面上只有这一个${scope}`;
  const parts: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    if (f === "path") { parts.push(`${i ? "再加" : "按"}${named(f)} 才是这一个`); break; }
    if (f === "type") { parts.push(`没有 id、文字或描述，按${named(f)} 有 ${same(fields.slice(0, i + 1))} 个`); continue; }
    const n = same(fields.slice(0, i + 1));
    parts.push(i ? `加${named(f)} ${n > 1 ? `还有 ${n} 个` : "就只剩这一个"}` : `${named(f)} 有 ${n} 个${scope}`);
  }
  return "# " + parts.join("，");
}

/** A Selector() chain: resource id, text, content-desc as needed to be unique in `roots`, else class + path. */
export function selectorCode(node: UiNode, roots?: UiNode[]): string {
  return `from xscript.android import node\n${selectorChain(node, "node", roots)}.find(timeout=5)`;
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
