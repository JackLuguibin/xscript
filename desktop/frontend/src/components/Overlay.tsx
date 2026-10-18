import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { t } from "../strings";

function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
    (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1,
  );
}

/** True while a dialog that owns the keyboard (the confirm dialog) is open: global shortcuts stand down meanwhile. */
export function isModalOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector("[data-owns-keys='true']") !== null;
}

/**
 * Dialog shell: focus trap, backdrop click, and focus returned to whoever opened it (unless a command took focus).
 * `ownsKeys`: the dialog handles Escape itself and global shortcuts are ignored while it is open (they are otherwise
 * routed through GlobalShortcuts, which closes its own overlays on Escape).
 */
export function Overlay({
  title,
  onClose,
  restoreFocus,
  initialFocus,
  titleId = "shortcut-dialog-title",
  closeButton = true,
  ownsKeys = false,
  role = "dialog",
  describedBy,
  children,
}: {
  title: string;
  onClose: () => void;
  restoreFocus: RefObject<boolean>;
  initialFocus?: string;
  titleId?: string;
  closeButton?: boolean;
  ownsKeys?: boolean;
  role?: "dialog" | "alertdialog";
  describedBy?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = panel.current;
    // After every effect cleanup in this commit (the previous dialog may restore focus synchronously).
    queueMicrotask(() => {
      if (!root?.isConnected) return;
      const target = (initialFocus && root.querySelector<HTMLElement>(initialFocus)) || focusables(root)[0];
      target?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (!root) return;
      if (ownsKeys && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables(root);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    root?.addEventListener("keydown", onKey);
    return () => {
      root?.removeEventListener("keydown", onKey);
      if (restoreFocus.current && prev && document.contains(prev)) prev.focus();
      restoreFocus.current = true;
    };
  }, [initialFocus, restoreFocus, ownsKeys]);
  return (
    <div className="overlay-backdrop" onMouseDown={onClose}>
      <div
        className="overlay-panel"
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        data-owns-keys={ownsKeys ? "true" : undefined}
        ref={panel}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="overlay-head">
          <h2 id={titleId}>{title}</h2>
          {closeButton && (
            <button type="button" className="small" onClick={onClose}>
              {t.shortcuts.close}
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
