// Executable spec for the flow DSL (§8.5, §8.8).
// Structured form: sequence, if, match, for, while, for-each, try, parallel, def/call, macro, let.
// A pure data node used once is inlined. A let, or several uses, becomes one local.
// A back edge or a join falls back to label/goto and a pc/while state machine.

export interface FlowNode {
  id: string;
  type: string;
  inputs?: Record<string, string | number | boolean | null>;
  config?: Record<string, string | number | boolean | null>;
  meta?: { comment?: string; disabled?: boolean; origin?: CodeOrigin };
}

export interface FlowEdge {
  from: string;
  to: string;
}

export interface FlowVariable {
  name: string;
  type: string;
  default?: string | number | boolean | null;
  doc?: string;
  category?: string;
  editable?: boolean;
}

export interface FlowEnv {
  name: string;
  secret?: boolean;
}

export interface CodeOrigin {
  nodes: FlowNode[];
  edges: FlowEdge[];
  entry: string | null;
  execOut: Array<{ from: string; pin: string; codePin: string }>;
  dataIn: Array<{ codePin: string; to: string; pin: string }>;
  dataOut: Array<{ codePin: string; from: string; pin: string }>;
}

export interface FlowGraph {
  xflow: 1;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  variables?: FlowVariable[];
  env?: FlowEnv[];
  params?: FlowVariable[];
}

export type Val =
  | { kind: "lit"; value: string | number | boolean | null }
  | { kind: "ref"; node: string; pin: string }
  | { kind: "name"; name: string }
  | { kind: "call"; alias: string; args: string };

const ALIAS_OF: Record<string, string> = {
  "action.app.open": "app.open",
  "flow.wait": "wait",
  "flow.wait_until": "until",
  "flow.retry": "retry",
  "flow.end": "end",
  "flow.merge": "merge",
  "node.find": "node.find",
  "action.click": "click",
  "debug.log": "log",
  "math.add": "add",
  "math.sub": "sub",
  "math.mul": "mul",
  "math.div": "div",
  "math.mod": "mod",
  "math.eq": "eq",
  "math.ne": "ne",
  "math.lt": "lt",
  "math.gt": "gt",
  "math.le": "le",
  "math.ge": "ge",
  "logic.and": "and",
  "logic.or": "or",
  "logic.not": "not",
  "string.concat": "concat",
  "string.format": "format",
  "string.slice": "slice",
  "string.contains": "contains",
  "string.replace": "replace",
  "string.split": "split",
  "string.regex": "regex",
  "string.len": "len",
  "math.floor": "floor",
  "math.random": "random",
  "math.clamp": "clamp",
  "list.at": "at",
  "list.push": "push",
  "list.drop": "drop",
  "list.sort": "sort",
  "list.filter": "filter",
  "list.map": "map",
  "dict.key": "key",
  "dict.put": "put",
  "json.parse": "parse",
  "json.dump": "dump",
  "time.now": "now",
  "time.format": "tformat",
  "time.diff": "elapsed",
  "math.float": "float",
  "math.int": "int",
  "math.str": "str",
  "math.bool": "bool",
  "code.python": "code",
  "data.get": "get",
  "data.set": "set",
  "data.must": "must",
  "data.default": "default",
};

const TYPE_OF: Record<string, string> = Object.fromEntries(Object.entries(ALIAS_OF).map(([type, alias]) => [alias, type]));

/** Generated nodes use their type id as the DSL alias. Builtin aliases stay in place. */
export function registerNodeAliases(rows: Iterable<{ type: string; dsl: { alias: string } }>): void {
  for (const row of rows) {
    if (!row?.type || !row.dsl?.alias || ALIAS_OF[row.type]) continue;
    ALIAS_OF[row.type] = row.dsl.alias;
    if (!TYPE_OF[row.dsl.alias]) TYPE_OF[row.dsl.alias] = row.type;
  }
}

interface Line {
  indent: number;
  text: string;
}

