// Basic checks for XScript projects, the same ones the Web IDE shows: undefined names (with "did you mean"),
// unknown attributes, wrong call arguments, import typos, async/await misuse, duplicate definitions, unused
// imports/variables and unreachable code. The implementation is shared with the Web IDE and lives in
// android/app/src/main/assets/tools/editor-{parse,symbols,docs}.js; `npm run compile` copies it to out/web-ide/
// (scripts/copy-lint.js). Free of `vscode` so it runs under node --test.
import * as fs from "fs";
import * as path from "path";

export interface Problem {
  /** 1-based line. */
  line: number;
  /** 0-based column. */
  col: number;
  length: number;
  message: string;
  /** "warning" for a likely bug; "unused" for code that can go (unused import/variable, unreachable). */
  severity: "warning" | "unused";
  /** Quick fixes (VS Code Ctrl/Cmd+.) built from the check's own data: the "是不是 …" rename and the missing import. */
  fixes?: Fix[];
}

/**
 * One quick fix: text edits as character offsets into the file text the check saw (`from`..`to` replaced by `text`),
 * or a place to jump to (1-based line, 0-based col).
 */
export interface Fix {
  title: string;
  edits?: { from: number; to: number; text: string }[];
  jump?: { line: number; col: number };
  preferred?: boolean;
}

interface RawProblem {
  line: number;
  col: number;
  length: number;
  message: string;
  severity: string;
  suggest?: string;
  fix?: string[];
  name?: string;
  kind?: string;
  stmtLine?: number;
  names?: number;
  edit?: { line: number; col: number; length: number; text: string; label: string };
  jump?: { line: number; col: number };
  dead?: { from: number; to: number };
}

interface Index {
  importLine(path: string): number;
  problemsIn(path: string): RawProblem[];
  unusedIn(path: string): RawProblem[];
  unreachableIn(path: string): RawProblem[];
}
interface Core {
  build(files: { path: string; content: string }[], docs: unknown): Index;
  removeImport(text: string, stmtLine: number, name: string, names: number): { from: number; to: number; text: string } | null;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const core: Core = require("./web-ide/editor-symbols.js").EditorSymbols;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const docs: unknown = require("./web-ide/editor-docs.js").XSDocs;

const SKIP_DIRS = new Set(["__pycache__", ".git", ".mypy_cache", ".pytest_cache", ".venv", "venv", ".idea", ".vscode", "node_modules"]);
const MAX_FILES = 2000;
const MAX_BYTES = 400000;

/**
 * Every .py file of the project at `root` as {path relative with "/", content}. `open` holds the unsaved text of
 * open editors (absolute path -> text) and wins over the disk.
 */
export function projectSources(root: string, open: Map<string, string> = new Map()): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_FILES || ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(full);
      } else if (ent.isFile() && ent.name.endsWith(".py")) {
        let content = open.get(full);
        if (content === undefined) {
          if (fs.statSync(full).size > MAX_BYTES) continue;
          content = fs.readFileSync(full, "utf8");
        }
        out.push({ path: path.relative(root, full).split(path.sep).join("/"), content });
      }
    }
  };
  walk(root);
  return out;
}

/**
 * The Web IDE's hints name its own Ctrl+. quick fixes. When VS Code offers the same fix (`hasFix`),
 * those keep the hint as "Ctrl/Cmd+."; the others (delete an unused import, …) are dropped:
 * "（Ctrl+. 从 m 导入）" -> "（可以从 m 导入）", "（Ctrl+. 删除）" -> "".
 */
export function plainMessage(message: string, hasFix = false): string {
  if (hasFix) return message.replace(/Ctrl\+\./g, "Ctrl/Cmd+.");
  return message
    .replace(/Ctrl\+\. 从 /g, "可以从 ")
    .replace(/[；;]?\s*Ctrl\+\.[^）)]*/g, "")
    .replace(/（\s*）|\(\s*\)/g, "")
    .trim();
}

/** Problems of `file` (project-relative, "/") in `files`, as the Web IDE lists them: a dead line hides its unused marks. */
export function lintFile(files: { path: string; content: string }[], file: string): Problem[] {
  const index = core.build(files, docs);
  const dead = index.unreachableIn(file);
  const deadLines = new Set(dead.map((d) => d.line));
  const text = files.find((f) => f.path === file)?.content ?? "";
  return index
    .problemsIn(file)
    .concat(index.unusedIn(file).filter((u) => !deadLines.has(u.line)), dead)
    .map((p) => {
      const fixes = fixesOf(p, text, () => index.importLine(file));
      const out: Problem = { line: p.line, col: p.col, length: Math.max(1, p.length), message: plainMessage(p.message, fixes.length > 0), severity: p.severity === "unused" ? "unused" : "warning" };
      if (fixes.length) out.fixes = fixes;
      return out;
    });
}

/** Offset of (1-based line, 0-based col) in `lines` (clamped to the text). */
function offsetOf(lines: string[], line: number, col: number): number {
  let at = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) at += lines[i].length + 1;
  return at + col;
}

/**
 * The Web IDE's Ctrl+. actions for one problem: the "是不是 …" rename, `from m import name` for each module that
 * defines a missing name, the check's own edit (fill in missing arguments, drop an unused variable), deleting an
 * unused import or unreachable lines, and jumping to the earlier duplicate definition.
 */
function fixesOf(p: RawProblem, text: string, importLine: () => number): Fix[] {
  const lines = text.split("\n");
  const total = text.length;
  const at = (line: number, col: number) => Math.min(total, offsetOf(lines, line, col));
  if (p.kind === "import" && p.name && p.stmtLine) {
    const r = core.removeImport(text, p.stmtLine, p.name, p.names ?? 1);
    return r ? [{ title: "删除未使用的 import " + p.name, edits: [r], preferred: true }] : [];
  }
  if (p.edit) {
    const from = at(p.edit.line, p.edit.col);
    return [{ title: p.edit.label, edits: [{ from, to: Math.min(total, from + p.edit.length), text: p.edit.text }], preferred: true }];
  }
  if (p.dead) {
    // whole lines from the first to the last dead line, with their line breaks (the last line takes the one before it)
    const { from, to } = p.dead;
    const n = to - from + 1;
    const title = "删除 " + n + " 行执行不到的代码";
    if (to >= lines.length && from > 1) return [{ title, edits: [{ from: at(from - 1, lines[from - 2].length), to: total, text: "" }] }];
    return [{ title, edits: [{ from: at(from, 0), to: Math.min(total, at(to + 1, 0)), text: "" }] }];
  }
  if (p.jump) return [{ title: "跳到第 " + p.jump.line + " 行的定义", jump: p.jump }];
  if (p.severity === "unused") return [];
  if (p.suggest) {
    const from = at(p.line, p.col);
    return [{ title: "改为 " + p.suggest, edits: [{ from, to: from + p.length, text: p.suggest }], preferred: true }];
  }
  if (!p.fix?.length || !p.name) return [];
  let line = importLine(), lead = "";
  if (line > lines.length) {
    // the file ends without a newline: append after its last line
    line = lines.length + 1;
    lead = "\n";
  }
  const from = at(line, 0);
  return p.fix.map((m) => ({ title: "从 " + m + " 导入 " + p.name, edits: [{ from, to: from, text: lead + "from " + m + " import " + p.name + "\n" }], preferred: p.fix!.length === 1 }));
}
