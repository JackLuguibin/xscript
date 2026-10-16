import { afterEach, describe, expect, it, vi } from "vitest";
import { connectQtTransport, inQtShell } from "../src/bridge/qt";

type W = Window & { qt?: unknown; QWebChannel?: unknown };
const w = window as unknown as W;

afterEach(() => {
  delete w.qt;
  delete w.QWebChannel;
  vi.useRealTimers();
});

function fakeChannel(objects: Record<string, unknown>) {
  w.qt = { webChannelTransport: {} };
  w.QWebChannel = class {
    constructor(_t: unknown, init: (c: { objects: Record<string, unknown> }) => void) {
      init({ objects });
    }
  };
}

describe("Qt transport", () => {
  it("is not in the shell in a plain browser, and refuses to connect", async () => {
    expect(inQtShell()).toBe(false);
    await expect(connectQtTransport()).rejects.toThrow(/not running inside/);
  });

  it("needs BOTH qt.webChannelTransport and QWebChannel", () => {
    w.qt = { webChannelTransport: {} };
    expect(inQtShell()).toBe(false);
    delete w.qt;
    w.QWebChannel = class {};
    expect(inQtShell()).toBe(false);
  });

  it("bridges xs.call / xs.message and supports several subscribers and unsubscribe", async () => {
    const sent: string[] = [];
    let push: (j: string) => void = () => undefined;
    fakeChannel({ xs: { call: (j: string) => sent.push(j), message: { connect: (cb: (j: string) => void) => (push = cb) } } });
    expect(inQtShell()).toBe(true);
    const t = await connectQtTransport();
    t.send('{"a":1}');
    expect(sent).toEqual(['{"a":1}']);
    const a: string[] = [];
    const b: string[] = [];
    const offA = t.onMessage((j) => a.push(j));
    t.onMessage((j) => b.push(j));
    push("1");
    offA();
    push("2");
    expect(a).toEqual(["1"]);
    expect(b).toEqual(["1", "2"]);
  });

  it("rejects when the bridge object is not registered", async () => {
    fakeChannel({});
    await expect(connectQtTransport()).rejects.toThrow(/'xs' is not registered/);
  });

  it("rejects when QWebChannel never becomes ready", async () => {
    vi.useFakeTimers();
    w.qt = { webChannelTransport: {} };
    w.QWebChannel = class {
      constructor() {
        /* never calls init */
      }
    };
    const p = connectQtTransport(500);
    const assertion = expect(p).rejects.toThrow(/did not become ready/);
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
  });
});
