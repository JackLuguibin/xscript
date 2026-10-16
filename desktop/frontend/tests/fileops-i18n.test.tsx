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

    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "删除 b.py" }));
    expect(transport.sent.some((m) => m.method === "project.deleteFile")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "删除 b.py" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^b\.py/ })).toBeNull());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByText("选择一个文件查看或编辑")).toBeTruthy(); // the open file was deleted
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
