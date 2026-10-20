import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import type { MemoryTransport } from "../src/bridge/memory";
import { AUTO_KEY, DiagnosticsPanel, LAST_KEY, UpdatePanel, formatSize, useUpdateBadge } from "../src/components/UpdatePanel";
import { createDemoTransport } from "../src/demo";
import { DEMO_UPDATE } from "../src/update-demo";
import { setLanguage, t } from "../src/strings";

const IDLE = { state: "idle", update: null, error: null, progress: { done: 0, total: 0 } };
const INFO = { version: "0.4.0", platform: "macos-arm64", configured: true, feed: "https://x/desktop-update.json", configError: "", canInstall: true, ...IDLE };

function mount(node = <UpdatePanel />, opts: { inShell?: boolean; setup?: (tr: MemoryTransport) => void } = {}) {
  const transport = createDemoTransport();
  opts.setup?.(transport); // handlers the panel reads on mount must be in place first
  const rpc = new RpcClient(transport);
  const view = render(<ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: opts.inShell ?? true }}>{node}</ServicesContext.Provider>);
  return { transport, view };
}

const downloadButton = () => screen.findByRole("button", { name: t.update.download(formatSize(DEMO_UPDATE.asset.size)) });

beforeEach(() => localStorage.clear());
afterEach(() => setLanguage("zh"));

describe("UpdatePanel (P5.4)", () => {
  it("checks, downloads, and installs only after confirming", async () => {
    const { transport } = mount();
    expect(await screen.findByText(t.update.version("0.4.0"))).toBeTruthy();
    expect(screen.getByText(/desktop-update\.json$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.update.check }));
    expect(await screen.findByText(t.update.available("0.5.0"))).toBeTruthy();
    expect(screen.getByText(DEMO_UPDATE.notes.zh)).toBeTruthy();
    expect(Number(localStorage.getItem(LAST_KEY))).toBeGreaterThan(0);
    fireEvent.click(await downloadButton());
    expect(await screen.findByText(t.update.ready)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.update.install }));
    const dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByText(t.update.confirm("0.5.0"))).toBeTruthy();
    expect(transport.sent.some((m) => m.method === "update.install")).toBe(false); // nothing before the confirmation
    fireEvent.click(within(dlg).getByRole("button", { name: t.update.install }));
    expect(await screen.findByText(t.update.installing)).toBeTruthy();
    expect(transport.sent.filter((m) => m.method === "update.install")).toHaveLength(1);
  });

  it("cancelling the confirmation installs nothing", async () => {
    const { transport } = mount();
    fireEvent.click(await screen.findByRole("button", { name: t.update.check }));
    fireEvent.click(await downloadButton());
    fireEvent.click(await screen.findByRole("button", { name: t.update.install }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: t.confirm.cancel }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(transport.sent.some((m) => m.method === "update.install")).toBe(false);
    expect(screen.getByRole("button", { name: t.update.install })).toBeTruthy();
  });

  it("shows download progress from update.status while update.download runs", async () => {
    let finish: (v: unknown) => void = () => undefined;
    mount(<UpdatePanel />, {
      setup: (tr) => {
        tr.setHandler("update.download", () => new Promise((r) => (finish = r)));
        tr.setHandler("update.status", () => ({ state: "downloading", update: DEMO_UPDATE, error: null, progress: { done: 50, total: 200 } }));
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: t.update.check }));
    fireEvent.click(await downloadButton());
    expect(await screen.findByText(t.update.downloading(25), {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: t.update.check }).hasAttribute("disabled")).toBe(true);
    await act(async () => finish({ state: "ready", update: DEMO_UPDATE, error: null, progress: { done: 200, total: 200 } }));
    expect(await screen.findByText(t.update.ready)).toBeTruthy();
  });

  it("explains a refused signature, a bad download and a refused install", async () => {
    const { transport } = mount();
    transport.setHandler("update.check", () => ({ ...IDLE, state: "error", error: { kind: "signature", message: "no trusted key matched" } }));
    fireEvent.click(await screen.findByRole("button", { name: t.update.check }));
    expect((await screen.findByRole("alert")).textContent).toContain(t.update.kinds.signature);
    transport.setHandler("update.check", () => ({ ...IDLE, state: "available", update: DEMO_UPDATE }));
    transport.setHandler("update.download", () => ({ ...IDLE, state: "error", update: DEMO_UPDATE, error: { kind: "integrity", message: "sha256 differs" } }));
    fireEvent.click(screen.getByRole("button", { name: t.update.check }));
    fireEvent.click(await downloadButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(t.update.kinds.integrity));
    transport.setHandler("update.download", () => ({ ...IDLE, state: "ready", update: DEMO_UPDATE, progress: { done: 1, total: 1 } }));
    transport.setHandler("update.install", () => {
      throw { code: "update.unsaved", message: "save first" };
    });
    fireEvent.click(await downloadButton()); // a failed download can be retried
    fireEvent.click(await screen.findByRole("button", { name: t.update.install }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: t.update.install }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(t.update.kinds.unsaved));
    transport.setHandler("update.check", () => {
      throw { code: "rpc.internal", message: "boom" };
    });
    fireEvent.click(screen.getByRole("button", { name: t.update.check }));
    // a non-update error goes through the shared error text (errorLine) and replaces the previous message
    await waitFor(() => expect(screen.getAllByRole("alert").some((a) => a.textContent?.includes(t.update.kinds.unsaved))).toBe(false));
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  });

  it.each([
    [{ configured: false, platform: "macos-arm64" }, () => t.update.notConfigured],
    [{ configured: false, platform: null }, () => t.update.noPlatform],
    [{ configured: true, platform: null }, () => t.update.noPlatform],
  ])("explains why there is no update: %o", async (over, text) => {
    mount(<UpdatePanel />, { setup: (tr) => tr.setHandler("update.info", () => ({ ...INFO, ...over })) });
    expect(await screen.findByText(text())).toBeTruthy();
  });

  it("a source checkout downloads but leaves installing to the user", async () => {
    mount(<UpdatePanel />, { setup: (tr) => tr.setHandler("update.info", () => ({ ...INFO, canInstall: false })) });
    fireEvent.click(await screen.findByRole("button", { name: t.update.check }));
    fireEvent.click(await downloadButton());
    expect(await screen.findByText(DEMO_UPDATE.asset.name)).toBeTruthy();
    expect(screen.getByText(new RegExp(t.update.manual.slice(0, 8)))).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.update.install })).toBeNull();
  });

  it("a failed update.info is shown", async () => {
    mount(<UpdatePanel />, { setup: (tr) => tr.setHandler("update.info", () => { throw { code: "update.config", message: "bad key" }; }) });
    expect((await screen.findByRole("alert")).textContent).toContain(t.update.kinds.config);
  });

  it("remembers the auto-check choice and shows English notes in English", async () => {
    setLanguage("en");
    mount();
    const box = (await screen.findByRole("checkbox", { name: t.update.auto })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(localStorage.getItem(AUTO_KEY)).toBe("0");
    fireEvent.click(box);
    expect(localStorage.getItem(AUTO_KEY)).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: t.update.check }));
    expect(await screen.findByText(DEMO_UPDATE.notes.en)).toBeTruthy();
  });

  it("formats sizes", () => {
    expect([formatSize(5), formatSize(2048), formatSize(218_000_000), formatSize(2_500_000_000)]).toEqual(["5 B", "2 KB", "218 MB", "2.5 GB"]);
  });
});

