import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { MirrorPage } from "../src/components/MirrorPage";
import { createDemoTransport } from "../src/demo";
import { fitWidth, isLandscape, loadMirrorPrefs, resetMirrorSession, saveMirrorPrefs, wheelPixels, wheelSwipe } from "../src/mirror";
import { isTextEntry } from "../src/shortcuts";

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  resetMirrorSession();
});

describe("mirror fit / wheel / prefs helpers", () => {
  it("fit keeps the aspect ratio inside the available height; 1:1 is device px / dpr; unknown size → null", () => {
    expect(fitWidth({ w: Infinity, h: 700 }, { w: 1080, h: 2340 }, "fit")).toBe(323); // 700 * 1080/2340
    expect(fitWidth({ w: 500, h: 700 }, { w: 2340, h: 1080 }, "fit")).toBe(500); // landscape: width-capped
    expect(fitWidth({ w: Infinity, h: 700 }, { w: 2340, h: 1080 }, "fit")).toBe(1516);
    expect(fitWidth({ w: Infinity, h: 700 }, { w: 1080, h: 2340 }, "actual", 2)).toBe(540);
    expect(fitWidth({ w: Infinity, h: 700 }, null, "fit")).toBeNull();
    expect(fitWidth({ w: Infinity, h: 700 }, { w: 0, h: 10 }, "fit")).toBeNull();
    expect(isLandscape({ w: 2340, h: 1080 })).toBe(true);
    expect(isLandscape({ w: 1080, h: 2340 })).toBe(false);
    expect(isLandscape(null)).toBe(false);
  });

  it("wheel down swipes the finger up from the cursor; edges keep the full length; horizontal and tiny deltas", () => {
    const scr = { w: 1080, h: 2340 };
    expect(wheelSwipe({ x: 540, y: 1200 }, { dx: 0, dy: 100 }, 4, scr)).toEqual({ type: "swipe", x1: 540, y1: 1200, x2: 540, y2: 800, dur: 250 });
    expect(wheelSwipe({ x: 540, y: 1200 }, { dx: 0, dy: -100 }, 4, scr)).toMatchObject({ y1: 1200, y2: 1600 });
    // minimum 8 % of the screen, maximum 50 %
    expect(wheelSwipe({ x: 540, y: 1200 }, { dx: 0, dy: 3 }, 4, scr)).toMatchObject({ y1: 1200, y2: 1013 });
    expect(wheelSwipe({ x: 540, y: 1200 }, { dx: 0, dy: 5000 }, 4, scr)).toMatchObject({ y1: 1200, y2: 30 });
    // near the top a downward scroll starts lower so the swipe is not cut off
    expect(wheelSwipe({ x: 540, y: 10 }, { dx: 0, dy: 100 }, 4, scr)).toMatchObject({ y1: 400, y2: 0 });
    expect(wheelSwipe({ x: 540, y: 2335 }, { dx: 0, dy: -100 }, 4, scr)).toMatchObject({ y1: 1939, y2: 2339 });
    expect(wheelSwipe({ x: 540, y: 1200 }, { dx: 100, dy: 10 }, 2, scr)).toMatchObject({ x1: 540, x2: 340, y1: 1200, y2: 1200 });
    expect(wheelSwipe({ x: 1, y: 1 }, { dx: 0.2, dy: 0.4 }, 4, scr)).toBeNull();
    expect(wheelPixels(3, 1, 500)).toBe(48);
    expect(wheelPixels(1, 2, 500)).toBe(500);
    expect(wheelPixels(7, 0, 500)).toBe(7);
  });

  it("fps and fit persist in storage, pause only for the session; bad storage values fall back", () => {
    expect(loadMirrorPrefs()).toEqual({ fps: 12, fit: "fit", playing: true });
    saveMirrorPrefs({ fps: 5, fit: "actual", playing: false });
    expect(loadMirrorPrefs()).toEqual({ fps: 5, fit: "actual", playing: false });
    resetMirrorSession(); // = an app restart
    expect(loadMirrorPrefs()).toEqual({ fps: 5, fit: "actual", playing: true });
    window.localStorage.setItem("xscript.mirror", JSON.stringify({ fps: 999, fit: "zoom" }));
    expect(loadMirrorPrefs()).toMatchObject({ fps: 12, fit: "fit" });
    window.localStorage.setItem("xscript.mirror", "{not json");
    expect(loadMirrorPrefs()).toMatchObject({ fps: 12, fit: "fit" });
  });

  it("the mirror frame counts as text entry, so single-key shortcuts (?) don't fire while typing into it", () => {
    const el = document.createElement("div");
    el.setAttribute("data-text-entry", "true");
    const child = document.createElement("img");
    el.appendChild(child);
    expect(isTextEntry(el)).toBe(true);
    expect(isTextEntry(child)).toBe(true);
    expect(isTextEntry(document.createElement("div"))).toBe(false);
  });
});

