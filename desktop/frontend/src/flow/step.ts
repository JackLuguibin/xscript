import { fillStmt, pyIdent, type FlowGraph, type NodeSpec } from "./dsl";

/** Same cap as `POST /eval` (openapi EvalRequest.timeout_ms default). */
export const STEP_TIMEOUT_MS = 8000;

const REFUSED = new Set([
  "flow.branch",
  "flow.match",
  "flow.for_range",
  "flow.for_each",
  "flow.while",
  "flow.retry",
  "flow.try",
  "flow.sequence",
  "flow.parallel",
  "flow.wait_until",
  "flow.def",
  "flow.macro",
  "flow.call",
  "flow.end",
  "flow.merge",
]);

export type StepSnippet =
  | { ok: true; code: string; timeoutMs: number; where: "local" | "device" }
  | { ok: false; reason: "refused" | "missing" | "wired"; pin?: string };

function refused(type: string): boolean {
  return type.startsWith("event.") || REFUSED.has(type);
}

function needsDevice(code: string): boolean {
  return /\b(xscript|action|node|system)\b/.test(code);
}

function wrap(filled: string, id: string): string {
  const ident = pyIdent(id);
  if (filled.startsWith(ident + " =")) return filled + "\n_result = " + ident;
  if (/^(print|raise|import|from|def|if|for|while|try|with)\b/.test(filled) || filled.includes("\n")) {
    return filled + "\n_result = None";
  }
  return "_result = " + filled;
}

/** Build the `/eval` fragment for one node. A wired pin uses the variable-inspector cache when that source has a value. */
export function stepSnippet(
  graph: FlowGraph,
  id: string,
  specs: Map<string, NodeSpec>,
  cache?: Record<string, string>,
): StepSnippet {
  const node = graph.nodes.find((item) => item.id === id);
  if (!node || refused(node.type)) return { ok: false, reason: "refused" };
  const spec = specs.get(node.type);
  if (!spec?.py?.stmt) return { ok: false, reason: "refused" };
  const inputs = { ...(node.inputs ?? {}) };
  for (const pin of spec.inputs) {
    if (inputs[pin.name] !== undefined) continue;
    const edge = graph.edges.find((item) => item.to === id + "." + pin.name);
    const cached = edge ? cachedInput(edge.from, cache) : undefined;
    if (cached !== undefined) {
      inputs[pin.name] = cached;
      continue;
    }
    if (edge) return { ok: false, reason: "wired", pin: pin.name };
    if (pin.default !== undefined) {
      inputs[pin.name] = pin.default;
      continue;
    }
    return { ok: false, reason: "missing", pin: pin.name };
  }
  const trial = { ...node, inputs };
  const graphForFill: FlowGraph = {
    ...graph,
    nodes: graph.nodes.map((item) => (item.id === id ? trial : item)),
    edges: graph.edges.filter((edge) => !edge.to.startsWith(id + ".")),
  };
  const filled = fillStmt(spec.py.stmt, trial, graphForFill, undefined, specs);
  const code = wrap(filled, id);
  return { ok: true, code, timeoutMs: STEP_TIMEOUT_MS, where: needsDevice(code) ? "device" : "local" };
}

/**
 * The failed step of a recorded run that can be tried again on its own: a simple node (not control flow) still in the
 * graph whose inputs are literals, defaults or cached upstream values. Null when there is none.
 */
export function retryStep(
  run: { status: string; error_node: string },
  graph: FlowGraph,
  specs: Map<string, NodeSpec>,
  cache?: Record<string, string>,
): string | null {
  if (run.status !== "error" || !run.error_node) return null;
  return stepSnippet(graph, run.error_node, specs, cache).ok ? run.error_node : null;
}

function cachedInput(from: string, cache?: Record<string, string>): string | number | boolean | null | undefined {
  if (!cache) return undefined;
  const dot = from.indexOf(".");
  const id = from.slice(0, dot);
  const pin = from.slice(dot + 1);
  const raw = cache[id + "." + pin] ?? cache[id];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed === "None") return null;
  if (trimmed === "True") return true;
  if (trimmed === "False") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** Trace summaries fill the cache. Keys the user edited stay as they left them. */
export function rememberRuns(cache: Record<string, string>, edited: ReadonlySet<string>, runs: Record<string, string>): Record<string, string> {
  const next = { ...cache };
  for (const [id, value] of Object.entries(runs)) {
    if (!edited.has(id)) next[id] = value;
  }
  return next;
}

type Val = string | number | boolean | null;

/** Fold a literal `_result = ...` the same way Python would, for the preview. Unknown forms return null. */
export function literalPreview(code: string): string | null {
  const line = code.split("\n").find((item) => item.startsWith("_result = "));
  if (!line) return null;
  try {
    const parser = new Parser(line.slice("_result = ".length).trim());
    const value = parser.parseExpr();
    parser.end();
    return show(value);
  } catch {
    return null;
  }
}

function show(value: Val): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  return value;
}

class Parser {
  private i = 0;

  constructor(private readonly text: string) {}

  end(): void {
    if (this.i !== this.text.length) throw new Error("tail");
  }

  parseExpr(): Val {
    return this.parseOr();
  }

  private parseOr(): Val {
    let left = this.parseAnd();
    while (this.eatWord("or")) {
      const right = this.parseAnd();
      left = truthy(left) ? left : right;
    }
    return left;
  }

  private parseAnd(): Val {
    let left = this.parseNot();
    while (this.eatWord("and")) {
      const right = this.parseNot();
      left = truthy(left) ? right : left;
    }
    return left;
  }

