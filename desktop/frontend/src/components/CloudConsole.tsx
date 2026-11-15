import { createElement, useEffect, useState } from "react";
import { useServices } from "../app-context";
import { inElectronShell } from "../bridge/electron";
import { errorLine } from "../errors";
import { t } from "../strings";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";

type ConsoleLink = { page: string; url: string };

/** The complete server UI runs in a separate browser session with no desktop bridge or API token. */
export function CloudConsole() {
  const { api } = useServices();
  const embedded = inElectronShell();
  const [links, setLinks] = useState<ConsoleLink[]>([]);
  const [selected, setSelected] = useState("overview");
  const [err, setErr] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    api.cloudConsole(embedded).then((r) => { if (active) setLinks(r.links); }, (e) => { if (active) setErr(errorLine(e)); });
    return () => { active = false; };
  }, [api, embedded]);
  const current = links.find((link) => link.page === selected) ?? links[0];
  return <div className="cloud-console">
    <p className="hint">{embedded ? t.cloud.console.embeddedHint : t.cloud.console.hint}</p>
    {err && <Alert tone="error">{err}</Alert>}
    {embedded && current ? <div className="cloud-console-workspace">
      <nav className="cloud-console-nav" aria-label={t.cloud.console.navigation}>
        {links.map((link) => <Button key={link.page} variant={current.page === link.page ? "primary" : "ghost"}
          aria-current={current.page === link.page ? "page" : undefined} onClick={() => setSelected(link.page)}>
          {t.cloud.console.pages[link.page] ?? link.page}
        </Button>)}
      </nav>
      <section className="cloud-console-view">
        <div className="row cloud-console-toolbar">
          <strong>{t.cloud.console.pages[current.page] ?? current.page}</strong>
          <Button size="sm" onClick={() => setRevision((value) => value + 1)}>{t.cloud.refresh}</Button>
        </div>
        {createElement("webview", { key: `${current.url}:${revision}`, src: current.url, partition: "xscript-cloud-console",
          className: "cloud-console-embed", title: t.cloud.console.pages[current.page] ?? current.page })}
      </section>
    </div> : <ul className="cloud-links">
      {links.map((link) => <li key={link.page}>
        <a href={link.url} rel="noreferrer" title={t.cloud.console.open}>
          <strong>{t.cloud.console.pages[link.page] ?? link.page}</strong><span className="mono">{link.url}</span>
        </a>
      </li>)}
    </ul>}
  </div>;
}
