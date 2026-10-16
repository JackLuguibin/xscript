// Python completion over the ide/python-stubs data (generated: scripts/gen_stub_completions.py). Pure: no Monaco here,
// so it is unit-tested in jsdom; monaco.ts adapts the items to Monaco's CompletionItemProvider.

export interface StubMember {
  kind: "function" | "method" | "class" | "variable" | "ref";
  detail: string;
  doc: string;
  members?: Record<string, StubMember>;
}
export interface StubModule {
  doc: string;
  members: Record<string, StubMember>;
}
export interface StubData {
  modules: Record<string, StubModule>;
}

export type ItemKind = "module" | "function" | "method" | "class" | "variable";
export interface CompletionItem {
  label: string;
  kind: ItemKind;
  detail: string;
  doc: string;
  /** characters before the cursor that the item replaces */
  replace: number;
}

type Target = { module: string } | { cls: StubMember } | null;

export class StubIndex {
  constructor(private data: StubData) {}

  get moduleNames(): string[] {
    return Object.keys(this.data.modules).filter((m) => !m.split(".").some((p) => p.startsWith("_")));
  }

  /** dotted path → module or class */
  resolve(path: string, depth = 0): Target {
    if (depth > 8 || !path) return null;
    if (this.data.modules[path]) return { module: path };
    const i = path.lastIndexOf(".");
    if (i < 0) return null;
    const parent = this.resolve(path.slice(0, i), depth + 1);
    const name = path.slice(i + 1);
    if (!parent) return null;
    const m = "module" in parent ? this.data.modules[parent.module].members[name] : parent.cls.members?.[name];
    if (!m) return null;
    if (m.kind === "ref") return this.resolve(m.detail, depth + 1);
    if (m.kind === "class") return { cls: m };
    return null;
  }

  members(t: Target): Array<{ name: string; m: StubMember | null }> {
    if (!t) return [];
    if ("cls" in t) return Object.entries(t.cls.members ?? {}).map(([name, m]) => ({ name, m }));
    const out: Array<{ name: string; m: StubMember | null }> = Object.entries(this.data.modules[t.module].members).map(([name, m]) => ({ name, m }));
    const seen = new Set(out.map((x) => x.name));
    for (const mod of this.moduleNames) {
      if (mod.startsWith(t.module + ".")) {
        const sub = mod.slice(t.module.length + 1);
        if (!sub.includes(".") && !seen.has(sub)) out.push({ name: sub, m: null });
      }
    }
    return out;
  }

  /** the stub entry for a member (follows `ref`s) so the item shows the real signature */
  deref(m: StubMember, depth = 0): StubMember {
    if (m.kind !== "ref" || depth > 8) return m;
    const i = m.detail.lastIndexOf(".");
    const mod = this.data.modules[m.detail.slice(0, i)];
    const next = mod?.members[m.detail.slice(i + 1)];
    if (next) return this.deref(next, depth + 1);
    return this.data.modules[m.detail] ? { kind: "variable", detail: m.detail, doc: this.data.modules[m.detail].doc } : m;
  }
}

/** Names the document binds to stub modules/members: `import a.b as x`, `import a.b`, `from m import n as y`, `from m import *`. */
export function bindings(doc: string, index: StubIndex): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of doc.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    let m = /^import\s+(.+)$/.exec(line);
    if (m) {
      for (const part of m[1].split(",")) {
        const [mod, alias] = part.trim().split(/\s+as\s+/);
        if (!mod) continue;
        if (alias) out.set(alias.trim(), mod.trim());
        else out.set(mod.split(".")[0], mod.split(".")[0]);
      }
      continue;
    }
    m = /^from\s+([\w.]+)\s+import\s+\(?([^)]*)\)?$/.exec(line);
    if (m) {
      const mod = m[1];
      if (m[2].trim() === "*") {
        for (const { name } of index.members(index.resolve(mod))) out.set(name, `${mod}.${name}`);
        continue;
      }
      for (const part of m[2].split(",")) {
        const [name, alias] = part.trim().split(/\s+as\s+/);
        if (name) out.set((alias ?? name).trim(), `${mod}.${name.trim()}`);
      }
    }
  }
  return out;
}

function item(index: StubIndex, base: string, name: string, m: StubMember | null, replace: number): CompletionItem {
  if (!m) return { label: name, kind: "module", detail: `${base}.${name}`, doc: index.resolve(`${base}.${name}`) ? "" : "", replace };
  const r = index.deref(m);
  const kind: ItemKind = r.kind === "ref" ? "variable" : r.kind;
  return { label: name, kind, detail: r.detail, doc: r.doc, replace };
}

/** Completion items for the text of the current line up to the cursor, given the whole document. */
export function complete(index: StubIndex, doc: string, before: string): CompletionItem[] {
  let m = /^\s*(?:from|import)\s+([\w.]*)$/.exec(before);
  if (m) {
    const typed = m[1];
    return index.moduleNames.filter((n) => n.startsWith(typed)).map((n) => ({ label: n, kind: "module" as const, detail: n, doc: "", replace: typed.length }));
  }
  m = /^\s*from\s+([\w.]+)\s+import\s+(?:.*,\s*)?\(?\s*(\w*)$/.exec(before);
  if (m) {
    const base = m[1];
    const typed = m[2];
    return index.members(index.resolve(base)).filter((x) => x.name.startsWith(typed)).map((x) => item(index, base, x.name, x.m, typed.length));
  }
  m = /([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*)\.(\w*)$/.exec(before);
  if (m) {
    const [head, ...rest] = m[1].split(".");
    const bound = bindings(doc, index).get(head);
    if (!bound) return [];
    const base = [bound, ...rest].join(".");
    const typed = m[2];
    return index.members(index.resolve(base)).filter((x) => x.name.startsWith(typed)).map((x) => item(index, base, x.name, x.m, typed.length));
  }
  m = /(?:^|[^\w.])([A-Za-z_]\w*)$/.exec(before);
  if (m) {
    const typed = m[1];
    const out: CompletionItem[] = [];
    for (const [name, path] of bindings(doc, index)) {
      if (!name.startsWith(typed)) continue;
      const t = index.resolve(path);
      out.push({ label: name, kind: t && "cls" in t ? "class" : t ? "module" : "variable", detail: path, doc: "", replace: typed.length });
    }
    return out;
  }
  return [];
}
