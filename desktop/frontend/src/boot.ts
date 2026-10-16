import { createApi } from "./api";
import type { AppServices } from "./app-context";
import { RpcClient } from "./bridge/client";
import { connectQtTransport, inQtShell } from "./bridge/qt";
import type { Transport } from "./bridge/types";
import { createDemoTransport } from "./demo";

/** Build the services: the real Qt bridge inside the shell, the in-memory demo backend in a plain browser. */
export async function bootServices(transportOverride?: Transport): Promise<AppServices> {
  const inShell = !transportOverride && inQtShell();
  const transport = transportOverride ?? (inShell ? await connectQtTransport() : createDemoTransport());
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  // Round-trip proof for the shell's --selftest: a request out and its reply back before we announce "ready".
  const nonce = Math.random().toString(36).slice(2);
  const ping = await api.ping(nonce);
  await api.hello(ping.pong === nonce);
  return { rpc, api, inShell };
}
