import { entryStub, type DeployFile } from "./deploy";
import { parse, type FlowGraph } from "./dsl";
import type { FlowLayout } from "./layout";
import type { FlowSourceMap } from "./map";

/**
 * A flow bundle: the files of a flow's device project (what `deployPlan` lays out) in one portable JSON text, so a
 * flow built on this desktop can be saved, carried to another desktop and pushed to any paired device to run or debug
 * (docs/plans/flow-blueprint-packaging.md, B.1). The bundle carries the traced build and its source map, so a
 * traceback on the other device still points back at a node. Reading a bundle is strict: only the paths `deployPlan`
 * writes, the exact entry stub, a flow text that parses and names the project, and per-file sizes and checksums.
 */
export const BUNDLE_FORMAT = "xscript-flow-bundle";
export const BUNDLE_VERSION = 1;
export const BUNDLE_EXT = ".xflowpkg";
/** Upper bound on the summed file sizes of one bundle (UTF-8 bytes). A flow project is a few hundred KB at most. */
export const BUNDLE_MAX_BYTES = 8 * 1024 * 1024;

const PROJECT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface BundleFile extends DeployFile {
  /** UTF-8 length of `content`. */
  size: number;
  /** FNV-1a 32-bit of the UTF-8 bytes, 8 lowercase hex digits. Catches truncation and accidental edits, not tampering. */
  fnv1a: string;
}

export interface FlowBundle {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  project: string;
  /** ISO 8601 time the bundle was made. */
  createdAt: string;
  /** Desktop version that made it, when known. */
  app?: string;
  files: BundleFile[];
}

export interface BundleMeta {
  createdAt: string;
  app?: string;
}

export type BundleProblem = "json" | "format" | "version" | "name" | "files" | "path" | "duplicate" | "size" | "checksum" | "missing" | "entry" | "flow" | "map" | "layout";

export interface OpenedBundle {
  bundle: FlowBundle;
  /** Ready for `pushPlan`. */
  plan: { project: string; files: DeployFile[]; map: FlowSourceMap };
  graph: FlowGraph;
  layout: FlowLayout | null;
}

export type BundleRead = ({ ok: true } & OpenedBundle) | { ok: false; reason: BundleProblem; detail: string };

const encoder = new TextEncoder();

export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function bundleFileName(project: string): string {
  return project + BUNDLE_EXT;
}

/** The fixed project layout of a flow named `project` (see `deployPlan`). */
function bundlePaths(project: string) {
  const flow = "flows/" + project;
  return { build: flow + ".py", text: flow + ".xflow", map: flow + ".xflow.map.json", layout: flow + ".xflow.layout.json", pkg: "flows/__init__.py", entry: "__init__.py" };
}

/** Wrap a deploy plan (from `deployPlan`) into a bundle. */
export function packBundle(plan: { project: string; files: readonly DeployFile[] }, meta: BundleMeta): FlowBundle {
  const files = plan.files.map((file) => ({ path: file.path, content: file.content, size: encoder.encode(file.content).length, fnv1a: fnv1a32(file.content) }));
  const bundle: FlowBundle = { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, project: plan.project, createdAt: meta.createdAt, files };
  if (meta.app) bundle.app = meta.app;
  return bundle;
}

export function bundleText(bundle: FlowBundle): string {
  return JSON.stringify(bundle, null, 2) + "\n";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const fail = (reason: BundleProblem, detail: string): BundleRead => ({ ok: false, reason, detail });

/** Parse and check a bundle text. Never throws: a bad bundle comes back as `{ ok: false, reason, detail }`. */
export function readBundle(text: string): BundleRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return fail("json", err instanceof Error ? err.message : String(err));
  }
  if (!isRecord(raw) || raw.format !== BUNDLE_FORMAT) return fail("format", isRecord(raw) ? String(raw.format) : typeof raw);
  if (raw.version !== BUNDLE_VERSION) return fail("version", String(raw.version));
  const project = raw.project;
  if (typeof project !== "string" || !PROJECT_NAME.test(project)) return fail("name", String(project));
  if (typeof raw.createdAt !== "string") return fail("format", "createdAt");
  if (raw.app !== undefined && typeof raw.app !== "string") return fail("format", "app");
  if (!Array.isArray(raw.files)) return fail("files", typeof raw.files);

  const paths = bundlePaths(project);
  const allowed = new Set(Object.values(paths));
  const byPath = new Map<string, string>();
  const files: BundleFile[] = [];
  let total = 0;
  for (const item of raw.files as unknown[]) {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.content !== "string" || typeof item.size !== "number" || typeof item.fnv1a !== "string") return fail("files", JSON.stringify(item)?.slice(0, 80) ?? "");
    const { path, content } = item;
    if (!allowed.has(path)) return fail("path", path);
    if (byPath.has(path)) return fail("duplicate", path);
    const size = encoder.encode(content).length;
    total += size;
    if (total > BUNDLE_MAX_BYTES) return fail("size", String(total));
    if (size !== item.size || fnv1a32(content) !== item.fnv1a) return fail("checksum", path);
    byPath.set(path, content);
    files.push({ path, content, size, fnv1a: item.fnv1a });
  }
  for (const need of [paths.pkg, paths.build, paths.text, paths.map, paths.entry]) if (!byPath.has(need)) return fail("missing", need);
  if (byPath.get(paths.entry) !== entryStub(project)) return fail("entry", paths.entry);

  let graph: FlowGraph;
  try {
    graph = parse(byPath.get(paths.text) ?? "");
  } catch (err) {
    return fail("flow", err instanceof Error ? err.message : String(err));
  }
  if (graph.name !== project) return fail("flow", graph.name);

  let map: FlowSourceMap;
  try {
    const parsed: unknown = JSON.parse(byPath.get(paths.map) ?? "");
    if (!isRecord(parsed) || parsed.version !== 1 || parsed.file !== paths.build || !isRecord(parsed.lines) || !isRecord(parsed.nodes)) return fail("map", paths.map);
    map = parsed as unknown as FlowSourceMap;
  } catch {
    return fail("map", paths.map);
  }

  let layout: FlowLayout | null = null;
  const layoutText = byPath.get(paths.layout);
  if (layoutText !== undefined) {
    try {
      const parsed: unknown = JSON.parse(layoutText);
      if (!isRecord(parsed) || parsed.xflowLayout !== 1 || !isRecord(parsed.nodes)) return fail("layout", paths.layout);
      layout = parsed as unknown as FlowLayout;
    } catch {
      return fail("layout", paths.layout);
    }
  }

  const bundle: FlowBundle = { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, project, createdAt: raw.createdAt, files };
  if (typeof raw.app === "string") bundle.app = raw.app;
  return { ok: true, bundle, plan: { project, files: files.map(({ path, content }) => ({ path, content })), map }, graph, layout };
}
