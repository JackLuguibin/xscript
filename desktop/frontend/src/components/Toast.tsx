import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../strings";
import { IconMark } from "./icons";
import { Button } from "./ui/button";

/** How long a toast stays up. Exported for tests. */
export const TOAST_MS = 4000;
const MAX_TOASTS = 3;

interface Item {
  id: number;
  text: string;
}

/** Page-local success toasts that dismiss themselves (an error stays a banner the user dismisses). */
export function useToast(): { toast: (text: string) => void; toasts: ReactNode } {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const close = useCallback((id: number) => {
    const tm = timers.current.get(id);
    if (tm !== undefined) clearTimeout(tm);
    timers.current.delete(id);
    setItems((cur) => cur.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback((text: string) => {
    const id = ++seq.current;
    setItems((cur) => [...cur, { id, text }].slice(-MAX_TOASTS));
    timers.current.set(id, setTimeout(() => close(id), TOAST_MS));
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
          <Button variant="ghost" size="sm" className="icon-btn" aria-label={t.errors.dismiss} onClick={() => close(x.id)}>
            <IconMark size={12} />
          </Button>
        </div>
      ))}
    </div>
  );
  return { toast, toasts };
}