export function semanticKey(g: FlowGraph): string {
  const nodes = [...g.nodes]
    .map((n) => {
      const row: {
        id: string;
        type: string;
        inputs: Record<string, string | number | boolean | null>;
        comment?: string;
        disabled?: boolean;
        config?: FlowNode["config"];
      } = { id: n.id, type: n.type, inputs: n.inputs ?? {} };
      if (n.meta?.comment) row.comment = n.meta.comment;
      if (n.meta?.disabled) row.disabled = true;
      if (n.config && Object.keys(n.config).length) row.config = n.config;
      return row;
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edges = [...g.edges].map((e) => e.from + "->" + e.to).sort();
  const variables = [...(g.variables ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const env = [...(g.env ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const params = [...(g.params ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify({ name: g.name, nodes, edges, variables, env, params });
}

export function readLocals(node: FlowNode): FlowVariable[] {
  const raw = node.config?.locals;
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as FlowVariable[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function takeVarAttr(rest: string, key: string): { rest: string; value?: string } {
  const mark = " " + key + "=";
  const at = rest.lastIndexOf(mark);
  if (at < 0) return { rest };
  try {
    const value = JSON.parse(rest.slice(at + mark.length)) as unknown;
    if (typeof value !== "string") return { rest };
    return { rest: rest.slice(0, at), value };
  } catch {
    return { rest };
  }
}

function parseVarLine(line: string): FlowVariable | null {
  const head = /^var\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/.exec(line);
  if (!head) return null;
  let rest = line.slice(head[0].length);
  let editable = false;
  if (rest.endsWith(" editable")) {
    editable = true;
    rest = rest.slice(0, -" editable".length);
  }
  const category = takeVarAttr(rest, "category");
  rest = category.rest;
  const doc = takeVarAttr(rest, "doc");
  rest = doc.rest;
  const variable: FlowVariable = {
    name: head[1],
    type: head[2],
    default: JSON.parse(rest) as string | number | boolean | null,
  };
  if (doc.value) variable.doc = doc.value;
  if (category.value) variable.category = category.value;
  if (editable) variable.editable = true;
  return variable;
}

function printVar(v: FlowVariable): string {
  let line = "var " + v.name + ": " + v.type + " = " + jsonLit(v.default ?? null);
  if (v.doc) line += " doc=" + jsonLit(v.doc);
  if (v.category) line += " category=" + jsonLit(v.category);
  if (v.editable) line += " editable";
  return line;
}

export function parse(text: string): FlowGraph {
  const lines = text
    .replace(/\s+$/, "")
    .split("\n")
    .map((raw) => ({ indent: raw.match(/^ */)?.[0].length ?? 0, text: raw.trim() }))
    .filter((l) => l.text !== "");
  const head = /^flow\s+([A-Za-z_][A-Za-z0-9_]*)\s+#\s*xflow\s+1\s*$/.exec(lines[0]?.text ?? "");
  if (!head) throw new Error("flow header must be: flow name  # xflow 1");
  const state = { i: 1 };
  const variables: FlowVariable[] = [];
  const env: FlowEnv[] = [];
  const params: FlowVariable[] = [];
  const nodes: FlowNode[] = [{ id: "start", type: "event.start" }];
  const edges: FlowEdge[] = [];
  let auto = 1;
  const nextAuto = () => "n" + auto++;
  while (state.i < lines.length && lines[state.i].indent === 0 && splitTrailingComment(lines[state.i].text).code !== "on start:") {
    const line = splitTrailingComment(lines[state.i].text).code;
    state.i++;
    const variable = parseVarLine(line);
    if (variable) {
      variables.push(variable);
      continue;
    }
    const environment = /^env\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+secret)?\s*$/.exec(line);
    if (environment) {
      env.push({ name: environment[1], secret: line.endsWith(" secret") });
      continue;
    }
    const param = /^param\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (param) {
      params.push({ name: param[1], type: param[2], default: JSON.parse(param[3]) as string | number | boolean | null });
      continue;
    }
    const def = /^(def|macro)\s+([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)\s*(?:->\s*([A-Za-z_][A-Za-z0-9_]*))?\s*:\s*$/.exec(line);
    if (def) {
      const params = def[3].split(",").map((part) => part.trim()).filter(Boolean).join(", ");
      const config: NonNullable<FlowNode["config"]> = { params };
      if (def[4]) config.returns = def[4];
      nodes.push({ id: def[2], type: def[1] === "macro" ? "flow.macro" : "flow.def", config });
      block(lines, state, 2, { node: def[2], pin: "body" }, nodes, edges, nextAuto, [], def[2]);
      continue;
    }
    throw new Error("cannot parse: " + line);
  }
  if (splitTrailingComment(lines[state.i]?.text ?? "").code !== "on start:") throw new Error("missing on start:");
  state.i++;
  block(lines, state, 2, { node: "start", pin: "then" }, nodes, edges, nextAuto, [], null);
  if (state.i < lines.length && lines[state.i].indent === 0 && splitTrailingComment(lines[state.i].text).code === "floating:") {
    state.i++;
    block(lines, state, 2, null, nodes, edges, nextAuto, [], null);
  }
  if (state.i < lines.length) throw new Error("leftover line: " + lines[state.i].text);
  const graph: FlowGraph = { xflow: 1, name: head[1], nodes, edges };
  if (variables.length) graph.variables = variables;
  if (env.length) graph.env = env;
  if (params.length) graph.params = params;
  return graph;
}

function block(
  lines: Line[],
  state: { i: number },
  indent: number,
  pred: { node: string; pin: string } | null,
  nodes: FlowNode[],
  edges: FlowEdge[],
  nextAuto: () => string,
  loops: string[],
  defId: string | null,
): void {
  let cursor = pred;
  while (state.i < lines.length && lines[state.i].indent === indent) {
    const split = splitTrailingComment(lines[state.i].text);
    let line = split.code;
    const comment = split.comment;
    armOff = false;
    if (line.startsWith("off ")) {
      armOff = true;
      line = line.slice(4);
    }
    if (line === "else:" || line === "floating:" || line === "branch:" || line.startsWith("except ")) break;
    state.i++;
    const local = /^local\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (local) {
      if (!defId) throw new Error("local is only valid inside a def");
      const owner = nodes.find((node) => node.id === defId);
      if (!owner) throw new Error("missing def " + defId);
      const list = readLocals(owner);
      list.push({ name: local[1], type: local[2], default: JSON.parse(local[3]) as string | number | boolean | null });
      owner.config = { ...(owner.config ?? {}), locals: JSON.stringify(list) };
      continue;
    }
    if (line === "break" || line === "continue") {
      const loop = loops[loops.length - 1];
      if (!loop || !cursor) throw new Error(line + " outside loop");
      edges.push({ from: cursor.node + "." + cursor.pin, to: loop + "." + line });
      cursor = null;
      continue;
    }
    if (line === "fail") {
      const retry = [...loops].reverse().find((loopId) => nodes.some((node) => node.id === loopId && node.type === "flow.retry"));
      if (!retry || !cursor) throw new Error("fail outside retry");
      edges.push({ from: cursor.node + "." + cursor.pin, to: retry + ".fail" });
      cursor = null;
      continue;
    }
    const gt = /^goto\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line);
    if (gt) {
      if (!cursor) throw new Error("goto without a source");
      edges.push({ from: cursor.node + "." + cursor.pin, to: gt[1] + ".exec" });
      cursor = null;
      continue;
    }
    const lab = /^label\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/.exec(line);
    if (lab) {
      const before = nodes.length;
      block(lines, state, indent + 2, null, nodes, edges, nextAuto, loops, defId);
      if (!nodes.slice(before).some((n) => n.id === lab[1])) throw new Error("label does not name its node: " + lab[1]);
      cursor = null;
      continue;
    }
    const fr = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+range\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)\s*:\s*$/.exec(line);
    if (fr) {
      const id = fr[1];
      nodes.push(noted({ id, type: "flow.for_range", inputs: { start: Number(fr[2]), end: Number(fr[3]) } }, comment));
      if (cursor) edges.push({ from: cursor.node + "." + cursor.pin, to: id + ".exec" });
      loops.push(id);
      block(lines, state, indent + 2, { node: id, pin: "body" }, nodes, edges, nextAuto, loops, defId);
      loops.pop();
      cursor = { node: id, pin: "completed" };
      continue;
    }
    const fe = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*:\s*$/.exec(line);
    if (fe) {
      const id = fe[1];
      const node: FlowNode = { id, type: "flow.for_each" };
      if (fe[3]) edges.push({ from: fe[2] + "." + fe[3], to: id + ".items" });
      else node.config = { items: fe[2] };
      nodes.push(noted(node, comment));
      if (cursor) edges.push({ from: cursor.node + "." + cursor.pin, to: id + ".exec" });
      loops.push(id);
      block(lines, state, indent + 2, { node: id, pin: "body" }, nodes, edges, nextAuto, loops, defId);
      loops.pop();
      cursor = { node: id, pin: "completed" };
      continue;
    }
    const wh = /^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?while\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s+max=\s*(\d+)\s*:\s*$/.exec(line);
    if (wh) {
      const id = wh[1] || nextAuto();
      nodes.push(noted({ id, type: "flow.while", inputs: { max: Number(wh[4]) } }, comment));
      if (cursor) edges.push({ from: cursor.node + "." + cursor.pin, to: id + ".exec" });
      edges.push({ from: wh[2] + "." + wh[3], to: id + ".cond" });
      loops.push(id);
      block(lines, state, indent + 2, { node: id, pin: "body" }, nodes, edges, nextAuto, loops, defId);
      loops.pop();
      cursor = { node: id, pin: "completed" };
      continue;
    }
    const until = /^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?until(?:\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*))?\s+timeout=(\d+)\s+interval=(\d+)\s*:\s*$/.exec(line);
    if (until) {
      const id = until[1] || nextAuto();
      nodes.push(noted({ id, type: "flow.wait_until", inputs: { timeout: Number(until[4]), interval: Number(until[5]) } }, comment));
      if (cursor) edges.push({ from: cursor.node + "." + cursor.pin, to: id + ".exec" });
      if (until[2] && until[3]) edges.push({ from: until[2] + "." + until[3], to: id + ".cond" });
      block(lines, state, indent + 2, { node: id, pin: "then" }, nodes, edges, nextAuto, loops, defId);
      if (state.i < lines.length && lines[state.i].indent === indent && splitTrailingComment(lines[state.i].text).code === "timeout:") {
        state.i++;
        block(lines, state, indent + 2, { node: id, pin: "timeout" }, nodes, edges, nextAuto, loops, defId);
      }
      cursor = null;
      continue;
    }
    const retry = /^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?retry\s+times=(\d+)\s*:\s*$/.exec(line);
    if (retry) {
      const id = retry[1] || nextAuto();
      nodes.push(noted({ id, type: "flow.retry", inputs: { times: Number(retry[2]) } }, comment));
      if (cursor) edges.push({ from: cursor.node + "." + cursor.pin, to: id + ".exec" });
      loops.push(id);
      block(lines, state, indent + 2, { node: id, pin: "body" }, nodes, edges, nextAuto, loops, defId);
      loops.pop();
      if (state.i < lines.length && lines[state.i].indent === indent && splitTrailingComment(lines[state.i].text).code === "ok:") {
        state.i++;
        block(lines, state, indent + 2, { node: id, pin: "ok" }, nodes, edges, nextAuto, loops, defId);
      }
      if (state.i < lines.length && lines[state.i].indent === indent && splitTrailingComment(lines[state.i].text).code === "failed:") {
        state.i++;
        block(lines, state, indent + 2, { node: id, pin: "failed" }, nodes, edges, nextAuto, loops, defId);
      }
      cursor = null;
      continue;
    }
    const tr = /^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?try\s*:\s*$/.exec(line);
    if (tr) {
      const id = tr[1] || nextAuto();
      const node = noted({ id, type: "flow.try" }, comment);
      nodes.push(node);
      if (cursor) edges.push({ from: cursor.node + "." + cursor.pin, to: id + ".exec" });
      block(lines, state, indent + 2, { node: id, pin: "body" }, nodes, edges, nextAuto, loops, defId);
      if (state.i >= lines.length || lines[state.i].indent !== indent) throw new Error("try without except");
      const ex = /^except\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/.exec(splitTrailingComment(lines[state.i].text).code);
      if (!ex) throw new Error("try without except");
      state.i++;
      node.config = { err: ex[1] };
      block(lines, state, indent + 2, { node: id, pin: "handler" }, nodes, edges, nextAuto, loops, defId);
      cursor = { node: id, pin: "completed" };
      continue;
    }
    const par = /^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?parallel\s*:\s*$/.exec(line);
    if (par) {
      const id = par[1] || nextAuto();
      nodes.push(noted({ id, type: "flow.parallel" }, comment));
      if (cursor) edges.push({ from: cursor.node + "." + cursor.pin, to: id + ".exec" });
      let n = 0;
      while (state.i < lines.length && lines[state.i].indent === indent + 2 && splitTrailingComment(lines[state.i].text).code === "branch:") {
        state.i++;
        block(lines, state, indent + 4, { node: id, pin: "b" + n }, nodes, edges, nextAuto, loops, defId);
        n++;
      }
      if (n === 0) throw new Error("parallel without a branch");
      cursor = { node: id, pin: "joined" };
      continue;
    }
    const seq = /^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?seq\s*:\s*$/.exec(line);
    if (seq) {
      const id = seq[1] || nextAuto();
      nodes.push(noted({ id, type: "flow.sequence" }, comment));
      if (cursor) edges.push({ from: cursor.node + "." + cursor.pin, to: id + ".exec" });
      let n = 0;
      while (state.i < lines.length && lines[state.i].indent === indent + 2 && splitTrailingComment(lines[state.i].text).code === "step:") {
        state.i++;
        block(lines, state, indent + 4, { node: id, pin: "s" + n }, nodes, edges, nextAuto, loops, defId);
        n++;
      }
      cursor = { node: id, pin: "next" };
      continue;
    }
    const iff = /^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?if\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/.exec(line);
    if (iff) {
      const id = iff[1] || nextAuto();
      nodes.push(noted({ id, type: "flow.branch" }, comment));
      if (cursor) edges.push({ from: cursor.node + "." + cursor.pin, to: id + ".exec" });
      edges.push({ from: iff[2] + "." + iff[3], to: id + ".cond" });
      block(lines, state, indent + 2, { node: id, pin: "then" }, nodes, edges, nextAuto, loops, defId);
      if (state.i < lines.length && lines[state.i].indent === indent && splitTrailingComment(lines[state.i].text).code === "else:") {
        state.i++;
        block(lines, state, indent + 2, { node: id, pin: "else" }, nodes, edges, nextAuto, loops, defId);
      }
      cursor = null;
      continue;
    }
    const ret = /^return\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (ret) {
      if (!defId) throw new Error("return outside def");
      const owner = nodes.find((n) => n.id === defId);
      const outName = String(owner?.config?.returns ?? "");
      if (!owner || ret[1] !== outName) throw new Error("return does not match -> " + outName);
      const raw = ret[2].trim();
      const pin = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw);
      const bare = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw);
      const params = String(owner.config?.params ?? "").split(",").map((part) => part.trim());
      if (pin) edges.push({ from: pin[1] + "." + pin[2], to: defId + "." + outName });
      else if (bare && params.includes(bare[1])) edges.push({ from: defId + "." + bare[1], to: defId + "." + outName });
      else owner.config = { ...owner.config, returnLit: JSON.parse(raw) as string | number | boolean | null };
      cursor = null;
      continue;
    }
    const sub = /^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?call\s+([A-Za-z_][A-Za-z0-9_]*)\((.*)\)\s*$/.exec(line);
    if (sub) {
      const id = sub[1] || nextAuto();
      const node: FlowNode = { id, type: "flow.call", config: { callee: sub[2] } };
      const inputs: Record<string, string | number | boolean | null> = {};
      for (const [key, val] of splitArgs(sub[3])) wireArg(nodes, edges, id, key, val, defId, inputs, nextAuto);
      if (Object.keys(inputs).length) node.inputs = inputs;
      nodes.push(noted(node, comment));
      if (cursor) edges.push({ from: cursor.node + "." + cursor.pin, to: id + ".exec" });
      cursor = { node: id, pin: "then" };
      continue;
    }
    const mh = /^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?match\s+([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*:\s*$/.exec(line);
    if (mh) {
      const id = mh[1] || nextAuto();
      const config: NonNullable<FlowNode["config"]> = {};
      if (mh[3]) edges.push({ from: mh[2] + "." + mh[3], to: id + ".value" });
      else config.subject = mh[2];
      const cases: Array<string | number> = [];
      nodes.push(noted({ id, type: "flow.match", config }, comment));
      if (cursor) edges.push({ from: cursor.node + "." + cursor.pin, to: id + ".exec" });
      let n = 0;
      while (state.i < lines.length && lines[state.i].indent === indent + 2) {
        const caseLine = splitTrailingComment(lines[state.i].text).code;
        const arm = /^((?:"(?:\\.|[^"\\])*")|-?\d+|_)\s*:\s*$/.exec(caseLine);
        if (!arm) break;
        state.i++;
        cases.push(arm[1] === "_" ? "_" : (JSON.parse(arm[1]) as string | number));
        block(lines, state, indent + 4, { node: id, pin: "c" + n }, nodes, edges, nextAuto, loops, defId);
        n++;
      }
      if (!cases.length) throw new Error("match without a case");
      config.cases = JSON.stringify(cases);
      cursor = { node: id, pin: "completed" };
      continue;
    }
    const lets = /^let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_.]*)\((.*)\)\s*$/.exec(line);
    if (lets) {
      const id = lets[1];
      const type = TYPE_OF[lets[2]];
      if (!type) throw new Error("unknown alias: " + lets[2]);
      const node: FlowNode = { id, type };
      const inputs: Record<string, string | number | boolean | null> = {};
      for (const [key, val] of splitArgs(lets[3])) wireArg(nodes, edges, id, key, val, defId, inputs, nextAuto);
      if (Object.keys(inputs).length) node.inputs = inputs;
      nodes.push(noted(node, comment));
      continue;
    }
    const endLine = /^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?end\s*$/.exec(line);
    if (endLine) {
      const id = endLine[1] || nextAuto();
      nodes.push(noted({ id, type: "flow.end" }, comment));
      if (cursor) edges.push({ from: cursor.node + "." + cursor.pin, to: id + ".exec" });
      cursor = null;
      continue;
    }
    const call = /^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?([A-Za-z_][A-Za-z0-9_.]*)\((.*)\)\s*$/.exec(line);
    if (!call) throw new Error("cannot parse: " + line);
    const id = call[1] || nextAuto();
    const type = TYPE_OF[call[2]];
    if (!type) throw new Error("unknown alias: " + call[2]);
    const inputs: Record<string, string | number | boolean | null> = {};
    for (const [key, val] of splitArgs(call[3])) wireArg(nodes, edges, id, key, val, defId, inputs, nextAuto);
    const node: FlowNode = { id, type };
    if (type === "code.python") {
      const config: NonNullable<FlowNode["config"]> = {};
      if (Object.prototype.hasOwnProperty.call(inputs, "source")) {
        config.source = String(inputs.source ?? "");
        delete inputs.source;
      }
      if (Object.prototype.hasOwnProperty.call(inputs, "inPins")) {
        config.inPins = String(inputs.inPins ?? "");
        delete inputs.inPins;
      }
      if (Object.prototype.hasOwnProperty.call(inputs, "outPins")) {
        config.outPins = String(inputs.outPins ?? "");
        delete inputs.outPins;
      }
      if (Object.keys(config).length) node.config = config;
    }
    if (Object.keys(inputs).length) node.inputs = inputs;
    nodes.push(noted(node, comment));
    if (cursor) edges.push({ from: cursor.node + "." + cursor.pin, to: id + ".exec" });
    cursor = { node: id, pin: "then" };
  }
}

let armOff = false;

function noted(node: FlowNode, comment?: string): FlowNode {
  const meta: NonNullable<FlowNode["meta"]> = { ...(node.meta ?? {}) };
  if (comment) meta.comment = comment;
  if (armOff) {
    meta.disabled = true;
    armOff = false;
  }
  if (Object.keys(meta).length) node.meta = meta;
  return node;
}

/** Skip or restore one node. The graph keeps its wires either way. */
export function setNodeDisabled(graph: FlowGraph, id: string, disabled: boolean): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.id !== id || node.type === "event.start") return node;
      const meta: NonNullable<FlowNode["meta"]> = { ...(node.meta ?? {}) };
      if (disabled) meta.disabled = true;
      else delete meta.disabled;
      const next = { ...node };
      if (Object.keys(meta).length) next.meta = meta;
      else delete next.meta;
      return next;
    }),
  };
}

function splitTrailingComment(text: string): { code: string; comment?: string } {
  let quote: string | null = null;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") {
      const code = text.slice(0, i).trim();
      const comment = text.slice(i + 1).trim();
      return comment ? { code, comment } : { code };
    }
  }
  return { code: text.trim() };
}

function splitArgs(body: string): Array<[string, Val]> {
  const args: Array<[string, Val]> = [];
  let cur = "";
  let quote: string | null = null;
  let esc = false;
  const push = () => {
    const part = cur.trim();
    cur = "";
    if (!part) return;
    const eq = part.indexOf("=");
    if (eq < 0) throw new Error("argument needs a name: " + part);
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    const ref = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw);
    const call = /^([A-Za-z_][A-Za-z0-9_.]*)\((.*)\)$/.exec(raw);
    const bare = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw);
    if (ref) args.push([name, { kind: "ref", node: ref[1], pin: ref[2] }]);
    else if (call && TYPE_OF[call[1]]) args.push([name, { kind: "call", alias: call[1], args: call[2] }]);
    else if (bare) args.push([name, { kind: "name", name: bare[1] }]);
    else args.push([name, { kind: "lit", value: JSON.parse(raw) as string | number | boolean | null }]);
  };
  let depth = 0;
  for (const ch of body) {
    if (quote) {
      cur += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) push();
    else cur += ch;
  }
  push();
  return args;
}

