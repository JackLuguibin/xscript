import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { createDemoTransport } from "../src/demo";
import {
  filterCommands,
  formatChord,
  isApplePlatform,
  isTextEntry,
  matchChord,
  readSidebarCollapsed,
  readSingleKeyEnabled,
  shortcutAction,
  writeSidebarCollapsed,
  writeSingleKeyEnabled,
  type KeyEventLike,
} from "../src/shortcuts";
import { setLanguage } from "../src/strings";

const apple = isApplePlatform();

function press(key: string, opts: { mod?: boolean; shift?: boolean; repeat?: boolean; target?: Element | Window } = {}) {
  fireEvent.keyDown(opts.target ?? window, {
    key,
    bubbles: true,
    cancelable: true,
    metaKey: Boolean(opts.mod && apple),
    ctrlKey: Boolean(opts.mod && !apple),
    shiftKey: Boolean(opts.shift),
    repeat: Boolean(opts.repeat),
  });
}

function mount() {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const view = render(
    <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
      <App />
    </ServicesContext.Provider>,
  );
  return { transport, ...view };
}

function ev(partial: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...partial };
}

const ctx = { overlay: null, page: "devices" as const, singleKey: true, typing: false, apple: false };

beforeEach(() => {
  localStorage.clear();
  setLanguage("zh");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.lang = "zh-CN";
});

afterEach(() => {
  setLanguage("zh");
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("shortcut matching", () => {
  it("uses ⌘ on macOS and Ctrl elsewhere, and keeps comma un-cased", () => {
    expect(formatChord({ key: "k", mod: true }, true)).toBe("⌘K");
    expect(formatChord({ key: "t", mod: true, shift: true }, true)).toBe("⌘⇧T");
    expect(formatChord({ key: "k", mod: true }, false)).toBe("Ctrl+K");
    expect(formatChord({ key: ",", mod: true }, false)).toBe("Ctrl+,");
  });

  it("treats Ctrl as ⌘ only on Apple, and ignores alt, repeat, and composing", () => {
    const chord = { key: "k", mod: true };
    expect(matchChord(ev({ key: "k", ctrlKey: true }), chord, false)).toBe(true);
    expect(matchChord(ev({ key: "K", metaKey: true }), chord, true)).toBe(true);
    expect(matchChord(ev({ key: "k", ctrlKey: true }), chord, true)).toBe(false);
    expect(matchChord(ev({ key: "k", metaKey: true, ctrlKey: true }), chord, true)).toBe(false);
    expect(matchChord(ev({ key: "k", ctrlKey: true, altKey: true }), chord, false)).toBe(false);
    expect(matchChord(ev({ key: "k", ctrlKey: true, repeat: true }), chord, false)).toBe(false);
    expect(matchChord(ev({ key: "k", ctrlKey: true, isComposing: true }), chord, false)).toBe(false);
  });

  it("filters commands by label or keywords, case-insensitively", () => {
    const items = [{ label: "屏幕", keywords: "screen" }, { label: "设备", keywords: "devices" }];
    expect(filterCommands(items, "  ")).toEqual(items);
    expect(filterCommands(items, "SCR")).toEqual([items[0]]);
    expect(filterCommands(items, "没有")).toEqual([]);
  });

  it("claims F5 and Ctrl+R only on the device page, and never Shift+F5", () => {
    expect(shortcutAction(ev({ key: "F5" }), ctx)).toEqual({ type: "refresh" });
    expect(shortcutAction(ev({ key: "F5", shiftKey: true }), ctx)).toBeNull();
    expect(shortcutAction(ev({ key: "F5" }), { ...ctx, page: "projects" })).toBeNull();
    expect(shortcutAction(ev({ key: "r", ctrlKey: true }), ctx)).toEqual({ type: "refresh" });
    expect(shortcutAction(ev({ key: "r", ctrlKey: true }), { ...ctx, page: "mirror" })).toEqual({ type: "noop" });
    expect(shortcutAction(ev({ key: "2", ctrlKey: true }), ctx)).toEqual({ type: "nav", index: 1 });
    expect(shortcutAction(ev({ key: "?" }), ctx)).toEqual({ type: "help" });
    expect(shortcutAction(ev({ key: "?" }), { ...ctx, typing: true })).toBeNull();
    expect(shortcutAction(ev({ key: "?" }), { ...ctx, singleKey: false })).toBeNull();
    expect(shortcutAction(ev({ key: "Escape" }), { ...ctx, overlay: "palette" })).toEqual({ type: "close" });
    expect(shortcutAction(ev({ key: "k", ctrlKey: true }), { ...ctx, overlay: "settings" })).toEqual({ type: "palette" });
    expect(shortcutAction(ev({ key: "r", ctrlKey: true }), { ...ctx, overlay: "palette" })).toBeNull();
    expect(shortcutAction(ev({ key: "k", ctrlKey: true, repeat: true }), ctx)).toBeNull();
  });

  it("does not treat checkboxes, radios, or Monaco's surface as plain typing", () => {
    const check = document.createElement("input");
    check.type = "checkbox";
    const text = document.createElement("input");
    const area = document.createElement("textarea");
    expect(isTextEntry(check)).toBe(false);
    expect(isTextEntry(text)).toBe(true);
    expect(isTextEntry(area)).toBe(true);
    expect(isTextEntry(window)).toBe(false);
    const host = document.createElement("div");
    host.className = "monaco-editor";
    const span = document.createElement("span");
    host.appendChild(span);
    document.body.appendChild(host);
    expect(isTextEntry(span)).toBe(true);
    host.remove();
  });

  it("keeps defaults when localStorage throws", () => {
    const orig = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("denied"); } });
    expect(readSidebarCollapsed()).toBe(false);
    expect(readSingleKeyEnabled()).toBe(true);
    expect(() => writeSidebarCollapsed(true)).not.toThrow();
    expect(() => writeSingleKeyEnabled(false)).not.toThrow();
    Object.defineProperty(window, "localStorage", orig);
  });
});

