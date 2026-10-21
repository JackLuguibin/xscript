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

/**
 * Device folders that `gone` leaves without files: every device file under them is being deleted and no local
 * file lives under them (a file uploaded a moment ago is not in the pre-upload `remote` list). Only the topmost
 * such folders, sorted. __pycache__ and .pyc leftovers do not count as content; the folders are removed with
 * DELETE ?recursive=1, which takes those leftovers too.
 */
export function planEmptiedFolders(local: Iterable<string>, remote: RemoteFile[] | undefined, gone: string[]): string[] {
  if (!remote || !gone.length) return [];
  const deleting = new Set(gone);
  const dirsOf = (p: string) => {
    const parts = p.split("/");
    const out: string[] = [];
    for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
    return out;
  };
  const keep = new Set<string>();
  // Compiled leftovers do not keep a folder alive; anything else (.syncignore'd data, dot files) does.
  const generated = (p: string) => p.endsWith(".pyc") || p.split("/").includes("__pycache__");
  for (const f of remote) if (!deleting.has(f.path) && !generated(f.path)) for (const d of dirsOf(f.path)) keep.add(d);
  for (const p of local) for (const d of dirsOf(p)) keep.add(d);
  const cands = new Set<string>();
  for (const p of gone) for (const d of dirsOf(p)) if (!keep.has(d)) cands.add(d);
  return [...cands].filter((d) => !dirsOf(d).some((a) => cands.has(a))).sort();
}

export interface SyncPreview {
  /** Local files the device does not have. */
  added: string[];
  /** Local files the device has, but changed since the last upload from here (or never uploaded from here). */
  changed: string[];
  unchanged: number;
  /** With syncDeletes: device files the upload would delete (after the usual confirmation) and the folders they empty. */
  deletes: string[];
  folders: string[];
  /** Without syncDeletes: device-only files an upload leaves alone. */
  kept: string[];
}

/** What "Run" (incremental upload) would do, computed without sending or deleting anything. */
export function previewSync(files: UploadFile[], remote: RemoteFile[], cache: SyncCache, synced: (rel: string) => boolean, syncDeletes: boolean): SyncPreview {
  const plan = planUpload(files, remote, cache);
  const onDevice = new Set(remote.map((f) => f.path));
  const sent = plan.upload.map((f) => f.path).sort();
  const local = files.map((f) => f.path);
  const gone = planDeletes(local, remote, synced);
  return {
    added: sent.filter((p) => !onDevice.has(p)),
    changed: sent.filter((p) => onDevice.has(p)),
    unchanged: plan.skipped,
    deletes: syncDeletes ? gone : [],
    folders: syncDeletes ? planEmptiedFolders(local, remote, gone) : [],
    kept: syncDeletes ? [] : gone,
  };
}

/** Whether uploading would send or delete anything (the preview then offers to upload). */
export function previewHasWork(p: SyncPreview): boolean {
  return p.added.length + p.changed.length + p.deletes.length > 0;
}

/** The preview as text for the output channel. */
export function describePreview(name: string, p: SyncPreview, max = 30): string {
  const out = ["Preview of \"" + name + "\" (nothing was sent or deleted):"];
  const section = (title: string, paths: string[]) => {
    if (!paths.length) return;
    out.push("", title + " (" + paths.length + "):", ...describeDeletes(paths, max).split("\n").map((l) => "  " + l));
  };
  section("New on the device", p.added);
  section("Changed, would be sent again", p.changed);
  out.push("", "Unchanged, skipped: " + p.unchanged);
  section("Would be deleted on the device after you confirm (xscript.syncDeletes)", p.deletes);
  section("Folders those deletes leave empty, removed too", p.folders.map((d) => d + "/"));
  section("Only on the device, kept (turn on xscript.syncDeletes to delete them)", p.kept);
  if (!previewHasWork(p)) out.push("", "Everything is up to date.");
  out.push("", "Run uploads exactly this; Upload Project sends every file again.");
  return out.join("\n");
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
