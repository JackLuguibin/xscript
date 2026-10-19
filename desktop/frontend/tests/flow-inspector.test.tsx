import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FlowPage } from "../src/components/FlowPage";
import { paletteStep } from "../src/flow/palette";
import { COMPACT_QUERY, inspectorShown, numberIssue, toggleInspector } from "../src/flow/panels";

beforeAll(() => {
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, "ResizeObserver", { configurable: true, writable: true, value: Observer });
  Object.defineProperty(window, "DOMMatrixReadOnly", { configurable: true, writable: true, value: class { m22 = 1; } });
});

type Listener = () => void;
function mockCompact(initial: boolean) {
  const listeners = new Set<Listener>();
  const query = {
    matches: initial,
    media: COMPACT_QUERY,
    addEventListener: (_type: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_type: string, fn: Listener) => listeners.delete(fn),
  };
  const other = (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: (text: string) => (text === COMPACT_QUERY ? query : other(text)) });
  return {
    set(next: boolean) {
      query.matches = next;
      for (const fn of listeners) fn();
    },
  };
}

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

const page = () => document.querySelector(".flow-page") as HTMLElement;
const flowText = () => (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;
const inspectorToggle = () => screen.getByRole("button", { name: "检查器（⌘⇧I / Ctrl+Shift+I）" });
const pick = (id: string) => fireEvent.click(screen.getByRole("checkbox", { name: id }));
/** Select on the canvas, which works while the inspector (and its node list) is folded away. */
const pickOnCanvas = (id: string) => fireEvent.click(document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement);

describe("inspector and palette helpers", () => {
  it("shows the inspector on wide windows, and on compact ones only while something is picked", () => {
    expect(inspectorShown("auto", false, false)).toBe(true);
    expect(inspectorShown("auto", true, false)).toBe(false);
    expect(inspectorShown("auto", true, true)).toBe(true);
    expect(inspectorShown("open", true, false)).toBe(true);
    expect(inspectorShown("closed", false, true)).toBe(false);
    expect(toggleInspector("auto", false, false)).toBe("closed");
    expect(toggleInspector("auto", true, false)).toBe("open");
    expect(toggleInspector("auto", true, true)).toBe("closed");
    expect(toggleInspector("closed", false, false)).toBe("open");
  });

  it("explains why a number draft cannot be stored", () => {
    expect(numberIssue("", "int")).toEqual({ kind: "required" });
    expect(numberIssue("  ", "float")).toEqual({ kind: "required" });
    expect(numberIssue("abc", "float")).toEqual({ kind: "number" });
    expect(numberIssue("Infinity", "float")).toEqual({ kind: "number" });
    expect(numberIssue("1.5", "int")).toEqual({ kind: "integer" });
    expect(numberIssue("1.5", "float")).toBeNull();
    expect(numberIssue("-1", "int", 0)).toEqual({ kind: "min", min: 0 });
    expect(numberIssue("0", "int", 0)).toBeNull();
    expect(numberIssue("-1", "int")).toBeNull();
  });

  it("walks the palette rows with the arrow, Home and End keys", () => {
    expect(paletteStep("ArrowDown", 0, 3)).toBe(1);
    expect(paletteStep("ArrowDown", 2, 3)).toBe(2);
    expect(paletteStep("ArrowUp", 0, 3)).toBe(0);
    expect(paletteStep("ArrowUp", 2, 3)).toBe(1);
    expect(paletteStep("Home", 2, 3)).toBe(0);
    expect(paletteStep("End", 0, 3)).toBe(2);
    expect(paletteStep("Tab", 0, 3)).toBeNull();
    expect(paletteStep("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("inspector groups", () => {
  it("groups the selected node's fields into collapsible sections", () => {
    render(<FlowPage />);
    pick("btn");
    const general = screen.getByRole("region", { name: "常规" });
    const inputs = screen.getByRole("region", { name: "输入" });
    expect(screen.getByRole("region", { name: "输出" })).toBeTruthy();
    expect(within(general).getByRole("textbox", { name: "显示名" })).toBeTruthy();
    expect(within(general).getByRole("textbox", { name: "节点文本" })).toBeTruthy();
    expect(within(inputs).getByRole("textbox", { name: "属性 text" })).toBeTruthy();
    const head = within(inputs).getByRole("button", { name: /输入/ });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(head.textContent).toMatch(/输入\d+/);
    expect(document.getElementById(head.getAttribute("aria-controls") ?? "")).toBeTruthy();
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("textbox", { name: "属性 text" })).toBeNull();
    // Folding is remembered while moving between nodes.
    pick("btn");
    pick("warm");
    expect(screen.queryByRole("spinbutton", { name: "属性 ms" })).toBeNull();
    fireEvent.click(within(screen.getByRole("region", { name: "输入" })).getByRole("button", { name: /输入/ }));
    expect(screen.getByRole("spinbutton", { name: "属性 ms" })).toBeTruthy();
    // General folds on its own.
    fireEvent.click(within(screen.getByRole("region", { name: "常规" })).getByRole("button", { name: "常规" }));
    expect(screen.queryByRole("textbox", { name: "显示名" })).toBeNull();
    expect(screen.getByRole("spinbutton", { name: "属性 ms" })).toBeTruthy();
  });

  it("puts the code node's pins and source in a code section, and pin jumps under general", async () => {
    render(<FlowPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "流程文本" }), {
      target: { value: ["flow c  # xflow 1", "on start:", '  box: code(outPins="x:int", source="x = 1")', "  say: log(message=box.x)", ""].join("\n") },
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    pick("box");
    const code = screen.getByRole("region", { name: "代码" });
    expect((within(code).getByRole("textbox", { name: "源码" }) as HTMLTextAreaElement).value).toBe("x = 1");
    expect((within(code).getByRole("textbox", { name: "输出引脚" }) as HTMLInputElement).value).toBe("x:int");
    fireEvent.click(within(code).getByRole("button", { name: "代码" }));
    expect(screen.queryByRole("textbox", { name: "源码" })).toBeNull();
    pick("box");
    pick("say");
    const general = screen.getByRole("region", { name: "常规" });
    fireEvent.click(within(general).getByRole("button", { name: "转到 box" }));
    expect((screen.getByRole("checkbox", { name: "box" }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("inline validation", () => {
  it("keeps an invalid number draft, says why, and stores only valid values", () => {
    render(<FlowPage />);
    pick("warm");
    const ms = screen.getByRole("spinbutton", { name: "属性 ms" }) as HTMLInputElement;
    expect(ms.getAttribute("aria-invalid")).toBeNull();
    expect(ms.step).toBe("1");
    fireEvent.change(ms, { target: { value: "" } });
    expect(screen.getByRole("alert").textContent).toBe("请输入数字");
    expect(ms.getAttribute("aria-invalid")).toBe("true");
    expect(ms.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
    expect(ms.closest("label")?.classList.contains("is-invalid")).toBe(true);
    expect(flowText()).toContain("ms=2000");
    fireEvent.change(ms, { target: { value: "1.5" } });
    expect(screen.getByRole("alert").textContent).toBe("需要整数");
    fireEvent.change(ms, { target: { value: "-5" } });
    expect(screen.getByRole("alert").textContent).toBe("不能小于 0");
    expect(ms.value).toBe("-5");
    expect(flowText()).toContain("ms=2000");
    fireEvent.change(ms, { target: { value: "1500" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(ms.getAttribute("aria-invalid")).toBeNull();
    expect(flowText()).toContain("ms=1500");
  });

  it("drops a stale invalid draft when the value changes elsewhere", async () => {
    render(<FlowPage />);
    pick("warm");
    const ms = () => screen.getByRole("spinbutton", { name: "属性 ms" }) as HTMLInputElement;
    fireEvent.change(ms(), { target: { value: "" } });
    expect(screen.getByRole("alert")).toBeTruthy();
    const canvasField = document.querySelector('.react-flow__node[data-id="warm"] .xflow-field input') as HTMLInputElement;
    fireEvent.change(canvasField, { target: { value: "700" } });
    expect(ms().value).toBe("700");
    expect(screen.queryByRole("alert")).toBeNull();
    // A float pin accepts fractions and has no step.
    pick("warm");
    pick("btn");
    const timeout = screen.getByRole("spinbutton", { name: "属性 timeout" }) as HTMLInputElement;
    expect(timeout.step).toBe("any");
    fireEvent.change(timeout, { target: { value: "2.5" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(flowText()).toContain("timeout=2.5");
  });
});

describe("inspector panel", () => {
  it("folds away from the toolbar, the header and the keyboard on a wide window", () => {
    render(<FlowPage />);
    expect(page().dataset.inspector).toBe("open");
    expect(inspectorToggle().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(inspectorToggle());
    expect(page().dataset.inspector).toBe("closed");
    expect(screen.queryByRole("complementary", { name: "检查器" })).toBeNull();
    expect(inspectorToggle().getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(window, { key: "I", ctrlKey: true, shiftKey: true });
    expect(page().dataset.inspector).toBe("open");
    fireEvent.click(screen.getByRole("button", { name: "收起检查器" }));
    expect(page().dataset.inspector).toBe("closed");
    // Picking a node does not reopen a panel the user closed.
    pickOnCanvas("warm");
    expect(page().dataset.inspector).toBe("closed");
    fireEvent.keyDown(window, { key: "i", metaKey: true, shiftKey: true });
    expect(page().dataset.inspector).toBe("open");
  });

  it("starts folded on a compact window and opens while a node is picked", () => {
    const media = mockCompact(true);
    render(<FlowPage />);
    expect(page().dataset.inspector).toBe("closed");
    pickOnCanvas("warm");
    expect(page().dataset.inspector).toBe("open");
    expect(screen.getByRole("spinbutton", { name: "属性 ms" })).toBeTruthy();
    // The toggle flips what is shown: folded while picked, then open again even with nothing picked.
    fireEvent.click(inspectorToggle());
    expect(page().dataset.inspector).toBe("closed");
    fireEvent.click(inspectorToggle());
    expect(page().dataset.inspector).toBe("open");
    act(() => media.set(false));
    expect(page().dataset.inspector).toBe("open");
  });
});

describe("palette keyboard", () => {
  it("moves through the rows like a tree view", () => {
    render(<FlowPage />);
    const palette = screen.getByRole("region", { name: "组件" });
    const search = within(palette).getByRole("textbox", { name: "搜索组件" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const first = document.activeElement as HTMLElement;
    expect(first.classList.contains("flow-family") || first.classList.contains("flow-leaf")).toBe(true);
    const rows = () => [...palette.querySelectorAll<HTMLElement>(".flow-family, .flow-cat, .flow-leaves .flow-leaf")];
    fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(rows()[rows().length - 1]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(rows()[0]);
    // A folded family opens with →, the next → walks into it, ← goes back up and folds it.
    const family = rows().find((row) => row.classList.contains("flow-family") && row.getAttribute("aria-expanded") === "false") as HTMLElement;
    family.focus();
    fireEvent.keyDown(family, { key: "ArrowRight" });
    expect(family.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(family, { key: "ArrowRight" });
    const cat = document.activeElement as HTMLElement;
    expect(cat.classList.contains("flow-cat")).toBe(true);
    fireEvent.keyDown(cat, { key: "ArrowRight" });
    expect(cat.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(cat, { key: "ArrowDown" });
    const leaf = document.activeElement as HTMLElement;
    expect(leaf.classList.contains("flow-leaf")).toBe(true);
    fireEvent.keyDown(leaf, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cat);
    fireEvent.keyDown(cat, { key: "ArrowLeft" });
    expect(cat.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(cat, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(family);
    fireEvent.keyDown(family, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "x" });
  });

  it("adds the first search hit with Enter and clears the search with Escape", () => {
    render(<FlowPage />);
    const palette = screen.getByRole("region", { name: "组件" });
    const search = within(palette).getByRole("textbox", { name: "搜索组件" }) as HTMLInputElement;
    const before = document.querySelectorAll(".react-flow__node").length;
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.change(search, { target: { value: "打印" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(flowText().match(/log\(/g)?.length).toBeGreaterThan(2);
    expect(document.querySelectorAll(".react-flow__node").length).toBeGreaterThanOrEqual(before);
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search.value).toBe("");
    fireEvent.keyDown(search, { key: "Escape" });
  });
});
