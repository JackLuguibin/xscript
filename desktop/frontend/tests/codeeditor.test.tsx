import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeEditor, editorLoader } from "../src/components/CodeEditor";

const realLoad = editorLoader.load;
afterEach(() => {
  editorLoader.load = realLoad;
  document.documentElement.removeAttribute("data-theme");
});

function fakeMonaco() {
  const calls = { created: 0, disposed: 0, theme: [] as boolean[], set: [] as string[], bps: [] as number[][], cur: [] as Array<number | null>, reveal: [] as number[][] };
  let value = "";
  type O = { value: string; onChange: (v: string) => void; onKey: (e: KeyboardEvent) => void; dark: boolean; language: string; breakpoints?: number[]; currentLine?: number | null; onToggleBreakpoint?: (n: number) => void };
  let opts: O | null = null;
  const mod = {
    languageFor: (p: string) => (p.endsWith(".py") ? "python" : "plaintext"),
    createEditor: (el: HTMLElement, o: O) => {
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
        setBreakpoints: (l: number[]) => calls.bps.push(l),
        setCurrentLine: (n: number | null) => calls.cur.push(n),
        reveal: (l: number, c: number, n: number) => calls.reveal.push([l, c, n]),
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

  it("textarea fallback: F9 toggles a breakpoint on the caret line and shows the paused line", () => {
    const toggle = vi.fn();
    const onKey = vi.fn();
    const { rerender } = render(<CodeEditor path="a.py" value={"a = 1\nb = 2\nc = 3\n"} label="ed" onChange={() => undefined} onKeyDown={onKey} onToggleBreakpoint={toggle} />);
    const ta = screen.getByRole("textbox", { name: "ed" }) as HTMLTextAreaElement;
    ta.setSelectionRange(8, 8);
    fireEvent.keyDown(ta, { key: "F9" });
    expect(toggle).toHaveBeenCalledWith(2);
    expect(onKey).not.toHaveBeenCalled();
    rerender(<CodeEditor path="a.py" value={"a = 1\nb = 2\nc = 3\n"} label="ed" onChange={() => undefined} onKeyDown={onKey} currentLine={3} />);
    expect(screen.getByTestId("current-line").textContent).toContain("3: c = 3");
  });

  it("Monaco: passes breakpoints/current line through and forwards gutter toggles", async () => {
    const f = fakeMonaco();
    editorLoader.load = () => Promise.resolve(f.mod);
    const toggle = vi.fn();
    const props = { path: "m.py", value: "x", label: "ed", onChange: () => undefined, onKeyDown: () => undefined, onToggleBreakpoint: toggle };
    const { rerender } = render(<CodeEditor {...props} breakpoints={[2]} currentLine={null} />);
    await act(async () => undefined);
    expect(f.opts().breakpoints).toEqual([2]);
    f.opts().onToggleBreakpoint!(4);
    expect(toggle).toHaveBeenCalledWith(4);
    rerender(<CodeEditor {...props} breakpoints={[2, 4]} currentLine={4} />);
    expect(f.calls.bps.at(-1)).toEqual([2, 4]);
    expect(f.calls.cur.at(-1)).toBe(4);
  });

  it("reveal selects the match: in Monaco, and in the textarea fallback", async () => {
    const props = { path: "m.py", value: "a = 1\nprint(tap)\n", label: "ed", onChange: () => undefined, onKeyDown: () => undefined };
    const { unmount } = render(<CodeEditor {...props} reveal={{ line: 2, column: 7, length: 3 }} />);
    const ta = screen.getByRole("textbox", { name: "ed" }) as HTMLTextAreaElement;
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe("tap");
    expect(document.activeElement).toBe(ta);
    unmount();

    const f = fakeMonaco();
    editorLoader.load = () => Promise.resolve(f.mod);
    const { rerender } = render(<CodeEditor {...props} reveal={{ line: 2, column: 7, length: 3 }} />);
    await act(async () => undefined);
    expect(f.calls.reveal).toEqual([[2, 7, 3]]);
    rerender(<CodeEditor {...props} reveal={{ line: 1, column: 1, length: 1 }} />);
    expect(f.calls.reveal.at(-1)).toEqual([1, 1, 1]);
  });
});