function nodeMap(g: FlowGraph): Map<string, FlowNode> {
  return new Map(g.nodes.map((n) => [n.id, n]));
}

function outEdge(g: FlowGraph, id: string, pin: string): { node: string; pin: string } | null {
  const hit = g.edges.find((e) => e.from === id + "." + pin);
  if (!hit) return null;
  const dot = hit.to.indexOf(".");
  return { node: hit.to.slice(0, dot), pin: hit.to.slice(dot + 1) };
}

function inEdge(g: FlowGraph, id: string, pin: string): { node: string; pin: string } | null {
  const hit = g.edges.find((e) => e.to === id + "." + pin);
  if (!hit) return null;
  const dot = hit.from.indexOf(".");
  return { node: hit.from.slice(0, dot), pin: hit.from.slice(dot + 1) };
}

function jsonLit(v: string | number | boolean | null): string {
  return JSON.stringify(v);
}

function argsOf(g: FlowGraph, id: string): Array<[string, Val]> {
  const node = nodeMap(g).get(id);
  const args: Array<[string, Val]> = [];
  for (const [key, value] of Object.entries(node?.inputs ?? {})) args.push([key, { kind: "lit", value }]);
  for (const e of g.edges) {
    if (!e.to.startsWith(id + ".")) continue;
    const pin = e.to.slice(id.length + 1);
    if (pin === "exec" || pin === "break" || pin === "continue" || pin === "fail" || pin === "cond") continue;
    const dot = e.from.indexOf(".");
    args.push([pin, { kind: "ref", node: e.from.slice(0, dot), pin: e.from.slice(dot + 1) }]);
  }
  args.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return args;
}

function wireArg(
  nodes: FlowNode[],
  edges: FlowEdge[],
  id: string,
  key: string,
  val: Val,
  defId: string | null,
  inputs: Record<string, string | number | boolean | null>,
  nextAuto: () => string,
): void {
  if (val.kind === "lit") {
    inputs[key] = val.value;
    return;
  }
  if (val.kind === "ref") {
    edges.push({ from: val.node + "." + val.pin, to: id + "." + key });
    return;
  }
  if (val.kind === "call") {
    const type = TYPE_OF[val.alias];
    if (!type) throw new Error("unknown alias: " + val.alias);
    const pureId = nextAuto();
    const node: FlowNode = { id: pureId, type };
    const childInputs: Record<string, string | number | boolean | null> = {};
    nodes.push(node);
    for (const [childKey, childVal] of splitArgs(val.args)) {
      wireArg(nodes, edges, pureId, childKey, childVal, defId, childInputs, nextAuto);
    }
    if (Object.keys(childInputs).length) node.inputs = childInputs;
    edges.push({ from: pureId + ".result", to: id + "." + key });
    return;
  }
  const owner = defId ? nodes.find((n) => n.id === defId) : undefined;
  const params = String(owner?.config?.params ?? "").split(",").map((part) => part.trim());
  if (defId && params.includes(val.name)) {
    edges.push({ from: defId + "." + val.name, to: id + "." + key });
    return;
  }
  const named = nodes.find((n) => n.id === val.name);
  if (!named) throw new Error("unknown name: " + val.name);
  edges.push({ from: named.id + ".result", to: id + "." + key });
}

function isPure(node: FlowNode): boolean {
  return node.type.startsWith("math.") || node.type.startsWith("logic.") || node.type.startsWith("string.") || node.type.startsWith("list.") || node.type.startsWith("dict.") || node.type.startsWith("json.") || node.type.startsWith("time.") || node.type === "data.get";
}

function shouldInline(g: FlowGraph, node: FlowNode): boolean {
  if (!isPure(node) || !/^n\d+$/.test(node.id)) return false;
  let uses = 0;
  for (const edge of g.edges) if (edge.from.startsWith(node.id + ".")) uses++;
  return uses === 1;
}

function formatPureCall(g: FlowGraph, node: FlowNode): string {
  const alias = ALIAS_OF[node.type];
  if (!alias) throw new Error("cannot print " + node.type);
  const body = argsOf(g, node.id).map(([key, val]) => key + "=" + formatVal(g, val)).join(", ");
  return alias + "(" + body + ")";
}

function formatVal(g: FlowGraph, val: Val): string {
  if (val.kind === "lit") return jsonLit(val.value);
  if (val.kind === "name") return val.name;
  if (val.kind === "call") return val.alias + "(" + val.args + ")";
  const src = nodeMap(g).get(val.node);
  if (src?.type === "flow.def" || src?.type === "flow.macro") return val.pin;
  if (src && isPure(src) && shouldInline(g, src)) return formatPureCall(g, src);
  if (val.pin === "result") return val.node;
  return val.node + "." + val.pin;
}

let printLabels: { mode: "export" | "edit"; n: number } = { mode: "export", n: 1 };

function labelPrefix(id: string): string {
  if (printLabels.mode === "edit" || id !== "n" + printLabels.n) return id + ": ";
  printLabels.n += 1;
  return "";
}

function formatCall(g: FlowGraph, id: string, alias: string, args: Array<[string, Val]>): string {
  const body = args.map(([key, val]) => key + "=" + formatVal(g, val)).join(", ");
  return labelPrefix(id) + alias + "(" + body + ")";
}

