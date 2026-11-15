import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { MemoryTransport } from "../src/bridge/memory";
import { CloudManagement } from "../src/components/CloudManagement";
import { FlowDelivery } from "../src/components/FlowDelivery";
import { parse } from "../src/flow/dsl";
import { SAMPLE_FLOW } from "../src/flow/sample";
import { layoutFromGraph } from "../src/flow/layout";
import { alignNodes } from "../src/flow/align";

const admin = {
  username: "alice",
  role: "admin" as const,
  canOperate: true,
  isAdmin: true,
};
function setup(
  handlers: ConstructorParameters<typeof MemoryTransport>[0] = {},
) {
  const transport = new MemoryTransport({
    "debug.status": () => ({ state: "idle", frames: [] }),
    "device.list": () => ({ devices: [] }),
    "app.setUnsaved": (p) => p,
    ...handlers,
  });
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  return { transport, services: { rpc, api, inShell: true } };
}

describe("native management", () => {
  it("creates a script with named fields and uploads a version", async () => {
    const { transport, services } = setup({
      "cloud.manage": (p) =>
        p.action === "list"
          ? { items: [{ id: 1, name: "demo", project_name: "demo" }] }
          : { id: 2 },
      "cloud.upload": () => ({ id: 2 }),
    });
    render(
      <ServicesContext.Provider value={services}>
        <CloudManagement account={admin} />
      </ServicesContext.Provider>,
    );
    await screen.findAllByText("demo", { selector: "td span" });
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "test" },
    });
    fireEvent.change(screen.getByLabelText("工程名"), {
      target: { value: "test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(transport.sent.some((r) => r.params?.action === "create")).toBe(
        true,
      ),
    );
    expect(
      transport.sent.find((r) => r.params?.action === "create")?.params?.body,
    ).toMatchObject({ name: "test", project_name: "test", protect: false });
    fireEvent.click(
      await screen.findByRole("button", { name: "上传版本 ZIP" }),
    );
    await waitFor(() =>
      expect(transport.sent.some((r) => r.method === "cloud.upload")).toBe(
        true,
      ),
    );
  });
  it("keeps viewer writes disabled and displays backend failures", async () => {
    const { services } = setup({
      "cloud.manage": () => {
        throw { code: "backend.unreachable", message: "service unavailable" };
      },
    });
    render(
      <ServicesContext.Provider value={services}>
        <CloudManagement
          account={{
            ...admin,
            role: "viewer",
            isAdmin: false,
            canOperate: false,
          }}
        />
      </ServicesContext.Provider>,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "service unavailable",
    );
    expect(
      (screen.getByRole("button", { name: "新建" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("option", { name: "用户" }) as HTMLOptionElement)
        .disabled,
    ).toBe(true);
  });
  it("confirms destructive actions and renders trend series", async () => {
    const { services, transport } = setup({
      "cloud.manage": (p) =>
        p.resource === "trends"
          ? { days: ["one", "two"], series: { online_devices: [1, 3] } }
          : { items: [{ id: 1, name: "demo" }] },
    });
    render(
      <ServicesContext.Provider value={services}>
        <CloudManagement account={admin} />
      </ServicesContext.Provider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
    await waitFor(() =>
      expect(transport.sent.some((r) => r.params?.action === "delete")).toBe(
        true,
      ),
    );
    fireEvent.change(screen.getByLabelText("管理分区"), {
      target: { value: "trends" },
    });
    expect(
      await screen.findByRole("img", { name: "Daily trends" }),
    ).toBeTruthy();
  });
});

describe("flow delivery", () => {
  it("saves local text with layout and exports portable compiled files", async () => {
    const { services, transport } = setup({
      "flow.saveDocument": (p) => ({ handle: "h1", name: p.name }),
    });
    const graph = parse(SAMPLE_FLOW);
    const layout = layoutFromGraph(graph);
    render(
      <ServicesContext.Provider value={services}>
        <FlowDelivery
          graph={graph}
          text={SAMPLE_FLOW}
          layout={layout}
          breaks={[]}
          currentDevice=""
          onOpen={vi.fn()}
          onPick={vi.fn()}
          onRun={vi.fn()}
        />
      </ServicesContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/已保存/);
    const save = transport.sent.find((r) => r.method === "flow.saveDocument")!;
    expect(save.params?.content).toBe(SAMPLE_FLOW);
    expect(save.params?.layout).toEqual(layout);
    fireEvent.click(screen.getByRole("button", { name: "导出流程包" }));
    await waitFor(() =>
      expect(
        transport.sent.filter((r) => r.method === "flow.saveDocument").length,
      ).toBe(2),
    );
    const exported = transport.sent.filter(
      (r) => r.method === "flow.saveDocument",
    )[1];
    expect(
      JSON.parse(String(exported.params?.content)).files.some(
        (f: { path: string }) => f.path.endsWith(".xflow.map.json"),
      ),
    ).toBe(true);
  });
  it("opens a native flow and keeps batch failures isolated", async () => {
    const graph = parse(SAMPLE_FLOW);
    const layout = layoutFromGraph(graph);
    const opened = vi.fn();
    const { services, transport } = setup({
      "flow.openDocument": () => ({
        name: "demo.xflow",
        handle: "h",
        content: SAMPLE_FLOW,
        layout,
      }),
      "device.list": () => ({
        devices: [
          { id: "first", state: "online", info: {} },
          { id: "second", state: "online", info: {} },
        ],
      }),
      "project.list": (p) => {
        if (p.id === "first") throw Error("first offline");
        return { projects: [] };
      },
      "project.create": () => ({ ok: true }),
      "project.writeFile": () => ({ ok: true }),
    });
    // Use API methods directly so this test remains independent of project RPC naming.
    services.api.projects = vi.fn(async (id) => {
      if (id === "first") throw Error("first offline");
      return { projects: [] };
    });
    services.api.createProject = vi.fn(async () => ({ ok: true }));
    services.api.writeFile = vi.fn(async () => ({ ok: true }));
    render(
      <ServicesContext.Provider value={services}>
        <FlowDelivery
          graph={graph}
          text={SAMPLE_FLOW}
          layout={layout}
          breaks={[]}
          currentDevice=""
          onOpen={opened}
          onPick={vi.fn()}
          onRun={vi.fn()}
        />
      </ServicesContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "打开 / 导入" }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith(graph, layout));
    const checks = within(
      screen.getByRole("group", { name: "批量推送目标" }),
    ).getAllByRole("checkbox");
    checks.forEach((check) => fireEvent.click(check));
    fireEvent.click(screen.getByRole("button", { name: "推送" }));
    await screen.findByText("first offline");
    await screen.findByText("成功");
    expect(services.api.writeFile).toHaveBeenCalled();
    expect(transport.sent.some((r) => r.method === "device.list")).toBe(true);
  });
  it("aligns opposite edges and distributes selected nodes without changing other positions", () => {
    const graph = parse(SAMPLE_FLOW);
    const layout = layoutFromGraph(graph);
    layout.nodes = {
      a: { x: 0, y: 5 },
      b: { x: 20, y: 30 },
      c: { x: 90, y: 50 },
      other: { x: 3, y: 8 },
    };
    expect(
      alignNodes(layout, ["a", "b"], "right", {
        a: { width: 10, height: 10 },
        b: { width: 20, height: 20 },
      }).nodes.a.x,
    ).toBe(30);
    expect(alignNodes(layout, ["a", "b", "c"], "horizontal").nodes.b.x).toBe(
      45,
    );
    expect(alignNodes(layout, ["a", "b"], "top").nodes.b.y).toBe(5);
    expect(alignNodes(layout, ["a"], "left")).toBe(layout);
    expect(alignNodes(layout, ["a", "b"], "bottom").nodes.other).toBe(
      layout.nodes.other,
    );
  });
});

