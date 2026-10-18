import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "../app-context";
import type { AdbDevice, Device, ScanFound, ScanHit, ScanProgress } from "../api";
import { RpcError } from "../bridge/types";
import { useCurrentDevice } from "../device-context";
import { t } from "../strings";
import { useBusy } from "../useBusy";
import { Badge } from "./Badge";
import { DeviceCard, type DevicePageTarget } from "./DeviceCard";
import { EmptyState } from "./EmptyState";
import { ErrorBanner } from "./ErrorBanner";
import { IconAlert, IconPhone, IconPlus, IconRefresh, IconSearch, IconUsb, IconWifi, Spinner } from "./icons";

/** ADB list refresh while the device page is visible: plug-in detection (Python auto-connects saved devices on it). */
export const ADB_POLL_MS = 2500;

type ScanState = {
  id: string;
  running: boolean;
  cancelled: boolean;
  done: number;
  total: number;
  hits: ScanHit[];
};

const sortHits = (hits: ScanHit[]) => [...hits].sort((a, b) => (a.host === b.host ? a.port - b.port : a.host < b.host ? -1 : 1));

export function DevicePage({
  refreshToken = 0,
  focusToken = 0,
  adbPollMs = ADB_POLL_MS,
  onNavigate,
}: {
  refreshToken?: number;
  focusToken?: number;
  adbPollMs?: number;
  /** a device card's 「屏幕」/「工程」: the device is already the current one when this is called */
  onNavigate?: (page: DevicePageTarget) => void;
}) {
  const { api, rpc } = useServices();
  const { devId, select, confirmLeave } = useCurrentDevice();
  const [adb, setAdb] = useState<AdbDevice[] | null>(null);
  const [adbError, setAdbError] = useState<{
    code: string;
    error: unknown;
  } | null>(null);
  const [adbLoading, setAdbLoading] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { has, track } = useBusy();
  const [error, setError] = useState<unknown>(null);
  const [address, setAddress] = useState("");
  const [scan, setScan] = useState<ScanState | null>(null);
  const [dbNotice, setDbNotice] = useState("");
  const [dbDetail, setDbDetail] = useState("");
  const [addOpen, setAddOpen] = useState<boolean | null>(null); // null until the saved list is in: open when it is empty
  const [autoReconnect, setAutoReconnect] = useState<boolean | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const inflight = useRef(false);

  /** `silent`: the background hotplug tick (no spinner, and a failure keeps the last good list). */
  const loadAdb = useCallback(
    async (silent = false) => {
      if (silent && inflight.current) return;
      inflight.current = true;
      if (!silent) {
        setAdbError(null);
        setAdbLoading(true);
      }
      try {
        const r = await api.adbList();
        if (!alive.current) return;
        setAdb(r.devices);
        if (silent) setAdbError(null);
      } catch (e) {
        if (!alive.current) return;
        if (!silent) setAdb([]);
        setAdbError({ code: e instanceof RpcError ? e.code : "", error: e });
      } finally {
        inflight.current = false;
        if (alive.current && !silent) setAdbLoading(false);
      }
    },
    [api],
  );

  // The mount effect already loads the list. A non-zero token on first paint (palette
  // opened this page and asked for a refresh together) must not fetch a second time.
  const seenRefresh = useRef(refreshToken);
  useEffect(() => {
    if (refreshToken === seenRefresh.current) return;
    seenRefresh.current = refreshToken;
    void loadAdb();
  }, [refreshToken, loadAdb]);

  // Ctrl+L (focus the address box): open the add-device panel first, then focus once it is rendered
  const wantFocus = useRef(false);
  useEffect(() => {
    if (!focusToken) return;
    wantFocus.current = true;
    setAddOpen(true);
  }, [focusToken]);
  useEffect(() => {
    if (!wantFocus.current || !addOpen) return;
    let dead = false;
    queueMicrotask(() => {
      if (dead) return;
      wantFocus.current = false;
      document.getElementById("device-address")?.focus();
    });
    return () => {
      dead = true;
    };
  });

  useEffect(() => {
    void loadAdb();
    void api
      .listDevices()
      .then((r) => {
        if (!alive.current) return;
        setDevices(r.devices);
        setDbNotice(r.notice || "");
        setDbDetail(r.noticeDetail || "");
        setLoaded(true);
      })
      .catch(() => alive.current && setLoaded(true));
    void api
      .getSettings()
      .then((s) => alive.current && setAutoReconnect(s.autoReconnect))
      .catch(() => undefined);
  }, [api, loadAdb]);

  useEffect(() => {
    if (loaded && addOpen === null) setAddOpen(devices.length === 0);
  }, [loaded, addOpen, devices.length]);

  // hotplug: re-list ADB devices while this page is on screen
  useEffect(() => {
    if (!adbPollMs) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void loadAdb(true);
    }, adbPollMs);
    return () => clearInterval(timer);
  }, [adbPollMs, loadAdb]);

  // device.state is pushed by Python (health polling, auto-reconnect); device.removed on forget.
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
    try {
      await track(key, async () => {
        setError(null);
        await fn();
      });
    } catch (e) {
      if (alive.current) setError(e);
    }
  };

  const upsert = (d: Device) => setDevices((cur) => (cur.some((x) => x.id === d.id) ? cur.map((x) => (x.id === d.id ? d : x)) : [...cur, d]));

  const connectAdb = (serial: string) => run("adb:" + serial, async () => upsert(await api.connectAdb(serial)));
  const connectLan = (addr: string) => run("lan:" + addr, async () => upsert(await api.connectLan(addr)));
  const disconnect = (id: string) =>
    run("rm:" + id, async () => {
      const res = await api.disconnect(id);
      if (res.device) upsert(res.device);
      else setDevices((cur) => cur.filter((d) => d.id !== id));
    });
  const forget = async (id: string) => {
    // forgetting the device the editor is on would switch the projects page away and drop unsaved edits
    if (id === devId && !(await confirmLeave(t.flow.forgetUnsaved))) return;
    await run("fg:" + id, async () => {
      await api.forgetDevice(id);
      setDevices((cur) => cur.filter((d) => d.id !== id));
    });
  };
  const retry = (d: Device) =>
    run("re:" + d.id, async () => {
      upsert(d.transport === "adb" ? await api.connectAdb(d.serial || d.address) : await api.connectLan(d.address));
    });
  const saveMeta = (d: Device, patch: { name: string; group: string; note: string; autoConnect: boolean }) =>
    run("sv:" + d.id, async () => upsert(await api.updateDevice(d.id, patch)));
  const open = (d: Device, page: DevicePageTarget) => void select(d.id).then((ok) => ok && onNavigate?.(page));
  const toggleAuto = (on: boolean) => run("auto", async () => setAutoReconnect((await api.setAutoReconnect(on)).autoReconnect));

  const doScan = () =>
    run("scan", async () => {
      const id = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setScan({
        id,
        running: true,
        cancelled: false,
        done: 0,
        total: 0,
        hits: [],
      });
      const mine = (d: unknown) => (d as { scanId?: string }).scanId === id;
      const offFound = rpc.on("device.scan.found", (d) => {
        if (!mine(d)) return;
        const hit = (d as ScanFound).device;
        setScan((s) => (s && s.id === id && !s.hits.some((h) => h.address === hit.address) ? { ...s, hits: sortHits([...s.hits, hit]) } : s));
      });
      const offProgress = rpc.on("device.scan.progress", (d) => {
        if (!mine(d)) return;
        const p = d as ScanProgress;
        setScan((s) => (s && s.id === id ? { ...s, done: Math.max(s.done, p.done), total: p.total } : s));
      });
      try {
        const r = await api.scan({ scanId: id });
        if (alive.current) {
          setScan((s) => ({
            id,
            running: false,
            cancelled: Boolean(r.cancelled),
            done: s?.total || s?.done || 0,
            total: s?.total || 0,
            hits: sortHits(r.found),
          }));
        }
      } catch (e) {
        if (alive.current) setScan((s) => (s ? { ...s, running: false } : s));
        throw e;
      } finally {
        offFound();
        offProgress();
      }
    });
  const cancelScan = () => {
    if (scan?.running) void api.scanCancel(scan.id).catch(() => undefined);
  };

  const liveIds = new Set(devices.filter((d) => d.state === "online" || d.state === "connecting").map((d) => d.id));
  const adbHint = (state: string) => (state === "unauthorized" ? t.adbUnauthorized : state === "offline" ? t.adbOffline : "");
  const pct = scan && scan.total ? Math.round((scan.done / scan.total) * 100) : 0;

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
      {error !== null && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      <section aria-labelledby="h-connected">
        <div className="section-head">
          <h2 id="h-connected">{t.connected}</h2>
          {devices.length > 0 && <span className="count">{devices.length}</span>}
          <span className="grow" />
          {autoReconnect !== null && (
            <label className="check small" title={t.flow.autoReconnectHint}>
              <input type="checkbox" checked={autoReconnect} disabled={has("auto")} onChange={(e) => void toggleAuto(e.target.checked)} />
              {t.flow.autoReconnect}
            </label>
          )}
          <button
            type="button"
            className={addOpen ? "small" : "small primary"}
            aria-expanded={Boolean(addOpen)}
            aria-controls="add-device"
            onClick={() => setAddOpen((o) => !o)}
          >
            <IconPlus size={14} />
            {t.flow.addDevice}
          </button>
        </div>

        {addOpen && (
          <div id="add-device" className="add-device" aria-label={t.flow.addDevice} role="region">
            <div className="add-col">
              <div className="section-head">
                <h3 id="h-adb">
                  <IconUsb size={16} /> {t.adbDevices}
                </h3>
                <span className="grow" />
                <button className="small" onClick={() => void loadAdb()} disabled={adb === null || adbLoading}>
                  {adbLoading ? <Spinner /> : <IconRefresh size={14} />}
                  {t.refresh}
                </button>
              </div>
              {adb === null && (
                <div className="list" aria-busy="true" aria-label={t.adbLoading}>
                  <div className="skeleton" style={{ height: "3.25rem" }} />
                </div>
              )}
              {adbError &&
                (adbError.code === "adb.not_found" ? (
                  <EmptyState
                    icon={<IconAlert size={26} />}
                    title={t.adbMissingTitle}
                    tone="error"
                    role="alert"
                    actions={<button onClick={() => void loadAdb()}>{t.retry}</button>}
                  >
                    {t.adbMissing}
                  </EmptyState>
                ) : (
                  <EmptyState
                    icon={<IconAlert size={26} />}
                    title={t.adbErrorTitle}
                    tone="error"
                    role="alert"
                    actions={<button onClick={() => void loadAdb()}>{t.retry}</button>}
                  >
                    <ErrorBanner error={adbError.error} />
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
                        disabled={d.state !== "device" || has("adb:" + d.serial) || liveIds.has("adb:" + d.serial)}
                      >
                        {has("adb:" + d.serial) ? <Spinner /> : t.connect}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="add-col">
              <div className="section-head">
                <h3 id="h-lan">
                  <IconWifi size={16} /> {t.lanTitle}
                </h3>
              </div>
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
                <input
                  id="device-address"
                  aria-label="device address"
                  className="grow"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder={t.lanPlaceholder}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="submit" className="primary" aria-label={t.addressConnect} disabled={has("lan:" + address.trim()) || !address.trim()}>
                  {has("lan:" + address.trim()) ? <Spinner /> : t.connect}
                </button>
              </form>
              <div className="row scan-row">
                {scan?.running ? (
                  <button type="button" onClick={cancelScan}>
                    <Spinner />
                    {t.flow.scanCancel}
                  </button>
                ) : (
                  <button type="button" onClick={() => void doScan()} disabled={has("scan")}>
                    <IconSearch size={16} />
                    {t.scan}
                  </button>
                )}
                {scan && (
                  <span className="muted grow" role="status" aria-live="polite">
                    {scan.running
                      ? `${t.scanning} ${t.flow.scanProgress(scan.done, scan.total)} · ${t.flow.scanFound(scan.hits.length)}`
                      : scan.cancelled
                        ? t.flow.scanCancelled(scan.hits.length)
                        : t.flow.scanDone(scan.hits.length)}
                  </span>
                )}
              </div>
              {scan?.running && (
                <div className="progress" role="progressbar" aria-label={t.scanning} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                  <span style={{ width: `${pct}%` }} />
                </div>
              )}
              {scan !== null && (
                <ul className="list" style={{ marginTop: "var(--sp-3)" }}>
                  {scan.hits.length === 0 && !scan.running && (
                    <li className="muted" role="status">
                      {t.scanNone}
                    </li>
                  )}
                  {scan.hits.map((h) => (
                    <li key={h.address} className="list-item">
                      <span className="meta grow">
                        <strong>{h.address}</strong>
                        <span className="muted">{h.info.name || h.info.model}</span>
                      </span>
                      <button
                        aria-label={`${t.connect} ${h.address}`}
                        onClick={() => void connectLan(h.address)}
                        disabled={has("lan:" + h.address) || liveIds.has("lan:" + h.address)}
                      >
                        {t.connect}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

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
                current={d.id === devId}
                onDisconnect={() => disconnect(d.id)}
                onForget={() => void forget(d.id)}
                onRetry={() => retry(d)}
                onSave={(patch) => saveMeta(d, patch)}
                onOpen={(page) => open(d, page)}
                busy={has("rm:" + d.id) || has("fg:" + d.id) || has("re:" + d.id) || has("sv:" + d.id)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
