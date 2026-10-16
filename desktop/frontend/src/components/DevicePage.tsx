import { useCallback, useEffect, useState } from "react";
import { useServices } from "../app-context";
import type { AdbDevice, Device, ScanHit } from "../api";
import { RpcError } from "../bridge/types";
import { t } from "../strings";
import { DeviceCard } from "./DeviceCard";

function errText(e: unknown): string {
  if (e instanceof RpcError) return e.code === "adb.not_found" ? t.adbMissing : `${e.message} [${e.code}]`;
  return e instanceof Error ? e.message : String(e);
}

export function DevicePage() {
  const { api, rpc } = useServices();
  const [adb, setAdb] = useState<AdbDevice[] | null>(null);
  const [adbError, setAdbError] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState("");
  const [address, setAddress] = useState("");
  const [scan, setScan] = useState<ScanHit[] | null>(null);
  const [scanning, setScanning] = useState(false);

  const loadAdb = useCallback(async () => {
    setAdbError("");
    try {
      setAdb((await api.adbList()).devices);
    } catch (e) {
      setAdb([]);
      setAdbError(errText(e));
    }
  }, [api]);

  useEffect(() => {
    void loadAdb();
    void api.listDevices().then((r) => setDevices(r.devices)).catch(() => undefined);
  }, [api, loadAdb]);

  // device.state is pushed by Python (health polling); device.removed on disconnect.
  useEffect(() => {
    const offState = rpc.on("device.state", (d) =>
      setDevices((cur) => {
        const dev = d as Device;
        return cur.some((x) => x.id === dev.id) ? cur.map((x) => (x.id === dev.id ? dev : x)) : [...cur, dev];
      }),
    );
    const offRemoved = rpc.on("device.removed", (d) => setDevices((cur) => cur.filter((x) => x.id !== (d as { id: string }).id)));
    return () => {
      offState();
      offRemoved();
    };
  }, [rpc]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy("");
    }
  };

  const upsert = (d: Device) => setDevices((cur) => (cur.some((x) => x.id === d.id) ? cur.map((x) => (x.id === d.id ? d : x)) : [...cur, d]));

  const connectAdb = (serial: string) => run("adb:" + serial, async () => upsert(await api.connectAdb(serial)));
  const connectLan = (addr: string) => run("lan", async () => upsert(await api.connectLan(addr)));
  const disconnect = (id: string) => run("rm:" + id, async () => { await api.disconnect(id); setDevices((cur) => cur.filter((d) => d.id !== id)); });
  const doScan = () => run("scan", async () => {
    setScanning(true);
    try {
      setScan((await api.scan()).found);
    } finally {
      setScanning(false);
    }
  });

  const connectedIds = new Set(devices.map((d) => d.id));

  return (
    <div className="page">
      {error && (
        <div className="banner error" role="alert">
          {t.errorPrefix}：{error}
        </div>
      )}

      <section aria-labelledby="h-connected">
        <h2 id="h-connected">{t.connected}</h2>
        {devices.length === 0 ? <p className="muted">{t.none}</p> : devices.map((d) => <DeviceCard key={d.id} device={d} onDisconnect={() => disconnect(d.id)} busy={busy === "rm:" + d.id} />)}
      </section>

      <section aria-labelledby="h-adb">
        <h2 id="h-adb">
          {t.adbDevices}{" "}
          <button className="small" onClick={() => void loadAdb()} disabled={adb === null}>
            {t.refresh}
          </button>
        </h2>
        {adbError && <div className="banner warn">{adbError}</div>}
        {adb !== null && adb.length === 0 && !adbError && <p className="muted">{t.noAdbDevices}</p>}
        <ul className="list">
          {(adb ?? []).map((d) => (
            <li key={d.serial} className="row">
              <span className="grow">
                <strong>{d.serial}</strong> <span className="muted">{d.model}</span> <span className={"pill " + (d.state === "device" ? "ok" : "bad")}>{d.state}</span>
              </span>
              <button aria-label={`${t.connect} ${d.serial}`} onClick={() => void connectAdb(d.serial)} disabled={d.state !== "device" || busy !== "" || connectedIds.has("adb:" + d.serial)}>
                {busy === "adb:" + d.serial ? "…" : t.connect}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="h-lan">
        <h2 id="h-lan">{t.lanTitle}</h2>
        <p className="muted">{t.lanWarning}</p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (address.trim()) void connectLan(address.trim());
          }}
        >
          <input aria-label="device address" className="grow" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t.lanPlaceholder} />
          <button type="submit" aria-label={`${t.connect}地址`} disabled={busy !== "" || !address.trim()}>
            {t.connect}
          </button>
          <button type="button" onClick={() => void doScan()} disabled={busy !== ""}>
            {scanning ? t.scanning : t.scan}
          </button>
        </form>
        {scan !== null && (
          <ul className="list">
            {scan.length === 0 && <li className="muted">{t.scanNone}</li>}
            {scan.map((h) => (
              <li key={h.address} className="row">
                <span className="grow">
                  <strong>{h.address}</strong> <span className="muted">{h.info.name || h.info.model}</span>
                </span>
                <button aria-label={`${t.connect} ${h.address}`} onClick={() => void connectLan(h.address)} disabled={busy !== "" || connectedIds.has("lan:" + h.address)}>
                  {t.connect}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