function formatSub(g: FlowGraph, node: FlowNode): string {
  const callee = String(node.config?.callee ?? "");
  const def = g.nodes.find((n) => n.id === callee && (n.type === "flow.def" || n.type === "flow.macro"));
  const params = String(def?.config?.params ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const byName = new Map(argsOf(g, node.id));
  const body = params.map((name) => {
    const val = byName.get(name);
    if (!val) throw new Error(node.id + " is missing " + name);
    return name + "=" + formatVal(g, val);
  }).join(", ");
  return labelPrefix(node.id) + "call " + callee + "(" + body + ")";
}

class Unstructured extends Error {}

export interface DslSync {
  text: string;
  graph: FlowGraph;
  fromCanvas(graph: FlowGraph): { text: string; applied: boolean };
  fromText(text: string): { graph: FlowGraph; applied: boolean; error?: string };
}

/** Edit-mode text and the graph stay aligned. An echo of our own last write is ignored. A bad parse leaves the graph as it was. */
export function createDslSync(graph: FlowGraph): DslSync {
  let current = graph;
  let text = printFlow(graph, { mode: "edit" });
  let origin: "canvas" | "text" | null = null;
  return {
    get text() {
      return text;
    },
    get graph() {
      return current;
    },
    fromCanvas(next) {
      if (origin === "text" && semanticKey(next) === semanticKey(current)) {
        origin = null;
        return { text, applied: false };
      }
      current = next;
      text = printFlow(next, { mode: "edit" });
      origin = "canvas";
      return { text, applied: true };
    },
    fromText(nextText) {
      if (origin === "canvas" && nextText === text) {
        origin = null;
        return { graph: current, applied: false };
      }
      try {
        current = parse(nextText);
        text = nextText;
        origin = "text";
        return { graph: current, applied: true };
      } catch (err) {
        return { graph: current, applied: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** Pretty form when the graph is nested. Otherwise label/goto. `edit` keeps every node label. */
export function printFlow(g: FlowGraph, opts?: { mode?: "export" | "edit" }): string {
  const prev = printLabels;
  printLabels = { mode: opts?.mode ?? "export", n: 1 };
  try {
    const structured = structuredText(g);
    return structured ?? printState(g);
  } finally {
    printLabels = prev;
  }
}

/** Each attempt numbers auto labels from n1, so the answer never depends on an earlier print or compile. */
function structuredText(g: FlowGraph): string | null {
  const prev = printLabels;
  printLabels = { mode: prev.mode, n: 1 };
  try {
    const text = printStructured(g);
    return semanticKey(parse(text)) === semanticKey(g) ? text : null;
  } catch (err) {
    if (err instanceof Unstructured) return null;
    throw err;
  } finally {
    printLabels = prev;
  }
}

function printStructured(g: FlowGraph): string {
  const lines = openFlow(g);
  const start = outEdge(g, "start", "then");
  const trail = new Set<string>();
  const shown = new Set<string>();
  writeBlock(g, start?.node ?? null, lines, 1, new Set(), trail, shown);
  const reached = reachable(g);
  const owned = reachedFrom(g, g.nodes.filter((n) => n.type === "flow.def" || n.type === "flow.macro").map((n) => n.id));
  const floating = new Set(
    g.nodes
      .filter((n) => {
        if (n.type === "event.start" || n.type === "flow.def" || n.type === "flow.macro") return false;
        if (reached.has(n.id) || owned.has(n.id)) return false;
        if (!isPure(n)) return true;
        return !g.edges.some((edge) => edge.from.startsWith(n.id + "."));
      })
      .map((n) => n.id),
  );
  if (floating.size) {
    lines.push("floating:");
    const incoming = new Set(g.edges.filter((e) => e.to.endsWith(".exec")).map((e) => e.to.slice(0, e.to.length - 5)));
    const heads = [...floating].filter((id) => !incoming.has(id)).sort();
    for (const head of heads) writeBlock(g, head, lines, 1, new Set(reached), trail, shown);
  }
  return lines.join("\n") + "\n";
}

function prelude(g: FlowGraph): string[] {
  const lines = ["flow " + g.name + "  # xflow 1"];
  for (const v of [...(g.variables ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    lines.push(printVar(v));
  }
  for (const e of [...(g.env ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    lines.push("env " + e.name + (e.secret ? " secret" : ""));
  }
  for (const param of [...(g.params ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    lines.push("param " + param.name + ": " + param.type + " = " + jsonLit(param.default ?? null));
  }
  return lines;
}

function openFlow(g: FlowGraph): string[] {
  const lines = prelude(g);
  const shown = new Set<string>();
  for (const node of g.nodes) {
    if (node.type !== "flow.def" && node.type !== "flow.macro") continue;
    const params = String(node.config?.params ?? "");
    const ret = String(node.config?.returns ?? "");
    const keyword = node.type === "flow.macro" ? "macro" : "def";
    lines.push(decorate(keyword + " " + node.id + "(" + params + ")" + (ret ? " -> " + ret : "") + ":", node));
    for (const local of readLocals(node)) {
      lines.push("  local " + local.name + ": " + local.type + " = " + jsonLit(local.default ?? null));
    }
    writeBlock(g, outEdge(g, node.id, "body")?.node ?? null, lines, 1, new Set(), new Set(), shown);
    if (ret && Object.prototype.hasOwnProperty.call(node.config ?? {}, "returnLit")) {
      lines.push("  return " + ret + "=" + jsonLit((node.config?.returnLit ?? null) as string | number | boolean | null));
    } else if (ret) {
      const src = inEdge(g, node.id, ret);
      if (src) lines.push("  return " + ret + "=" + (src.node === node.id ? src.pin : src.node + "." + src.pin));
    }
  }
  lines.push("on start:");
  return lines;
}

function reachedFrom(g: FlowGraph, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    for (const edge of g.edges) {
      if (edge.from.startsWith(id + ".")) stack.push(edge.to.slice(0, edge.to.indexOf(".")));
    }
  }
  return seen;
}

function decorate(line: string, node: FlowNode): string {
  const marked = node.meta?.disabled ? line.replace(/^(\s*)/, "$1off ") : line;
  return node.meta?.comment ? marked + "  # " + node.meta.comment : marked;
}

/** Where execution continues when a node is turned off. Nested regions are not entered. */
function disabledNext(g: FlowGraph, node: FlowNode): string | null {
  const region = ["flow.for_range", "flow.for_each", "flow.while", "flow.branch", "flow.match", "flow.try", "flow.wait_until", "flow.retry", "flow.parallel"].includes(node.type);
  if (region) return outEdge(g, node.id, "completed")?.node ?? null;
  if (node.type === "flow.sequence") return outEdge(g, node.id, "next")?.node ?? null;
  return outEdge(g, node.id, "then")?.node ?? outEdge(g, node.id, "next")?.node ?? null;
}

function ensureLets(g: FlowGraph, consumerId: string, lines: string[], pad: string, shown: Set<string>): void {
  const deps: string[] = [];
  for (const edge of g.edges) {
    if (!edge.to.startsWith(consumerId + ".")) continue;
    const srcId = edge.from.slice(0, edge.from.indexOf("."));
    const src = nodeMap(g).get(srcId);
    if (src && isPure(src)) deps.push(srcId);
  }
  for (const srcId of deps) {
    ensureLets(g, srcId, lines, pad, shown);
    if (shown.has(srcId)) continue;
    const src = nodeMap(g).get(srcId);
    if (!src) continue;
    shown.add(srcId);
    if (shouldInline(g, src)) continue;
    lines.push(pad + "let " + srcId + " = " + formatPureCall(g, src));
  }
}

function reachable(g: FlowGraph): Set<string> {
  const seen = new Set<string>();
  const stack = ["start"];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of g.edges) {
      if (e.from.startsWith(id + ".")) stack.push(e.to.slice(0, e.to.indexOf(".")));
    }
  }
  return seen;
}

function writeBlock(
  g: FlowGraph,
  entry: string | null,
  lines: string[],
  depth: number,
  stop: Set<string>,
  trail: Set<string>,
  shown: Set<string>,
): void {
  const nodes = nodeMap(g);
  let id: string | null = entry;
  const pad = "  ".repeat(depth);
  while (id && !stop.has(id)) {
    if (trail.has(id)) throw new Unstructured(id);
    trail.add(id);
    ensureLets(g, id, lines, pad, shown);
    const node = nodes.get(id);
    if (!node) throw new Error("missing node " + id);
    if (node.type === "flow.for_range") {
      const start = node.inputs?.start;
      const end = node.inputs?.end;
      lines.push(decorate(pad + "for " + id + " in range(" + start + ", " + end + "):", node));
      const body = outEdge(g, id, "body");
      writeBlock(g, body?.node ?? null, lines, depth + 1, stop, trail, shown);
      id = outEdge(g, id, "completed")?.node ?? null;
      continue;
    }
    if (node.type === "flow.for_each") {
      const items = inEdge(g, id, "items");
      const source = items ? items.node + "." + items.pin : String(node.config?.items ?? "");
      if (!source) throw new Error("for_each without items: " + id);
      lines.push(decorate(pad + "for " + id + " in " + source + ":", node));
      const body = outEdge(g, id, "body");
      writeBlock(g, body?.node ?? null, lines, depth + 1, stop, trail, shown);
      id = outEdge(g, id, "completed")?.node ?? null;
      continue;
    }
    if (node.type === "flow.while") {
      const cond = inEdge(g, id, "cond");
      if (!cond) throw new Error("while without condition: " + id);
      lines.push(decorate(pad + labelPrefix(id) + "while " + cond.node + "." + cond.pin + " max=" + node.inputs?.max + ":", node));
      const body = outEdge(g, id, "body");
      writeBlock(g, body?.node ?? null, lines, depth + 1, stop, trail, shown);
      id = outEdge(g, id, "completed")?.node ?? null;
      continue;
    }
    if (node.type === "flow.wait_until") {
      const cond = inEdge(g, id, "cond");
      const subject = cond ? cond.node + "." + cond.pin + " " : "";
      lines.push(decorate(pad + labelPrefix(id) + "until " + subject + "timeout=" + node.inputs?.timeout + " interval=" + node.inputs?.interval + ":", node));
      writeBlock(g, outEdge(g, id, "then")?.node ?? null, lines, depth + 1, stop, trail, shown);
      const late = outEdge(g, id, "timeout");
      if (late) {
        lines.push(pad + "timeout:");
        writeBlock(g, late.node, lines, depth + 1, stop, trail, shown);
      }
      return;
    }
    if (node.type === "flow.retry") {
      lines.push(decorate(pad + labelPrefix(id) + "retry times=" + node.inputs?.times + ":", node));
      writeBlock(g, outEdge(g, id, "body")?.node ?? null, lines, depth + 1, stop, trail, shown);
      const ok = outEdge(g, id, "ok");
      if (ok) {
        lines.push(pad + "ok:");
        writeBlock(g, ok.node, lines, depth + 1, stop, trail, shown);
      }
      const failed = outEdge(g, id, "failed");
      if (failed) {
        lines.push(pad + "failed:");
        writeBlock(g, failed.node, lines, depth + 1, stop, trail, shown);
      }
      return;
    }
    if (node.type === "flow.try") {
      lines.push(decorate(pad + labelPrefix(id) + "try:", node));
      writeBlock(g, outEdge(g, id, "body")?.node ?? null, lines, depth + 1, stop, trail, shown);
      lines.push(pad + "except " + (node.config?.err ?? "err") + ":");
      writeBlock(g, outEdge(g, id, "handler")?.node ?? null, lines, depth + 1, stop, trail, shown);
      id = outEdge(g, id, "completed")?.node ?? null;
      continue;
    }
    if (node.type === "flow.parallel") {
      lines.push(decorate(pad + labelPrefix(id) + "parallel:", node));
      for (const pin of parallelBranches(g, id)) {
        lines.push(pad + "  branch:");
        writeBlock(g, outEdge(g, id, pin)?.node ?? null, lines, depth + 2, stop, trail, shown);
      }
      id = outEdge(g, id, "joined")?.node ?? null;
      continue;
    }
    if (node.type === "flow.sequence") {
      lines.push(decorate(pad + labelPrefix(id) + "seq:", node));
      for (const pin of sequenceSteps(g, id)) {
        lines.push(pad + "  step:");
        writeBlock(g, outEdge(g, id, pin)?.node ?? null, lines, depth + 2, stop, trail, shown);
      }
      id = outEdge(g, id, "next")?.node ?? null;
      continue;
    }
    if (node.type === "flow.branch") {
      const cond = inEdge(g, id, "cond");
      if (!cond) throw new Error("branch without condition: " + id);
      lines.push(decorate(pad + labelPrefix(id) + "if " + cond.node + "." + cond.pin + ":", node));
      const then = outEdge(g, id, "then");
      writeBlock(g, then?.node ?? null, lines, depth + 1, stop, trail, shown);
      const els = outEdge(g, id, "else");
      if (els) {
        lines.push(pad + "else:");
        writeBlock(g, els.node, lines, depth + 1, stop, trail, shown);
      }
      return;
    }
    if (node.type === "flow.match") {
      const matchId = id;
      const value = inEdge(g, matchId, "value");
      const subject = value ? value.node + "." + value.pin : String(node.config?.subject ?? "");
      lines.push(decorate(pad + labelPrefix(matchId) + "match " + subject + ":", node));
      const cases = JSON.parse(String(node.config?.cases ?? "[]")) as Array<string | number>;
      cases.forEach((label, index) => {
        const labelText = label === "_" ? "_" : jsonLit(label);
        lines.push(pad + "  " + labelText + ":");
        writeBlock(g, outEdge(g, matchId, "c" + index)?.node ?? null, lines, depth + 2, stop, trail, shown);
      });
      id = outEdge(g, id, "completed")?.node ?? null;
      continue;
    }
    if (node.type === "flow.call") {
      lines.push(decorate(pad + formatSub(g, node), node));
      const nxt = outEdge(g, id, "then");
      if (nxt?.pin === "break" || nxt?.pin === "continue" || nxt?.pin === "fail") {
        lines.push(pad + nxt.pin);
        return;
      }
      id = nxt?.node ?? null;
      continue;
    }
    if (node.type === "code.python") {
      const parts: Array<[string, string | number | boolean | null]> = [];
      const add = (key: string, value: string | number | boolean | null | undefined) => {
        if (value !== undefined && value !== "") parts.push([key, value]);
      };
      add("inPins", node.config?.inPins);
      add("outPins", node.config?.outPins);
      add("source", node.config?.source);
      for (const [key, value] of Object.entries(node.inputs ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : 1))) add(key, value);
      parts.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      lines.push(decorate(pad + labelPrefix(id) + "code(" + parts.map(([key, value]) => key + "=" + jsonLit(value)).join(", ") + ")", node));
      const nxt = outEdge(g, id, "then");
      if (nxt?.pin === "break" || nxt?.pin === "continue" || nxt?.pin === "fail") {
        lines.push(pad + nxt.pin);
        return;
      }
      id = nxt?.node ?? null;
      continue;
    }
    const alias = ALIAS_OF[node.type];
    if (!alias) throw new Error("cannot print " + node.type);
    lines.push(decorate(pad + formatCall(g, id, alias, argsOf(g, id)), node));
    const nxt = outEdge(g, id, "then");
    if (nxt?.pin === "break" || nxt?.pin === "continue" || nxt?.pin === "fail") {
      lines.push(pad + nxt.pin);
      return;
    }
    id = nxt?.node ?? null;
  }
}

function sequenceSteps(g: FlowGraph, id: string): string[] {
  const pins = new Set<string>();
  for (const edge of g.edges) {
    if (!edge.from.startsWith(id + ".")) continue;
    const pin = edge.from.slice(id.length + 1);
    if (/^s\d+$/.test(pin)) pins.add(pin);
  }
  return [...pins].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function parallelBranches(g: FlowGraph, id: string): string[] {
  const pins = new Set<string>();
  for (const edge of g.edges) {
    if (!edge.from.startsWith(id + ".")) continue;
    const pin = edge.from.slice(id.length + 1);
    if (/^b\d+$/.test(pin)) pins.add(pin);
  }
  return [...pins].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function successors(g: FlowGraph, id: string): string[] {
  const node = nodeMap(g).get(id);
  if (!node) return [];
  const pins =
    node.type === "flow.branch"
      ? ["then", "else"]
      : node.type === "flow.try"
        ? ["body", "handler", "completed"]
        : node.type === "flow.parallel"
          ? [...parallelBranches(g, id), "joined"]
          : node.type === "flow.sequence"
            ? [...sequenceSteps(g, id), "next"]
            : node.type === "flow.wait_until"
              ? ["then", "timeout"]
              : node.type === "flow.match"
                ? [...regionPins(g, node), "completed"]
              : node.type === "flow.retry"
                ? ["body", "ok", "failed"]
                : node.type === "flow.for_range" || node.type === "flow.for_each" || node.type === "flow.while"
            ? ["body", "completed"]
            : ["then"];
  const out: string[] = [];
  for (const pin of pins) {
    const edge = outEdge(g, id, pin);
    if (edge && edge.pin !== "break" && edge.pin !== "continue" && edge.pin !== "fail") out.push(edge.node);
  }
  return out;
}

function stateOrder(g: FlowGraph): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = successors(g, "start");
  while (queue.length) {
    const id = queue.shift();
    if (!id || id === "start" || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    queue.push(...successors(g, id));
  }
  const owned = reachedFrom(g, g.nodes.filter((n) => n.type === "flow.def" || n.type === "flow.macro").map((n) => n.id));
  for (const node of [...g.nodes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (node.id !== "start" && !seen.has(node.id) && !owned.has(node.id)) order.push(node.id);
  }
  return order;
}

function printState(g: FlowGraph): string {
  const lines = openFlow(g);
  const first = outEdge(g, "start", "then");
  if (first) lines.push("  goto " + first.node);
  for (const id of stateOrder(g)) {
    const node = nodeMap(g).get(id);
    if (!node || node.type === "event.start") continue;
    const alias = ALIAS_OF[node.type];
    if (node.type !== "flow.branch" && !alias) throw new Error("state machine cannot lower " + node.type);
    lines.push("  label " + id + ":");
    if (node.type === "flow.branch") {
      const cond = inEdge(g, id, "cond");
      if (!cond) throw new Error("branch without condition: " + id);
      lines.push(decorate("    " + labelPrefix(id) + "if " + cond.node + "." + cond.pin + ":", node));
      const then = outEdge(g, id, "then");
      if (then) lines.push("      goto " + then.node);
      const els = outEdge(g, id, "else");
      if (els) {
        lines.push("    else:");
        lines.push("      goto " + els.node);
      }
      continue;
    }
    lines.push(decorate("    " + formatCall(g, id, alias ?? "", argsOf(g, id)), node));
    const nxt = outEdge(g, id, "then");
    if (nxt?.pin === "continue") lines.push("    continue");
    else if (nxt?.pin === "fail") lines.push("    fail");
    else if (nxt && nxt.pin !== "break") lines.push("    goto " + nxt.node);
  }
  return lines.join("\n") + "\n";
}

export function pyRepr(v: string | number | boolean | null): string {
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n") + "'";
}

export interface NodeSpec {
  type: string;
  py?: { stmt: string; imports?: string[] };
  dsl: { alias: string };
  latent?: boolean;
  inputs: Array<{ name: string; type?: string; default?: string | number | boolean | null; ui?: string; min?: number; options?: string[] }>;
  outputs: Array<{ name: string; type?: string }>;
  exec: { in: string[]; out: string[] };
  title?: { zh: string; en: string };
  doc?: { zh: string; en: string };
  category?: string;
  icon?: string;
  availability?: "ok" | "partial" | "stub" | "hidden";
}

export interface CompileResult {
  python: string;
  lines: Record<string, string>;
}

const PY_RESERVED = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "action", "node", "system", "print", "range",
]);

export function pyIdent(id: string): string {
  return PY_RESERVED.has(id) ? id + "_" : id;
}

/** Python expression for the value on an output pin: a local, an inlined pure call, a def parameter or a tuple slot. */
function refExpr(g: FlowGraph, ref: { node: string; pin: string }, specs?: Map<string, NodeSpec>, subst?: Map<string, string>): string {
  const key = ref.node + "." + ref.pin;
  if (subst?.has(key)) return subst.get(key) ?? "";
  const src = nodeMap(g).get(ref.node);
  if (src?.type === "data.get") return pyIdent(String(src.inputs?.name ?? ""));
  if (src && isPure(src)) {
    if (!shouldInline(g, src)) return pyIdent(src.id);
    const template = specs?.get(src.type)?.py?.stmt;
    if (!template) throw new Error("no compile template for " + src.type);
    return fillStmt(template, src, g, undefined, specs, subst);
  }
  if (src?.type === "flow.def" || src?.type === "flow.macro") return pyIdent(ref.pin);
  if (src?.type === "flow.merge" && ref.pin === "value") return pyIdent(ref.node);
  if (src?.type === "code.python") {
    const outs = codePins(src).outputs;
    if (outs.length <= 1) return pyIdent(ref.node);
    const index = outs.findIndex((pin) => pin.name === ref.pin);
    return index < 0 ? pyIdent(ref.node) : pyIdent(ref.node) + "[" + index + "]";
  }
  // Loop variables are named after the loop node, whether the wire comes from the spec pin or the DSL's `result`.
  if (src?.type === "flow.for_range" && ref.pin === "index") return pyIdent(ref.node);
  if (src?.type === "flow.for_each" && ref.pin === "item") return pyIdent(ref.node);
  if (src?.type === "flow.call" || ref.pin === "node" || ref.pin === "result") return pyIdent(ref.node);
  return pyIdent(ref.node) + "." + ref.pin;
}

/** Test for a branch / while / until condition. `node.find`'s `found` is `x is not None`; anything else is its value. */
function condExpr(g: FlowGraph, cond: { node: string; pin: string }, specs?: Map<string, NodeSpec>, subst?: Map<string, string>): string {
  const src = nodeMap(g).get(cond.node);
  if (src?.type === "node.find" && cond.pin === "found" && !subst?.has(cond.node + "." + cond.pin)) return "(" + pyIdent(cond.node) + " is not None)";
  return refExpr(g, cond, specs, subst);
}

/** Replace `{pin}` with a Python literal or name. User text goes through repr, never raw splicing.

`{id}` is the node id. `{node}` is also the node id when that pin is not connected, so older
templates keep working. A pin literally named `node` or `id` is written `{p_node}` / `{p_id}`.
*/
export function fillStmt(
  stmt: string,
  node: FlowNode,
  g: FlowGraph,
  defaults?: Record<string, string | number | boolean | null>,
  specs?: Map<string, NodeSpec>,
  subst?: Map<string, string>,
): string {
  if (node.meta?.disabled) return "None";
  return stmt.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, name: string) => {
    if (name === "id") return pyIdent(node.id);
    const pin = name.startsWith("p_") ? name.slice(2) : name;
    const lit = node.inputs?.[pin];
    const ref = lit === undefined ? inEdge(g, node.id, pin) : undefined;
    if (name === "node" && lit === undefined && !ref) return pyIdent(node.id);
    if (lit !== undefined) return pyRepr(lit);
    if (ref) return refExpr(g, ref, specs, subst);
    if (defaults && Object.prototype.hasOwnProperty.call(defaults, pin)) return pyRepr(defaults[pin] ?? null);
    throw new Error(node.type + " is missing {" + name + "}");
  });
}

function traceHeader(): string[] {
  return [
    "import time as _xf_time",
    "_xf_tokens = 200.0",
    "_xf_stamp = None",
    "_xf_loops = {}",
    "def __xf_trace(kind, nid, value=\"\"):",
    "    global _xf_tokens, _xf_stamp",
    "    now = _xf_time.monotonic()",
    "    if _xf_stamp is not None:",
    "        _xf_tokens = min(200.0, _xf_tokens + (now - _xf_stamp) * 500.0)",
    "    _xf_stamp = now",
    "    text = \"\" if value is None else str(value)",
    "    if len(text) > 80:",
    "        text = text[:79] + \"…\"",
    "    rec = _xf_loops.get(nid)",
    "    if rec is None:",
    "        _xf_loops[nid] = [1, now]",
    "    elif rec[0] < 3:",
    "        rec[0] += 1",
    "    elif now - rec[1] < 0.25:",
    "        rec[0] += 1",
    "        return",
    "    else:",
    "        rec[0] += 1",
    "        kind = \"loop\"",
    "        text = str(rec[0])",
    "        rec[1] = now",
    "    if _xf_tokens < 1.0:",
    "        return",
    "    _xf_tokens -= 1.0",
    '    print("\\x1fXF\\t%s\\t%s\\t%s" % (kind, nid, text), flush=True)',
    "",
  ];
}

/** Compile the proven subset. Line map matches the design's sign-in source map.

`trace` injects `__xf_trace`: one span per call, a 200-line burst and 500 lines/second (§14.7).
*/
export function compile(g: FlowGraph, specs: Map<string, NodeSpec>, opts?: { trace?: boolean }): CompileResult {
  if (structuredText(g) === null) return compileState(g, specs, opts);
  const lines: string[] = [
    "# generated from " + g.name + ".xflow.json by XScript Desktop; do not edit, edit the flow instead",
    "from xscript.android import action, node, system",
    ...extraImports(g, specs),
  ];
  if (g.nodes.some((n) => n.type === "flow.parallel")) lines.push("import threading");
  lines.push("");
  if (opts?.trace) lines.push(...traceHeader());
  if (g.nodes.some((n) => n.type === "flow.merge")) lines.push(...mergeHeader());
  const map: Record<string, string> = {};
  const emit = (text: string, mark: string | null, indent: number) => {
    lines.push("    ".repeat(indent) + text);
    if (mark) map[String(lines.length)] = mark;
  };
  emitBindings(g, emit);
  for (const node of g.nodes) {
    if (node.type === "flow.def") emitDef(g, specs, node, emit, opts?.trace ?? false);
  }
  const start = outEdge(g, "start", "then");
  compileBlock(g, specs, start?.node ?? null, emit, 0, opts?.trace ?? false, new Set());
  return { python: lines.join("\n") + "\n", lines: map };
}

function extraImports(g: FlowGraph, specs: Map<string, NodeSpec>): string[] {
  const covered = new Set(["action", "node", "system"]);
  const lines = new Set<string>();
  for (const node of g.nodes) {
    for (const line of specs.get(node.type)?.py?.imports ?? []) {
      const imported = /^from xscript\.android import ([A-Za-z0-9_, ]+)$/.exec(line);
      if (imported && imported[1].split(",").every((name) => covered.has(name.trim()))) continue;
      lines.add(line);
    }
  }
  return [...lines].sort();
}

function emitBindings(g: FlowGraph, emit: (text: string, mark: string | null, indent: number) => void): void {
  for (const variable of [...(g.variables ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const fallback = pyRepr(variable.default ?? null);
    const line = variable.editable
      ? pyIdent(variable.name) + " = system.params().get(" + pyRepr(variable.name) + ", " + fallback + ")"
      : pyIdent(variable.name) + " = " + fallback;
    emit(line, null, 0);
  }
  for (const item of [...(g.env ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    emit(pyIdent(item.name) + " = __import__('os').environ[" + pyRepr(item.name) + "]", null, 0);
  }
  for (const param of [...(g.params ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    emit(pyIdent(param.name) + " = system.params().get(" + pyRepr(param.name) + ", " + pyRepr(param.default ?? null) + ")", null, 0);
  }
}

function emitDef(
  g: FlowGraph,
  specs: Map<string, NodeSpec>,
  node: FlowNode,
  emit: (text: string, mark: string | null, indent: number) => void,
  trace: boolean,
): void {
  const params = String(node.config?.params ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  emit("def " + pyIdent(node.id) + "(" + params.map((name) => pyIdent(name)).join(", ") + "):", node.id, 0);
  const locals = readLocals(node);
  for (const local of locals) emit(pyIdent(local.name) + " = " + pyRepr(local.default ?? null), node.id, 1);
  const body = outEdge(g, node.id, "body");
  if (!body) {
    if (!locals.length) emit("pass", null, 1);
  } else compileBlock(g, specs, body.node, emit, 1, trace, new Set());
  const ret = String(node.config?.returns ?? "");
  if (!ret) return;
  if (Object.prototype.hasOwnProperty.call(node.config ?? {}, "returnLit")) {
    emit("return " + pyRepr((node.config?.returnLit ?? null) as string | number | boolean | null), node.id, 1);
    return;
  }
  const src = inEdge(g, node.id, ret);
  if (!src) {
    emit("return None", node.id, 1);
    return;
  }
  const value = src.node === node.id ? pyIdent(src.pin) : src.pin === "node" ? pyIdent(src.node) : pyIdent(src.node) + "." + src.pin;
  emit("return " + value, node.id, 1);
}

function compileBlock(
  g: FlowGraph,
  specs: Map<string, NodeSpec>,
  entry: string | null,
  emit: (text: string, mark: string | null, indent: number) => void,
  indent: number,
  trace: boolean,
  shown: Set<string>,
  subst?: Map<string, string>,
): void {
  const nodes = nodeMap(g);
  let id: string | null = entry;
  while (id) {
    const node = nodes.get(id);
    if (!node) throw new Error("missing node " + id);
    if (node.meta?.disabled) {
      id = disabledNext(g, node);
      continue;
    }
    emitPures(g, specs, id, emit, indent, shown, subst);
    if (node.type === "flow.for_range") {
      emit("for " + pyIdent(id) + " in range(" + node.inputs?.start + ", " + node.inputs?.end + "):", id, indent);
      const body = outEdge(g, id, "body");
      compileBlock(g, specs, body?.node ?? null, emit, indent + 1, trace, shown, subst);
      id = outEdge(g, id, "completed")?.node ?? null;
      continue;
    }
    if (node.type === "flow.for_each") {
      const items = inEdge(g, id, "items");
      const source = items ? refExpr(g, items, specs, subst) : pyIdent(String(node.config?.items ?? ""));
      emit("for " + pyIdent(id) + " in " + source + ":", id, indent);
      const body = outEdge(g, id, "body");
      if (!body) emit("pass", null, indent + 1);
      else compileBlock(g, specs, body.node, emit, indent + 1, trace, shown, subst);
      id = outEdge(g, id, "completed")?.node ?? null;
      continue;
    }
    if (node.type === "flow.while") {
      const cond = inEdge(g, id, "cond");
      if (!cond) throw new Error("while without condition");
      const counter = id + "_i";
      const max = node.inputs?.max;
      emit(counter + " = 0", id, indent);
      emit("while " + counter + " < " + max + ":", id, indent);
      emit(counter + " += 1", null, indent + 1);
      const src = nodes.get(cond.node);
      const stop = src?.type === "node.find" && cond.pin === "found" ? pyIdent(cond.node) + " is None" : "not " + condExpr(g, cond, specs, subst);
      emit("if " + stop + ":", null, indent + 1);
      emit("break", null, indent + 2);
      compileBlock(g, specs, outEdge(g, id, "body")?.node ?? null, emit, indent + 1, trace, shown, subst);
      id = outEdge(g, id, "completed")?.node ?? null;
      continue;
    }
    if (node.type === "flow.wait_until") {
      const cond = inEdge(g, id, "cond");
      if (!cond) throw new Error("until without condition");
      const timeout = Number(node.inputs?.timeout ?? 0);
      const interval = Math.max(1, Number(node.inputs?.interval ?? 200));
      const times = Math.floor(timeout / interval);
      const counter = pyIdent(id + "_i");
      const flag = pyIdent(id + "_ok");
      const test = condExpr(g, cond, specs, subst);
      emit(flag + " = False", id, indent);
      emit(counter + " = 0", null, indent);
      emit("while " + counter + " < " + times + ":", null, indent);
      emit("if " + test + ":", null, indent + 1);
      emit(flag + " = True", null, indent + 2);
      emit("break", null, indent + 2);
      emit("action.sleep(" + interval / 1000 + ")", null, indent + 1);
      emit(counter + " += 1", null, indent + 1);
      emit("if " + flag + ":", null, indent);
      const ready = outEdge(g, id, "then");
      if (!ready) emit("pass", null, indent + 1);
      else compileBlock(g, specs, ready.node, emit, indent + 1, trace, shown, subst);
      const late = outEdge(g, id, "timeout");
      if (late) {
        emit("else:", null, indent);
        compileBlock(g, specs, late.node, emit, indent + 1, trace, shown, subst);
      }
      return;
    }
    if (node.type === "flow.retry") {
      const times = Number(node.inputs?.times ?? 1);
      const counter = pyIdent(id + "_i");
      const flag = pyIdent(id + "_ok");
      emit(flag + " = False", id, indent);
      emit("for " + counter + " in range(" + times + "):", null, indent);
      const body = outEdge(g, id, "body");
      if (body) compileBlock(g, specs, body.node, emit, indent + 1, trace, shown, subst);
      else emit("pass", null, indent + 1);
      emit(flag + " = True", null, indent + 1);
      emit("break", null, indent + 1);
      emit("if " + flag + ":", null, indent);
      const ok = outEdge(g, id, "ok");
      if (!ok) emit("pass", null, indent + 1);
      else compileBlock(g, specs, ok.node, emit, indent + 1, trace, shown, subst);
      const failed = outEdge(g, id, "failed");
      if (failed) {
        emit("else:", null, indent);
        compileBlock(g, specs, failed.node, emit, indent + 1, trace, shown, subst);
      }
      return;
    }
    if (node.type === "flow.try") {
      emit("try:", id, indent);
      const body = outEdge(g, id, "body");
      if (!body) emit("pass", null, indent + 1);
      else compileBlock(g, specs, body.node, emit, indent + 1, trace, shown, subst);
      emit("except Exception as " + pyIdent(String(node.config?.err ?? "err")) + ":", id, indent);
      const handler = outEdge(g, id, "handler");
      if (!handler) emit("pass", null, indent + 1);
      else compileBlock(g, specs, handler.node, emit, indent + 1, trace, shown, subst);
      id = outEdge(g, id, "completed")?.node ?? null;
      continue;
    }
    if (node.type === "flow.parallel") {
      const branches = parallelBranches(g, id);
      for (const pin of branches) {
        const fn = pyIdent("_" + id + "_" + pin);
        emit("def " + fn + "():", id, indent);
        const body = outEdge(g, id, pin);
        if (!body) emit("pass", null, indent + 1);
        else compileBlock(g, specs, body.node, emit, indent + 1, trace, shown, subst);
      }
      const names = branches.map((pin) => "threading.Thread(target=" + pyIdent("_" + id + "_" + pin) + ")");
      emit("_threads = [" + names.join(", ") + "]", id, indent);
      emit("for _t in _threads:", null, indent);
      emit("_t.start()", null, indent + 1);
      emit("for _t in _threads:", null, indent);
      emit("_t.join()", null, indent + 1);
      id = outEdge(g, id, "joined")?.node ?? null;
      continue;
    }
    if (node.type === "flow.sequence") {
      for (const pin of sequenceSteps(g, id)) {
        const body = outEdge(g, id, pin);
        if (body) compileBlock(g, specs, body.node, emit, indent, trace, shown, subst);
      }
      id = outEdge(g, id, "next")?.node ?? null;
      continue;
    }
    if (node.type === "flow.match") {
      const matchId = id;
      const value = inEdge(g, matchId, "value");
      const subject = value ? (value.pin === "node" ? pyIdent(value.node) : pyIdent(value.node) + "." + value.pin) : pyIdent(String(node.config?.subject ?? ""));
      const cases = JSON.parse(String(node.config?.cases ?? "[]")) as Array<string | number>;
      const tmp = pyIdent(matchId + "_v");
      emit(tmp + " = " + subject, matchId, indent);
      cases.forEach((label, index) => {
        if (label === "_" && index !== cases.length - 1) throw new Error("match default must be last");
        const head = label === "_" ? (index === 0 ? "if True:" : "else:") : (index === 0 ? "if " : "elif ") + tmp + " == " + pyRepr(label) + ":";
        emit(head, matchId, indent);
        const body = outEdge(g, matchId, "c" + index);
        if (!body) emit("pass", null, indent + 1);
        else compileBlock(g, specs, body.node, emit, indent + 1, trace, shown, subst);
      });
      id = outEdge(g, id, "completed")?.node ?? null;
      continue;
    }
    if (node.type === "flow.call") {
      const callee = String(node.config?.callee ?? "");
      const def = nodes.get(callee);
      if (!def || (def.type !== "flow.def" && def.type !== "flow.macro")) throw new Error("unknown def " + callee);
      const params = String(def.config?.params ?? "").split(",").map((part) => part.trim()).filter(Boolean);
      const args = params.map((name) => {
        const lit = node.inputs?.[name];
        if (lit !== undefined) return pyRepr(lit);
        const ref = inEdge(g, node.id, name);
        if (!ref) throw new Error(id + " is missing " + name);
        const bound = subst?.get(ref.node + "." + ref.pin);
        if (bound) return bound;
        const src = nodes.get(ref.node);
        if (src && isPure(src)) return shouldInline(g, src) ? compileCall(g, specs, src, subst) : pyIdent(src.id);
        if (src?.type === "flow.def" || src?.type === "flow.macro") return pyIdent(ref.pin);
        if (src?.type === "flow.call" || ref.pin === "node" || ref.pin === "result") return pyIdent(ref.node);
        return pyIdent(ref.node) + "." + ref.pin;
      });
      if (def.type === "flow.macro") {
        const local = new Map(subst);
        params.forEach((name, index) => local.set(def.id + "." + name, args[index]));
        const body = outEdge(g, def.id, "body");
        if (body) compileBlock(g, specs, body.node, emit, indent, trace, shown, local);
        const ret = String(def.config?.returns ?? "");
        if (ret) {
          let value = "None";
          if (Object.prototype.hasOwnProperty.call(def.config ?? {}, "returnLit")) {
            value = pyRepr((def.config?.returnLit ?? null) as string | number | boolean | null);
          } else {
            const src = inEdge(g, def.id, ret);
            if (src) value = local.get(src.node + "." + src.pin) ?? pyIdent(src.pin);
          }
          emit(pyIdent(id) + " = " + value, id, indent);
        }
        const nxt = outEdge(g, id, "then");
        if (nxt?.pin === "break" || nxt?.pin === "continue" || nxt?.pin === "fail") {
          emit(nxt.pin === "fail" ? "continue" : nxt.pin, id + "(" + nxt.pin + ")", indent);
          return;
        }
        id = nxt?.node ?? null;
        continue;
      }
      const stmt = (def.config?.returns ? pyIdent(id) + " = " : "") + pyIdent(callee) + "(" + args.join(", ") + ")";
      if (trace && specs.get(node.type)?.latent) emit("__xf_trace(" + JSON.stringify("enter") + ", " + JSON.stringify(id) + ")", null, indent);
      emit(stmt, id, indent);
      if (trace) emit("__xf_trace(" + JSON.stringify("span") + ", " + JSON.stringify(id) + ", " + exitValue(node, stmt) + ")", null, indent);
      const nxt = outEdge(g, id, "then");
      if (nxt?.pin === "break" || nxt?.pin === "continue" || nxt?.pin === "fail") {
        emit(nxt.pin === "fail" ? "continue" : nxt.pin, id + "(" + nxt.pin + ")", indent);
        return;
      }
      id = nxt?.node ?? null;
      continue;
    }
    if (node.type === "flow.branch") {
      const cond = inEdge(g, id, "cond");
      if (!cond) throw new Error("branch without condition");
      const test = condExpr(g, cond, specs, subst);
      emit("if " + test + ":", id, indent);
      // An arm wired straight to a loop's break/continue pin is that jump, not a walk back into the loop.
      const arm = (edge: { node: string; pin: string } | null) => {
        if (!edge) emit("pass", null, indent + 1);
        else if (edge.pin === "break" || edge.pin === "continue" || edge.pin === "fail") emit(edge.pin === "fail" ? "continue" : edge.pin, null, indent + 1);
        else compileBlock(g, specs, edge.node, emit, indent + 1, trace, shown, subst);
      };
      arm(outEdge(g, id, "then"));
      const els = outEdge(g, id, "else");
      if (els) {
        emit("else:", id + "(else)", indent);
        arm(els);
      }
      return;
    }
    if (node.type === "code.python" && !node.meta?.origin) {
      const pins = codePins(node);
      const nodeId = id;
      const fn = pyIdent("_code_" + nodeId);
      const args = pins.inputs.map((pin) => {
        const lit = node.inputs?.[pin.name];
        if (lit !== undefined) return pyRepr(lit);
        const ref = inEdge(g, nodeId, pin.name);
        if (!ref) return "None";
        return fillStmt("{" + pin.name + "}", node, g, undefined, specs, subst);
      });
      emit("def " + fn + "(" + pins.inputs.map((pin) => pyIdent(pin.name)).join(", ") + "):", nodeId, indent);
      const body = String(node.config?.source ?? "") === "" ? ["pass"] : String(node.config?.source ?? "").split("\n");
      for (const line of body) emit(line, null, indent + 1);
      if (!body.some((line) => /^\s*return\b/.test(line)) && pins.outputs.length) {
        emit("return " + pins.outputs.map((pin) => pyIdent(pin.name)).join(", "), null, indent + 1);
      }
      const call = fn + "(" + args.join(", ") + ")";
      emit(pins.outputs.length ? pyIdent(nodeId) + " = " + call : call, null, indent);
      const nxt = outEdge(g, id, "then");
      if (nxt?.pin === "break" || nxt?.pin === "continue" || nxt?.pin === "fail") {
        emit(nxt.pin === "fail" ? "continue" : nxt.pin, id + "(" + nxt.pin + ")", indent);
        return;
      }
      id = nxt?.node ?? null;
      continue;
    }
    if (node.type === "code.python") {
      const fn = pyIdent("_code_" + id);
      const source = String(node.config?.source ?? "");
      emit("def " + fn + "():", id, indent);
      for (const line of source === "" ? ["pass"] : source.split("\n")) emit(line, null, indent + 1);
      emit(fn + "()", null, indent);
      const nxt = outEdge(g, id, "then");
      if (nxt?.pin === "break" || nxt?.pin === "continue" || nxt?.pin === "fail") {
        emit(nxt.pin === "fail" ? "continue" : nxt.pin, id + "(" + nxt.pin + ")", indent);
        return;
      }
      id = nxt?.node ?? null;
      continue;
    }
    const stmt = compileCall(g, specs, node, subst);
    if (trace && specs.get(node.type)?.latent) emit("__xf_trace(" + JSON.stringify("enter") + ", " + JSON.stringify(id) + ")", null, indent);
    emit(stmt, id, indent);
    if (trace) emit("__xf_trace(" + JSON.stringify("span") + ", " + JSON.stringify(id) + ", " + exitValue(node, stmt) + ")", null, indent);
    const nxt = outEdge(g, id, "then");
    if (nxt?.pin === "break" || nxt?.pin === "continue" || nxt?.pin === "fail") {
      emit(nxt.pin === "fail" ? "continue" : nxt.pin, id + "(" + nxt.pin + ")", indent);
      return;
    }
    id = nxt?.node ?? null;
  }
}

function exitValue(node: FlowNode, stmt: string): string {
  const assigned = /^([A-Za-z_][A-Za-z0-9_]*) = /.exec(stmt);
  if (node.type === "node.find" && assigned) return assigned[1] + " is not None";
  if (assigned) return assigned[1];
  return '""';
}

function mergeHeader(): string[] {
  return [
    "def _xf_pick(*getters):",
    "    for get in getters:",
    "        try:",
    "            value = get()",
    "        except NameError:",
    "            continue",
    "        if value is not None:",
    "            return value",
    "    return None",
    "",
  ];
}

function mergeExpr(g: FlowGraph, node: FlowNode, pin: string, specs?: Map<string, NodeSpec>, subst?: Map<string, string>): string | null {
  const lit = node.inputs?.[pin];
  if (lit !== undefined) return pyRepr(lit);
  const ref = inEdge(g, node.id, pin);
  if (!ref) return null;
  const src = nodeMap(g).get(ref.node);
  if (src && isPure(src)) return compileCall(g, specs ?? new Map(), src, subst);
  if (src?.type === "flow.merge" && ref.pin === "value") return pyIdent(ref.node);
  if (ref.pin === "result" || ref.pin === "node" || ref.pin === "value") return pyIdent(ref.node);
  return pyIdent(ref.node) + "." + ref.pin;
}

function mergeStmt(g: FlowGraph, node: FlowNode, specs?: Map<string, NodeSpec>, subst?: Map<string, string>): string {
  const exprs = ["a", "b", "c"].map((pin) => mergeExpr(g, node, pin, specs, subst)).filter((expr): expr is string => expr !== null);
  if (!exprs.length) return pyIdent(node.id) + " = None";
  return pyIdent(node.id) + " = _xf_pick(" + exprs.map((expr) => "lambda: " + expr).join(", ") + ")";
}

function compileCall(g: FlowGraph, specs: Map<string, NodeSpec>, node: FlowNode, subst?: Map<string, string>): string {
  if (node.meta?.disabled) return "None";
  if (node.type === "flow.merge") return mergeStmt(g, node, specs, subst);
  if (node.type === "data.get") return pyIdent(String(node.inputs?.name ?? ""));
  if (node.type === "data.set") {
    const name = pyIdent(String(node.inputs?.name ?? ""));
    const lit = node.inputs?.value;
    const ref = inEdge(g, node.id, "value");
    let value = "None";
    if (lit !== undefined) value = pyRepr(lit);
    else if (ref) {
      const src = nodeMap(g).get(ref.node);
      if (src?.type === "data.get") value = pyIdent(String(src.inputs?.name ?? ""));
      else if (src && isPure(src)) value = compileCall(g, specs, src, subst);
      else if (ref.pin === "value" && !subst?.has(ref.node + "." + ref.pin)) value = pyIdent(ref.node);
      else value = refExpr(g, ref, specs, subst);
    }
    return name + " = " + value;
  }
  const spec = specs.get(node.type);
  const stmt = spec?.py?.stmt;
  if (!stmt) throw new Error("no compile template for " + node.type);
  const defaults: Record<string, string | number | boolean | null> = {};
  for (const pin of spec?.inputs ?? []) {
    if (pin.default !== undefined) defaults[pin.name] = pin.default;
  }
  return fillStmt(stmt, node, g, defaults, specs, subst);
}

function emitPures(
  g: FlowGraph,
  specs: Map<string, NodeSpec>,
  consumerId: string,
  emit: (text: string, mark: string | null, indent: number) => void,
  indent: number,
  shown: Set<string>,
  subst?: Map<string, string>,
): void {
  const deps: string[] = [];
  for (const edge of g.edges) {
    if (!edge.to.startsWith(consumerId + ".")) continue;
    const srcId = edge.from.slice(0, edge.from.indexOf("."));
    const src = nodeMap(g).get(srcId);
    if (src && isPure(src)) deps.push(srcId);
  }
  for (const srcId of deps) {
    emitPures(g, specs, srcId, emit, indent, shown, subst);
    if (shown.has(srcId)) continue;
    const src = nodeMap(g).get(srcId);
    if (!src || src.meta?.disabled) {
      shown.add(srcId);
      continue;
    }
    shown.add(srcId);
    if (shouldInline(g, src)) continue;
    emit(pyIdent(srcId) + " = " + compileCall(g, specs, src, subst), srcId, indent);
  }
}

function compileState(g: FlowGraph, specs: Map<string, NodeSpec>, opts?: { trace?: boolean }): CompileResult {
  const lines: string[] = [
    "# generated from " + g.name + ".xflow.json by XScript Desktop; do not edit, edit the flow instead",
    "from xscript.android import action, node, system",
    ...extraImports(g, specs),
    "",
  ];
  if (opts?.trace) lines.push(...traceHeader());
  if (g.nodes.some((n) => n.type === "flow.merge")) lines.push(...mergeHeader());
  const map: Record<string, string> = {};
  const emit = (text: string, mark: string | null, indent: number) => {
    lines.push("    ".repeat(indent) + text);
    if (mark) map[String(lines.length)] = mark;
  };
  emitBindings(g, emit);
  for (const node of g.nodes) {
    if (node.type === "flow.def") emitDef(g, specs, node, emit, opts?.trace ?? false);
  }
  const first = outEdge(g, "start", "then");
  emit("pc = " + pyRepr(first?.node ?? ""), null, 0);
  emit("while True:", null, 0);
  const owned = new Set<string>();
  const trace = opts?.trace ?? false;
  for (const id of stateOrder(g)) {
    const node = nodeMap(g).get(id);
    if (!node || node.type === "event.start" || node.type === "flow.def" || node.type === "flow.macro" || owned.has(id)) continue;
    if (node.type === "flow.branch") {
      emit("if pc == " + pyRepr(id) + ":", id, 1);
      const cond = inEdge(g, id, "cond");
      if (!cond) throw new Error("branch without condition");
      emitPures(g, specs, id, emit, 2, new Set());
      const then = outEdge(g, id, "then");
      const els = outEdge(g, id, "else");
      emit("if " + condExpr(g, cond, specs) + ":", null, 2);
      emit(then ? "pc = " + pyRepr(then.node) : "break", null, 3);
      // A missing arm ends the flow, like falling off the structured `if`; staying on this pc would spin forever.
      emit("else:", null, 2);
      emit(els ? "pc = " + pyRepr(els.node) : "break", null, 3);
      emit("continue", null, 2);
      continue;
    }
    const outs = specs.get(node.type)?.exec.out ?? [];
    const join = STATE_JOIN[node.type];
    const exit = STATE_EXIT[node.type] ?? join ?? ((ALIAS_OF[node.type] || STATE_SOLO.has(node.type)) && outs.every((pin) => pin === "then") ? "then" : null);
    if (!exit) throw new Error("state machine cannot lower " + node.type);
    if (STATE_EXIT[node.type]) {
      const inner = loopBody(g, id);
      if (!inner) throw new Error("state machine cannot lower " + node.type + " " + id + ": its body jumps out of the loop");
      for (const member of inner) owned.add(member);
    } else if (join) {
      const inner = regionBody(g, id, regionPins(g, node));
      if (!inner) throw new Error("state machine cannot lower " + node.type + " " + id + ": a branch jumps out of it");
      for (const member of inner) owned.add(member);
    }
    emit("if pc == " + pyRepr(id) + ":", null, 1);
    // One state: this node (and, for a loop, its whole body) compiled the structured way, then a jump.
    const solo: FlowGraph = { ...g, edges: g.edges.filter((edge) => edge.from !== id + "." + exit) };
    compileBlock(solo, specs, id, emit, 2, trace, new Set());
    const nxt = outEdge(g, id, exit);
    if (nxt && nxt.pin !== "break" && nxt.pin !== "continue" && nxt.pin !== "fail") {
      emit("pc = " + pyRepr(nxt.node), null, 2);
      emit("continue", null, 2);
    } else {
      emit("break", null, 2);
    }
  }
  emit("break", null, 1);
  return { python: lines.join("\n") + "\n", lines: map };
}

/** Loops a state can hold whole, keyed by the pin that leaves them. */
const STATE_EXIT: Record<string, string> = { "flow.for_range": "completed", "flow.for_each": "completed", "flow.while": "completed" };
/**
 * Containers a state can hold whole when every inner branch stays inside: the structured code for the container,
 * then a jump along this pin. Keyed by node type.
 */
const STATE_JOIN: Record<string, string> = { "flow.match": "completed", "flow.sequence": "next" };

/** The exec pins that open a container's inner branches (each one compiled inside the container). */
function regionPins(g: FlowGraph, node: FlowNode): string[] {
  if (node.type === "flow.sequence") return sequenceSteps(g, node.id);
  if (node.type === "flow.match") return g.edges.filter((edge) => pinNode(edge.from) === node.id && /^c\d+$/.test(edge.from.slice(node.id.length + 1))).map((edge) => edge.from.slice(node.id.length + 1));
  return [];
}

/** Single-exit nodes without a DSL alias that the structured compiler already knows. */
const STATE_SOLO = new Set(["flow.call", "code.python", "data.set", "flow.merge"]);

/**
 * Nodes run by a loop's body, when the body is closed: every node it reaches is entered only from inside it.
 * null when the body jumps out (a goto to an outer node) or is entered from elsewhere; that needs real states.
 */
function loopBody(g: FlowGraph, loop: string): Set<string> | null {
  return regionBody(g, loop, ["body"]);
}

/**
 * Nodes run by the branches leaving `owner` on `pins`, when they are closed: every node they reach is entered only
 * from inside them (or from one of those pins). null when a branch jumps back to the owner or out to an outer node.
 */
function regionBody(g: FlowGraph, owner: string, pins: string[]): Set<string> | null {
  const inner = new Set<string>();
  const entries = new Set(pins.map((pin) => owner + "." + pin));
  const stack = pins.map((pin) => outEdge(g, owner, pin)?.node).filter((id): id is string => !!id);
  while (stack.length) {
    const id = stack.pop() as string;
    if (inner.has(id)) continue;
    if (id === owner || id === "start") return null;
    inner.add(id);
    stack.push(...successors(g, id));
  }
  for (const edge of g.edges) {
    const to = pinNode(edge.to);
    if (!inner.has(to) || !EXEC_IN.test(edge.to.slice(to.length + 1))) continue;
    const from = pinNode(edge.from);
    if (!inner.has(from) && !entries.has(edge.from)) return null;
  }
  return inner;
}

const EXEC_IN = /^exec$/;

function pinNode(ref: string): string {
  return ref.slice(0, ref.indexOf("."));
}

function pinOf(ref: string): { node: string; pin: string } {
  const dot = ref.indexOf(".");
  return { node: ref.slice(0, dot), pin: ref.slice(dot + 1) };
}

function renamePin(ref: string, rename: Map<string, string>, known: Set<string>): string {
  const dot = ref.indexOf(".");
  const node = ref.slice(0, dot);
  const pin = ref.slice(dot + 1);
  if (rename.has(node)) return rename.get(node) + "." + pin;
  if (!known.has(node)) return "dangling__" + node + "." + pin;
  return ref;
}

/** Set one unwired literal. Callers skip pins that already have a wire. */
export function codePins(node: FlowNode): { inputs: Array<{ name: string; type: string }>; outputs: Array<{ name: string; type: string }> } {
  const read = (raw: string) => {
    const pins: Array<{ name: string; type: string }> = [];
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const split = trimmed.indexOf(":");
      const name = (split < 0 ? trimmed : trimmed.slice(0, split)).trim();
      const type = (split < 0 ? "any" : trimmed.slice(split + 1)).trim() || "any";
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) pins.push({ name, type });
    }
    return pins;
  };
  if (node.type !== "code.python") return { inputs: [], outputs: [] };
  return {
    inputs: read(String(node.config?.inPins ?? "")),
    outputs: read(String(node.config?.outPins ?? "")),
  };
}

export function setCodeIo(graph: FlowGraph, id: string, field: "inPins" | "outPins" | "source", value: string): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === id && node.type === "code.python" ? { ...node, config: { ...node.config, [field]: value } } : node,
    ),
  };
}

export function setNodeInput(graph: FlowGraph, id: string, pin: string, value: string | number | boolean | null): FlowGraph {
  if (!graph.nodes.some((node) => node.id === id)) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === id ? { ...node, inputs: { ...node.inputs, [pin]: value } } : node)),
  };
}

/** Move a literal from a misspelled pin name onto the spec pin. */
export function renameInput(graph: FlowGraph, id: string, from: string, to: string): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.id !== id || !node.inputs || !Object.prototype.hasOwnProperty.call(node.inputs, from)) return node;
      if (Object.prototype.hasOwnProperty.call(node.inputs, to)) return node;
      const inputs = { ...node.inputs };
      inputs[to] = inputs[from] as string | number | boolean | null;
      delete inputs[from];
      return { ...node, inputs };
    }),
  };
}

/** Drop nodes and every wire that touches them. The entry node stays. Neighbors are not joined. */
export function deleteNodes(graph: FlowGraph, ids: readonly string[]): FlowGraph {
  const drop = new Set(ids.filter((id) => id !== "start"));
  if (drop.size === 0) return graph;
  const owner = (pin: string) => pin.slice(0, pin.indexOf("."));
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => !drop.has(node.id)),
    edges: graph.edges.filter((edge) => !drop.has(owner(edge.from)) && !drop.has(owner(edge.to))),
  };
}

