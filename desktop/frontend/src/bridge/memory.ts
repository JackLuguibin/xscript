import type { Transport } from "./types";

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

/**
 * In-memory stand-in for the Python side: used by the unit tests and by the "demo mode" you get when the page is opened in a
 * plain browser (npm run dev). Handlers throw {code, message, retryable?} objects to produce error responses.
 */
export class MemoryTransport implements Transport {
  private subs = new Set<(json: string) => void>();
  readonly sent: Array<{ id?: number | string; method: string; params?: Record<string, unknown> }> = [];
  constructor(private handlers: Record<string, Handler> = {}, private latencyMs = 0) {}

  setHandler(method: string, h: Handler): void {
    this.handlers[method] = h;
  }

  send(json: string): void {
    const req = JSON.parse(json);
    this.sent.push(req);
    if (req.method === "cancel") return;
    const run = async () => {
      const h = this.handlers[req.method];
      if (!h) return this.reply({ id: req.id, ok: false, error: { code: "rpc.method_not_found", message: "unknown method: " + req.method, retryable: false } });
      try {
        this.reply({ id: req.id, ok: true, result: await h(req.params ?? {}) });
      } catch (e) {
        const err = e as { code?: string; message?: string; retryable?: boolean };
        this.reply({ id: req.id, ok: false, error: { code: err.code ?? "rpc.internal", message: err.message ?? String(e), retryable: !!err.retryable } });
      }
    };
    if (this.latencyMs > 0) setTimeout(run, this.latencyMs);
    else queueMicrotask(run);
  }

  onMessage(cb: (json: string) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  /** Push a raw message to the page, e.g. an event: push({event: true, topic: "device.state", data}). */
  push(msg: unknown): void {
    this.reply(msg);
  }

  private reply(msg: unknown): void {
    const json = JSON.stringify(msg);
    this.subs.forEach((cb) => cb(json));
  }
}
