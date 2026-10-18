import { useId, useState } from "react";
import { useServices } from "../app-context";
import { describeError, type ErrorInfo } from "../errors";
import { t } from "../strings";
import { IconAlert, IconMark } from "./icons";

/**
 * Error banner: mapped title + actionable hint, raw detail behind 「详情」 with a 「复制」 button,
 * and a dismiss button when the owner can clear it.
 */
export function ErrorBanner({ error, info, onDismiss, label, role = "alert" }: {
  error?: unknown;
  info?: ErrorInfo;
  onDismiss?: () => void;
  /** Accessible name for the banner (e.g. which device it belongs to). */
  label?: string;
  /** "status" for errors that arrive from background polling (device cards), so they are announced politely. */
  role?: "alert" | "status";
}) {
  const { api } = useServices();
  const d = info ?? describeError(error);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const detailId = useId();
  const copy = () => {
    void api.copyText(d.detail).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div className="banner error error-banner" role={role} aria-label={label}>
      <IconAlert size={16} />
      <div className="grow err-body">
        <strong className="err-title">{d.title}</strong>
        {d.hint && <span className="err-hint">{d.hint}</span>}
        {open && (
          <div className="err-detail" id={detailId}>
            <pre className="mono">{d.detail}</pre>
            <button type="button" className="small" onClick={copy}>
              {copied ? t.errors.copied : t.errors.copy}
            </button>
          </div>
        )}
      </div>
      <div className="err-actions">
        {d.detail && d.detail !== d.title && (
          <button type="button" className="small ghost" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((o) => !o)}>
            {t.errors.details}
          </button>
        )}
        {onDismiss && (
          <button type="button" className="small ghost icon-btn" aria-label={t.errors.dismiss} title={t.errors.dismiss} onClick={onDismiss}>
            <IconMark size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
