import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { SyncPanel } from "../src/components/SyncPanel";
import { createDemoTransport } from "../src/demo";

function mount(onSynced = vi.fn(), onError = vi.fn(), project = "demo") {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const ui = (p: string) => (
    <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
      <SyncPanel devId="adb:e" project={p} onSynced={onSynced} onError={onError} />
    </ServicesContext.Provider>
  );
  const r = render(ui(project));
  return { ...r, transport, onSynced, onError, rerenderProject: (p: string) => r.rerender(ui(p)) };
}

beforeEach(() => localStorage.clear());

describe("SyncPanel", () => {
  it("buttons stay disabled until a folder is set; the picker fills and remembers it per device/project", async () => {
    const { rerenderProject } = mount();
    expect((screen.getByRole("button", { name: "增量上传" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "选择…" }));
    await screen.findByDisplayValue("/demo/projects/demo");
    expect((screen.getByRole("button", { name: "增量上传" }) as HTMLButtonElement).disabled).toBe(false);
    expect(localStorage.getItem("xscript.syncdir.adb:e/demo")).toBe("/demo/projects/demo");
    rerenderProject("other");
    expect((screen.getByRole("textbox", { name: "本地文件夹" }) as HTMLInputElement).value).toBe("");
    rerenderProject("demo");
    expect((screen.getByRole("textbox", { name: "本地文件夹" }) as HTMLInputElement).value).toBe("/demo/projects/demo");
  });

  it("preview, incremental/full upload, pull report their results and send the right params", async () => {
    const { transport, onSynced } = mount();
    fireEvent.change(screen.getByRole("textbox", { name: "本地文件夹" }), { target: { value: "/p" } });
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(await screen.findByText(/将上传 1 个文件，0 个未改动：__init__\.py/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "增量上传" }));
    expect(await screen.findByText("已上传 1 个文件，跳过 0 个未改动")).toBeTruthy();
    expect(onSynced).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "全量上传" }));
    await screen.findByText("已上传 1 个文件，跳过 0 个未改动");
    expect(transport.sent.filter((m) => m.method === "sync.upload").map((m) => m.params?.full)).toEqual([false, true]);
    fireEvent.click(screen.getByRole("button", { name: "拉取到本地" }));
    expect(await screen.findByText(/已写入 1 个文件（新增 0，修改 1）/)).toBeTruthy();
    expect(transport.sent.find((m) => m.method === "sync.pull")?.params).toMatchObject({ id: "adb:e", project: "demo", dir: "/p" });
  });

  it("shows progress events for this project only, an empty plan, and reports errors to the parent", async () => {
    const { transport, onError } = mount();
    fireEvent.change(screen.getByRole("textbox", { name: "本地文件夹" }), { target: { value: "/p" } });
    await act(async () => transport.push({ event: true, topic: "sync.progress", data: { id: "adb:e", project: "x", sent: 1, total: 9 } }));
    expect(screen.queryByText(/上传中/)).toBeNull();
    await act(async () => transport.push({ event: true, topic: "sync.progress", data: { id: "adb:e", project: "demo", sent: 2, total: 5 } }));
    expect(screen.getByText("上传中 2/5")).toBeTruthy();
    transport.setHandler("sync.preview", () => ({ upload: [], skipped: ["a"], bytes: 0 }));
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(await screen.findByText("没有需要上传的文件（全部未改动）")).toBeTruthy();
    transport.setHandler("sync.preview", () => ({ upload: Array.from({ length: 10 }, (_, i) => `f${i}.py`), skipped: [], bytes: 0 }));
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(await screen.findByText(/f7\.py…$/)).toBeTruthy();
    transport.setHandler("sync.upload", () => {
      throw { code: "sync.not_project", message: "no __init__.py" };
    });
    fireEvent.click(screen.getByRole("button", { name: "增量上传" }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
  });

  it("a cancelled folder dialog keeps the old folder; storage errors are tolerated", async () => {
    const { transport } = mount();
    transport.setHandler("app.pickDirectory", () => ({ path: null }));
    fireEvent.change(screen.getByRole("textbox", { name: "本地文件夹" }), { target: { value: "/keep" } });
    fireEvent.click(screen.getByRole("button", { name: "选择…" }));
    await vi.waitFor(() => expect((screen.getByRole("button", { name: "选择…" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("textbox", { name: "本地文件夹" }) as HTMLInputElement).value).toBe("/keep");
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    fireEvent.change(screen.getByRole("textbox", { name: "本地文件夹" }), { target: { value: "/x" } });
    expect((screen.getByRole("textbox", { name: "本地文件夹" }) as HTMLInputElement).value).toBe("/x");
    mount(vi.fn(), vi.fn(), "p2");
    spy.mockRestore();
    get.mockRestore();
  });
});
