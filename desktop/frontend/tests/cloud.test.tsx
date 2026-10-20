import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { CloudPage } from "../src/components/CloudPage";
import { createDemoTransport } from "../src/demo";
import { t } from "../src/strings";

function mount() {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  render(
    <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
      <CloudPage />
    </ServicesContext.Provider>,
  );
  return { transport, api };
}

async function connect(origin: string, token: string) {
  fireEvent.change(await screen.findByLabelText(t.cloud.origin), { target: { value: origin } });
  fireEvent.change(screen.getByLabelText(t.cloud.token), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: t.cloud.connect }));
}

describe("CloudPage (P4.1 connection)", () => {
  it("starts disconnected, connects with an API token and shows the role", async () => {
    const { transport } = mount();
    expect(await screen.findByText(t.cloud.state.not_configured, { selector: ".ui-badge, span" })).toBeTruthy();
    const tokenField = screen.getByLabelText(t.cloud.token) as HTMLInputElement;
    expect(tokenField.type).toBe("password");
    await connect("https://cloud.example.com/", "xsk_op_demo");
    expect(await screen.findByText(t.cloud.signedIn("olga", t.cloud.roles.operator))).toBeTruthy();
    expect(screen.getByText(t.cloud.state.connected)).toBeTruthy();
    expect(screen.getByText("https://cloud.example.com")).toBeTruthy();
    expect(screen.queryByLabelText(t.cloud.token)).toBeNull(); // form is gone, token not kept in the DOM
    expect(transport.sent.find((m) => m.method === "cloud.connect")?.params).toMatchObject({ origin: "https://cloud.example.com/" });
  });

  it("shows the backend error and keeps the form for a bad origin or token", async () => {
    mount();
    await connect("http://cloud.example.com", "xsk_x");
    expect((await screen.findByRole("alert")).textContent).toMatch(/https|localhost/);
    await connect("https://cloud.example.com", "nope");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/令牌|token/i));
    expect(screen.getByLabelText(t.cloud.token)).toBeTruthy();
  });

  it("viewer accounts get the read-only hint; disconnect asks first", async () => {
    mount();
    await connect("http://localhost:8000", "xsk_view_demo");
    expect(await screen.findByText(t.cloud.roleHint.viewer)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.cloud.disconnect }));
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg.textContent).toContain(t.cloud.disconnectConfirm);
    fireEvent.click(screen.getAllByRole("button", { name: t.cloud.disconnect }).at(-1)!);
    expect(await screen.findByLabelText(t.cloud.token)).toBeTruthy();
    expect(screen.queryByText(t.cloud.roleHint.viewer)).toBeNull();
  });
});
