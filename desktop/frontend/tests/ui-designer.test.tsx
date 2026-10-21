import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { ProjectsPage } from "../src/components/ProjectsPage";
import { createDemoTransport } from "../src/demo";
import { uiForm } from "../src/ui-form";

async function setup(content: string) {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  await api.connectAdb("emulator-5554");
  const id = (await api.listDevices()).devices[0].id;
  await api.writeFile(id, "demo", "res/ui/main.ui.json", content, true);
  render(
    <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
      <ProjectsPage pollMs={20} />
    </ServicesContext.Provider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /^demo/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^res\/ui\/main\.ui\.json/ }));
  return { api, id };
}

describe("desktop UI designer (D.3 / D.4)", () => {
  it("edits a .ui.json in the shared designer and saving writes the spec, the page and the Python", async () => {
    const { api, id } = await setup(uiForm.serializeSpec(uiForm.newSpec("挂机设置")));
    const designer = await screen.findByLabelText("界面设计器", undefined, { timeout: 3000 });
    // palette: 单行文本 then 复选框
    fireEvent.click(within(designer).getByRole("button", { name: /单行文本/ }));
    fireEvent.click(within(designer).getByRole("button", { name: /复选框/ }));
    expect(screen.getByText("未保存")).toBeTruthy();
    expect(designer.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/已生成 res\/ui\/main\.html、ui_main\.py/, undefined, { timeout: 3000 })).toBeTruthy();
    const saved = uiForm.parseSpec((await api.readFile(id, "demo", "res/ui/main.ui.json")).content);
    expect(saved.fields.map((f) => f.kind)).toEqual(["text", "checkbox"]);
    const want = uiForm.outputs(saved, "main");
    expect((await api.readFile(id, "demo", "res/ui/main.html")).content).toBe(want["res/ui/main.html"]);
    expect((await api.readFile(id, "demo", "ui_main.py")).content).toBe(want["ui_main.py"]);
  });

  it("switches to JSON (editor + read-only preview) and back; a broken spec is saved but not generated", async () => {
    const bad = JSON.stringify({ version: 1, title: "x", submit: "ok", width: "85vw", height: "60vh", fields: [{ kind: "select", id: "mode", label: "模式" }] });
    const { api, id } = await setup(bad);
    await screen.findByLabelText("界面设计器", undefined, { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    const editor = (await screen.findByRole("textbox", { name: "编辑器" })) as HTMLTextAreaElement;
    expect(screen.getByTitle("界面预览")).toBeTruthy();
    fireEvent.change(editor, { target: { value: bad + "\n" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/已保存但没有生成/, undefined, { timeout: 3000 })).toBeTruthy();
    await expect(api.readFile(id, "demo", "ui_main.py")).rejects.toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "设计" }));
    await waitFor(() => expect(screen.getByLabelText("界面设计器")).toBeTruthy());
  });

  it("a new file named *.ui.json starts as an empty form spec", async () => {
    const { api, id } = await setup(uiForm.serializeSpec(uiForm.newSpec()));
    fireEvent.click(screen.getByRole("button", { name: "新建文件" }));
    const input = await screen.findByRole("textbox", { name: /^新文件路径/ });
    fireEvent.change(input, { target: { value: "res/ui/login.ui.json" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(async () => expect(uiForm.parseSpec((await api.readFile(id, "demo", "res/ui/login.ui.json")).content).fields).toEqual([]));
  });

  it("undo / redo step through designer edits (buttons and Ctrl+Z / Ctrl+Shift+Z) and update the text", async () => {
    await setup(uiForm.serializeSpec(uiForm.newSpec("挂机设置")));
    const designer = await screen.findByLabelText("界面设计器", undefined, { timeout: 3000 });
    const undo = screen.getByRole("button", { name: "撤销" }) as HTMLButtonElement;
    const redo = screen.getByRole("button", { name: "重做" }) as HTMLButtonElement;
    expect(undo.disabled && redo.disabled).toBe(true);
    const kinds = async () => {
      fireEvent.click(screen.getByRole("button", { name: "JSON" }));
      const v = ((await screen.findByRole("textbox", { name: "编辑器" })) as HTMLTextAreaElement).value;
      fireEvent.click(screen.getByRole("button", { name: "设计" }));
      return uiForm.parseSpec(v).fields.map((f) => f.kind);
    };
    fireEvent.click(within(designer).getByRole("button", { name: /单行文本/ }));
    await new Promise((r) => setTimeout(r, 700)); // separate steps, not merged
    fireEvent.click(within(designer).getByRole("button", { name: /复选框/ }));
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    expect(redo.disabled).toBe(false);
    expect(await kinds()).toEqual(["text"]);
    const d2 = await screen.findByLabelText("界面设计器");
    fireEvent.keyDown(d2, { key: "z", ctrlKey: true });
    expect(await kinds()).toEqual([]);
    const d3 = await screen.findByLabelText("界面设计器");
    fireEvent.keyDown(d3, { key: "z", ctrlKey: true, shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    expect(await kinds()).toEqual(["text", "checkbox"]);
  });

  it("unsaved designer edits ask before another file replaces them", async () => {
    await setup(uiForm.serializeSpec(uiForm.newSpec()));
    const designer = await screen.findByLabelText("界面设计器", undefined, { timeout: 3000 });
    fireEvent.click(within(designer).getByRole("button", { name: /单行文本/ }));
    expect(screen.getByText("未保存")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^__init__\.py/ }));
    expect(await screen.findByText("未保存，确定放弃修改？")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByText("未保存")).toBeTruthy();
  });

  it("an edit made as JSON is one undo step in the designer", async () => {
    await setup(uiForm.serializeSpec(uiForm.newSpec("A")));
    await screen.findByLabelText("界面设计器", undefined, { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    const editor = (await screen.findByRole("textbox", { name: "编辑器" })) as HTMLTextAreaElement;
    const before = editor.value;
    fireEvent.change(editor, { target: { value: uiForm.serializeSpec(uiForm.newSpec("B")) } });
    fireEvent.click(screen.getByRole("button", { name: "设计" }));
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect(((await screen.findByRole("textbox", { name: "编辑器" })) as HTMLTextAreaElement).value).toBe(before);
  });

  it("新建界面 takes a name, creates res/ui/<name>.ui.json and opens it in the designer", async () => {
    const { api, id } = await setup(uiForm.serializeSpec(uiForm.newSpec()));
    await screen.findByLabelText("界面设计器", undefined, { timeout: 3000 });
    const ask = async (name: string) => {
      fireEvent.click(screen.getByRole("button", { name: "新建界面" }));
      const input = await screen.findByRole("textbox", { name: "界面名称（例如 settings）" });
      fireEvent.change(input, { target: { value: name } });
      fireEvent.click(screen.getByRole("button", { name: "OK" }));
    };
    await ask("9bad");
    expect(await screen.findByText(/界面名称只能用字母/)).toBeTruthy();
    await ask("main");
    expect(await screen.findByText("res/ui/main.ui.json 已存在")).toBeTruthy();
    await ask("login");
    await waitFor(async () => expect(uiForm.parseSpec((await api.readFile(id, "demo", "res/ui/login.ui.json")).content).title).toBe("login"), { timeout: 3000 });
    // opened: the designer now edits the new form (its window title field shows the name)
    await waitFor(() => expect(screen.getByLabelText("界面设计器")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    await waitFor(() => expect(uiForm.parseSpec((screen.getByRole("textbox", { name: "编辑器" }) as HTMLTextAreaElement).value).title).toBe("login"), { timeout: 3000 });
  });
});
