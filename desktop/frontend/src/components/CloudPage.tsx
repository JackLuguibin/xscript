import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useServices } from "../app-context";
import type { CloudStatus } from "../api";
import { errorLine } from "../errors";
import { t } from "../strings";
import { CloudBatch } from "./CloudBatch";
import { CloudDeploy } from "./CloudDeploy";
import { CloudDevices } from "./CloudDevices";
import { CloudLogs } from "./CloudLogs";
import { CloudOverview } from "./CloudOverview";
import { CloudPack } from "./CloudPack";
import { CloudTasks } from "./CloudTasks";
import { CloudWall } from "./CloudWall";
import { useConfirm } from "./ConfirmDialog";
import { IconCloud } from "./icons";
import { Alert } from "./ui/alert";
import { Badge, type BadgeTone } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FormActions } from "./ui/field";
import { Toolbar } from "./ui/toolbar";
import { Tabs } from "./ui/tabs";

export type CloudTab = "connect" | "overview" | "devices" | "wall" | "logs" | "tasks" | "deploy" | "pack";
const TABS: CloudTab[] = ["connect", "overview", "devices", "wall", "logs", "tasks", "deploy", "pack"];
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
      <div className="cloud-connect-heading">
        <span className="cloud-connect-icon" aria-hidden="true"><IconCloud size={24} /></span>
        <div><h2>{t.cloud.connectTitle}</h2><p className="muted">{t.cloud.setupDescription}</p></div>
      </div>
      <Field label={t.cloud.origin} hint={t.cloud.insecure}>
        <Input aria-label={t.cloud.origin} value={origin} placeholder={t.cloud.originPlaceholder} autoComplete="url" spellCheck={false} onChange={(e) => setOrigin(e.target.value)} />
      </Field>
      <Field label={t.cloud.token}>
        <Input aria-label={t.cloud.token} type="password" value={token} placeholder={t.cloud.tokenPlaceholder} autoComplete="off" spellCheck={false} maxLength={512} onChange={(e) => setToken(e.target.value)} />
      </Field>
      {err && (
        <Alert tone="error" role="alert">
          {err}
        </Alert>
      )}
      <FormActions>
        <Button type="submit" variant="primary" disabled={busy || !origin.trim() || !token.trim()}>
          {busy ? t.cloud.connecting : t.cloud.connect}
        </Button>
      </FormActions>
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);
  const { confirm, dialog } = useConfirm();

  const refresh = useCallback(() => {
    setErr("");
    setReloadKey((k) => k + 1);
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
  if (tab !== "connect" && !connected) {
    body = <p className="muted">{t.cloud.dev.needConnect}</p>;
  } else if (tab === "wall" && account) {
    body = <CloudWall account={account} />;
  } else if (tab === "pack" && account) {
    body = <CloudPack account={account} />;
  } else if (tab === "overview") {
    body = <CloudOverview onOpen={setTab} reloadKey={reloadKey} />;

  } else if (tab === "deploy" && account) {
    body = <CloudDeploy account={account} />;
  } else if (tab === "logs") {
    body = <CloudLogs initialDevice={selected.size === 1 ? [...selected][0] : ""} />;
  } else if (tab === "tasks" && account) {
    body = <CloudTasks account={account} selected={[...selected]} reloadKey={reloadKey} />;
  } else if (tab === "devices") {
    body = (
      <>
        {account && <CloudBatch account={account} selected={[...selected]} onDone={() => setReloadKey((k) => k + 1)} />}
        <CloudDevices selected={selected} onSelected={setSelected} reloadKey={reloadKey} />
      </>
    );
  } else {
    body = (
      <div className="cloud-pane cloud-connection-pane">
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
          <div className="cloud-setup-layout">
          <ConnectForm
            initialOrigin={status.origin}
            onConnected={(s) => {
              setEditing(false);
              setStatus(s);
            }}
          />
          <aside className="cloud-setup-guide" aria-label={t.cloud.setupGuide}>
            <h3>{t.cloud.setupGuide}</h3>
            <ol>
              <li><strong>{t.cloud.setupStepAccount}</strong><p>{t.cloud.setupAccountHint}</p></li>
              <li><strong>{t.cloud.setupStepToken}</strong><p>{t.cloud.setupTokenHint}</p></li>
              <li><strong>{t.cloud.setupStepConnect}</strong><p>{t.cloud.setupConnectHint}</p></li>
            </ol>
            <p className="cloud-token-note">{t.cloud.tokenStorageHint}</p>
          </aside>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page cloud-page">
      <Toolbar label={t.nav.cloud} className="cloud-head">
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
                setSelected(new Set());
                setStatus(s);
              }, (e) => setErr(errorLine(e)));
            }}
          >
            {t.cloud.disconnect}
          </Button>
        )}
      </Toolbar>
      {err && <Alert tone="error">{err}</Alert>}
      <Tabs label={t.cloud.tablist} value={tab} onValueChange={setTab} className="cloud-content-tabs" panelClassName="cloud-pane"
        items={TABS.map((id) => ({ value: id, label: t.cloud.tabs[id] }))}>
        {body}
      </Tabs>
      {dialog}
    </div>
  );
}
