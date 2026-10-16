import { isEvent, RpcError, type RpcId, type RpcResponse, type Transport } from "./types";

export interface CallOptions {
  /** Reject with code "rpc.timeout" after this many ms (default 30 000). The Python side is asked to cancel. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

type Listener = (data: unknown) => void;

/** Request/response correlation + event fan-out on top of a Transport. */
export class RpcClient {
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private listeners = new Map<string, Set<Listener>>();
  private off: () => void;

  constructor(private transport: Transport, private defaultTimeoutMs = 30_000) {
    this.off = transport.onMessage((json) => this.dispatch(json));
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
      const finish = () => {
        const p = this.pending.get(id);
        if (!p) return false;
        clearTimeout(p.timer);
        p.cleanup();
        this.pending.delete(id);
        return true;
      };
      const timer = setTimeout(() => {
        if (finish()) {
          this.cancel(id);
          reject(new RpcError({ code: "rpc.timeout", message: `${method} timed out after ${timeoutMs} ms`, retryable: true }));
        }
      }, timeoutMs);
      const onAbort = () => {
        if (finish()) {
          this.cancel(id);
          reject(new RpcError({ code: "rpc.aborted", message: `${method} aborted`, retryable: false }));
        }
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => opts.signal?.removeEventListener("abort", onAbort);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, cleanup });
      if (opts.signal?.aborted) return onAbort();
      this.transport.send(JSON.stringify({ id, method, params }));
    });
  }

  on(topic: string, cb: Listener): () => void {
    let set = this.listeners.get(topic);
    if (!set) this.listeners.set(topic, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  dispose(): void {
    this.off();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.cleanup();
      p.reject(new RpcError({ code: "rpc.disposed", message: "client disposed", retryable: false }));
      this.pending.delete(id);
    }
  }

  private cancel(id: RpcId): void {
    this.transport.send(JSON.stringify({ method: "cancel", params: { id } }));
  }

  private dispatch(json: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(json);
    } catch {
      console.warn("bridge: dropped a non-JSON message");
      return;
    }
    if (isEvent(msg)) {
      this.listeners.get(msg.topic)?.forEach((cb) => cb(msg.data));
      return;
    }
    const r = msg as RpcResponse;
    if (r.id === null || r.id === undefined) {
      if (!r.ok) console.warn("bridge: unattributed error", r.error);
      return;
    }
    const p = this.pending.get(r.id);
    if (!p) return; // late reply for a timed-out / aborted call
    clearTimeout(p.timer);
    p.cleanup();
    this.pending.delete(r.id);
    if (r.ok) p.resolve(r.result);
    else p.reject(new RpcError(r.error));
  }
}
