// Sync helpers: .syncignore rules, incremental upload planning and pulling a project from the device.
// Free of `vscode` so it runs under node --test. The rules file lives where AScript's extension keeps it:
// <project>/.vscode/.syncignore.
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { DeviceClient, RemoteFile, UploadFile } from "./client";

export const SYNCIGNORE_PATH = path.join(".vscode", ".syncignore");

export const DEFAULT_SYNCIGNORE = `# XScript sync rules (gitignore style): files matching a line are neither uploaded nor compared.
# '*' and '?' match inside one path segment, '**' crosses folders, a trailing '/' matches folders only,
# a leading '/' (or a '/' in the middle) anchors the rule to the project root, '!' re-includes.
# Dot files and folders, __pycache__, .pyc files and virtual environments are always skipped.
*.log
*.bak
*.tmp
dist/
build/
`;

interface Rule {
  re: RegExp;
  dirOnly: boolean;
  negate: boolean;
}

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** gitignore-lite matcher; the last matching rule wins. */
export class IgnoreRules {
  private rules: Rule[] = [];

  constructor(text = "") {
    for (let line of text.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      let negate = false;
      if (line.startsWith("!")) {
        negate = true;
        line = line.slice(1);
      }
      const dirOnly = line.endsWith("/");
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.startsWith("/") || line.includes("/");
      line = line.replace(/^\//, "");
      if (!line) continue;
      const body = globToRegex(line);
      this.rules.push({ re: new RegExp(anchored ? "^" + body + "$" : "(?:^|/)" + body + "$"), dirOnly, negate });
    }
  }

  get size(): number {
    return this.rules.length;
  }

  /** `rel` is "/"-separated and relative to the project root. */
  ignores(rel: string, isDir: boolean): boolean {
    let ignored = false;
    for (const r of this.rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(rel)) ignored = !r.negate;
    }
    return ignored;
  }
}

export function loadIgnoreRules(root: string): IgnoreRules {
  try {
    return new IgnoreRules(fs.readFileSync(path.join(root, SYNCIGNORE_PATH), "utf-8"));
  } catch {
    return new IgnoreRules();
  }
}

// ---------------------------------------------------------------- incremental upload

export function fileBytes(f: UploadFile): Buffer {
  return f.encoding === "base64" ? Buffer.from(f.content, "base64") : Buffer.from(f.content, "utf-8");
}

export function sha1(data: Buffer): string {
  return crypto.createHash("sha1").update(data).digest("hex");
}

/** path -> sha1 of what was last uploaded to one device/project. */
export type SyncCache = Record<string, string>;

export interface UploadPlan {
  upload: UploadFile[];
  skipped: number;
  /** The cache to store after a successful upload (hashes of every local file). */
  hashes: SyncCache;
}

/**
 * A file is skipped only when the device has it with the same size AND its content hash is the one we uploaded
 * last time. Files the device changed to a different size, or that were never uploaded from here, are sent again.
 */
export function planUpload(files: UploadFile[], remote: RemoteFile[] | undefined, cache: SyncCache): UploadPlan {
  const remoteSize = new Map((remote ?? []).map((f) => [f.path, f.size]));
  const hashes: SyncCache = {};
  const upload: UploadFile[] = [];
  let skipped = 0;
  for (const f of files) {
    const data = fileBytes(f);
    const h = sha1(data);
    hashes[f.path] = h;
    if (remote && remoteSize.get(f.path) === data.length && cache[f.path] === h) skipped++;
    else upload.push(f);
  }
  return { upload, skipped, hashes };
}

/** The device refuses to delete a project's entry. */
const PROTECTED = new Set(["__init__.py", "__init__.pyc"]);

/**
 * Device files an upload with `xscript.syncDeletes` would delete: on the device, not in `local`, and managed by uploads
 * (`synced`, e.g. not matched by .syncignore). Sorted. No device list (`remote` undefined) deletes nothing.
 */
export function planDeletes(local: Iterable<string>, remote: RemoteFile[] | undefined, synced: (rel: string) => boolean): string[] {
  if (!remote) return [];
  const have = new Set(local);
  const out = new Set<string>();
  for (const f of remote) if (!have.has(f.path) && !PROTECTED.has(f.path) && synced(f.path)) out.add(f.path);
  return [...out].sort();
}

/** The file list for the confirmation: at most `max` lines, then "… and N more". */
export function describeDeletes(paths: string[], max = 30): string {
  const lines = paths.slice(0, max);
  if (paths.length > max) lines.push("… and " + (paths.length - max) + " more");
  return lines.join("\n");
}

// ---------------------------------------------------------------- pull

export interface PulledFile {
  path: string;
  data: Buffer;
}

export function safeRelative(rel: string): boolean {
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) return false;
  return rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export async function fetchProject(client: DeviceClient, project: string, onFile?: (p: string) => void): Promise<PulledFile[]> {
  const list = await client.projectFiles(project);
  if (!list) throw new Error("project " + project + " does not exist on the device");
  const out: PulledFile[] = [];
  for (const f of list) {
    if (!safeRelative(f.path)) continue;
    onFile?.(f.path);
    out.push({ path: f.path, data: await client.readFileRaw(project, f.path) });
  }
  return out;
}

export interface PullDiff {
  added: string[];
  changed: string[];
  unchanged: string[];
}

export function diffAgainstLocal(root: string, pulled: PulledFile[]): PullDiff {
  const d: PullDiff = { added: [], changed: [], unchanged: [] };
  for (const f of pulled) {
    const full = path.join(root, ...f.path.split("/"));
    if (!fs.existsSync(full)) d.added.push(f.path);
    else if (Buffer.compare(fs.readFileSync(full), f.data) === 0) d.unchanged.push(f.path);
    else d.changed.push(f.path);
  }
  return d;
}

/** Writes only files that are new or different; local files the device does not have are left alone. */
export function writePulled(root: string, pulled: PulledFile[], diff = diffAgainstLocal(root, pulled)): number {
  const todo = new Set([...diff.added, ...diff.changed]);
  let n = 0;
  for (const f of pulled) {
    if (!todo.has(f.path)) continue;
    const full = path.join(root, ...f.path.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.data);
    n++;
  }
  return n;
}
