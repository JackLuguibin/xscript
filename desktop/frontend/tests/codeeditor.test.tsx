import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeEditor, editorLoader } from "../src/components/CodeEditor";

const realLoad = editorLoader.load;
afterEach(() => {
  editorLoader.load = realLoad;
  document.documentElement.removeAttribute("data-theme");
});

function fakeMonaco() {
  const calls = { created: 0, disposed: 0, theme: [] as boolean[], set: [] as string[] };
  let value = "";
  let opts: { onChange: (v: string) => void; onKey: (e: KeyboardEvent) => void; dark: boolean; language: string } | null = null;
  const mod = {
    languageFor: (p: string) => (p.endsWith(".py") ? "python" : "plaintext"),
    createEditor: (el: HTMLElement, o: { value: string; onChange: (v: string) => void; onKey: (e: KeyboardEvent) => void; dark: boolean; language: string }) => {
      calls.created++;
      value = o.value;
      opts = o;
      el.appendChild(document.createElement("div")).className = "monaco-editor";
      return {
        getValue: () => value,
        setValue: (v: string) => {
          value = v;
          calls.set.push(v);
        },
        setTheme: (d: boolean) => calls.theme.push(d),
        dispose: () => calls.disposed++,
      };
    },
  };
  return { mod, calls, type: (v: string) => ((value = v), opts!.onChange(v)), key: (e: KeyboardEvent) => opts!.onKey(e), opts: () => opts! };
}

describe("CodeEditor", () => {
  it("falls back to a textarea under jsdom (the default loader does not load Monaco)", async () => {
    expect(await editorLoader.load()).toBeNull();
    const onChange = vi.fn();
    const onKey = vi.fn();
    render(<CodeEditor path="a.py" value="x" label="ed" onChange={onChange} onKeyDown={onKey} />);
    const ta = screen.getByRole("textbox", { name: "ed" });
    fireEvent.change(ta, { target: { value: "y" } });
    fireEvent.keyDown(ta, { key: "s", ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith("y");
    expect(onKey.mock.calls[0][0].key).toBe("s");
  });

  it("swaps in Monaco once loaded: change/key callbacks, external value sync, theme follow, dispose", async () => {
    const f = fakeMonaco();
    editorLoader.load = () => Promise.resolve(f.mod);
    document.documentElement.setAttribute("data-theme", "dark");
    const onChange = vi.fn();
    const onKey = vi.fn();
    const { container, rerender, unmount } = render(<CodeEditor path="main.py" value="print(1)" label="ed" onChange={onChange} onKeyDown={onKey} />);
    await act(async () => undefined);
    expect(container.querySelector(".monaco-host")!.getAttribute("data-ready")).toBe("true");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(f.opts().dark).toBe(true);
    expect(f.opts().language).toBe("python");
    f.type("print(2)");
    expect(onChange).toHaveBeenCalledWith("print(2)");
    f.key(new KeyboardEvent("keydown", { key: "F6" }));
    expect(onKey).toHaveBeenCalled();
    rerender(<CodeEditor path="main.py" value="reloaded" label="ed" onChange={onChange} onKeyDown={onKey} />);
    expect(f.calls.set).toEqual(["reloaded"]);
    await act(async () => document.documentElement.setAttribute("data-theme", "light"));
    expect(f.calls.theme).toContain(false);
    unmount();
    expect(f.calls.disposed).toBe(1);
  });

  it("keeps the textarea when loading Monaco fails", async () => {
    editorLoader.load = () => Promise.reject(new Error("chunk failed"));
    render(<CodeEditor path="a.py" value="x" label="ed" onChange={() => undefined} onKeyDown={() => undefined} />);
    await act(async () => undefined);
    expect(screen.getByRole("textbox", { name: "ed" })).toBeTruthy();
  });
});
