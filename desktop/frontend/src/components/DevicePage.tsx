import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "../app-context";
import type { AdbDevice, Device, ScanFound, ScanHit, ScanProgress } from "../api";
import { RpcError } from "../bridge/types";
import { useCurrentDevice } from "../device-context";
import { t } from "../strings";
import { useBusy } from "../useBusy";
import { Badge } from "./Badge";
import { ConnectCheck } from "./ConnectCheck";
import { DeviceRow, type DevicePageTarget } from "./DeviceRow";
import { EmptyState } from "./EmptyState";
import { ErrorBanner } from "./ErrorBanner";
import { IconAlert, IconPhone, IconPlus, IconRefresh, IconSearch, IconUsb, IconWifi, Spinner } from "./icons";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog } from "./ui/dialog";
import { Toolbar } from "./ui/toolbar";
import { SearchField } from "./ui/search-field";
import { StatCard } from "./ui/stat-card";
import { Select } from "./ui/select";
import { Pagination } from "./ui/pagination";
import { Table, TableHead } from "./ui/table";
import { Panel, SectionHeader } from "./ui/panel";

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
  const gridRef = useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = useState(6);
  const [listPage, setListPage] = useState(1);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [transportFilter, setTransportFilter] = useState("all");
  const [devices, setDevices] = useState<Device[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { has, track } = useBusy();
  const [error, setError] = useState<unknown>(null);
  /** The connect attempt that just failed with a connection problem: shown as 「逐项检查连接」. */
  const [checking, setChecking] = useState<{ transport: "adb" | "lan"; target: string } | null>(null);
  const restoreAddFocus = useRef(true);
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

  // connection problems (not a typo in the address, not a missing adb) open the step-by-step check right away
  const connectAttempt = (transport: "adb" | "lan", target: string, fn: () => Promise<Device>) =>
    run(transport + ":" + target, async () => {
      setChecking(null);
      try {
        upsert(await fn());
      } catch (e) {
        if (needsCheck(e)) setChecking({ transport, target });
        throw e;
      }
    });
  const connectAdb = (serial: string) => connectAttempt("adb", serial, () => api.connectAdb(serial));
  const connectLan = (addr: string) => connectAttempt("lan", addr, () => api.connectLan(addr));
  const disconnect = (id: string) =>
    run("rm:" + id, async () => {
      const res = await api.disconnect(id);
      if (res.device) upsert(res.device);
      else setDevices((cur) => cur.filter((d) => d.id !== id));
    });
  const forget = async (id: string) => {
    // forgetting the device the editor is on would switch the projects page away and drop unsaved edits
    if (id === devId && !(await confirmLeave(t.deviceFlow.forgetUnsaved))) return;
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

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleDevices = devices.filter((d) =>
    (stateFilter === "all" || d.state === stateFilter) &&
    (transportFilter === "all" || d.transport === transportFilter) &&
    (!normalizedQuery || [d.name, d.group, d.note, d.id, d.address, d.serial, d.info.name, d.info.model, d.info.brand]
      .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))),
  );
  useEffect(() => { setListPage(1); }, [query, stateFilter, transportFilter]);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      // Reserve the column header; fixed-height rows keep pagination within the workspace.
      setPageSize(Math.max(1, Math.floor((height - 42) / 88)));
    });
    observer.observe(grid);
    return () => observer.disconnect();
  }, [loaded, devices.length === 0]);
  const pages = Math.max(1, Math.ceil(visibleDevices.length / pageSize));
  const currentPage = Math.min(listPage, pages);
  useEffect(() => { setListPage((page) => Math.min(page, pages)); }, [pages]);
  const pageDevices = visibleDevices.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const filtered = Boolean(query || stateFilter !== "all" || transportFilter !== "all");
  const resetFilters = () => { setQuery(""); setStateFilter("all"); setTransportFilter("all"); };

  const feedback = <>
    {error !== null && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
    {checking && <ConnectCheck key={checking.transport + ":" + checking.target} transport={checking.transport} target={checking.target}
      onClose={() => setChecking(null)} onConnect={() => void (checking.transport === "adb" ? connectAdb(checking.target) : connectLan(checking.target))} />}
  </>;

  return (
    <div className="page devices-page">
      <div className="device-overview" aria-label={t.connected}>
        <StatCard label={t.deviceFlow.totalDevices} value={devices.length} selected={stateFilter === "all"} onClick={() => setStateFilter("all")} />
        <StatCard label={t.state.online} value={devices.filter((d) => d.state === "online").length} tone="success" selected={stateFilter === "online"} onClick={() => setStateFilter(stateFilter === "online" ? "all" : "online")} />
        <StatCard label={t.state.offline} value={devices.filter((d) => d.state === "offline").length} selected={stateFilter === "offline"} onClick={() => setStateFilter(stateFilter === "offline" ? "all" : "offline")} />
      </div>
      {dbNotice === "db.newer" && (
        <Alert tone="warn" role="status">
          <IconAlert size={16} />
          <span className="grow">{t.saved.newer}</span>
        </Alert>
      )}
      {dbNotice === "db.corrupt" && (
        <Alert tone="warn" role="status">
          <IconAlert size={16} />
          <span className="grow">{t.saved.corrupt(dbDetail)}</span>
        </Alert>
      )}
      {!addOpen && feedback}

      <section aria-labelledby="h-connected">
        <SectionHeader title={t.connected} titleId="h-connected" count={devices.length || undefined} actions={<>
          {autoReconnect !== null && (
            <label className="check small" title={t.deviceFlow.autoReconnectHint}>
              <input type="checkbox" checked={autoReconnect} disabled={has("auto")} onChange={(e) => void toggleAuto(e.target.checked)} />
              {t.deviceFlow.autoReconnect}
            </label>
          )}
          <Button
            size="sm"
            variant={addOpen ? "default" : "primary"}
            aria-expanded={Boolean(addOpen)}
            aria-haspopup="dialog"
            aria-controls={addOpen ? "add-device" : undefined}
            onClick={() => setAddOpen((o) => !o)}
          >
            <IconPlus size={14} />
            {t.deviceFlow.addDevice}
          </Button>
        </>} />

        {devices.length > 0 && <Toolbar label={t.deviceFlow.filters} actions={filtered && <Button variant="ghost" size="sm" onClick={resetFilters}>{t.deviceFlow.resetFilters}</Button>}>
          <SearchField label={t.deviceFlow.search} clearLabel={t.deviceFlow.clearSearch} placeholder={t.deviceFlow.searchHint} value={query} onValueChange={setQuery} />
          <label className="ui-filter-field"><span>{t.deviceFlow.statusFilter}</span>
            <Select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
              <option value="all">{t.deviceFlow.allStates}</option>
              {["online", "offline", "connecting", "unpaired"].map((state) => <option key={state} value={state}>{t.state[state]}</option>)}
            </Select>
          </label>
          <label className="ui-filter-field"><span>{t.deviceFlow.transportFilter}</span>
            <Select value={transportFilter} onChange={(e) => setTransportFilter(e.target.value)}>
              <option value="all">{t.deviceFlow.allTransports}</option><option value="adb">USB / ADB</option><option value="lan">{t.lanTitle}</option>
            </Select>
          </label>
        </Toolbar>}
        {loaded && devices.length > 0 && <p className="device-results muted" role="status" aria-live="polite">{t.deviceFlow.results(visibleDevices.length, devices.length)}</p>}

        {addOpen && (
          <Dialog title={t.deviceFlow.addDevice} closeLabel={t.shortcuts.close} onClose={() => setAddOpen(false)}
            restoreFocus={restoreAddFocus} initialFocus="#device-address" ownsKeys className="connect-dialog">
            {feedback}
          <div id="add-device" className="add-device" aria-label={t.deviceFlow.addDevice} role="region">
            <Panel className="add-col" titleId="h-adb" level={3} title={<><IconUsb size={16} /> {t.adbDevices}</>} actions={
                <Button size="sm" onClick={() => void loadAdb()} disabled={adb === null || adbLoading}>
                  {adbLoading ? <Spinner /> : <IconRefresh size={14} />}{t.refresh}
                </Button>
            }>
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
                    actions={<Button onClick={() => void loadAdb()}>{t.retry}</Button>}
                  >
                    {t.adbMissing}
                  </EmptyState>
                ) : (
                  <EmptyState
                    icon={<IconAlert size={26} />}
                    title={t.adbErrorTitle}
                    tone="error"
                    role="alert"
                    actions={<Button onClick={() => void loadAdb()}>{t.retry}</Button>}
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
                    <li key={d.serial} className="list-row">
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
                      <Button
                        variant={d.state === "device" && !liveIds.has("adb:" + d.serial) ? "primary" : "default"}
                        aria-label={`${t.connect} ${d.serial}`}
                        onClick={() => void connectAdb(d.serial)}
                        disabled={d.state !== "device" || has("adb:" + d.serial) || liveIds.has("adb:" + d.serial)}
                      >
                        {has("adb:" + d.serial) ? <Spinner /> : t.connect}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </Panel>

            <Panel className="add-col" titleId="h-lan" level={3} title={<><IconWifi size={16} /> {t.lanTitle}</>}>
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
                <Input
                  id="device-address"
                  aria-label="device address"
                  className="grow w-auto"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder={t.lanPlaceholder}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button type="submit" variant="primary" aria-label={t.addressConnect} disabled={has("lan:" + address.trim()) || !address.trim()}>
                  {has("lan:" + address.trim()) ? <Spinner /> : t.connect}
                </Button>
              </form>
              <div className="row scan-row">
                {scan?.running ? (
                  <Button onClick={cancelScan}>
                    <Spinner />
                    {t.deviceFlow.scanCancel}
                  </Button>
                ) : (
                  <Button onClick={() => void doScan()} disabled={has("scan")}>
                    <IconSearch size={16} />
                    {t.scan}
                  </Button>
                )}
                {scan && (
                  <span className="muted grow" role="status" aria-live="polite">
                    {scan.running
                      ? `${t.scanning} ${t.deviceFlow.scanProgress(scan.done, scan.total)} · ${t.deviceFlow.scanFound(scan.hits.length)}`
                      : scan.cancelled
                        ? t.deviceFlow.scanCancelled(scan.hits.length)
                        : t.deviceFlow.scanDone(scan.hits.length)}
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
                    <li key={h.address} className="list-row">
                      <span className="meta grow">
                        <strong>{h.address}</strong>
                        <span className="muted">{h.info.name || h.info.model}</span>
                      </span>
                      <Button
                        aria-label={`${t.connect} ${h.address}`}
                        onClick={() => void connectLan(h.address)}
                        disabled={has("lan:" + h.address) || liveIds.has("lan:" + h.address)}
                      >
                        {t.connect}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
          </Dialog>
        )}

        <div className="device-list-viewport" ref={gridRef}>
        {devices.length === 0 ? (
          <EmptyState icon={<IconPhone size={26} />} title={t.emptyDevicesTitle} role="status">
            {t.emptyDevicesDesc}
          </EmptyState>
        ) : visibleDevices.length === 0 ? (
          <EmptyState icon={<IconSearch size={26} />} title={t.deviceFlow.noResults} actions={<Button onClick={resetFilters}>{t.deviceFlow.resetFilters}</Button>}>
            {t.deviceFlow.noResultsHint}
          </EmptyState>
        ) : (
          <Table aria-label={t.connected} className="device-table">
            <colgroup><col className="device-name-col" /><col className="device-state-col" /><col className="device-model-col" /><col className="device-address-col" /><col className="device-actions-col" /></colgroup>
            <thead><tr>
              <TableHead>{t.saved.name} / {t.saved.group}</TableHead><TableHead>{t.deviceFlow.statusFilter}</TableHead>
              <TableHead className="device-model-cell">{t.info.model}</TableHead><TableHead>{t.deviceFlow.connection}</TableHead><TableHead className="device-actions-cell">{t.deviceFlow.actions}</TableHead>
            </tr></thead>
            <tbody>
            {pageDevices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                current={d.id === devId}
                onDisconnect={() => disconnect(d.id)}
                onForget={() => void forget(d.id)}
                onRetry={() => retry(d)}
                onPair={async (code) => upsert(await api.pairDevice(d.id, code))}
                onSave={(patch) => saveMeta(d, patch)}
                onOpen={(page) => open(d, page)}
                busy={has("rm:" + d.id) || has("fg:" + d.id) || has("re:" + d.id) || has("sv:" + d.id)}
              />
            ))}
            </tbody>
          </Table>
        )}
        </div>
        {pages > 1 && <Pagination page={currentPage} pages={pages} onPageChange={setListPage}
          label={t.deviceFlow.pagination} previousLabel={t.deviceFlow.previousPage} nextLabel={t.deviceFlow.nextPage}
          summary={t.deviceFlow.pageSummary(currentPage, pages)} />}
      </section>
    </div>
  );
}

/** Errors worth the step-by-step check: the device or the app could not be reached, or did not answer as XScript. */
function needsCheck(e: unknown): boolean {
  const code = e instanceof RpcError ? e.code : "";
  if (code === "device.protocol" && /^invalid (port in )?device address/.test(e instanceof Error ? e.message : "")) return false;
  return ["device.unreachable", "device.timeout", "device.protocol", "adb.no_such_device", "adb.not_ready", "adb.failed", "adb.timeout"].includes(code);
}