  private parseNot(): Val {
    if (this.eatWord("not")) return !truthy(this.parseNot());
    return this.parseCmp();
  }

  private parseCmp(): Val {
    let left = this.parseAdd();
    const op = this.peekOp(["==", "!=", "<=", ">=", "<", ">"]);
    if (!op) return left;
    this.i += op.length;
    const right = this.parseAdd();
    if (typeof left === "number" && typeof right === "number") {
      if (op === "==") return left === right;
      if (op === "!=") return left !== right;
      if (op === "<") return left < right;
      if (op === ">") return left > right;
      if (op === "<=") return left <= right;
      return left >= right;
    }
    if (typeof left === "string" && typeof right === "string") {
      if (op === "==") return left === right;
      if (op === "!=") return left !== right;
      if (op === "<") return left < right;
      if (op === ">") return left > right;
      if (op === "<=") return left <= right;
      return left >= right;
    }
    throw new Error("cmp");
  }

  private parseAdd(): Val {
    let left = this.parseMul();
    for (;;) {
      const op = this.peekOp(["+", "-"]);
      if (!op) return left;
      this.i += 1;
      const right = this.parseMul();
      if (op === "+" && typeof left === "string" && typeof right === "string") left = left + right;
      else if (typeof left === "number" && typeof right === "number") left = op === "+" ? left + right : left - right;
      else throw new Error("add");
    }
  }

  private parseMul(): Val {
    let left = this.parseUnary();
    for (;;) {
      const op = this.peekOp(["*", "/", "%"]);
      if (!op) return left;
      this.i += 1;
      const right = this.parseUnary();
      if (typeof left !== "number" || typeof right !== "number") throw new Error("mul");
      if (op === "*") left = left * right;
      else if (op === "/") left = left / right;
      else left = left % right;
    }
  }

  private parseUnary(): Val {
    if (this.peekOp(["-"])) {
      this.i += 1;
      const value = this.parseUnary();
      if (typeof value !== "number") throw new Error("neg");
      return -value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Val {
    this.skip();
    if (this.text[this.i] === "(") {
      this.i += 1;
      const value = this.parseExpr();
      this.skip();
      if (this.text[this.i] !== ")") throw new Error("paren");
      this.i += 1;
      return value;
    }
    const start = this.i;
    const call = this.word();
    if (call && this.text[this.i] === "(") {
      this.i += 1;
      const args: Val[] = [];
      this.skip();
      if (this.text[this.i] !== ")") {
        args.push(this.parseExpr());
        while (this.text[this.i] === ",") {
          this.i += 1;
          args.push(this.parseExpr());
          this.skip();
        }
      }
      if (this.text[this.i] !== ")") throw new Error("call end");
      this.i += 1;
      return applyCall(call, args);
    }
    this.i = start;
    return this.atom();
  }

  private atom(): Val {
    this.skip();
    const word = this.word();
    if (word === "None") return null;
    if (word === "True") return true;
    if (word === "False") return false;
    if (word) throw new Error("name");
    if (this.text[this.i] === "'" || this.text[this.i] === '"') return this.string();
    const num = /^-?\d+(?:\.\d+)?/.exec(this.text.slice(this.i));
    if (!num) throw new Error("atom");
    this.i += num[0].length;
    return Number(num[0]);
  }

  private string(): string {
    const quote = this.text[this.i];
    this.i += 1;
    let out = "";
    while (this.i < this.text.length && this.text[this.i] !== quote) {
      if (this.text[this.i] === "\\") {
        const esc = this.text[this.i + 1];
        if (esc === "n") out += "\n";
        else if (esc === "r") out += "\r";
        else if (esc === "\\" || esc === "'" || esc === '"') out += esc;
        else throw new Error("esc");
        this.i += 2;
        continue;
      }
      out += this.text[this.i];
      this.i += 1;
    }
    if (this.text[this.i] !== quote) throw new Error("string");
    this.i += 1;
    return out;
  }

  private word(): string | null {
    this.skip();
    const hit = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.i));
    if (!hit) return null;
    this.i += hit[0].length;
    return hit[0];
  }

  private eatWord(word: string): boolean {
    this.skip();
    if (!this.text.startsWith(word, this.i)) return false;
    const after = this.text[this.i + word.length];
    if (after && /[A-Za-z0-9_]/.test(after)) return false;
    this.i += word.length;
    return true;
  }

  private peekOp(ops: string[]): string | null {
    this.skip();
    for (const op of ops) {
      if (this.text.startsWith(op, this.i)) return op;
    }
    return null;
  }

  private skip(): void {
    while (this.text[this.i] === " ") this.i += 1;
  }
}

function truthy(value: Val): boolean {
  if (value === null || value === false || value === "" || value === 0) return false;
  return true;
}

function applyCall(name: string, args: Val[]): Val {
  if (name === "str") {
    const value = args[0];
    if (value === null) return "None";
    if (value === true) return "True";
    if (value === false) return "False";
    return String(value);
  }
  if (name === "int") {
    const value = args[0];
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "number") return Math.trunc(value);
    if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
    throw new Error("int");
  }
  if (name === "float") {
    const value = args[0];
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
    throw new Error("float");
  }
  if (name === "bool") return truthy(args[0] ?? null);
  if (name === "len") {
    const value = args[0];
    if (typeof value === "string") return value.length;
    throw new Error("len");
  }
  if (name === "min" || name === "max") {
    const nums = args.filter((item): item is number => typeof item === "number");
    if (nums.length !== args.length || !nums.length) throw new Error(name);
    return name === "min" ? Math.min(...nums) : Math.max(...nums);
  }
  throw new Error("fn");
}
