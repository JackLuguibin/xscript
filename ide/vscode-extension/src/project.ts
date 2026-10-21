// Finding and reading a local XScript project. Kept free of `vscode` so it runs under node --test.
import * as fs from "fs";
import * as path from "path";
import type { UploadFile } from "./client";
import { IgnoreRules } from "./sync";

// Same rules as ide/mcp-server/xscript_mcp/client.py zip_directory.
const SKIP_DIRS = new Set([
  "__pycache__", ".git", ".mypy_cache", ".pytest_cache", ".venv", "venv", ".idea", ".vscode", "node_modules",
]);
const TEXT_EXT = new Set([".py", ".txt", ".json", ".md", ".html", ".js", ".css", ".yaml", ".yml", ".ini", ".cfg", ".csv", ".xml"]);

/** A project is a directory with an entry __init__.py, or with AScript's build.as (the device accepts both). */
export function isProjectDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, "__init__.py")) || fs.existsSync(path.join(dir, "build.as"));
}

/**
 * Walks up from `start` (a file or directory) and returns the topmost directory with an
 * __init__.py, without leaving `boundary`. Subpackages inside a project also have
 * __init__.py, so the topmost one is the project root.
 */
export function findProjectRoot(start: string, boundary?: string): string | undefined {
  let dir = fs.existsSync(start) && fs.statSync(start).isDirectory() ? start : path.dirname(start);
  const stop = boundary ? path.resolve(boundary) : path.parse(dir).root;
  let found: string | undefined;
  for (;;) {
    if (isProjectDir(dir)) found = dir;
    else if (found) break;
    if (path.resolve(dir) === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/**
 * Whether a device path is one an upload manages, i.e. collectFiles would pick it up if it existed here:
 * no dot names, no skipped folders, no .pyc/.pyo, not matched by .syncignore (nor any of its folders).
 */
export function isSyncedPath(rel: string, ignore: IgnoreRules): boolean {
  const segs = rel.split("/");
  if (segs.some((s) => s === "" || s.startsWith("."))) return false;
  for (let i = 0; i < segs.length - 1; i++) {
    if (SKIP_DIRS.has(segs[i]) || ignore.ignores(segs.slice(0, i + 1).join("/"), true)) return false;
  }
  return !/\.py[co]$/.test(segs[segs.length - 1]) && !ignore.ignores(rel, false);
}

export function collectFiles(root: string, ignore?: IgnoreRules): UploadFile[] {
  const out: UploadFile[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name) && !ignore?.ignores(rel, true)) walk(full);
        continue;
      }
      if (!ent.isFile() || /\.py[co]$/.test(ent.name) || ignore?.ignores(rel, false)) continue;
      const data = fs.readFileSync(full);
      if (TEXT_EXT.has(path.extname(ent.name).toLowerCase()) && isUtf8(data)) {
        out.push({ path: rel, content: data.toString("utf-8"), encoding: "utf-8" });
      } else {
        out.push({ path: rel, content: data.toString("base64"), encoding: "base64" });
      }
    }
  };
  walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function isUtf8(data: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}
