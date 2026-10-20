import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useServices } from "../app-context";
import type { CloudStatus } from "../api";
import { errorLine } from "../errors";
import { t } from "../strings";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { IconCloud } from "./icons";
import { Alert } from "./ui/alert";
import { Badge, type BadgeTone } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export type CloudTab = "connect";
const TABS: CloudTab[] = ["connect"];
const TONE: Record<CloudStatus["state"], BadgeTone> = { connected: "ok", expired: "warn", unreachable: "bad", error: "bad", not_configured: "neutral" };

/** Backend address + API token. The token is sent once (to the OS keyring) and the field is cleared. */
function ConnectForm({ initialOrigin, onConnected }: { initialOrigin: string; onConnected: (s: CloudStatus) => void }) {
  const { api } = useServices();
  const [origin, setOrigin] = useState(initialOrigin);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <form
      className="settings-form cloud-connect"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setErr("");
        void api
          .cloudConnect(origin.trim(), token.trim())
          .then((s) => {
            setToken("");
            onConnected(s);
          })
          .catch((e2) => setErr(errorLine(e2)))
          .finally(() => setBusy(false));
      }}
    >
      <fieldset>
        <legend>{t.cloud.connectTitle}</legend>
        <p className="muted">{t.cloud.connectHint}</p>
      </fieldset>
      <label className="stack">
        {t.cloud.origin}
        <Input aria-label={t.cloud.origin} value={origin} placeholder={t.cloud.originPlaceholder} autoComplete="url" spellCheck={false} onChange={(e) => setOrigin(e.target.value)} />
        <span className="hint">{t.cloud.insecure}</span>
      </label>
      <label className="stack">
        {t.cloud.token}
        <Input aria-label={t.cloud.token} type="password" value={token} placeholder={t.cloud.tokenPlaceholder} autoComplete="off" spellCheck={false} maxLength={512} onChange={(e) => setToken(e.target.value)} />
      </label>
      {err && (
        <Alert tone="error" role="alert">
          {err}
        </Alert>
      )}
      <div className="row">
        <Button type="submit" variant="primary" disabled={busy || !origin.trim() || !token.trim()}>
          {busy ? t.cloud.connecting : t.cloud.connect}
        </Button>
      </div>
    </form>
  );
}

/** Cloud control (P4): the admin backend's devices, commands, logs, tasks and deploys. Every call goes through Python. */
export function CloudPage() {
  const { api } = useServices();
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [tab, setTab] = useState<CloudTab>("connect");
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState("");
  const { confirm, dialog } = useConfirm();

  const refresh = useCallback(() => {
    setErr("");
    void api.cloudStatus().then(setStatus, (e) => setErr(errorLine(e)));
  }, [api]);
  useEffect(refresh, [refresh]);

  if (!status) {
    return <div className="page">{err ? <Alert tone="error">{err}</Alert> : <p className="muted" role="status">{t.cloud.connecting}</p>}</div>;
  }
  const connected = status.state === "connected" && status.account;
  const account = status.account;
  const showForm = !connected || editing;

  let body: ReactNode = null;
  if (tab === "connect") {
    body = (
      <>
        {status.state === "expired" && <Alert tone="warn">{t.cloud.expired}</Alert>}
        {status.state === "unreachable" && <Alert tone="error">{t.cloud.unreachable}</Alert>}
        {status.state === "error" && status.message && <Alert tone="error">{status.message}</Alert>}
        {connected && account && !editing && (
          <section className="panel cloud-account">
            <p>{t.cloud.signedIn(account.username, t.cloud.roles[account.role] ?? account.role)}</p>
            <p className="muted">{t.cloud.roleHint[account.role]}</p>
            <div className="row">
              <Button size="sm" type="button" onClick={() => setEditing(true)}>
                {t.cloud.reconnect}
              </Button>
            </div>
          </section>
        )}
        {showForm && (
          <ConnectForm
            initialOrigin={status.origin}
            onConnected={(s) => {
              setEditing(false);
              setStatus(s);
            }}
          />
        )}
        {!status.origin && !editing && (
          <EmptyState icon={<IconCloud size={26} />} title={t.cloud.state.not_configured}>
            {t.cloud.subtitle}
          </EmptyState>
        )}
      </>
    );
  }

  return (
    <div className="page cloud-page">
      <div className="row toolbar cloud-head">
        <Badge tone={TONE[status.state]}>{t.cloud.state[status.state]}</Badge>
        {status.origin && <span className="cloud-origin">{status.origin}</span>}
        {account && (
          <span className="muted">
            {account.username} · {t.cloud.roles[account.role] ?? account.role}
          </span>
        )}
        <span className="grow" />
        <Button size="sm" type="button" onClick={refresh}>
          {t.cloud.refresh}
        </Button>
        {status.origin && (
          <Button
            size="sm"
            variant="danger"
            type="button"
            onClick={async () => {
              if (!(await confirm({ message: t.cloud.disconnectConfirm, confirmLabel: t.cloud.disconnect, danger: true }))) return;
              void api.cloudDisconnect().then((s) => {
                setEditing(false);
                setStatus(s);
              }, (e) => setErr(errorLine(e)));
            }}
          >
            {t.cloud.disconnect}
          </Button>
        )}
      </div>
      {err && <Alert tone="error">{err}</Alert>}
      <div className="cloud-tabs" role="tablist" aria-label={t.cloud.tablist}>
        {TABS.map((id) => (
          <Button key={id} size="sm" type="button" role="tab" aria-selected={tab === id} variant={tab === id ? "primary" : undefined} onClick={() => setTab(id)}>
            {t.cloud.tabs[id]}
          </Button>
        ))}
      </div>
      <div className="cloud-pane" role="tabpanel">
        {body}
      </div>
      {dialog}
    </div>
  );
}
