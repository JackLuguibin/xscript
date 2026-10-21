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

  it("marks a device whose last run crashed with a red badge and the error in its tooltip", async () => {
    await openDevices("xsk_view", "victor", "viewer");
    const badges = screen.getAllByText(t.cloud.dev.crashed).filter((el) => el.closest("td"));
    expect(badges).toHaveLength(1);
    const badge = badges[0].closest(".badge") as HTMLElement;
    expect(badge.className).toContain("bad");
    expect(badge.getAttribute("title")).toContain("CaptureError");
    expect(badge.closest("tr")?.textContent).toContain("farm-02");
  });

  it("filters the device table to crashed devices", async () => {
    await openDevices("xsk_view", "victor", "viewer");
    fireEvent.change(screen.getByLabelText(t.cloud.dev.anyState), { target: { value: "crashed" } });
    expect(await screen.findByText(t.cloud.dev.total(1))).toBeTruthy();
    expect(screen.getByText("farm-02")).toBeTruthy();
    expect(screen.queryByText("farm-01")).toBeNull();
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

describe("CloudPage deploy (P4.5)", () => {
  async function confirmLast() {
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getAllByRole("button", { name: t.cloud.deploy.deploy }).at(-1)!);
  }

  it("deploys the editor's flow to a group as a new version and rolls back", async () => {
    const { transport } = await openTab("xsk_admin", "alice", "admin", t.cloud.tabs.deploy);
    expect(await screen.findByText(t.cloud.deploy.noVersions)).toBeTruthy();
    expect(screen.getByText("daily_signin")).toBeTruthy();
    const deploy = screen.getByRole("button", { name: t.cloud.deploy.deploy }) as HTMLButtonElement;
    expect(deploy.disabled).toBe(true);
    await waitFor(() => expect(screen.getAllByRole("option").some((o) => o.textContent?.startsWith("farm-2"))).toBe(true));
    fireEvent.change(screen.getByLabelText(t.cloud.deploy.group), { target: { value: "farm-2" } });
    fireEvent.change(screen.getByLabelText(t.cloud.deploy.notes), { target: { value: "first" } });
    fireEvent.click(deploy);
    await confirmLast();
    expect(await screen.findByText(t.cloud.deploy.done("1.0.0", 3, 3))).toBeTruthy();
    const sent = transport.sent.find((m) => m.method === "cloud.flowDeploy")?.params as { project: string; files: Array<{ path: string }>; group: string };
    expect(sent.project).toBe("daily_signin");
    expect(sent.group).toBe("farm-2");
    expect(sent.files.map((f) => f.path)).toContain("__init__.py");
    fireEvent.change(screen.getByLabelText(t.cloud.deploy.version), { target: { value: "1.1.0" } });
    fireEvent.click(screen.getByRole("button", { name: t.cloud.deploy.deploy }));
    await confirmLast();
    expect(await screen.findByText(t.cloud.deploy.done("1.1.0", 3, 3))).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: t.cloud.deploy.rollback }));
    await screen.findByText(t.cloud.deploy.rollbackConfirm("1.0.0", "farm-2"));
    await confirmLast();
    expect(await screen.findByText(t.cloud.deploy.done("1.0.0", 3, 3))).toBeTruthy();
    expect(transport.sent.find((m) => m.method === "cloud.flowRollback")?.params).toMatchObject({ group: "farm-2", versionId: 101 });
  });

  it("operators see deploy greyed out", async () => {
    await openTab("xsk_op_demo", "olga", "operator", t.cloud.tabs.deploy);
    expect(await screen.findByText(t.cloud.deploy.adminOnly)).toBeTruthy();
    const b = screen.getByRole("button", { name: t.cloud.deploy.deploy }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect((screen.getByLabelText(t.cloud.deploy.group) as HTMLSelectElement).disabled).toBe(true);
  });
});

describe("CloudPage screens, packaging and web console (P4.6)", () => {
  it("shows online devices' screens and pauses", async () => {
    await openTab("xsk_op_demo", "olga", "operator", t.cloud.tabs.wall);
    const imgs = await screen.findAllByRole("img");
    expect(imgs.length).toBe(10); // 12 demo phones, 2 offline
    expect((imgs[0] as HTMLImageElement).getAttribute("src")).toMatch(/^\/_cloudshot\/farm-01\.jpg\?max=320&t=0$/);
    fireEvent.change(screen.getByLabelText(t.cloud.dev.allGroups), { target: { value: "lab" } });
    await waitFor(() => expect(screen.getAllByRole("img").length).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: t.cloud.wall.pause }));
    expect(screen.getByText(t.cloud.wall.paused)).toBeTruthy();
  });

  it("escapes ids in the xsapp:// route and draws outlines in the plain-browser demo", async () => {
    const { cloudThumbUrl } = await import("../src/api");
    const { demoThumb } = await import("../src/components/CloudWall");
    expect(cloudThumbUrl("farm 01/x", 3)).toBe("/_cloudshot/farm%2001%2Fx.jpg?max=320&t=3");
    expect(decodeURIComponent(demoThumb("farm-01"))).toContain(">farm-01</text>");
  });

  it("viewers get no screens", async () => {
    await openTab("xsk_view_demo", "victor", "viewer", t.cloud.tabs.wall);
    expect(await screen.findByText(t.cloud.wall.viewerOnly)).toBeTruthy();
    expect(screen.queryAllByRole("img").length).toBe(0);
  });

  it("lists pack jobs, shows a log, saves an APK and cancels a running job", async () => {
    const { transport } = await openTab("xsk_op_demo", "olga", "operator", t.cloud.tabs.pack);
    expect(await screen.findByText("签名密钥不可用")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: t.cloud.pack.log })[1]);
    expect((await screen.findByLabelText(t.cloud.pack.log)).textContent).toContain("[#11] BUILD SUCCESSFUL");
    fireEvent.click(screen.getByRole("button", { name: t.cloud.pack.save }));
    expect(await screen.findByText(t.cloud.pack.saved("~/Downloads/demo-11.apk"))).toBeTruthy();
    expect(transport.sent.find((m) => m.method === "cloud.packSave")?.params).toEqual({ id: 11, name: "签到助手-1.2.0.apk" });
    fireEvent.click(screen.getByRole("button", { name: t.cloud.pack.cancel }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getAllByRole("button", { name: t.cloud.pack.cancel }).at(-1)!);
    expect(await screen.findByText(t.cloud.pack.status.cancelled)).toBeTruthy();
  });

  it("links into the web console without a token", async () => {
    await openTab("xsk_admin", "alice", "admin", t.cloud.tabs.console);
    await screen.findAllByRole("link");
    const link = screen.getAllByRole("link").find((a) => a.textContent?.startsWith(t.cloud.console.pages.pack)) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://cloud.example.com/pack");
    expect(link.getAttribute("target")).toBeNull(); // the shell refuses new windows; a plain link goes to the system browser
    for (const a of screen.getAllByRole("link")) expect(a.getAttribute("href")).not.toMatch(/xsk_|token/);
  });
});
