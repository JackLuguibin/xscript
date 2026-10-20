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

describe("CloudPage devices tab (P4.2)", () => {
  it("lists devices, filters by group/state/search and keeps a multi-selection", async () => {
    const { transport } = mount();
    await connect("https://cloud.example.com", "xsk_admin");
    await screen.findByText(t.cloud.signedIn("alice", t.cloud.roles.admin));
    fireEvent.click(screen.getByRole("tab", { name: t.cloud.tabs.devices }));
    expect(await screen.findByText("farm-01")).toBeTruthy();
    expect(screen.getByText(t.cloud.dev.total(12))).toBeTruthy();
    fireEvent.click(screen.getByLabelText(t.cloud.dev.selectRow("farm-01")));
    fireEvent.click(screen.getByLabelText(t.cloud.dev.selectRow("farm-02")));
    expect(screen.getByRole("status").textContent).toBe(t.cloud.dev.selected(2));
    fireEvent.change(screen.getByLabelText(t.cloud.dev.allGroups), { target: { value: "lab" } });
    await waitFor(() => expect(screen.queryByText("farm-01")).toBeNull());
    expect(screen.getByText("farm-11")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(t.cloud.dev.selected(2)); // selection survives filtering
    fireEvent.click(screen.getByLabelText(t.cloud.dev.selectAll));
    expect(screen.getByRole("status").textContent).toBe(t.cloud.dev.selected(4));
    fireEvent.change(screen.getByLabelText(t.cloud.dev.anyState), { target: { value: "offline" } });
    await waitFor(() => expect(screen.queryByText("farm-11")).toBeNull());
    expect(transport.sent.filter((m) => m.method === "cloud.devices").at(-1)?.params).toMatchObject({ group: "lab", online: false });
    fireEvent.change(screen.getByLabelText(t.cloud.dev.allGroups), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(t.cloud.dev.search), { target: { value: "rack" } });
    await waitFor(() => expect(transport.sent.filter((m) => m.method === "cloud.devices").at(-1)?.params).toMatchObject({ q: "rack" }));
    fireEvent.click(screen.getByRole("button", { name: t.cloud.dev.clear }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("asks to connect first", async () => {
    mount();
    fireEvent.click(await screen.findByRole("tab", { name: t.cloud.tabs.devices }));
    expect(screen.getByText(t.cloud.dev.needConnect)).toBeTruthy();
  });
});

describe("CloudPage batch commands (P4.3)", () => {
  async function openDevices(token: string, user: string, role: "admin" | "operator" | "viewer") {
    const m = mount();
    await connect("https://cloud.example.com", token);
    await screen.findByText(t.cloud.signedIn(user, t.cloud.roles[role]));
    fireEvent.click(screen.getByRole("tab", { name: t.cloud.tabs.devices }));
    await screen.findByText("farm-01");
    return m;
  }

  it("runs a project on the selected devices and lists each result, offline ones too", async () => {
    const { transport } = await openDevices("xsk_op_demo", "olga", "operator");
    const run = screen.getByRole("button", { name: t.cloud.batch.run }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(screen.getByText(t.cloud.batch.noSelection)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(t.cloud.dev.selectRow("farm-01")));
    fireEvent.click(screen.getByLabelText(t.cloud.dev.selectRow("farm-05"))); // offline in the demo
    fireEvent.change(screen.getByLabelText(t.cloud.batch.project), { target: { value: "night-run" } });
    fireEvent.click(run);
    expect(await screen.findByText(t.cloud.batch.summary(1, 2))).toBeTruthy();
    expect(screen.getByText("离线，未下发")).toBeTruthy();
    expect(await screen.findByText(`${t.cloud.dev.running} · night-run`)).toBeTruthy(); // table reloaded
    expect(transport.sent.find((m) => m.method === "cloud.command")?.params).toMatchObject({ ids: ["farm-01", "farm-05"], action: "run", project: "night-run" });
  });

  it("stop asks first", async () => {
    const { transport } = await openDevices("xsk_admin", "alice", "admin");
    fireEvent.click(screen.getByLabelText(t.cloud.dev.selectRow("farm-01")));
    fireEvent.click(screen.getByRole("button", { name: t.cloud.batch.stop }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getAllByRole("button", { name: t.cloud.batch.stop }).at(-1)!);
    expect(await screen.findByText(t.cloud.batch.summary(1, 1))).toBeTruthy();
    expect(transport.sent.find((m) => m.method === "cloud.command")?.params).toMatchObject({ action: "stop" });
  });

  it("greys everything out for a viewer", async () => {
    await openDevices("xsk_view_demo", "victor", "viewer");
    fireEvent.click(screen.getByLabelText(t.cloud.dev.selectRow("farm-01")));
    for (const name of [t.cloud.batch.run, t.cloud.batch.stop]) {
      const b = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.title).toBe(t.cloud.batch.viewerOnly);
    }
    expect((screen.getByLabelText(t.cloud.batch.project) as HTMLInputElement).disabled).toBe(true);
  });
});

async function openTab(token: string, user: string, role: "admin" | "operator" | "viewer", tab: string) {
  const m = mount();
  await connect("https://cloud.example.com", token);
  await screen.findByText(t.cloud.signedIn(user, t.cloud.roles[role]));
  fireEvent.click(screen.getByRole("tab", { name: tab }));
  return m;
}

describe("CloudPage logs and tasks (P4.4)", () => {
  it("searches a device's stored logs and pages back", async () => {
    const { transport } = await openTab("xsk_view_demo", "victor", "viewer", t.cloud.tabs.logs);
    fireEvent.change(screen.getByLabelText(t.cloud.logs.device), { target: { value: "farm-01" } });
    fireEvent.change(screen.getByLabelText(t.cloud.logs.stream), { target: { value: "stderr" } });
    fireEvent.click(screen.getByRole("button", { name: t.cloud.logs.find }));
    const log = await screen.findByLabelText(t.cloud.tabs.logs);
    expect(log.querySelectorAll(".stderr").length).toBe(40);
    expect(transport.sent.find((m) => m.method === "cloud.logs")?.params).toMatchObject({ id: "farm-01", stream: "stderr" });
    fireEvent.change(screen.getByLabelText(t.cloud.logs.stream), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: t.cloud.logs.find }));
    fireEvent.click(await screen.findByRole("button", { name: t.cloud.logs.older }));
    await waitFor(() => expect(screen.getByLabelText(t.cloud.tabs.logs).children.length).toBe(360));
  });

  it("fills the device from a single selection", async () => {
    await openTab("xsk_admin", "alice", "admin", t.cloud.tabs.devices);
    fireEvent.click(await screen.findByLabelText(t.cloud.dev.selectRow("farm-03")));
    fireEvent.click(screen.getByRole("tab", { name: t.cloud.tabs.logs }));
    expect((screen.getByLabelText(t.cloud.logs.device) as HTMLInputElement).value).toBe("farm-03");
  });

  it("operators toggle, run, create and delete tasks", async () => {
    const { transport } = await openTab("xsk_op_demo", "olga", "operator", t.cloud.tabs.tasks);
    const toggle = (await screen.findByLabelText(t.cloud.tasks.enable("夜间停止"))) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect((screen.getByLabelText(t.cloud.tasks.enable("夜间停止")) as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getAllByRole("button", { name: t.cloud.tasks.run })[0]);
    expect(await screen.findByText(t.cloud.tasks.ran(5, 5))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t.cloud.tasks.name), { target: { value: "lab ping" } });
    fireEvent.change(screen.getByLabelText(t.cloud.tasks.target), { target: { value: "group:lab" } });
    fireEvent.change(screen.getByLabelText(t.cloud.tasks.project), { target: { value: "ping" } });
    fireEvent.change(screen.getByLabelText(t.cloud.tasks.mode), { target: { value: "every" } });
    fireEvent.change(screen.getByLabelText(t.cloud.tasks.minutes), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: t.cloud.tasks.create }));
    expect(await screen.findByText(t.cloud.tasks.every(15))).toBeTruthy();
    expect(transport.sent.find((m) => m.method === "cloud.taskCreate")?.params).toMatchObject({ name: "lab ping", target: "group:lab", path: "app_run", project: "ping", every: 15 });
    fireEvent.click(screen.getAllByRole("button", { name: t.cloud.tasks.del }).at(-1)!);
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getAllByRole("button", { name: t.cloud.tasks.del }).at(-1)!);
    await waitFor(() => expect(screen.queryByText("lab ping")).toBeNull());
  });

  it("viewers see tasks read-only", async () => {
    await openTab("xsk_view_demo", "victor", "viewer", t.cloud.tabs.tasks);
    expect(((await screen.findByLabelText(t.cloud.tasks.enable("早班签到"))) as HTMLInputElement).disabled).toBe(true);
    for (const b of screen.getAllByRole("button", { name: t.cloud.tasks.run })) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: t.cloud.tasks.create })).toBeNull();
    expect(screen.getByText(t.cloud.tasks.viewerOnly)).toBeTruthy();
  });
});
