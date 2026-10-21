import { useId, useState } from "react";
import { useServices } from "../app-context";
import { describeError, type ErrorInfo } from "../errors";
import { t } from "../strings";
import { IconAlert, IconMark } from "./icons";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";

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
    <Alert tone="error" className="error-banner" role={role} aria-label={label}>
      <IconAlert size={16} />
      <div className="grow err-body">
        <strong className="err-title">{d.title}</strong>
        {d.hint && <span className="err-hint">{d.hint}</span>}
        {d.help && (
          // a plain link: the desktop shell hands clicked external links to the system browser
          <a className="err-help" href={d.help}>
            {t.errors.connectHelp}
          </a>
        )}
        {open && (
          <div className="err-detail" id={detailId}>
            <pre className="mono">{d.detail}</pre>
            <Button size="sm" onClick={copy}>
              {copied ? t.errors.copied : t.errors.copy}
            </Button>
          </div>
        )}
      </div>
      <div className="err-actions">
        {d.detail && d.detail !== d.title && (
          <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((o) => !o)}>
            {t.errors.details}
          </Button>
        )}
        {onDismiss && (
          <Button variant="ghost" size="sm" className="icon-btn" aria-label={t.errors.dismiss} title={t.errors.dismiss} onClick={onDismiss}>
            <IconMark size={14} />
          </Button>
        )}
      </div>
    </Alert>
  );
}
