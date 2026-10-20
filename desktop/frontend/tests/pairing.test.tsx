import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi, type Device } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { MemoryTransport } from "../src/bridge/memory";
import { formatPairCode } from "../src/components/DeviceCard";
import { DevicePage } from "../src/components/DevicePage";

const info = { name: "phone", model: "Pixel 8", brand: "google", android: "15", sdk: 35, width: 1080, height: 2400, density: 420, ip: "192.168.1.5",
  version: "0.3.0", deviceId: "abc", running: false, accessibility: true, root: false, capture: true, channel: "accessibility", cloud: "", project: "" };

function dev(over: Partial<Device> = {}): Device {
  return { id: "lan:192.168.1.5:9860", transport: "lan", address: "192.168.1.5:9860", serial: "", forwardPort: 0, state: "unpaired",
    error: "需要配对码：在手机 XScript 首页「开发与连接 → 配对码」查看后输入", errorCode: "device.unpaired", warning: "", lastSeen: 1, info, status: {}, ...over };
}

function setup(pair: (p: Record<string, unknown>) => unknown) {
  const t = new MemoryTransport({
    "device.list": () => ({ devices: [dev()] }),
    "device.adb.list": () => ({ adbPath: "/x/adb", devices: [] }),
    "device.pair": pair,
  });
  const rpc = new RpcClient(t);
  render(
    <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
      <DevicePage />
    </ServicesContext.Provider>,
  );
  return t;
}

describe("device pairing", () => {
  it("formats the code while typing", () => {
    expect(formatPairCode("abcd")).toBe("ABCD");
    expect(formatPairCode("abcde")).toBe("ABCD-E");
    expect(formatPairCode("ab cd-ef gh!!xyz")).toBe("ABCD-EFGH");
  });

  it("an unpaired device shows the pairing form instead of the raw error, and pairs", async () => {
    const user = userEvent.setup();
    const t = setup(() => dev({ state: "online", error: "", errorCode: "" }));
    const card = await screen.findByRole("article", { name: "device lan:192.168.1.5:9860" });
    expect(within(card).getByText("待配对")).toBeTruthy();
    expect(within(card).queryByText(/需要配对码：/)).toBeNull();
    const input = within(card).getByRole("textbox", { name: "phone 的配对码" });
    const submit = within(card).getByRole("button", { name: "配对" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(input, "abcdefgh");
    expect((input as HTMLInputElement).value).toBe("ABCD-EFGH");
    await user.click(submit);
    expect(await within(card).findByText("在线")).toBeTruthy();
    expect(within(card).queryByRole("textbox", { name: "phone 的配对码" })).toBeNull();
    expect(t.sent.find((m) => m.method === "device.pair")?.params).toEqual({ id: "lan:192.168.1.5:9860", code: "ABCD-EFGH" });
  });

  it("a wrong code keeps the form and says why", async () => {
    const user = userEvent.setup();
    setup(() => {
      throw { code: "device.unpaired", message: "配对码不正确（手机上重新生成过？）" };
    });
    const card = await screen.findByRole("article", { name: "device lan:192.168.1.5:9860" });
    await user.type(within(card).getByRole("textbox", { name: "phone 的配对码" }), "WRONG123");
    await user.click(within(card).getByRole("button", { name: "配对" }));
    expect((await within(card).findByRole("alert")).textContent).toContain("配对码不正确");
    expect(within(card).getByText("待配对")).toBeTruthy();
  });
});
