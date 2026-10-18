import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "../app-context";
import type { AdbDevice, Device, ScanHit } from "../api";
import { RpcError } from "../bridge/types";
import { t } from "../strings";
import { Badge } from "./Badge";
import { DeviceCard } from "./DeviceCard";
import { EmptyState } from "./EmptyState";
import { IconAlert, IconPhone, IconRefresh, IconSearch, IconUsb, IconWifi, Spinner } from "./icons";

function errText(e: unknown): string {
  if (e instanceof RpcError) return e.code === "adb.not_found" ? t.adbMissing : `${e.message} [${e.code}]`;
  return e instanceof Error ? e.message : String(e);
}

export function DevicePage({ refreshToken = 0, focusToken = 0 }: { refreshToken?: number; focusToken?: number }) {
  const { api, rpc } = useServices();
  const [adb, setAdb] = useState<AdbDevice[] | null>(null);
  const [adbError, setAdbError] = useState<{ code: string; text: string } | null>(null);
  const [adbLoading, setAdbLoading] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState("");
  const [address, setAddress] = useState("");
  const [scan, setScan] = useState<ScanHit[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [dbNotice, setDbNotice] = useState("");
  const [dbDetail, setDbDetail] = useState("");

  const loadAdb = useCallback(async () => {
    setAdbError(null);
    setAdbLoading(true);
    try {
      setAdb((await api.adbList()).devices);
    } catch (e) {
      setAdb([]);
      setAdbError({ code: e instanceof RpcError ? e.code : "", text: errText(e) });
    } finally {
      setAdbLoading(false);
    }
  }, [api]);

  // The mount effect already loads the list. A non-zero token on first paint (palette
  // opened this page and asked for a refresh together) must not fetch a second time.
  const seenRefresh = useRef(refreshToken);
  useEffect(() => {
    if (refreshToken === seenRefresh.current) return;
    seenRefresh.current = refreshToken;
    void loadAdb();
  }, [refreshToken, loadAdb]);

  useEffect(() => {
    if (!focusToken) return;
    let dead = false;
    queueMicrotask(() => {
      if (!dead) document.getElementById("device-address")?.focus();
    });
    return () => {
      dead = true;
    };
  }, [focusToken]);

  useEffect(() => {
    void loadAdb();
    void api.listDevices().then((r) => {
      setDevices(r.devices);
      setDbNotice(r.notice || "");
      setDbDetail(r.noticeDetail || "");
    }).catch(() => undefined);
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
  const disconnect = (id: string) => run("rm:" + id, async () => {
    const res = await api.disconnect(id);
    if (res.device) upsert(res.device);
    else setDevices((cur) => cur.filter((d) => d.id !== id));
  });
  const forget = (id: string) => run("fg:" + id, async () => {
    await api.forgetDevice(id);
    setDevices((cur) => cur.filter((d) => d.id !== id));
  });
  const retry = (d: Device) => run("re:" + d.id, async () => {
    upsert(d.transport === "adb" ? await api.connectAdb(d.serial || d.address) : await api.connectLan(d.address));
  });
  const saveMeta = (d: Device, patch: { name: string; group: string; note: string; autoConnect: boolean }) =>
    run("sv:" + d.id, async () => upsert(await api.updateDevice(d.id, patch)));
  const doScan = () => run("scan", async () => {
    setScanning(true);
    try {
      setScan((await api.scan()).found);
    } finally {
      setScanning(false);
    }
  });

  const liveIds = new Set(devices.filter((d) => d.state === "online" || d.state === "connecting").map((d) => d.id));
  const adbHint = (state: string) => (state === "unauthorized" ? t.adbUnauthorized : state === "offline" ? t.adbOffline : "");

  return (
    <div className="page">
      {dbNotice === "db.newer" && (
        <div className="banner warn" role="status">
          <IconAlert size={16} />
          <span className="grow">{t.saved.newer}</span>
        </div>
      )}
      {dbNotice === "db.corrupt" && (
        <div className="banner warn" role="status">
          <IconAlert size={16} />
          <span className="grow">{t.saved.corrupt(dbDetail)}</span>
        </div>
      )}
      {error && (
        <div className="banner error" role="alert">
          <IconAlert size={16} />
          <span className="grow">
            {t.errorPrefix}：{error}
          </span>
        </div>
      )}

      <section aria-labelledby="h-connected">
        <div className="section-head">
          <h2 id="h-connected">{t.connected}</h2>
          {devices.length > 0 && <span className="count">{devices.length}</span>}
        </div>
        {devices.length === 0 ? (
          <EmptyState icon={<IconPhone size={26} />} title={t.emptyDevicesTitle} role="status">
            {t.emptyDevicesDesc}
          </EmptyState>
        ) : (
          <div className="cards">
            {devices.map((d) => (
              <DeviceCard
                key={d.id}
                device={d}
                onDisconnect={() => disconnect(d.id)}
                onForget={() => forget(d.id)}
                onRetry={() => retry(d)}
                onSave={(patch) => saveMeta(d, patch)}
                busy={busy === "rm:" + d.id || busy === "fg:" + d.id || busy === "re:" + d.id || busy === "sv:" + d.id}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="h-adb">
        <div className="section-head">
          <h2 id="h-adb">
            <IconUsb size={16} /> {t.adbDevices}
          </h2>
          <span className="grow" />
          <button className="small" onClick={() => void loadAdb()} disabled={adb === null || adbLoading}>
            {adbLoading ? <Spinner /> : <IconRefresh size={14} />}
            {t.refresh}
          </button>
        </div>
        {adb === null && (
          <div className="list" aria-busy="true" aria-label={t.adbLoading}>
            <div className="skeleton" style={{ height: "3.25rem" }} />
            <div className="skeleton" style={{ height: "3.25rem" }} />
          </div>
        )}
        {adbError &&
          (adbError.code === "adb.not_found" ? (
            <EmptyState icon={<IconAlert size={26} />} title={t.adbMissingTitle} tone="error" role="alert" actions={<button onClick={() => void loadAdb()}>{t.retry}</button>}>
              {t.adbMissing}
            </EmptyState>
          ) : (
            <EmptyState icon={<IconAlert size={26} />} title={t.adbErrorTitle} tone="error" role="alert" actions={<button onClick={() => void loadAdb()}>{t.retry}</button>}>
              <span className="banner warn" style={{ display: "inline-flex" }}>{adbError.text}</span>
            </EmptyState>
          ))}
        {adb !== null && adb.length === 0 && !adbError && (
          <EmptyState icon={<IconUsb size={26} />} title={t.adbEmptyTitle} role="status">
            {t.noAdbDevices}
          </EmptyState>
        )}
        <ul className="list">
          {(adb ?? []).map((d) => {
            const hint = adbHint(d.state);
            return (
              <li key={d.serial} className="list-item">
                <span className="avatar" aria-hidden="true" style={{ width: "2rem", height: "2rem" }}>
                  {d.isEmulator ? <IconPhone size={16} /> : <IconUsb size={16} />}
                </span>
                <span className="meta grow">
                  <span>
                    <strong>{d.serial}</strong> <span className="muted">{d.model}</span>
                  </span>
                  {hint && <span className="hint">{hint}</span>}
                </span>
                <Badge tone={d.state === "device" ? "ok" : d.state === "unauthorized" ? "warn" : "bad"}>{d.state}</Badge>
                <button
                  className={d.state === "device" && !liveIds.has("adb:" + d.serial) ? "primary" : ""}
                  aria-label={`${t.connect} ${d.serial}`}
                  onClick={() => void connectAdb(d.serial)}
                  disabled={d.state !== "device" || busy !== "" || liveIds.has("adb:" + d.serial)}
                >
                  {busy === "adb:" + d.serial ? <Spinner /> : t.connect}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="h-lan">
        <div className="section-head">
          <h2 id="h-lan">
            <IconWifi size={16} /> {t.lanTitle}
          </h2>
        </div>
        <div className="panel">
          <p className="muted" style={{ marginBottom: "var(--sp-3)" }}>
            {t.lanWarning}
          </p>
          <form
            className="row lan-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (address.trim()) void connectLan(address.trim());
            }}
          >
            <input id="device-address" aria-label="device address" className="grow" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t.lanPlaceholder} autoComplete="off" spellCheck={false} />
            <button type="submit" className="primary" aria-label={t.addressConnect} disabled={busy !== "" || !address.trim()}>
              {busy === "lan" ? <Spinner /> : t.connect}
            </button>
            <button type="button" onClick={() => void doScan()} disabled={busy !== ""}>
              {scanning ? <Spinner /> : <IconSearch size={16} />}
              {scanning ? t.scanning : t.scan}
            </button>
          </form>
          {scan !== null && (
            <ul className="list" style={{ marginTop: "var(--sp-3)" }}>
              {scan.length === 0 && (
                <li className="muted" role="status">
                  {t.scanNone}
                </li>
              )}
              {scan.map((h) => (
                <li key={h.address} className="list-item">
                  <span className="meta grow">
                    <strong>{h.address}</strong>
                    <span className="muted">{h.info.name || h.info.model}</span>
                  </span>
                  <button aria-label={`${t.connect} ${h.address}`} onClick={() => void connectLan(h.address)} disabled={busy !== "" || liveIds.has("lan:" + h.address)}>
                    {t.connect}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
