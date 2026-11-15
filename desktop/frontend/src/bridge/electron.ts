import type { Transport } from "./types";

declare global {
  interface Window {
    xscriptElectron?: Transport;
  }
}

export function inElectronShell(): boolean {
  return typeof window !== "undefined" && !!window.xscriptElectron;
}

export function connectElectronTransport(): Transport {
  if (!window.xscriptElectron) throw new Error("Electron preload bridge unavailable");
  return window.xscriptElectron;
}

/** Dev pages run on Vite, but device images always belong to the desktop protocol. */
export function mediaUrl(path: string): string {
  return inElectronShell() ? `xsapp://app${path}` : path;
}
