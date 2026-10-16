import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/bridge/client";
import { MemoryTransport } from "../src/bridge/memory";
import { RpcError } from "../src/bridge/types";

describe("RpcClient", () => {
  it("correlates concurrent calls by id", async () => {
    const t = new MemoryTransport({ slow: () => new Promise((r) => setTimeout(() => r("slow"), 30)), fast: () => "fast" });
    const c = new RpcClient(t);
    const [a, b] = await Promise.all([c.call("slow"), c.call("fast")]);
    expect([a, b]).toEqual(["slow", "fast"]);
    expect(new Set(t.sent.map((s) => s.id)).size).toBe(2);
  });

  it("sends params and maps error responses to RpcError", async () => {
    const t = new MemoryTransport({
      echo: (p) => p,
      bad: () => { throw { code: "device.unreachable", message: "cannot reach", retryable: true }; },
    });
    const c = new RpcClient(t);
    expect(await c.call("echo", { x: "签到" })).toEqual({ x: "签到" });
    const err = await c.call("bad").catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ code: "device.unreachable", retryable: true, message: "cannot reach" });
  });

  it("unknown methods fail with rpc.method_not_found", async () => {
    const c = new RpcClient(new MemoryTransport());
    await expect(c.call("nope")).rejects.toMatchObject({ code: "rpc.method_not_found" });
  });

  it("times out, asks Python to cancel, and ignores the late reply", async () => {
    vi.useFakeTimers();
    const t = new MemoryTransport({ hang: () => new Promise(() => undefined) });
    const c = new RpcClient(t);
    const p = c.call("hang", {}, { timeoutMs: 100 });
    const assertion = expect(p).rejects.toMatchObject({ code: "rpc.timeout", retryable: true });
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
    const cancel = t.sent.find((s) => s.method === "cancel");
    expect(cancel?.params).toEqual({ id: t.sent[0].id });
    t.push({ id: t.sent[0].id, ok: true, result: 1 }); // late reply: must not throw
    vi.useRealTimers();
  });

  it("aborts through an AbortSignal", async () => {
    const t = new MemoryTransport({ hang: () => new Promise(() => undefined) });
    const c = new RpcClient(t);
    const ac = new AbortController();
    const p = c.call("hang", {}, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "rpc.aborted" });
    expect(t.sent.some((s) => s.method === "cancel")).toBe(true);
    await expect(c.call("hang", {}, { signal: ac.signal })).rejects.toMatchObject({ code: "rpc.aborted" });
  });

  it("delivers events to topic listeners and supports unsubscribe", async () => {
    const t = new MemoryTransport();
    const c = new RpcClient(t);
    const seen: unknown[] = [];
    const off = c.on("device.state", (d) => seen.push(d));
    t.push({ event: true, topic: "device.state", data: { id: "a" } });
    t.push({ event: true, topic: "other", data: 1 });
    off();
    t.push({ event: true, topic: "device.state", data: { id: "b" } });
    expect(seen).toEqual([{ id: "a" }]);
  });

  it("survives garbage and unattributed messages", () => {
    const t = new MemoryTransport();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    new RpcClient(t);
    const sub = (t as unknown as { subs: Set<(j: string) => void> }).subs;
    sub.forEach((cb) => cb("not json"));
    t.push({ id: null, ok: false, error: { code: "rpc.parse", message: "x", retryable: false } });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("dispose rejects pending calls", async () => {
    const c = new RpcClient(new MemoryTransport({ hang: () => new Promise(() => undefined) }));
    const p = c.call("hang");
    c.dispose();
    await expect(p).rejects.toMatchObject({ code: "rpc.disposed" });
  });
});
