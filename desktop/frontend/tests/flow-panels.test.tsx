import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FlowPage } from "../src/components/FlowPage";
import { toneOf, VariablePanel } from "../src/components/VariablePanel";
import { parse } from "../src/flow/dsl";
import { AUTO_FIT, libraryShown, matchesNarrow, NARROW_QUERY, overflowEdges, shouldAutoFit, startViewport, toggleLibrary, wheelShift } from "../src/flow/panels";

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
function mockMedia(initial: boolean) {
  const listeners = new Set<Listener>();
  const query = {
    matches: initial,
    media: NARROW_QUERY,
    addEventListener: (_type: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_type: string, fn: Listener) => listeners.delete(fn),
  };
  const spy = vi.fn((text: string) => (text === NARROW_QUERY ? query : { matches: false, media: text, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: spy });
  return {
    listeners,
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
const toggle = () => screen.getByRole("button", { name: "节点库（⌘B / Ctrl+B）" });

describe("flow page chrome helpers", () => {
  it("decides when the library shows and flips what the user sees", () => {
    expect(libraryShown("auto", false)).toBe(true);
    expect(libraryShown("auto", true)).toBe(false);
    expect(libraryShown("open", true)).toBe(true);
    expect(libraryShown("closed", false)).toBe(false);
    expect(toggleLibrary("auto", false)).toBe("closed");
    expect(toggleLibrary("auto", true)).toBe("open");
    expect(toggleLibrary("open", true)).toBe("closed");
    expect(toggleLibrary("closed", false)).toBe("open");
  });

  it("reports which toolbar edges hide buttons", () => {
    expect(overflowEdges(0, 300, 300)).toBe("");
    expect(overflowEdges(0, 300, 300.5)).toBe("");
    expect(overflowEdges(0, 300, 800)).toBe("end");
    expect(overflowEdges(200, 300, 800)).toBe("start end");
    expect(overflowEdges(500, 300, 800)).toBe("start");
  });

  it("turns a vertical wheel into a sideways scroll only when it dominates", () => {
    expect(wheelShift(0, 120)).toBe(120);
    expect(wheelShift(0, -40)).toBe(-40);
    expect(wheelShift(30, 10)).toBe(0);
    expect(wheelShift(0, 0)).toBe(0);
  });

  it("reads the narrow query defensively", () => {
    expect(matchesNarrow()).toBe(false);
    mockMedia(true);
    expect(matchesNarrow()).toBe(true);
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: () => { throw new Error("no media"); } });
    expect(matchesNarrow()).toBe(false);
  });

  it("frames a small flow centred and never zooms past 100%", () => {
    const view = startViewport({ x: 0, y: 0, width: 200, height: 100 }, 800, 400);
    expect(view.zoom).toBe(1);
    expect(view.x).toBe(300);
    expect(view.y).toBe(150);
  });

  it("fits a mid-size flow exactly inside the padding", () => {
    const view = startViewport({ x: 100, y: 50, width: 1000, height: 200 }, 832, 400);
    expect(view.zoom).toBeCloseTo(0.768, 3);
    expect(view.x).toBeCloseTo(32 - 100 * view.zoom, 6);
    expect(view.y).toBeCloseTo((400 - 200 * view.zoom) / 2 - 50 * view.zoom, 6);
  });

  it("keeps a readable zoom on a wide flow and pins its start", () => {
    const view = startViewport({ x: -40, y: 10, width: 4000, height: 300 }, 600, 400);
    expect(view.zoom).toBe(AUTO_FIT.minZoom);
    expect(view.x).toBeCloseTo(AUTO_FIT.padding + 40 * AUTO_FIT.minZoom, 6);
    expect(view.y).toBeCloseTo((400 - 300 * 0.6) / 2 - 10 * 0.6, 6);
    const tall = startViewport({ x: 0, y: 0, width: 100, height: 5000 }, 600, 400, { padding: 10, minZoom: 0.5, maxZoom: 1 });
    expect(tall).toEqual({ x: (600 - 50) / 2, y: 10, zoom: 0.5 });
    const empty = startViewport({ x: 0, y: 0, width: 0, height: 0 }, 10, 10);
    expect(empty.zoom).toBe(1);
  });

  it("fits once per flow and only after measuring", () => {
    expect(shouldAutoFit(null, "demo", false)).toBe(false);
    expect(shouldAutoFit(null, "demo", true)).toBe(true);
    expect(shouldAutoFit("demo", "demo", true)).toBe(false);
    expect(shouldAutoFit("demo", "other", true)).toBe(true);
  });

  it("maps variable types onto pin tones", () => {
    expect(toneOf("int")).toBe("int");
    expect(toneOf("string")).toBe("string");
    expect(toneOf("list[int]")).toBe("any");
    expect(toneOf("")).toBe("any");
  });
});

describe("flow page library toggle", () => {
  it("shows the library on wide windows and toggles it from the toolbar and ⌘B", () => {
    render(<FlowPage />);
    expect(page().dataset.library).toBe("open");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle());
    expect(page().dataset.library).toBe("closed");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(document.body, { key: "b", metaKey: true, ctrlKey: true, bubbles: true });
    expect(page().dataset.library).toBe("open");
  });

  it("starts hidden on narrow windows, opens on the first press and follows resizes", () => {
    const media = mockMedia(true);
    render(<FlowPage />);
    expect(page().dataset.library).toBe("closed");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    act(() => media.set(false));
    expect(page().dataset.library).toBe("open");
    act(() => media.set(true));
    expect(page().dataset.library).toBe("closed");
    fireEvent.click(toggle());
    expect(page().dataset.library).toBe("open");
    act(() => media.set(false));
    expect(page().dataset.library).toBe("open");
  });

  it("stops listening when the page goes away", () => {
    const media = mockMedia(false);
    const view = render(<FlowPage />);
    expect(media.listeners.size).toBe(1);
    view.unmount();
    expect(media.listeners.size).toBe(0);
  });
});

