import { describe, expect, it } from "vitest";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { createDemoTransport } from "../src/demo";

describe("demo backend (plain-browser mode)", () => {
  const api = () => createApi(new RpcClient(createDemoTransport()));

  it("mirrors the real method set the page uses", async () => {
    const a = api();
    expect((await a.ping("x")).pong).toBe("x");
    expect((await a.hello(true)).platform).toBe("browser");
    expect((await a.adbList()).devices).toHaveLength(1);
  });

  it("connect (adb and lan), list, refresh, disconnect", async () => {
    const a = api();
    const adb = await a.connectAdb("emulator-5554");
    const lan = await a.connectLan("192.168.1.20:9860");
    expect(adb.id).toBe("adb:emulator-5554");
    expect(adb.warning).toBe("");
    expect(lan.warning).not.toBe("");
    expect((await a.listDevices()).devices.map((d) => d.id).sort()).toEqual(["adb:emulator-5554", "lan:192.168.1.20:9860"]);
    expect((await a.refresh(adb.id)).id).toBe(adb.id);
    expect(await a.disconnect(adb.id)).toEqual({ removed: true });
    expect(await a.disconnect(adb.id)).toEqual({ removed: false });
    expect((await a.scan()).found).toEqual([]);
  });
});
