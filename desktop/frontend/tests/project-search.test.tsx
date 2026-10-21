import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { ProjectsPage } from "../src/components/ProjectsPage";
import { createDemoTransport } from "../src/demo";

async function setup() {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  await api.connectAdb("emulator-5554");
  const id = (await api.listDevices()).devices[0].id;
  await api.writeFile(id, "demo", "util.py", "def tap(x):\n    print('TAP', x)\n", true);
  await api.writeFile(id, "demo", "__init__.py", "from .util import tap\ntap(1)\n");
  render(
    <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
      <ProjectsPage pollMs={20} />
    </ServicesContext.Provider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /^demo/ }));
  await screen.findByRole("button", { name: /^__init__\.py/ });
  return { transport };
}

const search = (q: string) => {
  fireEvent.change(screen.getByRole("searchbox", { name: "在工程中搜索" }), { target: { value: q } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
};

describe("在工程中搜索", () => {
  it("finds text across files, grouped by file, and a result opens the file with the match selected", async () => {
    await setup();
    search("tap");
    expect(await screen.findByText("4 处匹配，2 个文件")).toBeTruthy();
    const list = screen.getByRole("list", { name: "搜索结果" });
    expect(within(list).getByText("util.py")).toBeTruthy();
    expect(list.querySelectorAll("mark")).toHaveLength(4);
    fireEvent.click(within(list).getByRole("button", { name: "打开 util.py 第 2 行" }));
    const editor = (await screen.findByRole("textbox", { name: "编辑器" }, { timeout: 3000 })) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value.slice(editor.selectionStart, editor.selectionEnd)).toBe("TAP"));
    expect(screen.getByText("demo/util.py", { exact: false })).toBeTruthy();
  });

  it("match case and regex toggles reach the search; no results and a bad regex are reported", async () => {
    const { transport } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "区分大小写" }));
    expect(screen.getByRole("button", { name: "区分大小写" }).getAttribute("aria-pressed")).toBe("true");
    search("TAP");
    expect(await screen.findByText("1 处匹配，1 个文件")).toBeTruthy();
    expect(transport.sent.filter((m) => m.method === "project.search").at(-1)?.params).toMatchObject({ caseSensitive: true, regex: false });
    search("nothing-here");
    expect(await screen.findByText("没有找到「nothing-here」")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "正则表达式" }));
    search("(");
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("Ctrl/Cmd+Shift+F focuses the search box; Escape and ✕ clear the results", async () => {
    await setup();
    fireEvent.keyDown(window, { key: "F", ctrlKey: true, shiftKey: true });
    const box = screen.getByRole("searchbox", { name: "在工程中搜索" });
    expect(document.activeElement).toBe(box);
    search("tap");
    await screen.findByText("4 处匹配，2 个文件");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("list", { name: "搜索结果" })).toBeNull();
    search("tap");
    await screen.findByText("4 处匹配，2 个文件");
    fireEvent.click(screen.getByRole("button", { name: "清除搜索结果" }));
    expect(screen.queryByRole("list", { name: "搜索结果" })).toBeNull();
    fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });
    expect(document.activeElement).toBe(box);
  });
});