async function setup() {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  const d = await api.connectAdb("emulator-5554");
  const r = render(
    <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
      <MirrorPage />
    </ServicesContext.Provider>,
  );
  return { transport, d, ...r, rpc, api };
}

function sizedFrame(): HTMLImageElement {
  const img = screen.getByAltText("设备屏幕") as HTMLImageElement;
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 270, height: 552, right: 270, bottom: 552, x: 0, y: 0, toJSON: () => ({}) });
  Object.defineProperty(img, "naturalWidth", { value: 540, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: 1104, configurable: true });
  return img;
}

const actions = (transport: ReturnType<typeof createDemoTransport>) => transport.sent.filter((m) => m.method === "device.action").map((m) => m.params);
const frameEl = () => screen.getByLabelText("设备屏幕（点一下后可直接打字，Enter 发送）");

describe("MirrorPage layout (H3)", () => {
  it("portrait fits the window height; a landscape stream stacks the layout; 1:1 scrolls inside the window height", async () => {
    const { transport } = await setup();
    await screen.findByAltText("设备屏幕");
    const fr = frameEl();
    const grid = fr.parentElement!;
    // jsdom: innerHeight 768, frame top 0 → 744 px available
    await act(async () => {
      transport.push({ event: true, topic: "mirror.frame", data: { id: "adb:emulator-5554", seq: 2, w: 1080, h: 2340 } });
    });
    expect(grid.className).not.toContain("stacked");
    expect(fr.style.width).toBe(`${Math.floor((744 * 1080) / 2340)}px`);
    await act(async () => {
      transport.push({ event: true, topic: "mirror.frame", data: { id: "adb:emulator-5554", seq: 3, w: 2340, h: 1080 } });
    });
    expect(grid.className).toContain("stacked");
    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    expect(screen.getByRole("button", { name: "1:1" }).getAttribute("aria-pressed")).toBe("true");
    expect(fr.className).toContain("actual");
    expect(fr.style.maxHeight).toBe("744px");
    expect((fr.querySelector(".mirror-shot") as HTMLElement).style.width).toBe("2340px");
  });

  it("the device dropdown marks offline devices", async () => {
    const { transport, d } = await setup();
    await screen.findByAltText("设备屏幕");
    await act(async () => {
      transport.push({ event: true, topic: "device.state", data: { ...d, id: "lan:10.0.0.9:9860", transport: "lan", state: "offline", info: { ...d.info, name: "备用机" } } });
    });
    const opt = screen.getByRole("option", { name: /备用机/ }) as HTMLOptionElement;
    expect(opt.textContent).toBe("备用机（离线）");
    expect(opt.disabled).toBe(true);
  });
});

