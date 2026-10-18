import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { createDemoTransport } from "../src/demo";

function mount(inShell: boolean) {
  const rpc = new RpcClient(createDemoTransport());
  return render(
    <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell }}>
      <App />
    </ServicesContext.Provider>,
  );
}

describe("App shell", () => {
  it("shows the demo banner outside the Qt shell and not inside it", async () => {
    const { unmount } = mount(false);
    expect(await screen.findByText(/演示模式/)).toBeTruthy();
    unmount();
    mount(true);
    await screen.findByText("emulator-5554");
    expect(screen.queryByText(/演示模式/)).toBeNull();
  });

  it("has landmarks: sidebar, labelled main navigation, one h1, main", async () => {
    mount(true);
    expect(screen.getByRole("complementary", { name: "sidebar" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "main" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("main")).toBeTruthy();
  });

  it("sidebar: the current page is marked, and flows opens the editor", () => {
    mount(true);
    const nav = within(screen.getByRole("navigation", { name: "main" }));
    expect(nav.getByRole("button", { name: (n) => n === "设备" }).getAttribute("aria-current")).toBe("page");
    const flows = nav.getByRole("button", { name: "流程" }) as HTMLButtonElement;
    expect(flows.disabled).toBe(false);
    fireEvent.click(flows);
    expect(screen.getByRole("heading", { level: 1, name: "流程" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "流程文本" })).toBeTruthy();
  });

  it("offers a skip link that targets the (focusable) main region", () => {
    mount(true);
    const skip = screen.getByRole("link", { name: "跳到主要内容" });
    expect(skip.getAttribute("href")).toBe("#main");
    expect(screen.getByRole("main").id).toBe("main");
    expect(screen.getByRole("main").getAttribute("tabindex")).toBe("-1");
  });

  it("throws a clear error when the services context is missing", () => {
    expect(() => render(<App />)).toThrow(/ServicesContext is missing/);
  });
});
