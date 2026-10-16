import type { Transport } from "./types";

// Minimal typing of what qwebchannel.js (served by the Qt shell) puts on `window`.
interface QtBridgeObject {
  call(json: string): void;
  message: { connect(cb: (json: string) => void): void };
}
declare global {
  interface Window {
    QWebChannel?: new (transport: unknown, init: (ch: { objects: Record<string, unknown> }) => void) => unknown;
    qt?: { webChannelTransport?: unknown };
  }
}

/** True inside the Qt shell (QtWebEngine injects qt.webChannelTransport into the page). */
export function inQtShell(): boolean {
  return typeof window !== "undefined" && !!window.qt?.webChannelTransport && typeof window.QWebChannel === "function";
}

/** Connect to the Python `Bridge` object registered as "xs". Resolves once the channel is ready. */
export function connectQtTransport(timeoutMs = 10_000): Promise<Transport> {
  return new Promise<Transport>((resolve, reject) => {
    if (!inQtShell()) return reject(new Error("not running inside the XScript Qt shell"));
    const timer = setTimeout(() => reject(new Error("QWebChannel did not become ready")), timeoutMs);
    new window.QWebChannel!(window.qt!.webChannelTransport, (channel) => {
      clearTimeout(timer);
      const xs = channel.objects["xs"] as QtBridgeObject | undefined;
      if (!xs) return reject(new Error("bridge object 'xs' is not registered"));
      const subs = new Set<(json: string) => void>();
      xs.message.connect((json) => subs.forEach((cb) => cb(json)));
      resolve({
        send: (json) => xs.call(json),
        onMessage: (cb) => {
          subs.add(cb);
          return () => subs.delete(cb);
        },
      });
    });
  });
}
