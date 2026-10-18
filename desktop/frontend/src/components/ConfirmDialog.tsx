import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../strings";
import { Overlay } from "./Overlay";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive action: the confirm button is styled as danger. Focus starts on Cancel either way. */
  danger?: boolean;
}

interface Pending {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

/**
 * In-app replacement for window.confirm (which QtWebEngine shows as an unstyled "JavaScript Confirm - xsapp://app" box).
 * `confirm()` resolves true/false; Escape, the backdrop and Cancel all resolve false. Render `dialog` somewhere in the tree.
 */
export function useConfirm(): { confirm: (opts: ConfirmOptions) => Promise<boolean>; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);
  const restoreFocus = useRef(true);
  const current = useRef<Pending | null>(null);
  current.current = pending;

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        current.current?.resolve(false); // a second request replaces (and declines) an unanswered one
        setPending({ opts, resolve });
      }),
    [],
  );

  // unmounting with a question open: answer it, never leave the caller hanging
  useEffect(() => () => current.current?.resolve(false), []);

  const answer = (ok: boolean) => {
    const p = current.current;
    if (!p) return;
    current.current = null;
    setPending(null);
    p.resolve(ok);
  };

  const o = pending?.opts;
  const dialog = o ? (
    <Overlay
      title={o.title ?? t.confirm.title}
      titleId="confirm-dialog-title"
      describedBy="confirm-dialog-message"
      role="alertdialog"
      closeButton={false}
      ownsKeys
      initialFocus="[data-confirm-cancel]"
      onClose={() => answer(false)}
      restoreFocus={restoreFocus}
    >
      <p id="confirm-dialog-message">{o.message}</p>
      <div className="row dialog-actions">
        <button type="button" data-confirm-cancel onClick={() => answer(false)}>
          {o.cancelLabel ?? t.confirm.cancel}
        </button>
        <button type="button" className={o.danger ? "danger" : "primary"} onClick={() => answer(true)}>
          {o.confirmLabel ?? t.confirm.ok}
        </button>
      </div>
    </Overlay>
  ) : null;

  return { confirm, dialog };
}
