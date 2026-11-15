import { afterEach, describe, expect, it } from "vitest";
import { bootServices } from "../src/boot";
import { mediaUrl } from "../src/bridge/electron";
import { MemoryTransport } from "../src/bridge/memory";

afterEach(() => { delete window.xscriptElectron; });
describe("Electron bridge", () => {
  it("boots through preload rather than the browser demo", async () => {
    const transport = new MemoryTransport({
      "app.ping": p => ({ pong: p.echo }),
      "app.hello": () => ({}),
    });
    window.xscriptElectron = transport;
    const services = await bootServices();
    expect(services.inShell).toBe(true);
    expect(transport.sent.map(m => m.method)).toEqual(["app.ping", "app.hello"]);
    expect(mediaUrl("/_frame/adb%3Atest?seq=1")).toBe("xsapp://app/_frame/adb%3Atest?seq=1");
  });
  it("retains relative media paths in browsers and the legacy Qt shell", () => {
    expect(mediaUrl("/_shot/test.jpg")).toBe("/_shot/test.jpg");
  });
});
