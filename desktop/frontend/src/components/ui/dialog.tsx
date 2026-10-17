import { useEffect, useId, useRef, type MouseEvent, type ReactNode, type RefObject } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";

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

/** Modal shell: focus trap, backdrop click, and focus returned to whoever opened it (unless a command took focus).
 *  The trap listens on the dialog node so the shortcut layer and tests see the same keydown target.
 *  `ownsKeys`: the dialog handles Escape itself and global shortcuts are ignored while it is open (they are otherwise
 *  routed through GlobalShortcuts, which closes its own overlays on Escape). */
export function Dialog({
  title,
  onClose,
  closeLabel,
  restoreFocus,
  initialFocus,
  titleId,
  closeButton = true,
  ownsKeys = false,
  role = "dialog",
  describedBy,
  children,
  className,
}: {
  title: string;
  onClose: () => void;
  closeLabel: string;
  restoreFocus: RefObject<boolean>;
  initialFocus?: string;
  titleId?: string;
  closeButton?: boolean;
  ownsKeys?: boolean;
  role?: "dialog" | "alertdialog";
  describedBy?: string;
  children: ReactNode;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const autoId = useId();
  const headingId = titleId ?? autoId;
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
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <div
      className="overlay-backdrop fixed inset-0 z-40 grid items-start justify-items-center bg-[color-mix(in_srgb,var(--bg)_35%,transparent)] px-sp-4 pb-sp-4 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        className={cn(
          "overlay-panel flex max-h-[min(70vh,32rem)] w-full max-w-lg flex-col gap-sp-3 overflow-auto rounded-lg border border-line-strong bg-surface p-sp-4 text-fg shadow-pop",
          className,
        )}
        role={role}
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={describedBy}
        data-owns-keys={ownsKeys ? "true" : undefined}
        ref={panel}
        onMouseDown={stop}
      >
        <div className="overlay-head flex items-center gap-sp-2">
          <h2 id={headingId} className="flex-1 text-lg font-[650]">
            {title}
          </h2>
          {closeButton && (
            <Button size="sm" onClick={onClose}>
              {closeLabel}
            </Button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