/** Paste `fragment` into `base`. Ids that already exist get a `_2` suffix, and refs inside the fragment follow. A ref to a node that is not in the fragment becomes `dangling__`. */
export function mergeFlow(base: FlowGraph, fragment: FlowGraph): FlowGraph {
  const used = new Set(base.nodes.map((node) => node.id));
  const rename = new Map<string, string>();
  const known = new Set<string>();
  const nodes = base.nodes.map((node) => ({ ...node }));
  for (const node of fragment.nodes) {
    if (node.id === "start") continue;
    let id = node.id;
    if (used.has(id)) {
      let n = 2;
      while (used.has(node.id + "_" + n)) n += 1;
      id = node.id + "_" + n;
    }
    used.add(id);
    known.add(id);
    rename.set(node.id, id);
    nodes.push({ ...node, id });
  }
  const edges = base.edges.map((edge) => ({ ...edge }));
  for (const edge of fragment.edges) {
    if (pinNode(edge.from) === "start" || pinNode(edge.to) === "start") continue;
    edges.push({ from: renamePin(edge.from, rename, known), to: renamePin(edge.to, rename, known) });
  }
  return { ...base, nodes, edges };
}

/** Edges whose endpoint is not a node in the graph. */
export function danglingEdges(g: FlowGraph): FlowEdge[] {
  const ids = new Set(g.nodes.map((node) => node.id));
  return g.edges.filter((edge) => !ids.has(pinNode(edge.from)) || !ids.has(pinNode(edge.to)));
}

