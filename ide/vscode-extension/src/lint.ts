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
}

interface Index {
  problemsIn(path: string): Problem[];
  unusedIn(path: string): Problem[];
  unreachableIn(path: string): Problem[];
}
interface Core {
  build(files: { path: string; content: string }[], docs: unknown): Index;
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
 * The Web IDE's hints name its own Ctrl+. quick fixes, which VS Code does not have:
 * "（是不是 x？Ctrl+. 改正）" -> "（是不是 x？）", "（Ctrl+. 从 m 导入）" -> "（可以从 m 导入）", "（Ctrl+. 删除）" -> "".
 */
export function plainMessage(message: string): string {
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
  return index
    .problemsIn(file)
    .concat(index.unusedIn(file).filter((u) => !deadLines.has(u.line)), dead)
    .map((p) => ({ line: p.line, col: p.col, length: Math.max(1, p.length), message: plainMessage(p.message), severity: p.severity === "unused" ? "unused" : "warning" }));
}