describe("command palette, settings, and chords", () => {
  it("opens the palette, filters, runs an action, and restores focus when it closes", async () => {
    mount();
    const refresh = await screen.findByRole<HTMLButtonElement>("button", { name: "刷新" });
    // disabled until the adb list has loaded, and a disabled button can't take focus (slow runners got here first)
    await waitFor(() => expect(refresh.disabled).toBe(false));
    refresh.focus();
    expect(document.activeElement).toBe(refresh);
    press("k", { mod: true });
    const box = await screen.findByRole("combobox", { name: "命令面板" });
    await waitFor(() => expect(document.activeElement).toBe(box));
    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(refresh);
    press("k", { mod: true });
    const again = await screen.findByRole("combobox", { name: "命令面板" });
    fireEvent.change(again, { target: { value: "屏幕" } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(await screen.findByRole("heading", { level: 1, name: "屏幕" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the flow editor from the command palette", async () => {
    mount();
    await screen.findByText("emulator-5554");
    press("k", { mod: true });
    const box = await screen.findByRole("combobox", { name: "命令面板" });
    fireEvent.change(box, { target: { value: "流程" } });
    const opt = screen.getByRole("option", { name: /流程/ });
    expect(opt.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByRole("heading", { level: 1, name: "流程" })).toBeTruthy();
    press("k", { mod: true });
    const again = await screen.findByRole("combobox", { name: "命令面板" });
    fireEvent.change(again, { target: { value: "没有这个操作" } });
    expect(screen.getByText("没有匹配的操作")).toBeTruthy();
  });

  it("moves the active option with the arrow keys and runs it on click", async () => {
    mount();
    await screen.findByText("emulator-5554");
    press("k", { mod: true });
    const dialog = await screen.findByRole("dialog", { name: "命令面板" });
    const box = within(dialog).getByRole("combobox");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByRole("heading", { level: 1, name: "屏幕" })).toBeTruthy();
    press("k", { mod: true });
    const again = await screen.findByRole("dialog", { name: "命令面板" });
    fireEvent.click(within(again).getByRole("option", { name: /工程/ }));
    expect(await screen.findByText("还没有在线设备")).toBeTruthy();
  });

  it("toggles the palette with the chord, closes from the backdrop, and keeps a click inside", async () => {
    mount();
    await screen.findByText("emulator-5554");
    press("k", { mod: true });
    const dialog = await screen.findByRole("dialog");
    fireEvent.mouseDown(dialog);
    expect(screen.getByRole("dialog")).toBeTruthy();
    press("k", { mod: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    press("k", { mod: true });
    fireEvent.mouseDown(document.querySelector(".overlay-backdrop")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("switches pages with Ctrl/⌘+1…5, ignores 9, and focuses the address with Ctrl/⌘+L", async () => {
    mount();
    await screen.findByText("emulator-5554");
    press("2", { mod: true });
    expect(await screen.findByRole("heading", { level: 1, name: "屏幕" })).toBeTruthy();
    press("4", { mod: true });
    expect(await screen.findByRole("heading", { level: 1, name: "设备墙" })).toBeTruthy();
    press("5", { mod: true });
    expect(await screen.findByRole("heading", { level: 1, name: "流程" })).toBeTruthy();
    press("9", { mod: true });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("流程");
    press("1", { mod: true });
    expect(await screen.findByRole("heading", { level: 1, name: "设备" })).toBeTruthy();
    press("3", { mod: true });
    await screen.findByText("还没有在线设备");
    press("l", { mod: true });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "device address" })));
  });

  it("refreshes the ADB list with F5 and Ctrl/⌘+R on the device page only", async () => {
    const { transport } = mount();
    await screen.findByText("emulator-5554");
    const n = () => transport.sent.filter((m) => m.method === "device.adb.list").length;
    const before = n();
    press("F5");
    await waitFor(() => expect(n()).toBe(before + 1));
    press("r", { mod: true });
    await waitFor(() => expect(n()).toBe(before + 2));
    press("3", { mod: true });
    await screen.findByText("还没有在线设备");
    const stayed = n();
    press("F5");
    press("r", { mod: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(n()).toBe(stayed);
  });

  it("collapses the sidebar, cycles the theme, and ignores key repeat", async () => {
    mount();
    await screen.findByText("emulator-5554");
    press("b", { mod: true, repeat: true });
    expect(document.querySelector(".app")?.classList.contains("sidebar-collapsed")).toBe(false);
    press("b", { mod: true });
    expect(document.querySelector(".app")?.classList.contains("sidebar-collapsed")).toBe(true);
    expect(localStorage.getItem("xscript.sidebar")).toBe("collapsed");
    press("b", { mod: true });
    expect(document.querySelector(".app")?.classList.contains("sidebar-collapsed")).toBe(false);
    expect(localStorage.getItem("xscript.sidebar")).toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
    press("t", { mod: true, shift: true });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    press("t", { mod: true, shift: true });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    press("t", { mod: true, shift: true });
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  });

  it("opens help with ? except while typing or when single-key shortcuts are off", async () => {
    const { unmount } = mount();
    const address = await screen.findByRole("textbox", { name: "device address" }); // the add-device panel is open (no saved devices)
    address.focus();
    fireEvent.keyDown(address, { key: "?" });
    expect(screen.queryByRole("dialog")).toBeNull();
    address.blur();
    press("?");
    expect(await screen.findByRole("dialog", { name: "快捷键" })).toBeTruthy();
    expect(screen.getByText(/按键按当前系统显示/)).toBeTruthy();
    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    press(",", { mod: true });
    const single = await screen.findByRole("checkbox", { name: /单键快捷键/ });
    fireEvent.click(single);
    expect(localStorage.getItem("xscript.singleKeyShortcuts")).toBe("0");
    press("Escape");
    press("?");
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();
    mount();
    await screen.findByText("emulator-5554");
    press("?");
    expect(screen.queryByRole("dialog")).toBeNull();
    press("k", { mod: true });
    const box = await screen.findByRole("combobox", { name: "命令面板" });
    fireEvent.change(box, { target: { value: "快捷键" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByRole("dialog", { name: "快捷键" })).toBeTruthy();
  });

  it("saves an adb path from settings and reports a path that is not a file", async () => {
    const { transport } = mount();
    await screen.findByText("emulator-5554");
    press(",", { mod: true });
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    const field = within(dialog).getByRole("textbox", { name: "adb 路径" });
    fireEvent.change(field, { target: { value: "/opt/platform-tools/adb" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await within(dialog).findByText("已保存")).toBeTruthy();
    expect(transport.sent.some((m) => m.method === "app.settings.set" && m.params?.adbPath === "/opt/platform-tools/adb")).toBe(true);
    press("Escape");

    transport.setHandler("app.settings.set", () => ({ adbPath: null }));
    press(",", { mod: true });
    const again = await screen.findByRole("textbox", { name: "adb 路径" });
    fireEvent.change(again, { target: { value: "/missing/adb" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/没有找到 adb/);
    expect((again as HTMLInputElement).value).toBe("/missing/adb");
  });

  it("changes theme, language, and the icon rail from the settings dialog", async () => {
    mount();
    await screen.findByText("emulator-5554");
    press(",", { mod: true });
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "深色" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(within(dialog).getByRole("radio", { name: "English" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
    fireEvent.click(screen.getByRole("checkbox", { name: "Sidebar shows icons only" }));
    expect(document.querySelector(".app")?.classList.contains("sidebar-collapsed")).toBe(true);
    expect(localStorage.getItem("xscript.lang")).toBe("en");
  });

  it("traps Tab inside the dialog", async () => {
    mount();
    await screen.findByText("emulator-5554");
    press("k", { mod: true });
    const dialog = await screen.findByRole("dialog");
    const box = within(dialog).getByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(box));
    const close = within(dialog).getByRole("button", { name: "关闭" });
    const options = within(dialog).getAllByRole("option");
    const last = options[options.length - 1];
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("runs refresh, address, theme, language, and the sidebar from the palette", async () => {
    const { transport } = mount();
    await screen.findByText("emulator-5554");
    const run = async (query: string) => {
      press("k", { mod: true });
      // the top-bar device switcher is a combobox too; the palette is named (in either language once 切换语言 ran)
      const box = await screen.findByRole("combobox", { name: /命令面板|Command palette/ });
      fireEvent.change(box, { target: { value: query } });
      fireEvent.keyDown(box, { key: "Enter" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    };
    press("3", { mod: true });
    await screen.findByText("还没有在线设备");
    const before = transport.sent.filter((m) => m.method === "device.adb.list").length;
    await run("刷新 ADB");
    await waitFor(() => expect(transport.sent.filter((m) => m.method === "device.adb.list").length).toBe(before + 1));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("设备");
    await run("聚焦");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "device address" })));
    await run("切换主题");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await run("切换语言");
    expect(document.documentElement.lang).toBe("en");
    await run("Collapse");
    expect(document.querySelector(".app")?.classList.contains("sidebar-collapsed")).toBe(true);
  });

  it("declares forced-colors borders and a Highlight focus ring without raw colors", () => {
    const css = readFileSync("src/styles/base.css", "utf8");
    expect(css).toContain("@media (forced-colors: active)");
    for (const name of ["Canvas", "CanvasText", "Highlight", "ButtonText"]) expect(css).toContain(name);
    const sheets = readFileSync("src/styles/base.css", "utf8") + readFileSync("src/styles/components.css", "utf8");
    expect(sheets.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    // the editor's failing-line flash and paused line stay visible when backgrounds are forced to Canvas
    expect(sheets).toMatch(/@media \(forced-colors: active\) \{\s*\.monaco-host \.err-flash-line, \.monaco-host \.dbg-current-line \{ outline: 2px solid Highlight;/);
  });
});