/** A function and the nodes it reaches, as a flow file that starts by calling it. */
export function promoteFunction(graph: FlowGraph, id: string): string | null {
  const owner = graph.nodes.find((node) => node.id === id && (node.type === "flow.def" || node.type === "flow.macro"));
  if (!owner) return null;
  const keep = new Set<string>();
  const stack = [owner.id];
  while (stack.length) {
    const current = stack.pop();
    if (!current || keep.has(current)) continue;
    keep.add(current);
    for (const edge of graph.edges) {
      if (edge.from.startsWith(current + ".")) stack.push(edge.to.slice(0, edge.to.indexOf(".")));
    }
  }
  const nodes = graph.nodes.filter((node) => keep.has(node.id));
  const edges = graph.edges.filter((edge) => keep.has(edge.from.slice(0, edge.from.indexOf("."))) && keep.has(edge.to.slice(0, edge.to.indexOf("."))));
  const params = String(owner.config?.params ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const inputs: Record<string, string> = {};
  for (const name of params) inputs[name] = "";
  let callId = "run";
  while (keep.has(callId)) callId += "_";
  const call: FlowNode = { id: callId, type: "flow.call", config: { callee: owner.id } };
  if (params.length) call.inputs = inputs;
  const file: FlowGraph = {
    xflow: 1,
    name: owner.id,
    nodes: [{ id: "start", type: "event.start" }, ...nodes, call],
    edges: [...edges, { from: "start.then", to: callId + ".exec" }],
  };
  try {
    return printFlow(file);
  } catch {
    return null;
  }
}

/** The selected nodes as their own flow, so they can be copied as DSL. */
export function snippetFlow(g: FlowGraph, ids: string[]): FlowGraph {
  const selected = new Set(ids);
  const nodes = g.nodes.filter((node) => selected.has(node.id));
  const edges = g.edges.filter((edge) => selected.has(pinNode(edge.from)) && selected.has(pinNode(edge.to)));
  const targeted = new Set(edges.filter((edge) => edge.to.endsWith(".exec")).map((edge) => pinNode(edge.to)));
  const heads = nodes.filter((node) => !targeted.has(node.id));
  const linked = heads.length ? [{ from: "start.then", to: heads[0].id + ".exec" }] : [];
  return { xflow: 1, name: "snippet", nodes: [{ id: "start", type: "event.start" }, ...nodes], edges: [...linked, ...edges] };
}

/** The one-line header printFlow would write for a structured node. The body stays on the canvas. */
function headerLine(graph: FlowGraph, node: FlowNode): string | null {
  const id = node.id;
  if (node.type === "flow.for_range") return "for " + id + " in range(" + (node.inputs?.start ?? 0) + ", " + (node.inputs?.end ?? 0) + "):";
  if (node.type === "flow.for_each") {
    const items = inEdge(graph, id, "items");
    const source = items ? (items.pin === "result" ? items.node : items.node + "." + items.pin) : String(node.config?.items ?? "");
    return source ? "for " + id + " in " + source + ":" : null;
  }
  if (node.type === "flow.while") {
    const cond = inEdge(graph, id, "cond");
    if (!cond) return null;
    return labelPrefix(id) + "while " + cond.node + "." + cond.pin + " max=" + (node.inputs?.max ?? 1) + ":";
  }
  if (node.type === "flow.branch") {
    const cond = inEdge(graph, id, "cond");
    if (!cond) return null;
    return labelPrefix(id) + "if " + cond.node + "." + cond.pin + ":";
  }
  if (node.type === "flow.wait_until") {
    const cond = inEdge(graph, id, "cond");
    const subject = cond ? cond.node + "." + cond.pin + " " : "";
    return labelPrefix(id) + "until " + subject + "timeout=" + (node.inputs?.timeout ?? 0) + " interval=" + (node.inputs?.interval ?? 0) + ":";
  }
  if (node.type === "flow.retry") return labelPrefix(id) + "retry times=" + (node.inputs?.times ?? 1) + ":";
  if (node.type === "flow.try") return labelPrefix(id) + "try:";
  if (node.type === "flow.parallel") return labelPrefix(id) + "parallel:";
  if (node.type === "flow.sequence") return labelPrefix(id) + "seq:";
  if (node.type === "flow.match") {
    const value = inEdge(graph, id, "value");
    const subject = value ? value.node + "." + value.pin : String(node.config?.subject ?? "");
    return labelPrefix(id) + "match " + subject + ":";
  }
  return null;
}

/** One node's edit-mode statement, including wires to nodes outside the selection. */
export function nodeStatement(graph: FlowGraph, id: string): string {
  const node = graph.nodes.find((item) => item.id === id);
  if (!node || node.type === "event.start") return "";
  const prev = printLabels;
  printLabels = { mode: "edit", n: 1 };
  try {
    const header = headerLine(graph, node);
    if (header) return (node.meta?.disabled ? "off " : "") + header;
    if (node.type === "flow.call") return formatSub(graph, node);
    if (node.type === "code.python") {
      const parts: Array<[string, string | number | boolean | null]> = [];
      if (node.config?.inPins !== undefined && node.config.inPins !== "") parts.push(["inPins", node.config.inPins]);
      if (node.config?.outPins !== undefined && node.config.outPins !== "") parts.push(["outPins", node.config.outPins]);
      if (node.config?.source !== undefined && node.config.source !== "") parts.push(["source", node.config.source]);
      for (const [key, value] of Object.entries(node.inputs ?? {})) parts.push([key, value]);
      parts.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      return (node.meta?.disabled ? "off " : "") + labelPrefix(id) + "code(" + parts.map(([key, value]) => key + "=" + jsonLit(value)).join(", ") + ")";
    }
    const alias = ALIAS_OF[node.type];
    if (!alias) return "";
    return (node.meta?.disabled ? "off " : "") + formatCall(graph, id, alias, argsOf(graph, id));
  } catch {
    return "";
  } finally {
    printLabels = prev;
  }
}

function renameNode(graph: FlowGraph, from: string, to: string): FlowGraph {
  const swap = (ref: string) => {
    const dot = ref.indexOf(".");
    if (dot < 0) return ref;
    return (ref.slice(0, dot) === from ? to : ref.slice(0, dot)) + ref.slice(dot);
  };
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.id === from) return { ...node, id: to };
      if (node.config?.callee === from) return { ...node, config: { ...node.config, callee: to } };
      return node;
    }),
    edges: graph.edges.map((edge) => ({ from: swap(edge.from), to: swap(edge.to) })),
  };
}