describe("MirrorPage control (M9)", () => {
  it("typing on the focused frame builds a line; Backspace edits, Esc cancels, Enter sends one input action", async () => {
    const { transport } = await setup();
    const img = await screen.findByAltText("设备屏幕");
    fireEvent.pointerDown(img, { button: 0, clientX: 1, clientY: 1, pointerId: 1 });
    const fr = frameEl();
    expect(document.activeElement).toBe(fr);
    for (const k of ["h", "i", "x"]) fireEvent.keyDown(fr, { key: k });
    fireEvent.keyDown(fr, { key: "Backspace" });
    fireEvent.keyDown(fr, { key: " " });
    fireEvent.keyDown(fr, { key: "你" });
    fireEvent.keyDown(fr, { key: "a", ctrlKey: true }); // chords are not typed
    fireEvent.keyDown(fr, { key: "Shift" }); // modifiers alone are not typed
    expect(fr.querySelector(".compose-text")!.textContent).toBe("hi 你▌");
    fireEvent.keyDown(fr, { key: "Escape" });
    expect(fr.querySelector(".compose-text")).toBeNull();
    fireEvent.keyDown(fr, { key: "o" });
    fireEvent.keyDown(fr, { key: "k" });
    fireEvent.paste(fr, { clipboardData: { getData: () => "!!" } });
    fireEvent.keyDown(fr, { key: "Enter" });
    await vi.waitFor(() => expect(actions(transport)).toEqual([expect.objectContaining({ type: "input", text: "ok!!" })]));
    expect(await screen.findByText("已发送：ok!!")).toBeTruthy();
    expect(fr.querySelector(".compose-text")).toBeNull();
    fireEvent.keyDown(fr, { key: "Enter" }); // nothing typed: nothing sent
    expect(actions(transport)).toHaveLength(1);
  });

  it("keys that arrive before a re-render (fast typing) are not lost", async () => {
    const { transport } = await setup();
    await screen.findByAltText("设备屏幕");
    const fr = frameEl();
    act(() => {
      for (const key of ["f", "a", "s", "t", "Enter"]) fr.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => expect(actions(transport)).toEqual([expect.objectContaining({ type: "input", text: "fast" })]));
  });

  it("a failed send keeps the typed line; inspect mode does not type", async () => {
    const { transport } = await setup();
    await screen.findByAltText("设备屏幕");
    const fr = frameEl();
    transport.setHandler("device.action", () => {
      throw { code: "device.unreachable", message: "cannot reach" };
    });
    fireEvent.keyDown(fr, { key: "z" });
    fireEvent.keyDown(fr, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toContain("连不上设备");
    expect(fr.querySelector(".compose-text")!.textContent).toBe("z▌");
    fireEvent.keyDown(fr, { key: "Escape" });
    fireEvent.click(screen.getByRole("radio", { name: "选控件" }));
    fireEvent.keyDown(fr, { key: "q" });
    expect(fr.querySelector(".compose-text")).toBeNull();
  });

  it("the wheel becomes one swipe per flick (scroll down = finger up) and does not scroll the page; right-click = back", async () => {
    const { transport } = await setup();
    await screen.findByAltText("设备屏幕");
    const img = sizedFrame();
    vi.useFakeTimers();
    const ev1 = new WheelEvent("wheel", { deltaY: 40, clientX: 135, clientY: 276, bubbles: true, cancelable: true });
    img.dispatchEvent(ev1);
    img.dispatchEvent(new WheelEvent("wheel", { deltaY: 60, clientX: 135, clientY: 260, bubbles: true, cancelable: true }));
    expect(ev1.defaultPrevented).toBe(true);
    expect(actions(transport)).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    vi.useRealTimers();
    // 100 element px * (2209/552) ≈ 400 device px, from the first wheel position (540, 1105)
    await vi.waitFor(() => expect(actions(transport)[0]).toMatchObject({ type: "swipe", x1: 540, y1: 1105, x2: 540, dur: 250 }));
    const sw = actions(transport)[0] as { y1: number; y2: number };
    expect(sw.y1 - sw.y2).toBeGreaterThan(380);
    expect(sw.y1 - sw.y2).toBeLessThan(420);

    fireEvent.pointerDown(img, { button: 2, clientX: 5, clientY: 5, pointerId: 1 });
    fireEvent.pointerUp(img, { button: 2, clientX: 5, clientY: 5, pointerId: 1 });
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    img.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(actions(transport)).toHaveLength(2));
    expect(actions(transport)[1]).toMatchObject({ type: "key", name: "back" }); // the right button press itself is not a tap
  });

  it("frame rate, fit and pause are remembered when the page is entered again", async () => {
    const first = await setup();
    await screen.findByAltText("设备屏幕");
    fireEvent.change(screen.getByRole("combobox", { name: "帧率" }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    first.unmount();
    const again = await setup();
    expect(((await screen.findByRole("combobox", { name: "帧率" })) as HTMLSelectElement).value).toBe("5");
    expect(screen.getByRole("button", { name: "1:1" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "开始" })).toBeTruthy();
    expect(screen.getByText("已暂停")).toBeTruthy();
    expect(again.transport.sent.some((m) => m.method === "mirror.subscribe")).toBe(false); // paused: no viewer slot taken
  });

  it("「取不到画面」 has a retry that reloads the frame and nudges the stream", async () => {
    const { transport } = await setup();
    const img = await screen.findByAltText("设备屏幕");
    const before = img.getAttribute("src");
    fireEvent.error(img);
    const overlay = screen.getByText(/取不到画面/).closest(".overlay") as HTMLElement;
    const retry = overlay.querySelector("button")!;
    expect(retry.textContent).toBe("重试");
    fireEvent.keyDown(retry, { key: "Enter" }); // the frame's typing must not swallow keys on its own buttons
    expect(frameEl().querySelector(".compose-text")).toBeNull();
    fireEvent.click(retry);
    expect(screen.queryByText(/取不到画面/)).toBeNull();
    expect(screen.getByAltText("设备屏幕").getAttribute("src")).not.toBe(before);
    await vi.waitFor(() => expect(transport.sent.some((m) => m.method === "mirror.retry")).toBe(true));
  });
});
