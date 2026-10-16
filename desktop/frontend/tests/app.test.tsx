import { render, screen } from "@testing-library/react";
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

  it("has a labelled main navigation and a single h1", async () => {
    mount(true);
    expect(screen.getByRole("navigation", { name: "main" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("main")).toBeTruthy();
  });

  it("throws a clear error when the services context is missing", () => {
    expect(() => render(<App />)).toThrow(/ServicesContext is missing/);
  });
});
