import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Design D4: all device/backend traffic goes through Python. The page must not make network requests of its own
// (the shell also enforces this with CSP connect-src 'none'); this keeps it from creeping in.
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

describe("frontend source", () => {
  it("never uses fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon", () => {
    const banned = /\b(fetch\s*\(|XMLHttpRequest|new\s+WebSocket|EventSource|sendBeacon)/;
    const offenders = walk("src").filter((f) => banned.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
