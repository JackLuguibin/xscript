import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { MemoryTransport } from "../src/bridge/memory";
import { ConnectCheck } from "../src/components/ConnectCheck";
import { DevicePage } from "../src/components/DevicePage";
import { TROUBLESHOOTING_URL } from "../src/errors";
import { t } from "../src/strings";

function withServices(ui: React.ReactNode, handlers: ConstructorParameters<typeof MemoryTransport>[0] = {}) {
  const transport = new MemoryTransport(handlers);
  render(<ServicesContext.Provider value={{ rpc: new RpcClient(transport), api: createApi(new RpcClient(transport)), inShell: true }}>{ui}</ServicesContext.Provider>);
  return transport;
}

const step = (id: string, ok: boolean | null, detail = "") => ({ id, ok, detail });

describe("ConnectCheck", () => {
  it("shows where the connection breaks, the fix for that step, and checks again on demand", async () => {
    let calls = 0;
    const transport = withServices(<ConnectCheck transport="lan" target="192.168.1.20:9860" onConnect={() => {}} onClose={() => {}} />, {
      "device.check": () => {
        calls++;
        return {
          transport: "lan", target: "192.168.1.20:9860", ok: false,
          steps: [step("address", true, "192.168.1.20:9860"), step("reach", false, "timeout"), step("app", null), step("xscript", null), step("pairing", null)],
        };
      },
    });
    const panel = await screen.findByRole("region", { name: /逐项检查连接/ });
    await waitFor(() => expect(panel.querySelector('[data-step="reach"].bad')).toBeTruthy());
    expect(transport.sent.find((m) => m.method === "device.check")?.params).toEqual({ transport: "lan", address: "192.168.1.20:9860" });
    expect(panel.querySelector('[data-step="address"].ok')).toBeTruthy();
    expect(panel.querySelector('[data-step="app"].skip')?.textContent).toContain(t.connectCheck.skipped);
    expect(panel.querySelector('[data-step="reach"] .check-fix')?.textContent).toContain("同一个 Wi-Fi");
    expect(panel.querySelectorAll(".check-fix")).toHaveLength(1);
    expect(within(panel).getByRole("link", { name: t.connectCheck.more }).getAttribute("href")).toBe(TROUBLESHOOTING_URL);
    expect(within(panel).queryByRole("button", { name: t.connectCheck.connect })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: t.connectCheck.recheck }));
    await waitFor(() => expect(calls).toBe(2));
  });

  it("offers 连接 once every step is green", async () => {
    const onConnect = vi.fn();
    withServices(<ConnectCheck transport="adb" target="emulator-5554" onConnect={onConnect} onClose={() => {}} />, {
      "device.check": () => ({
        transport: "adb", target: "emulator-5554", ok: true,
        steps: ["adb", "device", "authorized", "forward", "app", "xscript", "pairing"].map((id) => step(id, true)),
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: t.connectCheck.connect }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(screen.getByText(t.connectCheck.allOk)).toBeTruthy();
  });

  it("a failed check call says so instead of an empty panel", async () => {
    withServices(<ConnectCheck transport="adb" target="X" onConnect={() => {}} onClose={() => {}} />, {
      "device.check": () => {
        throw { code: "adb.not_found", message: "找不到 adb" };
      },
    });
    expect(await screen.findByText("找不到 adb")).toBeTruthy();
  });
});

describe("DevicePage opens the check after a failed connect", () => {
  const base = {
    "device.list": () => ({ devices: [] }),
    "device.adb.list": () => ({ adbPath: "/x/adb", devices: [] }),
    "device.check": (p: Record<string, unknown>) => ({
      transport: "lan", target: String(p.address), ok: false,
      steps: [step("address", true), step("reach", false, "refused"), step("app", null), step("xscript", null), step("pairing", null)],
    }),
  };

  it("for an unreachable address, and closes again", async () => {
    withServices(<DevicePage />, { ...base, "device.connect": () => { throw { code: "device.unreachable", message: "refused" }; } });
    fireEvent.change(await screen.findByRole("textbox", { name: "device address" }), { target: { value: "10.0.0.9:9860" } });
    fireEvent.click(screen.getByRole("button", { name: t.addressConnect }));
    const panel = await screen.findByRole("region", { name: /逐项检查连接/ });
    expect(panel.textContent).toContain("10.0.0.9:9860");
    fireEvent.click(within(panel).getByRole("button", { name: t.errors.dismiss }));
    expect(screen.queryByRole("region", { name: /逐项检查连接/ })).toBeNull();
  });

  it("not for a typo in the address", async () => {
    withServices(<DevicePage />, { ...base, "device.connect": () => { throw { code: "device.protocol", message: "invalid device address: x" }; } });
    fireEvent.change(await screen.findByRole("textbox", { name: "device address" }), { target: { value: "x:" } });
    fireEvent.click(screen.getByRole("button", { name: t.addressConnect }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("region", { name: /逐项检查连接/ })).toBeNull();
  });
});
