import { useEffect, useState } from "react";
import { useServices } from "../app-context";
import { errorLine } from "../errors";
import { t } from "../strings";
import { Alert } from "./ui/alert";

/**
 * Links into the web console (P4.6). Plain links: the shell's navigation guard sends http(s) link clicks to the
 * system browser, so the console runs with its own session there and the desktop's API token never reaches a page.
 */
export function CloudConsole() {
  const { api } = useServices();
  const [links, setLinks] = useState<Array<{ page: string; url: string }>>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.cloudConsole().then((r) => setLinks(r.links), (e) => setErr(errorLine(e)));
  }, [api]);
  return (
    <>
      <p className="muted">{t.cloud.console.hint}</p>
      {err && <Alert tone="error">{err}</Alert>}
      <ul className="cloud-links">
        {links.map((l) => (
          <li key={l.page}>
            <a href={l.url} rel="noreferrer" title={t.cloud.console.open}>
              <strong>{t.cloud.console.pages[l.page] ?? l.page}</strong>
              <span className="mono">{l.url}</span>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
