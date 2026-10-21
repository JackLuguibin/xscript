import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../strings";
import { IconMark } from "./icons";
import { Button } from "./ui/button";

/** How long a toast stays up. Exported for tests. */
export const TOAST_MS = 4000;
/** Toasts with an action (such as 撤销) stay up longer. */
export const ACTION_TOAST_MS = 10000;
const MAX_TOASTS = 3;

export interface ToastAction {
  label: string;
  run: () => void;
}

interface Item {
  id: number;
  text: string;
  action?: ToastAction;
}

/** Page-local success toasts that dismiss themselves (an error stays a banner the user dismisses). */
export function useToast(): { toast: (text: string, action?: ToastAction) => void; toasts: ReactNode; runLatestAction: () => boolean } {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const close = useCallback((id: number) => {
    const tm = timers.current.get(id);
    if (tm !== undefined) clearTimeout(tm);
    timers.current.delete(id);
    setItems((cur) => cur.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback((text: string, action?: ToastAction) => {
    const id = ++seq.current;
    setItems((cur) => [...cur, { id, text, action }].slice(-MAX_TOASTS));
    timers.current.set(id, setTimeout(() => close(id), action ? ACTION_TOAST_MS : TOAST_MS));
  }, [close]);

  /** Runs (and closes) the newest toast that still offers an action, such as 撤销 for Ctrl/Cmd+Z; false when none. */
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const runLatestAction = useCallback(() => {
    const latest = [...itemsRef.current].reverse().find((x) => x.action);
    if (!latest) return false;
    close(latest.id);
    latest.action!.run();
    return true;
  }, [close]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((tm) => clearTimeout(tm));
      map.clear();
    };
  }, []);

  const toasts = (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((x) => (
        <div key={x.id} className="toast">
          <span className="grow">{x.text}</span>
          {x.action && (
            <Button variant="ghost" size="sm" onClick={() => { close(x.id); x.action!.run(); }}>
              {x.action.label}
            </Button>
          )}
          <Button variant="ghost" size="sm" className="icon-btn" aria-label={t.errors.dismiss} onClick={() => close(x.id)}>
            <IconMark size={12} />
          </Button>
        </div>
      ))}
    </div>
  );
  return { toast, toasts, runLatestAction };
}