function Badge({ enabled }: { enabled: boolean }) {
  const v = useUpdateBadge(enabled);
  return <span data-testid="badge">{v ?? "-"}</span>;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("startup update check (badge)", () => {
  it("checks at most once a day and only when enabled", async () => {
    const first = mount(<Badge enabled />);
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe("0.5.0"));
    expect(first.transport.sent.filter((m) => m.method === "update.check")).toHaveLength(1);
    first.view.unmount();
    const again = mount(<Badge enabled />);
    await waitFor(() => expect(again.transport.sent.some((m) => m.method === "update.info")).toBe(true));
    await tick();
    expect(again.transport.sent.some((m) => m.method === "update.check")).toBe(false); // checked less than a day ago
    again.view.unmount();
    localStorage.clear();
    localStorage.setItem(AUTO_KEY, "0");
    const off = mount(<Badge enabled />);
    await tick();
    expect(off.transport.sent.some((m) => m.method.startsWith("update."))).toBe(false);
    off.view.unmount();
    localStorage.clear();
    const browser = mount(<Badge enabled={false} />, { inShell: false });
    await tick();
    expect(browser.transport.sent.some((m) => m.method.startsWith("update."))).toBe(false);
    browser.view.unmount();
    const unconfigured = mount(<Badge enabled />, { setup: (tr) => tr.setHandler("update.info", () => ({ ...INFO, configured: false })) });
    await tick();
    expect(unconfigured.transport.sent.some((m) => m.method === "update.check")).toBe(false);
  });

  it("badges a version the shell already knows about and ignores errors", async () => {
    const known = mount(<Badge enabled />, { setup: (tr) => tr.setHandler("update.info", () => ({ ...INFO, state: "ready", update: DEMO_UPDATE })) });
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe("0.5.0"));
    expect(known.transport.sent.some((m) => m.method === "update.check")).toBe(false);
    known.view.unmount();
    mount(<Badge enabled />, { setup: (tr) => tr.setHandler("update.info", () => { throw { code: "rpc.internal", message: "x" }; }) });
    await tick();
    expect(screen.getByTestId("badge").textContent).toBe("-");
  });
});

describe("DiagnosticsPanel (P5.5)", () => {
  it("exports through the shell and shows where it went", async () => {
    const { transport } = mount(<DiagnosticsPanel />);
    expect(screen.getByText(t.update.diagHint)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.update.diagExport }));
    expect(await screen.findByText(t.update.diagSaved("~/Desktop/xscript-diagnostics-demo.zip", 3))).toBeTruthy();
    expect(transport.sent.filter((m) => m.method === "app.diagnostics")).toHaveLength(1);
  });

  it("says nothing when the save dialog is cancelled and shows errors", async () => {
    const { transport } = mount(<DiagnosticsPanel />);
    transport.setHandler("app.diagnostics", () => ({ saved: false }));
    fireEvent.click(screen.getByRole("button", { name: t.update.diagExport }));
    await waitFor(() => expect(transport.sent.some((m) => m.method === "app.diagnostics")).toBe(true));
    await tick();
    expect(screen.queryByRole("status")).toBeNull();
    transport.setHandler("app.diagnostics", () => {
      throw { code: "app.unavailable", message: "no save dialog in this mode" };
    });
    fireEvent.click(screen.getByRole("button", { name: t.update.diagExport }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
