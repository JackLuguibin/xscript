import { useCallback, useRef, useState } from "react";

/**
 * Per-item busy tracking: a Set of keys (e.g. "save", "run", "rm:<id>") instead of one global string,
 * so an action on one item never disables unrelated buttons (and 「停止」 stays usable while saving or running).
 */
export function useBusy() {
  const ref = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const sync = () => setBusy(new Set(ref.current));

  /** Run `fn` under `key`; a second call with a key already in flight is ignored (returns false). */
  const track = useCallback(async (key: string, fn: () => Promise<void>): Promise<boolean> => {
    if (ref.current.has(key)) return false;
    ref.current.add(key);
    sync();
    try {
      await fn();
    } finally {
      ref.current.delete(key);
      sync();
    }
    return true;
  }, []);

  const has = (key: string) => busy.has(key);
  const hasPrefix = (prefix: string) => [...busy].some((k) => k.startsWith(prefix));
  return { busy, track, has, hasPrefix };
}