/** Replace one node's statement. A bad line leaves the caller to keep the old graph. Exec wires stay. */
export function applyNodeStatement(graph: FlowGraph, id: string, line: string): FlowGraph | null {
  const trimmed = line.trim();
  if (!trimmed || !graph.nodes.some((node) => node.id === id)) return null;
  let parsed: FlowGraph;
  try {
    parsed = parse(["flow snippet  # xflow 1", "on start:", "  " + trimmed, ""].join("\n"));
  } catch {
    return null;
  }
  const body = parsed.nodes.filter((node) => node.type !== "event.start");
  const label = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(trimmed);
  const main = body.find((node) => node.id === label?.[1]) ?? (body.length === 1 ? body[0] : undefined);
  if (!main) return null;
  const extras = body.filter((node) => node.id !== main.id);
  if (extras.some((node) => graph.nodes.some((have) => have.id === node.id && have.id !== id))) return null;
  if (main.id !== id && graph.nodes.some((node) => node.id === main.id)) return null;
  const renamed = main.id === id ? graph : renameNode(graph, id, main.id);
  const target = main.id;
  const kept = renamed.edges.filter((edge) => {
    if (!edge.to.startsWith(target + ".")) return true;
    const pin = edge.to.slice(target.length + 1);
    return pin === "exec" || pin === "break" || pin === "continue" || pin === "fail";
  });
  const added = parsed.edges.filter((edge) => !edge.from.startsWith("start.") && !edge.to.endsWith(".exec"));
  const nodes = [
    ...renamed.nodes.map((node) =>
      node.id === target ? { ...node, type: main.type, inputs: main.inputs, config: main.config, meta: main.meta } : node,
    ),
    ...extras.filter((node) => !renamed.nodes.some((have) => have.id === node.id)),
  ];
  return { ...renamed, nodes, edges: [...kept, ...added] };
}

