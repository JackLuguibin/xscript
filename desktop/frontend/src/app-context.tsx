import { createContext, useContext } from "react";
import type { Api } from "./api";
import type { RpcClient } from "./bridge/client";

export interface AppServices {
  rpc: RpcClient;
  api: Api;
  /** false when the page runs in a plain browser against the in-memory demo backend. */
  inShell: boolean;
}

export const ServicesContext = createContext<AppServices | null>(null);

export function useServices(): AppServices {
  const s = useContext(ServicesContext);
  if (!s) throw new Error("ServicesContext is missing");
  return s;
}
