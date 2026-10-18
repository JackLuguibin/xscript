import { compile, printFlow, type FlowGraph, type NodeSpec } from "./dsl";

/** First line of the entry stub this editor writes. Only a project whose `__init__.py` starts with it is overwritten. */
export const STUB_MARK = "# xscript-desktop flow entry: regenerated on every run from the flow editor, edit the flow instead";

const PROJECT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DeployFile {
  path: string;
  content: string;
}

export type DeployPlan =
  | { ok: true; project: string; files: DeployFile[] }
  | { ok: false; reason: "name" | "compile"; detail: string };

/** The stub imports the generated module, which runs the flow (the device imports the project as a package, §10.2). */
export function entryStub(name: string): string {
  return [STUB_MARK, "from .flows import " + name + "  # noqa: F401  importing the module runs the flow", ""].join("\n");
}

export function isEntryStub(content: string): boolean {
  return content.startsWith(STUB_MARK);
}

/**
 * Files for running this flow as the device project named after it: the traced build in `flows/<name>.py`,
 * the flow text next to it, and the entry stub. Same layout as design §10.2 (relative import, no `__main__` guard).
 */
export function deployPlan(graph: FlowGraph, specs: Map<string, NodeSpec>): DeployPlan {
  const name = graph.name;
  if (!PROJECT_NAME.test(name)) return { ok: false, reason: "name", detail: name };
  let python: string;
  try {
    python = compile(graph, specs, { trace: true }).python;
  } catch (err) {
    return { ok: false, reason: "compile", detail: err instanceof Error ? err.message : String(err) };
  }
  return {
    ok: true,
    project: name,
    files: [
      { path: "flows/__init__.py", content: "" },
      { path: "flows/" + name + ".py", content: python },
      { path: "flows/" + name + ".xflow", content: printFlow(graph) },
      { path: "__init__.py", content: entryStub(name) },
    ],
  };
}

export interface DeployApi {
  projects(id: string): Promise<{ projects: Array<{ name: string }> }>;
  createProject(id: string, project: string): Promise<{ ok: boolean }>;
  files(id: string, project: string): Promise<{ files: Array<{ path: string }> }>;
  readFile(id: string, project: string, path: string): Promise<{ content: string }>;
  writeFile(id: string, project: string, path: string, content: string, create?: boolean): Promise<{ ok: boolean }>;
}

export type DeployOutcome = { ok: true; created: boolean } | { ok: false; reason: "foreign" };

/**
 * Write the plan to the device. A new project is created. An existing project is only overwritten when its entry
 * is our stub (or it has none), so a hand-written project that happens to share the flow's name is never touched.
 */
export async function pushPlan(api: DeployApi, devId: string, plan: { project: string; files: readonly DeployFile[] }): Promise<DeployOutcome> {
  const listed = await api.projects(devId);
  const exists = listed.projects.some((item) => item.name === plan.project);
  if (exists) {
    const tree = await api.files(devId, plan.project);
    if (tree.files.some((item) => item.path === "__init__.py")) {
      const entry = await api.readFile(devId, plan.project, "__init__.py");
      if (!isEntryStub(entry.content)) return { ok: false, reason: "foreign" };
    }
  } else {
    await api.createProject(devId, plan.project);
  }
  // On an existing project the entry goes last, so a write that fails half way leaves the earlier stub and build.
  // On a new project it goes first, replacing the device's default entry, so a retry still recognises the project as ours.
  const entry = plan.files.filter((file) => file.path === "__init__.py");
  const rest = plan.files.filter((file) => file.path !== "__init__.py");
  for (const file of exists ? [...rest, ...entry] : [...entry, ...rest]) await api.writeFile(devId, plan.project, file.path, file.content);
  return { ok: true, created: !exists };
}
