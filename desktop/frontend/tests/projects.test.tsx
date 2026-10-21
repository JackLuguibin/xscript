import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { ProjectsPage } from "../src/components/ProjectsPage";
import { createDemoTransport } from "../src/demo";

async function setup(connect = true) {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  if (connect) await api.connectAdb("emulator-5554");
  const r = render(
    <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
      <ProjectsPage pollMs={20} />
    </ServicesContext.Provider>,
  );
  return { ...r, transport, api, rpc };
}

describe("ProjectsPage", () => {
  it("shows an empty state without an online device", async () => {
    await setup(false);
    expect(await screen.findByText("还没有在线设备")).toBeTruthy();
  });

  it("lists projects, opens a file, edits and saves it", async () => {
    const { api } = await setup();
    fireEvent.click(await screen.findByRole("button", { name: /^demo/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^__init__\.py/ }));
    const editor = (await screen.findByRole("textbox", { name: "编辑器" }, { timeout: 3000 })) as HTMLTextAreaElement;
    expect(editor.value).toContain("hello from demo");
    fireEvent.change(editor, { target: { value: "print(1)\n" } });
    expect(screen.getByText("未保存")).toBeTruthy();
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    await screen.findByText("已保存", undefined, { timeout: 3000 });
    const id = (await api.listDevices()).devices[0].id;
    expect((await api.readFile(id, "demo", "__init__.py")).content).toBe("print(1)\n");
  });

  it("truncates long names with an ellipsis span and a full-name tooltip", async () => {
    await setup();
    const proj = await screen.findByRole("button", { name: /^demo/ });
    expect(proj.querySelector(".list-name")?.getAttribute("title")).toBe("demo");
    fireEvent.click(proj);
    const file = await screen.findByRole("button", { name: /^__init__\.py/ });
    const name = file.querySelector(".list-name");
    expect(name?.getAttribute("title")).toBe("__init__.py");
    expect(name?.nextElementSibling?.textContent).toMatch(/ B$/);
  });

  it("creates a project", async () => {
    await setup();
    await screen.findByRole("button", { name: /^demo/ });
    fireEvent.change(screen.getByRole("textbox", { name: "新工程名" }), { target: { value: "neu" } });
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    const list = await screen.findByRole("list", { name: "工程列表" });
    await waitFor(() => expect(within(list).getByRole("button", { name: /^neu/ })).toBeTruthy());
  });

  it("runs, streams new log lines, reports a second run as already running", async () => {
    const { transport } = await setup();
    fireEvent.click(await screen.findByRole("button", { name: /^demo/ }));
    await screen.findByRole("button", { name: /^__init__\.py/ });
    await waitFor(() => expect(transport.sent.some((m) => m.method === "device.logs")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "保存并运行" }));
    await screen.findByText(/\[demo\] running demo/);
    fireEvent.click(screen.getByRole("button", { name: "保存并运行" }));
    expect(await screen.findByText(/设备上已有工程在运行/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(screen.getByText("暂无日志")).toBeTruthy();
  });

  it("sends hardware keys through device.action", async () => {
    const { transport } = await setup();
    await screen.findByRole("button", { name: /^demo/ });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "主页" })));
    await waitFor(() => expect(transport.sent.find((m) => m.method === "device.action")?.params).toMatchObject({ type: "key", name: "home" }));
  });
});

describe("App navigation", () => {
  it("switches between the devices and projects pages", async () => {
    const rpc = new RpcClient(createDemoTransport());
    render(
      <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
        <App />
      </ServicesContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /工程/ }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("工程");
    expect(await screen.findByText("还没有在线设备")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: (n) => n === "设备" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("设备");
  });
});
