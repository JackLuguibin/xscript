import { createElement, useEffect, useState } from "react";
import { useServices } from "../app-context";
import { inElectronShell } from "../bridge/electron";
import { useCurrentDevice } from "../device-context";
import { t } from "../strings";
import { ErrorBanner } from "./ErrorBanner";


export function ToolsPage() {
  const { api, inShell } = useServices();
  const { device } = useCurrentDevice();
  const page = "color";
  const [result, setResult] = useState<{ key: string; url: string; warning: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const online = device?.state === "online";
  const key = `${device?.id}:${page}`;

  useEffect(() => {
    let active = true;
    setResult(null);
    setError(null);
    if (device && online) {
      void api.toolsEmbed(device.id, page).then((res) => {
        if (active) setResult({ key, ...res });
      }).catch((e) => { if (active) setError(e); });
    }
    return () => { active = false; };
  }, [api, device?.id, online, page, key]);

  const current = online && result?.key === key ? result : null;
  return <div className="page tools-page">
      {error !== null && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
      {!online && <p className="muted">{t.deviceFlow.noDevice}</p>}
      {current?.warning && <p className="hint" role="status">{current.warning}</p>}
      {current && (inElectronShell()
        ? createElement("webview", { key, src: current.url, partition: "xscript-tools", className: "tool-embed", title: t.tools[page], "aria-label": t.tools[page] })
        : <iframe key={key} className="tool-embed" title={t.tools[page]}
            src={inShell ? current.url : undefined}
            srcDoc={!inShell ? `<p>${t.tools.demo}</p>` : undefined} />)}
  </div>;
}
