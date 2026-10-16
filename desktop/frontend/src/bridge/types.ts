// Wire types of the QWebChannel JSON-RPC bridge (docs/桌面端设计.md §3.3). Keep in sync with xscript_desktop/rpc.py.

export interface RpcErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export type RpcId = number | string;

export interface RpcRequest {
  id?: RpcId;
  method: string;
  params?: Record<string, unknown>;
}

export type RpcResponse =
  | { id: RpcId | null; ok: true; result: unknown }
  | { id: RpcId | null; ok: false; error: RpcErrorBody };

export interface RpcEvent {
  event: true;
  topic: string;
  data: unknown;
}

export class RpcError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  constructor(body: RpcErrorBody) {
    super(body.message);
    this.name = "RpcError";
    this.code = body.code;
    this.retryable = body.retryable;
    this.details = body.details;
  }
}

/** One duplex text channel to the Python side: the Qt bridge in the app, an in-memory fake in tests/demo. */
export interface Transport {
  send(json: string): void;
  /** Subscribe to every message the Python side pushes (responses and events). Returns an unsubscribe function. */
  onMessage(cb: (json: string) => void): () => void;
}

export function isEvent(m: unknown): m is RpcEvent {
  return typeof m === "object" && m !== null && (m as RpcEvent).event === true && typeof (m as RpcEvent).topic === "string";
}
