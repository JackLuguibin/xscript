import { describe, expect, it } from "vitest";
import { bootServices } from "../src/boot";
import { MemoryTransport } from "../src/bridge/memory";

describe("bootServices", () => {
  it("pings, then reports the round trip via app.hello (what --selftest waits for)", async () => {
    const t = new MemoryTransport({
      "app.ping": (p) => ({ pong: p.echo, version: "x", python: "3", platform: "test" }),
      "app.hello": () => ({ version: "x", platform: "test", adbPath: null, methods: [] }),
    });
    const s = await bootServices(t);
    expect(s.inShell).toBe(false);
    expect(t.sent.map((m) => m.method)).toEqual(["app.ping", "app.hello"]);
    expect(t.sent[1].params).toEqual({ pingOk: true });
  });

  it("reports pingOk=false when the echo does not match", async () => {
    const t = new MemoryTransport({
      "app.ping": () => ({ pong: "wrong", version: "x", python: "3", platform: "test" }),
      "app.hello": () => ({ version: "x", platform: "test", adbPath: null, methods: [] }),
    });
    await bootServices(t);
    expect(t.sent[1].params).toEqual({ pingOk: false });
  });

  it("works against the in-browser demo backend", async () => {
    const s = await bootServices();
    expect((await s.api.adbList()).devices[0].serial).toBe("emulator-5554");
  });
});
