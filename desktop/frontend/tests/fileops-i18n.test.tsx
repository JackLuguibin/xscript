import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { ProjectsPage } from "../src/components/ProjectsPage";
import { createDemoTransport } from "../src/demo";
import { readStoredLang } from "../src/i18n";
import { DICTS, getLanguage, setLanguage, t } from "../src/strings";

async function projects() {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  await api.connectAdb("emulator-5554");
  render(
    <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
      <ProjectsPage pollMs={50} />
    </ServicesContext.Provider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /^demo/ }));
  await screen.findByRole("button", { name: /^__init__\.py/ });
  return { transport, api };
}

const fileNames = () => within(screen.getByRole("list", { name: "文件" })).getAllByRole("button").map((b) => b.textContent ?? "").filter((x) => / B$/.test(x));

afterEach(() => {
  vi.restoreAllMocks();
  setLanguage("zh");
  localStorage.clear();
});

describe("file new / rename / delete", () => {
  it("the entry point cannot be renamed or deleted", async () => {
    await projects();
    expect((screen.getByRole("button", { name: "重命名 __init__.py" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "删除 __init__.py" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("creates, renames (keeping the open file) and deletes a file", async () => {
    const { transport } = await projects();
    fireEvent.click(screen.getByRole("button", { name: "新建文件" }));
    const input = screen.getByRole("textbox", { name: /新文件路径/ });
    fireEvent.change(input, { target: { value: "utils/a.py" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByRole("button", { name: /^utils\/a\.py/ });
    expect(transport.sent.find((m) => m.method === "project.write")?.params).toMatchObject({ path: "utils/a.py", create: true, content: "" });

    fireEvent.click(screen.getByRole("button", { name: /^utils\/a\.py/ }));
    await screen.findByText(/demo\/utils\/a\.py/);
    fireEvent.click(screen.getByRole("button", { name: "重命名 utils/a.py" }));
    const rn = screen.getByRole("textbox", { name: "新路径" }) as HTMLInputElement;
    expect(rn.value).toBe("utils/a.py");
    fireEvent.change(rn, { target: { value: "b.py" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await screen.findByRole("button", { name: /^b\.py/ });
    expect(screen.getByText(/demo\/b\.py/)).toBeTruthy();
    expect(fileNames().some((n) => n.startsWith("utils/a.py"))).toBe(false);

    // the in-app confirm dialog (never window.confirm): cancel first, then confirm
    const native = vi.spyOn(window, "confirm");
    fireEvent.click(screen.getByRole("button", { name: "删除 b.py" }));
    let dlg = await screen.findByRole("alertdialog");
    expect(dlg.textContent).toMatch(/确定从设备上删除 b\.py/);
    fireEvent.click(within(dlg).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(transport.sent.some((m) => m.method === "project.deleteFile")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "删除 b.py" }));
    dlg = await screen.findByRole("alertdialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^b\.py/ })).toBeNull());
    expect(native).not.toHaveBeenCalled();
    expect(screen.getByText("选择一个文件查看或编辑")).toBeTruthy(); // the open file was deleted
  });

  it("deletes a folder with everything in it after a confirm that lists its files", async () => {
    const { transport } = await projects();
    for (const path of ["pkg/a.py", "pkg/sub/b.py"]) {
      fireEvent.click(screen.getByRole("button", { name: "新建文件" }));
      const input = screen.getByRole("textbox", { name: /新文件路径/ });
      fireEvent.change(input, { target: { value: path } });
      fireEvent.submit(input.closest("form")!);
      await screen.findByRole("button", { name: new RegExp("^" + path.replace(/[/.]/g, "\\$&")) });
    }
    const folders = screen.getByRole("list", { name: "文件夹" });
    expect(within(folders).getByText(/pkg\/$/).parentElement!.textContent).toContain("2 个文件");
    expect(within(folders).getByText(/pkg\/sub\/$/).parentElement!.textContent).toContain("1 个文件");

    fireEvent.click(screen.getByRole("button", { name: /^pkg\/sub\/b\.py/ }));
    await screen.findByText(/demo\/pkg\/sub\/b\.py/);
    fireEvent.click(screen.getByRole("button", { name: "删除文件夹 pkg/" }));
    let dlg = await screen.findByRole("alertdialog");
    expect(dlg.textContent).toMatch(/确定从设备上删除文件夹 pkg\/ 和其中的 2 个文件/);
    expect(dlg.textContent).toContain("pkg/a.py");
    expect(dlg.textContent).toContain("pkg/sub/b.py");
    fireEvent.click(within(dlg).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(transport.sent.some((m) => m.method === "project.deleteFile")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "删除文件夹 pkg/" }));
    dlg = await screen.findByRole("alertdialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^pkg\/a\.py/ })).toBeNull());
    expect(transport.sent.find((m) => m.method === "project.deleteFile")?.params).toMatchObject({ path: "pkg", recursive: true });
    expect(screen.queryByRole("button", { name: /^pkg\/sub\/b\.py/ })).toBeNull();
    expect(screen.queryByRole("list", { name: "文件夹" })).toBeNull();
    expect(screen.getByText("选择一个文件查看或编辑")).toBeTruthy(); // the open file was inside
  });

  it("undo after deleting a file writes the saved copy back", async () => {
    const { transport, api } = await projects();
    fireEvent.click(screen.getByRole("button", { name: "新建文件" }));
    const input = screen.getByRole("textbox", { name: /新文件路径/ });
    fireEvent.change(input, { target: { value: "keep.py" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByRole("button", { name: /^keep\.py/ });
    const id = (await api.listDevices()).devices[0].id;
    await api.writeFile(id, "demo", "keep.py", "print('keep')\n");
    fireEvent.click(screen.getByRole("button", { name: "删除 keep.py" }));
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg.textContent).toContain("撤销");
    fireEvent.click(within(dlg).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^keep\.py/ })).toBeNull());
    const toasts = screen.getAllByRole("status").find((x) => x.className.includes("toasts"))!;
    expect(toasts.textContent).toContain("已删除 keep.py");
    fireEvent.click(within(toasts).getAllByRole("button", { name: "撤销" }).pop()!);
    await screen.findByRole("button", { name: /^keep\.py/ });
    expect((await api.readFile(id, "demo", "keep.py")).content).toBe("print('keep')\n");
    expect(transport.sent.filter((m) => m.method === "project.write").pop()?.params).toMatchObject({ path: "keep.py", create: true });
    await screen.findByText("已恢复");
  });

  it("undo after deleting a folder restores every file in it, base64 ones as base64", async () => {
    const { transport, api } = await projects();
    const id = (await api.listDevices()).devices[0].id;
    for (const path of ["pkg/a.py", "pkg/sub/b.py"]) {
      fireEvent.click(screen.getByRole("button", { name: "新建文件" }));
      const input = screen.getByRole("textbox", { name: /新文件路径/ });
      fireEvent.change(input, { target: { value: path } });
      fireEvent.submit(input.closest("form")!);
      await screen.findByRole("button", { name: new RegExp("^" + path.replace(/[/.]/g, "\\$&")) });
      await api.writeFile(id, "demo", path, "# " + path + "\n");
    }
    const read = api.readFile;
    api.readFile = async (d, p, f) => (f === "pkg/a.py" ? { path: f, encoding: "base64", content: "AAEC" } : read(d, p, f));
    fireEvent.click(screen.getByRole("button", { name: "删除文件夹 pkg/" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^pkg\/a\.py/ })).toBeNull());
    const toasts = screen.getAllByRole("status").find((x) => x.className.includes("toasts"))!;
    expect(toasts.textContent).toContain("已删除文件夹 pkg/（2 个文件）");
    fireEvent.click(within(toasts).getAllByRole("button", { name: "撤销" }).pop()!);
    await screen.findByRole("button", { name: /^pkg\/sub\/b\.py/ });
    await screen.findByRole("button", { name: /^pkg\/a\.py/ });
    const writes = transport.sent.filter((m) => m.method === "project.write").slice(-2).map((m) => m.params);
    expect(writes).toEqual([
      expect.objectContaining({ path: "pkg/a.py", content: "AAEC", encoding: "base64", create: true }),
      expect.objectContaining({ path: "pkg/sub/b.py", content: "# pkg/sub/b.py\n", create: true }),
    ]);
    expect(writes[1]).not.toHaveProperty("encoding");
    await screen.findByText("已恢复 2 个文件");
  });

  const newFile = async (path: string) => {
    fireEvent.click(screen.getByRole("button", { name: "新建文件" }));
    const input = screen.getByRole("textbox", { name: /新文件路径/ });
    fireEvent.change(input, { target: { value: path } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByRole("button", { name: new RegExp("^" + path.replace(/[/.]/g, "\\$&")) });
  };
  const toastArea = () => screen.getAllByRole("status").find((x) => x.className.includes("toasts"))!;

  it("undo after renaming moves the file back, also with Ctrl+Z", async () => {
    const { transport } = await projects();
    await newFile("r.py");
    fireEvent.click(screen.getByRole("button", { name: "重命名 r.py" }));
    const input = screen.getByRole("textbox", { name: "新路径" });
    fireEvent.change(input, { target: { value: "lib/r2.py" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByRole("button", { name: /^lib\/r2\.py/ });
    expect(toastArea().textContent).toContain("已将 r.py 重命名为 lib/r2.py");
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await screen.findByRole("button", { name: /^r\.py/ });
    expect(screen.queryByRole("button", { name: /^lib\/r2\.py/ })).toBeNull();
    expect(transport.sent.filter((m) => m.method === "project.move").pop()?.params).toMatchObject({ from: "lib/r2.py", to: "r.py" });
    await screen.findByText("已撤销");
  });

  it("undo after creating removes the file only while it is still empty", async () => {
    const { api } = await projects();
    const id = (await api.listDevices()).devices[0].id;
    await newFile("n1.py");
    expect(toastArea().textContent).toContain("已新建 n1.py");
    fireEvent.click(within(toastArea()).getAllByRole("button", { name: "撤销" }).pop()!);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^n1\.py/ })).toBeNull());

    await newFile("n2.py");
    await api.writeFile(id, "demo", "n2.py", "print(2)\n");
    fireEvent.click(within(toastArea()).getAllByRole("button", { name: "撤销" }).pop()!);
    await screen.findByText("n2.py 新建后已经写入内容，没有删除它");
    expect((await api.readFile(id, "demo", "n2.py")).content).toBe("print(2)\n");
  });

  it("Delete on a focused file asks first; Ctrl+Z in a text field is left alone", async () => {
    const { transport } = await projects();
    await newFile("k.py");
    const row = screen.getByRole("button", { name: /^k\.py/ });
    expect(row.getAttribute("aria-keyshortcuts")).toBe("Delete");
    expect(screen.getByRole("button", { name: /^__init__\.py/ }).getAttribute("aria-keyshortcuts")).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: /^__init__\.py/ }), { key: "Delete" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.keyDown(row, { key: "Delete" });
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^k\.py/ })).toBeNull());
    const moves = transport.sent.length;
    fireEvent.keyDown(screen.getByRole("textbox", { name: "新工程名" }), { key: "z", ctrlKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("button", { name: /^k\.py/ })).toBeNull();
    expect(transport.sent.slice(moves).some((m) => m.method === "project.write")).toBe(false);
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    await screen.findByRole("button", { name: /^k\.py/ });
  });

  it("escape / ✕ close the form; a device error is shown", async () => {
    const { transport } = await projects();
    fireEvent.click(screen.getByRole("button", { name: "新建文件" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: /新文件路径/ }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: /新文件路径/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "新建文件" }));
    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    expect(screen.queryByRole("textbox", { name: /新文件路径/ })).toBeNull();
    transport.setHandler("project.write", () => {
      throw { code: "device.http", message: "文件已存在: x.py" };
    });
    fireEvent.click(screen.getByRole("button", { name: "新建文件" }));
    fireEvent.change(screen.getByRole("textbox", { name: /新文件路径/ }), { target: { value: "x.py" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/文件已存在/);
    fireEvent.submit(screen.getByRole("textbox", { name: /新文件路径/ }).closest("form")!); // still open, resubmittable
  });
});

describe("i18n", () => {
  it("both dictionaries have the same keys (deep)", () => {
    const keys = (o: object, p = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`])).sort();
    expect(keys(DICTS.en)).toEqual(keys(DICTS.zh));
    expect(DICTS.en.sync.plan(2, 1)).toBe("2 file(s) to upload, 1 unchanged");
  });

  it("switches the whole UI to English and back, persists the choice, and sets <html lang>", async () => {
    const rpc = new RpcClient(createDemoTransport());
    render(
      <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
        <App />
      </ServicesContext.Provider>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("设备");
    fireEvent.click(screen.getByRole("button", { name: /语言：中文/ }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Devices");
    expect(screen.getByRole("button", { name: /Projects/ })).toBeTruthy();
    expect(await screen.findByText("ADB devices")).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem("xscript.lang")).toBe("en");
    expect(getLanguage()).toBe("en");
    expect(t.nav.devices).toBe("Devices");
    fireEvent.click(screen.getByRole("button", { name: /Language: English|Language：English/ }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("设备");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("starts in the stored language; unreadable storage falls back to zh", () => {
    localStorage.setItem("xscript.lang", "en");
    expect(readStoredLang()).toBe("en");
    const rpc = new RpcClient(createDemoTransport());
    render(
      <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
        <App />
      </ServicesContext.Provider>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Devices");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readStoredLang()).toBe("zh");
    fireEvent.click(screen.getByRole("button", { name: /Language/ })); // still switches even if not persisted
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("设备");
  });
});
