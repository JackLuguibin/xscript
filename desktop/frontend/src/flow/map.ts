import { compile, type CompileResult, type FlowGraph, type NodeSpec } from "./dsl";

/** The design's `*.xflow.map.json`: line → node, plus the reverse index. */
export interface FlowSourceMap {
  version: 1;
  file: string;
  lines: Record<string, string>;
  nodes: Record<string, string[]>;
}

export function sourceMap(result: CompileResult, file = "main.py"): FlowSourceMap {
  const nodes: Record<string, string[]> = {};
  for (const [line, mark] of Object.entries(result.lines)) {
    const id = mark.split("(")[0];
    if (!id) continue;
    (nodes[id] ??= []).push(line);
  }
  for (const id of Object.keys(nodes)) nodes[id].sort((a, b) => Number(a) - Number(b));
  return { version: 1, file, lines: result.lines, nodes };
}

export function mapGraph(graph: FlowGraph, specs: Map<string, NodeSpec>, file = "main.py"): FlowSourceMap {
  return sourceMap(compile(graph, specs), file);
}

export interface FlowFault {
  node: string;
  line: number;
  message: string;
}

function baseName(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** The last `File ".../main.py", line N` in the last traceback, looked up in the source map. */
export function blame(log: string, map: FlowSourceMap): FlowFault | null {
  const parts = log.split("Traceback (most recent call last):");
  if (parts.length < 2) return null;
  const block = parts[parts.length - 1] ?? "";
  const frames: { file: string; line: number }[] = [];
  for (const hit of block.matchAll(/File "([^"]+)", line (\d+)/g)) {
    frames.push({ file: hit[1] ?? "", line: Number(hit[2]) });
  }
  const own = frames.filter((frame) => baseName(frame.file) === baseName(map.file));
  const frame = own[own.length - 1];
  if (!frame) return null;
  const mark = map.lines[String(frame.line)];
  if (!mark) return null;
  const node = mark.split("(")[0] ?? "";
  if (!node) return null;
  let message = "";
  for (const raw of block.split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith(" ") || raw.startsWith("\t")) continue;
    message = raw.trim();
  }
  return { node, line: frame.line, message };
}
