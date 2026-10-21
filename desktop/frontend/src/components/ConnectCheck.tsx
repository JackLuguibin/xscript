import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "../app-context";
import type { ConnectCheckResult } from "../api";
import { describeError, TROUBLESHOOTING_URL } from "../errors";
import { t } from "../strings";
import { IconCheck, IconMark, IconRefresh, Spinner } from "./icons";
import { Button } from "./ui/button";

/**
 * 「逐项检查连接」: after a failed connect, walks adb → forward → app → XScript → pairing (or address → reachable → …)
 * and shows where it breaks, with the fix for that step. Never connects by itself; 「连接」 appears once every step is green.
 */
export function ConnectCheck({ transport, target, onConnect, onClose }: {
  transport: "adb" | "lan";
  target: string;
  onConnect: () => void;
  onClose: () => void;
}) {
  const { api } = useServices();
  const [res, setRes] = useState<ConnectCheckResult | null>(null);
  const [failed, setFailed] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const run = useCallback(() => {
    setBusy(true);
    setFailed("");
    api.checkConnection(transport, target).then(
      (r) => alive.current && (setRes(r), setBusy(false)),
      (e) => alive.current && (setFailed(describeError(e).title), setBusy(false)),
    );
  }, [api, transport, target]);
  useEffect(run, [run]);

  const steps = res?.steps ?? [];
  const broken = steps.find((s) => s.ok === false);
  return (
    <section className="panel connect-check" aria-labelledby="h-connect-check" aria-busy={busy}>
      <div className="row">
        <h3 id="h-connect-check" className="grow">
          {t.connectCheck.title}
          <span className="muted mono"> · {target}</span>
        </h3>
        <Button variant="ghost" size="sm" className="icon-btn" aria-label={t.errors.dismiss} title={t.errors.dismiss} onClick={onClose}>
          <IconMark size={14} />
        </Button>
      </div>
      <p className="hint">{t.connectCheck.intro}</p>
      {failed && <p className="err-hint">{failed}</p>}
      <ol className="check-steps">
        {steps.map((s) => {
          const info = t.connectCheck.steps[s.id] ?? { title: s.id, fix: "" };
          const state = s.ok === true ? "ok" : s.ok === false ? "bad" : "skip";
          return (
            <li key={s.id} className={`check-step ${state}`} data-step={s.id}>
              <span className="check-icon" aria-hidden="true">
                {state === "ok" ? <IconCheck size={14} /> : state === "bad" ? <IconMark size={12} /> : "·"}
              </span>
              <div className="grow">
                <span className="check-title">{info.title}</span>
                {state === "skip" && <span className="muted"> · {t.connectCheck.skipped}</span>}
                {s.detail && state !== "skip" && <span className="muted mono"> · {s.detail}</span>}
                {state === "bad" && (
                  <p className="check-fix">
                    <strong>{t.connectCheck.fixLabel}：</strong>
                    {info.fix}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {res?.ok && <p className="check-ok">{t.connectCheck.allOk}</p>}
      <div className="row">
        {broken && (
          <a className="err-help" href={TROUBLESHOOTING_URL}>
            {t.connectCheck.more}
          </a>
        )}
        <span className="grow" />
        <Button size="sm" disabled={busy} onClick={run}>
          {busy ? <Spinner /> : <IconRefresh size={14} />}
          {busy ? t.connectCheck.running : t.connectCheck.recheck}
        </Button>
        {res?.ok && (
          <Button size="sm" onClick={onConnect}>
            {t.connectCheck.connect}
          </Button>
        )}
      </div>
    </section>
  );
}
