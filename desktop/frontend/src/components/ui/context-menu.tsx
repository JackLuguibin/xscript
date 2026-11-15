import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
export interface ContextAction { label: string; run: () => void; disabled?: boolean; danger?: boolean }
/** Pointer and keyboard context menu with viewport clamping and focus restoration. */
export function ContextMenu({ x, y, label, actions, onClose }: { x: number; y: number; label: string; actions: ContextAction[]; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const [position, setPosition] = useState({ x, y });
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = menu.current!;
    const box = node.getBoundingClientRect();
    setPosition({ x: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) });
    node.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!node.contains(event.target as Node)) close.current(); };
    const dismiss = () => close.current();
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      // An action opening a dialog will take focus after this cleanup.
      if (previous?.isConnected && (node.contains(document.activeElement) || document.activeElement === document.body)) previous.focus();
    };
  }, [x, y]);
  return createPortal(<div ref={menu} className="ui-context-menu" role="menu" data-owns-keys="true" aria-label={label} style={{ left: position.x, top: position.y }} onContextMenu={(e) => e.preventDefault()} onKeyDown={(e) => {
    const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") items[(at + 1) % items.length]?.focus();
    else if (e.key === "ArrowUp") items[(at - 1 + items.length) % items.length]?.focus();
    else if (e.key === "Home") items[0]?.focus();
    else if (e.key === "End") items.at(-1)?.focus();
    else if (e.key === "Escape" || e.key === "Tab") onClose();
    else return;
    e.preventDefault(); e.stopPropagation();
  }}>{actions.map((action) => <button type="button" role="menuitem" key={action.label} className={action.danger ? "is-danger" : undefined} disabled={action.disabled} onClick={() => { onClose(); action.run(); }}>{action.label}</button>)}</div>, document.body);
}
