import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { createDemoTransport } from "../src/demo";
import { isApplePlatform } from "../src/shortcuts";
import { setLanguage } from "../src/strings";

const apple = isApplePlatform();

function mount() {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  render(
    <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
      <App />
    </ServicesContext.Provider>,
  );
  return transport;
}

beforeEach(() => setLanguage("zh"));

describe("credentials", () => {
  it("saves a name, clears the value, and never renders the secret", async () => {
    const transport = mount();
    fireEvent.keyDown(window, { key: ",", bubbles: true, metaKey: apple, ctrlKey: !apple });
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(await screen.findByText("还没有保存凭据")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "名称" }), { target: { value: "API_TOKEN" } });
    fireEvent.change(screen.getByLabelText("值"), { target: { value: "super-secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: "保存凭据" }));
    expect(await screen.findByText("已保存。值不会再显示。")).toBeTruthy();
    expect(dialog.textContent).not.toContain("super-secret-value");
    expect((screen.getByLabelText("值") as HTMLInputElement).value).toBe("");
    expect(await screen.findByText(/API_TOKEN/)).toBeTruthy();
    const sent = transport.sent.find((m) => m.method === "secret.set");
    expect(sent?.params).toMatchObject({ kind: "env", name: "API_TOKEN", value: "super-secret-value" });
    const listed = transport.sent.filter((m) => m.method === "secret.list");
    expect(listed.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.getByText("还没有保存凭据")).toBeTruthy());
    expect(document.body.textContent).not.toContain("super-secret-value");
  });
});
