import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { createDemoTransport } from "../src/demo";
import { applyMode, nextMode, readStoredMode, useTheme } from "../src/theme";

function mount() {
  const rpc = new RpcClient(createDemoTransport());
  return render(
    <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
      <App />
    </ServicesContext.Provider>,
  );
}
const toggle = () => screen.getByRole("button", { name: /^主题：/ });

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => window.localStorage.clear());

describe("theme", () => {
  it("cycles system → light → dark → system, pins data-theme and remembers the choice", async () => {
    const user = userEvent.setup();
    mount();
    expect(toggle().getAttribute("aria-label")).toContain("跟随系统");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    await user.click(toggle());
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("xscript.theme")).toBe("light");
    await user.click(toggle());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(toggle().getAttribute("aria-label")).toContain("深色");
    await user.click(toggle());
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem("xscript.theme")).toBeNull();
  });

  it("restores a stored choice on start", () => {
    window.localStorage.setItem("xscript.theme", "dark");
    mount();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("ignores garbage in storage and survives unavailable storage", () => {
    window.localStorage.setItem("xscript.theme", "neon");
    expect(readStoredMode()).toBe("system");
    const orig = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { get() { throw new Error("denied"); }, configurable: true });
    expect(readStoredMode()).toBe("system");
    Object.defineProperty(window, "localStorage", orig);
  });

  it("pure helpers", () => {
    expect(nextMode("system")).toBe("light");
    expect(nextMode("dark")).toBe("system");
    const el = document.createElement("div");
    applyMode("dark", el);
    expect(el.getAttribute("data-theme")).toBe("dark");
    applyMode("system", el);
    expect(el.hasAttribute("data-theme")).toBe(false);
  });

  it("useTheme outside a provider is a clear error", () => {
    function X() { useTheme(); return null; }
    expect(() => render(<X />)).toThrow(/ThemeProvider is missing/);
  });
});
