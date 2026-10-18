import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { App } from "../src/App";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { useConfirm } from "../src/components/ConfirmDialog";
import { ProjectsPage } from "../src/components/ProjectsPage";
import { createDemoTransport } from "../src/demo";
import { isApplePlatform } from "../src/shortcuts";
import { setLanguage } from "../src/strings";

const apple = isApplePlatform();
const nav = (n: string) => fireEvent.keyDown(window, { key: n, bubbles: true, cancelable: true, metaKey: apple, ctrlKey: !apple });

async function services() {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  await api.connectAdb("emulator-5554");
  return { transport, rpc, api };
}

/** Open demo/__init__.py and type into it. */
async function editInitPy(text = "print('edited')\n") {
  fireEvent.click(await screen.findByRole("button", { name: /^demo/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^__init__\.py/ }));
  const editor = (await screen.findByRole("textbox", { name: "编辑器" }, { timeout: 3000 })) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: text } });
  expect(screen.getByText("未保存")).toBeTruthy();
  return editor;
}

afterEach(() => {
  vi.restoreAllMocks();
  setLanguage("zh");
  localStorage.clear();
});

describe("ConfirmDialog", () => {
  function Harness({ onAnswer }: { onAnswer: (ok: boolean) => void }) {
    const { confirm, dialog } = useConfirm();
    const [n, setN] = useState(0);
    return (
      <>
        <button onClick={() => void confirm({ message: `question ${n}`, confirmLabel: "Yes", danger: true }).then(onAnswer)}>ask</button>
        <button onClick={() => setN((x) => x + 1)}>other</button>
        {dialog}
      </>
    );
  }

  it("starts on Cancel, Escape and the backdrop decline, focus goes back to the opener", async () => {
    const answers: boolean[] = [];
    render(<Harness onAnswer={(ok) => answers.push(ok)} />);
    const ask = screen.getByRole("button", { name: "ask" });
    ask.focus();
    fireEvent.click(ask);
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    expect(within(dlg).getByText("question 0")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dlg).getByRole("button", { name: "取消" })));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(answers).toEqual([false]);
    expect(document.activeElement).toBe(ask);

    fireEvent.click(ask);
    fireEvent.mouseDown(document.querySelector(".overlay-backdrop")!);
    await waitFor(() => expect(answers).toEqual([false, false]));

    fireEvent.click(ask);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(answers).toEqual([false, false, true]));
  });

  it("answers false when the owner unmounts with the question open", async () => {
    const answers: boolean[] = [];
    const view = render(<Harness onAnswer={(ok) => answers.push(ok)} />);
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    await screen.findByRole("alertdialog");
    view.unmount();
    await waitFor(() => expect(answers).toEqual([false]));
  });
});

describe("ProjectsPage unsaved guard", () => {
  it("asks before another file replaces unsaved edits; Cancel keeps them, Discard opens the file", async () => {
    const { rpc, api } = await services();
    const id = (await api.listDevices()).devices[0].id;
    await api.writeFile(id, "demo", "b.py", "B = 1\n", true);
    const dirty: boolean[] = [];
    render(
      <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
        <ProjectsPage pollMs={50} onDirtyChange={(d) => dirty.push(d)} />
      </ServicesContext.Provider>,
    );
    const native = vi.spyOn(window, "confirm");
    const editor = await editInitPy();
    expect(dirty.at(-1)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^b\.py/ }));
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg.textContent).toMatch(/未保存/);
    fireEvent.click(within(dlg).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(editor.value).toBe("print('edited')\n");
    expect(screen.getByText(/demo\/__init__\.py/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^b\.py/ }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "放弃修改" }));
    await screen.findByText(/demo\/b\.py/);
    expect(((await screen.findByRole("textbox", { name: "编辑器" })) as HTMLTextAreaElement).value).toBe("B = 1\n");
    expect(dirty.at(-1)).toBe(false);
    expect(native).not.toHaveBeenCalled();
  });
});

describe("App: switching pages keeps unsaved edits", () => {
  it("sidebar / Ctrl+N switch away and back without losing the buffer; the nav item and the shell know", async () => {
    const { transport, rpc, api } = await services();
    render(
      <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
        <App />
      </ServicesContext.Provider>,
    );
    const main = screen.getByRole("navigation", { name: "main" });
    fireEvent.click(within(main).getByRole("button", { name: /工程/ }));
    await editInitPy("x = 42\n");
    await waitFor(() => expect(transport.sent.some((m) => m.method === "app.setUnsaved" && m.params?.unsaved === true && m.params?.lang === "zh")).toBe(true));
    expect(within(main).getByRole("img", { name: "有未保存的修改" })).toBeTruthy();

    // away with the sidebar, back with Ctrl/Cmd+3
    fireEvent.click(within(main).getByRole("button", { name: /设备墙/ }));
    await screen.findByRole("heading", { level: 1, name: "设备墙" });
    expect(screen.queryByRole("alertdialog")).toBeNull(); // nothing is lost, so nothing to ask
    act(() => nav("3"));
    expect(((await screen.findByRole("textbox", { name: "编辑器" })) as HTMLTextAreaElement).value).toBe("x = 42\n");

    // away with Ctrl/Cmd+1 (the projects page stays mounted but hidden), back with the palette
    act(() => nav("1"));
    await screen.findByRole("heading", { level: 1, name: "设备" });
    expect(screen.queryByRole("textbox", { name: "编辑器" })).toBeNull(); // hidden: not in the accessibility tree
    act(() => fireEvent.keyDown(window, { key: "k", bubbles: true, cancelable: true, metaKey: apple, ctrlKey: !apple }));
    fireEvent.click(await screen.findByRole("option", { name: /^工程/ }));
    expect(((await screen.findByRole("textbox", { name: "编辑器" })) as HTMLTextAreaElement).value).toBe("x = 42\n");
    expect(screen.getByText("未保存")).toBeTruthy();
  });

  it("global shortcuts stand down while a confirm dialog is open", async () => {
    const { rpc, api } = await services();
    const id = (await api.listDevices()).devices[0].id;
    await api.writeFile(id, "demo", "b.py", "", true);
    render(
      <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
        <App />
      </ServicesContext.Provider>,
    );
    fireEvent.click(within(screen.getByRole("navigation", { name: "main" })).getByRole("button", { name: /工程/ }));
    await editInitPy();
    fireEvent.click(screen.getByRole("button", { name: /^b\.py/ }));
    await screen.findByRole("alertdialog");
    act(() => nav("1"));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("工程");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
});
