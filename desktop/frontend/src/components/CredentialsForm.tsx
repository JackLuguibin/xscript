import { useEffect, useState } from "react";
import { useServices } from "../app-context";
import type { SecretSlot } from "../api";
import { errorLine } from "../errors";
import { t } from "../strings";

const KINDS = ["env", "backend", "device"] as const;

/** Settings section. The value is sent once and then cleared; the list only has names. */
export function CredentialsForm() {
  const { api } = useServices();
  const [slots, setSlots] = useState<SecretSlot[]>([]);
  const [kind, setKind] = useState<(typeof KINDS)[number]>("env");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = () => {
    void api.secretList().then(
      (r) => setSlots(r.slots),
      (e) => setErr(errorLine(e)),
    );
  };
  useEffect(reload, [api]);

  const placeholder = kind === "backend" ? t.secrets.nameBackend : kind === "device" ? t.secrets.nameDevice : t.secrets.nameEnv;

  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setMsg("");
        setErr("");
        void api
          .secretSet(kind, name.trim(), value)
          .then(() => {
            setValue("");
            setMsg(t.secrets.saved);
            reload();
          })
          .catch((err2) => setErr(errorLine(err2)))
          .finally(() => setBusy(false));
      }}
    >
      <fieldset>
        <legend>{t.secrets.title}</legend>
        <p className="muted">{t.secrets.hint}</p>
      </fieldset>
      <label className="stack">
        {t.secrets.kind}
        <select aria-label={t.secrets.kind} value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t.secrets.kinds[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="stack">
        {t.secrets.name}
        <input aria-label={t.secrets.name} value={name} placeholder={placeholder} autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="stack">
        {t.secrets.value}
        <input
          aria-label={t.secrets.value}
          type="password"
          value={value}
          autoComplete="new-password"
          spellCheck={false}
          maxLength={4096}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      {err && (
        <p className="banner error" role="alert">
          {err}
        </p>
      )}
      {msg && (
        <p role="status" className="muted">
          {msg}
        </p>
      )}
      <button type="submit" disabled={busy || !name.trim() || !value}>
        {t.secrets.save}
      </button>
      {slots.length === 0 ? (
        <p className="muted">{t.secrets.empty}</p>
      ) : (
        <ul className="secret-list">
          {slots.map((s) => (
            <li key={`${s.kind}:${s.name}`}>
              <span>
                {t.secrets.kinds[s.kind]} · {s.name}
              </span>
              <button
                type="button"
                className="small danger"
                onClick={() => {
                  setErr("");
                  setMsg("");
                  void api
                    .secretDelete(s.kind, s.name)
                    .then(() => {
                      setMsg(t.secrets.removed);
                      reload();
                    })
                    .catch((err2) => setErr(errorLine(err2)));
                }}
              >
                {t.secrets.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