describe("flow toolbar overflow", () => {
  it("marks hidden edges and scrolls sideways with the wheel", () => {
    render(<FlowPage />);
    const bar = screen.getByRole("toolbar", { name: "画布操作" });
    let left = 0;
    Object.defineProperty(bar, "clientWidth", { configurable: true, get: () => 300 });
    Object.defineProperty(bar, "scrollWidth", { configurable: true, get: () => 900 });
    Object.defineProperty(bar, "scrollLeft", { configurable: true, get: () => left, set: (value: number) => { left = Math.max(0, Math.min(600, value)); } });
    fireEvent.scroll(bar);
    expect(bar.getAttribute("data-overflow")).toBe("end");
    expect(bar.getAttribute("title")).toBe("工具栏还有更多按钮，可横向滚动");
    fireEvent.wheel(bar, { deltaY: 200 });
    expect(left).toBe(200);
    fireEvent.scroll(bar);
    expect(bar.getAttribute("data-overflow")).toBe("start end");
    fireEvent.wheel(bar, { deltaX: 50, deltaY: 10 });
    expect(left).toBe(200);
    fireEvent.wheel(bar, { deltaY: 1000 });
    fireEvent.scroll(bar);
    expect(bar.getAttribute("data-overflow")).toBe("start");
    Object.defineProperty(bar, "scrollWidth", { configurable: true, get: () => 300 });
    left = 0;
    fireEvent.scroll(bar);
    expect(bar.hasAttribute("data-overflow")).toBe(false);
    expect(bar.hasAttribute("title")).toBe(false);
  });

  it("keeps the themed minimap on the canvas", () => {
    render(<FlowPage />);
    expect(document.querySelector(".flow-canvas .react-flow__minimap")).toBeTruthy();
  });
});

describe("variable rows", () => {
  it("shows kind, name, type and detail as separate parts with per-row actions", () => {
    const graph = parse(
      [
        "flow demo  # xflow 1",
        'var score: int = 1 doc="当前分数" category="计数"',
        "env TOKEN secret",
        "param retries: int = 3",
        "on start:",
        "  for attempt in range(0, 3):",
        '    log(message="x")',
        "",
      ].join("\n"),
    );
    const onChange = vi.fn();
    render(<VariablePanel graph={graph} onChange={onChange} />);
    const row = (name: string) => screen.getByRole("button", { name: "读取 " + name }).closest("li") as HTMLElement;
    const part = (name: string, cls: string) => row(name).querySelector(cls)?.textContent;
    expect(part("score", ".flow-var-kind")).toBe("变量");
    expect(part("score", ".flow-var-name")).toBe("计数 / score");
    expect(part("score", ".flow-var-type")).toBe("int");
    expect(part("score", ".flow-var-detail")).toBe("1");
    expect(row("score").querySelector(".flow-var-main")?.getAttribute("title")).toBe("当前分数");
    expect((row("score").querySelector(".flow-var-type") as HTMLElement).style.color).toBe("var(--tone-int)");
    expect(part("TOKEN", ".flow-var-kind")).toBe("环境");
    expect(part("TOKEN", ".flow-var-detail")).toBe("secret");
    expect(row("TOKEN").querySelector(".flow-var-main")?.hasAttribute("title")).toBe(false);
    expect(part("retries", ".flow-var-kind")).toBe("参数");
    expect(part("attempt", ".flow-var-kind")).toBe("循环");
    expect(screen.getByRole("button", { name: "写入 score" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "写入 TOKEN" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "写入 score" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("leaves out the detail part when there is none", () => {
    const graph = parse(["flow demo  # xflow 1", "env HOME", "on start:", '  log(message="x")', ""].join("\n"));
    render(<VariablePanel graph={graph} onChange={() => undefined} />);
    const row = screen.getByRole("button", { name: "读取 HOME" }).closest("li") as HTMLElement;
    expect(row.querySelector(".flow-var-detail")).toBeNull();
    expect(row.querySelector(".flow-var-type")?.textContent).toBe("string");
  });
});