it("maps node breakpoints to device lines and a stopped frame back to its node", async () => {
  const {services, transport} = setup({
    "device.list": () => ({devices: [{id: "phone", state: "online", info: {version: "0.6.0"}}]}),
    "debug.start": p => ({id: p.id, state: "running", frames: []}),
    "debug.setBreakpoints": () => ({breakpoints: []}),
  });
  services.api.projects = vi.fn(async () => ({projects: []}));
  services.api.createProject = vi.fn(async () => ({ok: true}));
  services.api.writeFile = vi.fn(async () => ({ok: true}));
  const graph = parse(SAMPLE_FLOW), pick = vi.fn();
  render(<ServicesContext.Provider value={services}><FlowDelivery graph={graph} layout={layoutFromGraph(graph)} text={SAMPLE_FLOW} breaks={[{node: "tap", enabled: true}]} currentDevice="phone" onPick={pick} onOpen={vi.fn()} onRun={vi.fn()}/></ServicesContext.Provider>);
  fireEvent.click(await screen.findByRole("button", {name: "设备节点调试"}));
  await waitFor(() => expect(transport.sent.some(r => r.method === "debug.start")).toBe(true));
  const call = transport.sent.find(r => r.method === "debug.start")!;
  const bps = call.params?.breakpoints as Record<string, Array<{line: number}>>;
  const path = "flows/daily_signin.py";
  expect(bps[path][0].line).toBeGreaterThan(0);
  transport.push({event: true, topic: "debug.state", data: {id: "phone", state: "stopped", frames: [{id: 1, path, line: bps[path][0].line}]}});
  await waitFor(() => expect(pick).toHaveBeenCalledWith(["tap"]));
});
