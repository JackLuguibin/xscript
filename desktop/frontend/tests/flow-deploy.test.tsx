import { execFileSync } from "node:child_process";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi, type Api } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { FlowPage } from "../src/components/FlowPage";
import { createDemoTransport } from "../src/demo";
import { deployPlan, entryStub, isEntryStub, pushPlan, STUB_MARK, type DeployApi } from "../src/flow/deploy";
import { parse, printFlow, type FlowGraph } from "../src/flow/dsl";
import { layoutFromGraph } from "../src/flow/layout";
import { mapGraph, type FlowSourceMap } from "../src/flow/map";
import { SAMPLE_FLOW } from "../src/flow/sample";
import { builtinSpecs } from "../src/flow/specs";

const specs = builtinSpecs();
const DEV = "adb:emulator-5554";

function parsesAsPython(sources: string[]): void {
  execFileSync("python3", ["-c", "import ast,sys\nfor part in sys.stdin.read().split('\\n# ---SPLIT---\\n'):\n    ast.parse(part)\n"], {
    input: sources.join("\n# ---SPLIT---\n"),
  });
}

describe("deploy plan", () => {
  it("lays the traced build, the flow text and the entry stub out as a project named after the flow", () => {
    const graph = parse(SAMPLE_FLOW);
    const plan = deployPlan(graph, specs);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.project).toBe("daily_signin");
    expect(plan.files.map((file) => file.path)).toEqual(["flows/__init__.py", "flows/daily_signin.py", "flows/daily_signin.xflow", "flows/daily_signin.xflow.map.json", "__init__.py"]);
    const byPath = new Map(plan.files.map((file) => [file.path, file.content]));
    expect(byPath.get("flows/daily_signin.py")).toContain("__xf_trace");
    expect(byPath.get("flows/daily_signin.xflow")).toBe(printFlow(graph));
    expect(byPath.get("__init__.py")).toBe(entryStub("daily_signin"));
    expect(entryStub("daily_signin")).toContain("from .flows import daily_signin");
    parsesAsPython([byPath.get("flows/daily_signin.py") ?? "", byPath.get("__init__.py") ?? ""]);
  });

  it("ships the source map of the traced build, and the layout when there is one", () => {
    const graph = parse(SAMPLE_FLOW);
    const layout = layoutFromGraph(graph);
    const plan = deployPlan(graph, specs, layout);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.files.map((file) => file.path).slice(-3)).toEqual(["flows/daily_signin.xflow.map.json", "flows/daily_signin.xflow.layout.json", "__init__.py"]);
    const byPath = new Map(plan.files.map((file) => [file.path, file.content]));
    const map = JSON.parse(byPath.get("flows/daily_signin.xflow.map.json") ?? "{}") as FlowSourceMap;
    expect(map).toEqual(plan.map);
    expect(map.file).toBe("flows/daily_signin.py");
    expect(JSON.parse(byPath.get("flows/daily_signin.xflow.layout.json") ?? "{}")).toEqual(layout);
    // The map describes the traced build that is deployed, which is longer than the untraced one.
    const lines = (byPath.get("flows/daily_signin.py") ?? "").split("\n");
    const editor = mapGraph(graph, specs);
    expect(map.nodes.tap).toBeDefined();
    expect(map.nodes.tap).not.toEqual(editor.nodes.tap);
    for (const line of map.nodes.tap ?? []) expect(lines[Number(line) - 1]).not.toBe(undefined);
    expect(map.nodes.tap?.some((line) => /click/.test(lines[Number(line) - 1] ?? ""))).toBe(true);
    for (const [id, rows] of Object.entries(map.nodes)) {
      expect(graph.nodes.some((node) => node.id === id)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it("refuses a flow name that is not a project name, and a graph that does not compile", () => {
    const graph = parse(SAMPLE_FLOW);
    expect(deployPlan({ ...graph, name: "9lives" }, specs)).toEqual({ ok: false, reason: "name", detail: "9lives" });
    expect(deployPlan({ ...graph, name: "has-dash" }, specs)).toMatchObject({ ok: false, reason: "name" });
    const broken: FlowGraph = { xflow: 1, name: "broken", nodes: [{ id: "start", type: "event.start" }, { id: "c", type: "flow.call", config: { callee: "nope" } }], edges: [{ from: "start.then", to: "c.exec" }] };
    const plan = deployPlan(broken, specs);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("compile");
    expect(plan.detail).toContain("nope");
  });

  it("recognises only its own entry stub", () => {
    expect(isEntryStub(entryStub("x"))).toBe(true);
    expect(isEntryStub("print('hello')\n")).toBe(false);
    expect(isEntryStub("\n" + STUB_MARK)).toBe(false);
  });
});

function fakeApi(projects: Record<string, Record<string, string>>) {
  const calls: string[] = [];
  const api: DeployApi = {
    projects: async () => ({ projects: Object.keys(projects).map((name) => ({ name })) }),
    createProject: async (_id, project) => {
      calls.push("create " + project);
      projects[project] = { "__init__.py": "print('hello')\n" };
      return { ok: true };
    },
    files: async (_id, project) => ({ files: Object.keys(projects[project] ?? {}).map((path) => ({ path })) }),
    readFile: async (_id, project, path) => ({ content: projects[project][path] }),
    writeFile: async (_id, project, path, content) => {
      calls.push("write " + path);
      projects[project][path] = content;
      return { ok: true };
    },
  };
  return { api, calls };
}

describe("pushing a plan", () => {
  const plan = { project: "p", files: [{ path: "flows/__init__.py", content: "" }, { path: "flows/p.py", content: "x = 1\n" }, { path: "__init__.py", content: entryStub("p") }] };

  it("creates a new project and replaces its default entry first", async () => {
    const { api, calls } = fakeApi({});
    expect(await pushPlan(api, DEV, plan)).toEqual({ ok: true, created: true });
    expect(calls).toEqual(["create p", "write __init__.py", "write flows/__init__.py", "write flows/p.py"]);
  });

  it("overwrites a project it wrote before, entry last", async () => {
    const { api, calls } = fakeApi({ p: { "__init__.py": entryStub("p"), "flows/p.py": "old\n" } });
    expect(await pushPlan(api, DEV, plan)).toEqual({ ok: true, created: false });
    expect(calls).toEqual(["write flows/__init__.py", "write flows/p.py", "write __init__.py"]);
  });

  it("leaves a hand-written project with the same name alone", async () => {
    const files = { p: { "__init__.py": "print('mine')\n" } };
    const { api, calls } = fakeApi(files);
    expect(await pushPlan(api, DEV, plan)).toEqual({ ok: false, reason: "foreign" });
    expect(calls).toEqual([]);
    expect(files.p["__init__.py"]).toBe("print('mine')\n");
  });

  it("fills a project that has no entry yet", async () => {
    const { api, calls } = fakeApi({ p: {} });
    expect(await pushPlan(api, DEV, plan)).toEqual({ ok: true, created: false });
    expect(calls[calls.length - 1]).toBe("write __init__.py");
  });
});

async function mount(patch?: (api: Api) => Partial<Api>) {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const base = createApi(rpc);
  await base.connectAdb("emulator-5554");
  const api = { ...base, ...(patch ? patch(base) : {}) } as Api;
  render(
    <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
      <FlowPage />
    </ServicesContext.Provider>,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { api: base, transport };
}

const status = () => screen.getAllByRole("status").map((item) => item.textContent ?? "").join(" | ");

describe("run on device", () => {
  it("asks for a device first", () => {
    render(<FlowPage />);
    fireEvent.click(screen.getByRole("button", { name: "在设备上运行" }));
    expect(status()).toContain("还没有连接设备");
  });

  it("writes the project, runs it, follows the log, and stops it", async () => {
    const { api, transport } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "在设备上运行" }));
    await waitFor(() => expect(status()).toContain("已在设备上运行工程 daily_signin"));
    const files = (await api.files(DEV, "daily_signin")).files.map((file) => file.path);
    expect(files).toEqual(expect.arrayContaining(["__init__.py", "flows/__init__.py", "flows/daily_signin.py", "flows/daily_signin.xflow"]));
    expect(isEntryStub((await api.readFile(DEV, "daily_signin", "__init__.py")).content)).toBe(true);
    // Following polls device.logs again and again; the first read only finds the end of the log.
    await waitFor(() => expect(transport.sent.filter((item) => item.method === "device.logs").length).toBeGreaterThanOrEqual(3));
    fireEvent.click(screen.getByRole("button", { name: "停止设备运行" }));
    await waitFor(() => expect(status()).toContain("已停止设备上的工程 daily_signin"));
    expect(screen.getByRole("button", { name: "在设备上运行" })).toBeTruthy();
    // A second run reuses the project it wrote.
    fireEvent.click(screen.getByRole("button", { name: "在设备上运行" }));
    await waitFor(() => expect(status()).toContain("已在设备上运行工程 daily_signin"));
  });

  it("does not overwrite a device project it did not write", async () => {
    const { api } = await mount();
    await api.createProject(DEV, "daily_signin");
    fireEvent.click(screen.getByRole("button", { name: "在设备上运行" }));
    await waitFor(() => expect(status()).toContain("它的入口不是流程编辑器生成的"));
    expect((await api.readFile(DEV, "daily_signin", "__init__.py")).content).toBe("print('hello')\n");
  });

  it("reports a busy device and a failed write", async () => {
    const { api } = await mount();
    await api.run(DEV, "demo");
    fireEvent.click(screen.getByRole("button", { name: "在设备上运行" }));
    await waitFor(() => expect(status()).toContain("发到设备失败：already running"));
    await api.stop(DEV, "demo");
  });

  it("reports a write error from the device", async () => {
    await mount(() => ({ writeFile: () => Promise.reject({ code: "device.http", message: "disk full" }) }));
    fireEvent.click(screen.getByRole("button", { name: "在设备上运行" }));
    await waitFor(() => expect(status()).toContain("发到设备失败"));
    expect(screen.getByRole("button", { name: "在设备上运行" })).toBeTruthy();
  });

  it("notices when the project ends on the device", async () => {
    const { transport } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "在设备上运行" }));
    await waitFor(() => expect(status()).toContain("已在设备上运行工程"));
    act(() => {
      transport.push({ event: true, topic: "device.state", data: { id: "adb:other", status: { running: false } } });
      transport.push({ event: true, topic: "device.state", data: { id: DEV, status: { running: false } } });
    });
    expect(screen.getByRole("button", { name: "停止设备运行" })).toBeTruthy();
    act(() => {
      transport.push({ event: true, topic: "device.state", data: { id: DEV, status: { running: true } } });
      transport.push({ event: true, topic: "device.state", data: { id: DEV, status: { running: false } } });
    });
    await waitFor(() => expect(status()).toContain("设备上的工程 daily_signin 已结束"));
    expect(screen.getByRole("button", { name: "在设备上运行" })).toBeTruthy();
  });

  it("maps a device traceback from the deployed build back to its node, after the run ended", async () => {
    const plan = deployPlan(parse(SAMPLE_FLOW), specs);
    if (!plan.ok) throw new Error("sample does not deploy");
    const line = Number(plan.map.nodes.tap?.[0]);
    const traceback = [
      "Traceback (most recent call last):",
      '  File "/data/user/0/com.xscript/files/projects/daily_signin/__init__.py", line 2, in <module>',
      `  File "/data/user/0/com.xscript/files/projects/daily_signin/flows/daily_signin.py", line ${line}, in main`,
      "RuntimeError: node gone",
    ];
    let ran = false;
    const { transport } = await mount((base) => ({
      run: (id: string, project: string) => {
        ran = true;
        return base.run(id, project);
      },
      logs: async () => (ran ? { entries: traceback.map((text, i) => ({ seq: i + 1, ts: 0, stream: "stderr", line: text })), next: traceback.length } : { entries: [], next: 0 }),
    }));
    fireEvent.click(screen.getByRole("tab", { name: /问题/ }));
    expect(screen.queryByText(/运行错误 · /)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "在设备上运行" }));
    const row = await screen.findByRole("button", { name: new RegExp(`运行错误 · tap（flows/daily_signin.py 第 ${line} 行）：RuntimeError: node gone`) });
    act(() => {
      transport.push({ event: true, topic: "device.state", data: { id: DEV, status: { running: true } } });
      transport.push({ event: true, topic: "device.state", data: { id: DEV, status: { running: false } } });
    });
    await waitFor(() => expect(status()).toContain("已结束"));
    expect(screen.getByRole("button", { name: /运行错误 · tap/ })).toBe(row);
    expect(screen.getByRole("tab", { name: /问题/ }).textContent).toMatch(/\d/);
    fireEvent.click(row);
    expect(screen.getByLabelText("tap " + "运行错误")).toBeTruthy();
  });

  it("does not blame a traceback from another file on the deployed flow", async () => {
    let ran = false;
    const traceback = ["Traceback (most recent call last):", '  File "/x/projects/other/__init__.py", line 3, in <module>', "ValueError: nope"];
    await mount((base) => ({
      run: (id: string, project: string) => {
        ran = true;
        return base.run(id, project);
      },
      logs: async () => (ran ? { entries: traceback.map((text, i) => ({ seq: i + 1, ts: 0, stream: "stderr", line: text })), next: traceback.length } : { entries: [], next: 0 }),
    }));
    fireEvent.click(screen.getByRole("tab", { name: /问题/ }));
    fireEvent.click(screen.getByRole("button", { name: "在设备上运行" }));
    await waitFor(() => expect(status()).toContain("已在设备上运行工程 daily_signin"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/运行错误 · /)).toBeNull();
  });

  it("uses the flow name as the project name", async () => {
    await mount();
    const box = screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: ["flow _x  # xflow 1", "on start:", '  log(message="a")', ""].join("\n") } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    fireEvent.click(screen.getByRole("button", { name: "在设备上运行" }));
    await waitFor(() => expect(status()).toContain("已在设备上运行工程 _x"));
  });
});