/** Copy the selected nodes beside themselves. Internal wires stay. Wires that leave the selection are not copied. */
export function duplicateNodes(graph: FlowGraph, ids: readonly string[]): { graph: FlowGraph; copies: Array<{ id: string; from: string }> } {
  const selected = ids.filter((id) => id !== "start" && graph.nodes.some((node) => node.id === id));
  if (!selected.length) return { graph, copies: [] };
  const before = new Set(graph.nodes.map((node) => node.id));
  const next = mergeFlow(graph, snippetFlow(graph, [...selected]));
  const known = new Set(selected);
  const copies = next.nodes
    .map((node) => node.id)
    .filter((id) => !before.has(id))
    .map((id) => {
      const split = /^(.*)_(\d+)$/.exec(id);
      const from = split && known.has(split[1]) ? split[1] : id;
      return { id, from };
    });
  return { graph: next, copies };
}

function copyOf<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pythonBody(python: string): string {
  const lines = python.replace(/\n$/, "").split("\n");
  const blank = lines.findIndex((line, index) => index > 0 && line === "");
  return lines.slice(blank + 1).join("\n");
}

function foldedSource(nodes: FlowNode[], edges: FlowEdge[], entry: string, specs: Map<string, NodeSpec>): string {
  const graph: FlowGraph = {
    xflow: 1,
    name: "folded",
    nodes: [{ id: "start", type: "event.start" }, ...nodes],
    edges: [{ from: "start.then", to: entry + ".exec" }, ...edges],
  };
  return pythonBody(compile(graph, specs).python);
}

/** Fold a straight selection into one code.python node. The original subgraph stays on meta.origin. */
export function foldGraph(g: FlowGraph, ids: string[], codeId: string, specs: Map<string, NodeSpec>): FlowGraph {
  const selected = new Set(ids);
  if (!selected.size) throw new Error("empty selection");
  if (selected.has("start")) throw new Error("cannot fold start");
  const inside = (ref: string) => selected.has(pinOf(ref).node);
  const chosen = g.nodes.filter((node) => selected.has(node.id));
  if (chosen.length !== selected.size) throw new Error("missing node");
  const internal = g.edges.filter((edge) => inside(edge.from) && inside(edge.to));
  const incoming = g.edges.filter((edge) => !inside(edge.from) && inside(edge.to));
  const outgoing = g.edges.filter((edge) => inside(edge.from) && !inside(edge.to));
  const execIn = incoming.filter((edge) => pinOf(edge.to).pin === "exec");
  if (execIn.length !== 1) throw new Error("selection needs one exec entry");
  const entry = pinOf(execIn[0].to).node;
  const execLeaves = outgoing.filter((edge) => {
    const pin = pinOf(edge.from).pin;
    return pin === "then" || pin === "completed" || pin === "joined";
  });
  const dataIn = incoming.filter((edge) => pinOf(edge.to).pin !== "exec");
  const dataOut = outgoing.filter((edge) => !execLeaves.includes(edge));
  const origin: CodeOrigin = {
    nodes: copyOf(chosen),
    edges: copyOf(internal),
    entry,
    execOut: execLeaves.map((edge, index) => ({
      from: pinOf(edge.from).node,
      pin: pinOf(edge.from).pin,
      codePin: execLeaves.length === 1 ? "then" : "out" + index,
    })),
    dataIn: dataIn.map((edge) => ({ codePin: pinOf(edge.to).node + "_" + pinOf(edge.to).pin, to: pinOf(edge.to).node, pin: pinOf(edge.to).pin })),
    dataOut: dataOut.map((edge) => ({
      codePin: pinOf(edge.from).node + "_" + pinOf(edge.from).pin,
      from: pinOf(edge.from).node,
      pin: pinOf(edge.from).pin,
    })),
  };
  const code: FlowNode = {
    id: codeId,
    type: "code.python",
    config: { source: foldedSource(origin.nodes, origin.edges, entry, specs) },
    meta: { origin },
  };
  const edges: FlowEdge[] = g.edges.filter((edge) => !inside(edge.from) && !inside(edge.to));
  edges.push({ from: execIn[0].from, to: codeId + ".exec" });
  origin.execOut.forEach((out, index) => edges.push({ from: codeId + "." + out.codePin, to: execLeaves[index].to }));
  for (const edge of dataIn) edges.push({ from: edge.from, to: codeId + "." + pinOf(edge.to).node + "_" + pinOf(edge.to).pin });
  for (const edge of dataOut) edges.push({ from: codeId + "." + pinOf(edge.from).node + "_" + pinOf(edge.from).pin, to: edge.to });
  return { ...g, nodes: [...g.nodes.filter((node) => !selected.has(node.id)), code], edges };
}

export function unfoldGraph(
  g: FlowGraph,
  codeId: string,
  specs: Map<string, NodeSpec>,
  opts?: { prefer?: "origin" },
): { ok: true; graph: FlowGraph } | { ok: false; reason: "edited" | "missing" } {
  const node = g.nodes.find((item) => item.id === codeId);
  const origin = node?.meta?.origin;
  if (!node || node.type !== "code.python" || !origin?.entry) return { ok: false, reason: "missing" };
  const fresh = foldedSource(origin.nodes, origin.edges, origin.entry, specs);
  if (fresh !== String(node.config?.source ?? "") && opts?.prefer !== "origin") return { ok: false, reason: "edited" };
  const edges: FlowEdge[] = [];
  for (const edge of g.edges) {
    if (pinOf(edge.from).node === codeId || pinOf(edge.to).node === codeId) continue;
    edges.push(edge);
  }
  const entryEdge = g.edges.find((edge) => edge.to === codeId + ".exec");
  if (entryEdge) edges.push({ from: entryEdge.from, to: origin.entry + ".exec" });
  for (const out of origin.execOut) {
    const edge = g.edges.find((item) => item.from === codeId + "." + out.codePin);
    if (edge) edges.push({ from: out.from + "." + out.pin, to: edge.to });
  }
  for (const input of origin.dataIn) {
    const edge = g.edges.find((item) => item.to === codeId + "." + input.codePin);
    if (edge) edges.push({ from: edge.from, to: input.to + "." + input.pin });
  }
  for (const output of origin.dataOut) {
    const edge = g.edges.find((item) => item.from === codeId + "." + output.codePin);
    if (edge) edges.push({ from: output.from + "." + output.pin, to: edge.to });
  }
  edges.push(...origin.edges);
  return { ok: true, graph: { ...g, nodes: [...g.nodes.filter((item) => item.id !== codeId), ...copyOf(origin.nodes)], edges } };
}
