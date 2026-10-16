import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "../app-context";
import type { Device, FileContent, LogEntry, ProjectFiles, ProjectSummary } from "../api";
import { RpcError } from "../bridge/types";
import { t } from "../strings";
import { Badge } from "./Badge";
import { CodeEditor } from "./CodeEditor";
import { EmptyState } from "./EmptyState";
import { IconAlert, IconFolder, IconPhone, IconRefresh, Spinner } from "./icons";

const MAX_LOG_LINES = 2000; // the device keeps about the same window (design §14)
export const LOG_POLL_MS = 1000;

function errText(e: unknown): string {
  if (e instanceof RpcError) return `${e.message} [${e.code}]`;
  return e instanceof Error ? e.message : String(e);
}

/** Device projects: list → files → edit/save → run/stop → follow /logs (the P1 "edit, sync, run, logs" loop, design §12.1). */
export function ProjectsPage({ pollMs = LOG_POLL_MS }: { pollMs?: number }) {
  const { api, rpc } = useServices();
  const [devices, setDevices] = useState<Device[]>([]);
  const [devId, setDevId] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [project, setProject] = useState("");
  const [files, setFiles] = useState<ProjectFiles | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newName, setNewName] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const cursor = useRef<number | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const online = devices.filter((d) => d.state === "online");
  const device = devices.find((d) => d.id === devId);

  useEffect(() => {
    void api.listDevices().then((r) => setDevices(r.devices)).catch(() => undefined);
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
  }, [api, rpc]);

  // pick the first online device; drop the selection when it goes away
  useEffect(() => {
    if (!devId || !devices.some((d) => d.id === devId)) setDevId(online[0]?.id ?? "");
  }, [devices, devId, online]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy("");
    }
  };

  const loadProjects = useCallback(async () => {
    if (!devId) return;
    try {
      setProjects((await api.projects(devId)).projects);
    } catch (e) {
      setProjects([]);
      setError(errText(e));
    }
  }, [api, devId]);

  useEffect(() => {
    setProjects(null);
    setProject("");
    setFiles(null);
    setFile(null);
    setLogs([]);
    cursor.current = null;
    void loadProjects();
  }, [loadProjects]);

  // follow /logs with the seq cursor. The first poll also shows the device's recent window (the device keeps ~2000 lines).
  useEffect(() => {
    if (!devId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await api.logs(devId, cursor.current ?? 0);
        if (stop) return;
        if (r.next < (cursor.current ?? 0)) setLogs([]); // the device restarted or its log was cleared: the cursor went backwards
        if (r.entries.length) setLogs((cur) => [...cur, ...r.entries].slice(-MAX_LOG_LINES));
        cursor.current = r.next;
      } catch {
        /* device offline: keep polling, the badge already shows it */
      }
      if (!stop) timer = setTimeout(() => void tick(), pollMs);
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, devId, pollMs]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const confirmDiscard = () => !dirty || window.confirm(`${t.projects.unsaved}，确定放弃修改？`);

  const openProject = (name: string) => {
    if (!confirmDiscard()) return;
    void act("open:" + name, async () => {
      setProject(name);
      setFile(null);
      setDirty(false);
      setFiles(await api.files(devId, name));
    });
  };

  const openFile = (path: string) => {
    if (!confirmDiscard()) return;
    void act("file:" + path, async () => {
      const f = await api.readFile(devId, project, path);
      setFile(f);
      setText(f.encoding === "utf-8" ? f.content : "");
      setDirty(false);
    });
  };

  const save = async () => {
    if (!file || file.encoding !== "utf-8" || !dirty) return;
    await api.writeFile(devId, project, file.path, text);
    setFile({ ...file, content: text });
    setDirty(false);
  };

  const create = () =>
    act("create", async () => {
      const name = newName.trim();
      await api.createProject(devId, name);
      setNewName("");
      await loadProjects();
      setProject(name);
      setFile(null);
      setFiles(await api.files(devId, name));
    });

  const running = !!device?.info.running;
  const runningProject = device?.info.project ?? "";

  const runProject = () =>
    act("run", async () => {
      await save();
      const r = await api.run(devId, project);
      if (r.error) setNotice(`${t.projects.alreadyRunning}${r.project ? `：${r.project}` : ""}`);
    });
  const stopProject = () => act("stop", async () => void (await api.stop(devId, runningProject || project)));
  const key = (name: string) => act("key:" + name, async () => void (await api.key(devId, name)));

  if (online.length === 0 && !device) {
    return (
      <div className="page">
        <EmptyState icon={<IconPhone size={26} />} title={t.projects.noDevice} role="status">
          {t.projects.noDeviceDesc}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page">
      {error && (
        <div className="banner error" role="alert">
          <IconAlert size={16} />
          <span className="grow">
            {t.errorPrefix}：{error}
          </span>
        </div>
      )}
      {notice && (
        <div className="banner warn" role="status">
          <span className="grow">{notice}</span>
        </div>
      )}

      <div className="row toolbar">
        <label className="row">
          {t.projects.device}
          <select aria-label={t.projects.device} value={devId} onChange={(e) => confirmDiscard() && setDevId(e.target.value)}>
            {devices.map((d) => (
              <option key={d.id} value={d.id} disabled={d.state !== "online"}>
                {(d.info.name || d.info.model || d.id) + (d.state !== "online" ? `（${t.state[d.state] ?? d.state}）` : "")}
              </option>
            ))}
          </select>
        </label>
        {running && <Badge tone="ok">{`${t.projects.running}${runningProject ? `：${runningProject}` : ""}`}</Badge>}
        <span className="grow" />
        <span className="muted">{t.projects.keys}</span>
        {(["back", "home", "recents"] as const).map((k) => (
          <button key={k} className="small" onClick={() => void key(k)} disabled={!devId || busy !== ""}>
            {t.projects[k]}
          </button>
        ))}
      </div>

      <div className="projects-grid">
        <section aria-labelledby="h-projects" className="panel">
          <div className="section-head">
            <h2 id="h-projects">
              <IconFolder size={16} /> {t.projects.list}
            </h2>
            <span className="grow" />
            <button className="small" aria-label={t.refresh} onClick={() => void loadProjects()} disabled={!devId}>
              <IconRefresh size={14} />
            </button>
          </div>
          {projects === null && <div className="skeleton" style={{ height: "3rem" }} aria-busy="true" />}
          {projects !== null && projects.length === 0 && <p className="muted" role="status">{t.projects.empty}</p>}
          <ul className="list" aria-label={t.projects.list}>
            {(projects ?? []).map((p) => (
              <li key={p.name}>
                <button className={"list-btn" + (p.name === project ? " active" : "")} aria-current={p.name === project ? "true" : undefined} onClick={() => openProject(p.name)}>
                  {p.name}
                  {running && runningProject === p.name && <Badge tone="ok">{t.projects.running}</Badge>}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="row"
            style={{ marginTop: "var(--sp-3)" }}
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) void create();
            }}
          >
            <input aria-label={t.projects.newName} className="grow" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t.projects.newName} spellCheck={false} />
            <button type="submit" disabled={!newName.trim() || busy !== ""}>
              {busy === "create" ? <Spinner /> : t.projects.create}
            </button>
          </form>
          {files && (
            <>
              <h3 className="sub-head">{t.projects.files}</h3>
              <ul className="list" aria-label={t.projects.files}>
                {files.files.map((f) => (
                  <li key={f.path}>
                    <button className={"list-btn mono" + (file?.path === f.path ? " active" : "")} onClick={() => openFile(f.path)}>
                      {f.path}
                      <span className="muted">{f.size} B</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section aria-labelledby="h-editor" className="panel editor-panel">
          <div className="section-head">
            <h2 id="h-editor">
              {t.projects.editor}
              {file && <span className="muted mono">{` ${project}/${file.path}`}</span>}
            </h2>
            <span className="grow" />
            {file && <span className="muted">{dirty ? t.projects.unsaved : t.projects.saved}</span>}
            <button onClick={() => void act("save", save)} disabled={!file || !dirty || busy !== ""}>
              {busy === "save" ? <Spinner /> : t.projects.save}
            </button>
            <button className="primary" onClick={() => void runProject()} disabled={!project || busy !== ""}>
              {busy === "run" ? <Spinner /> : t.projects.run}
            </button>
            <button className="danger" onClick={() => void stopProject()} disabled={!running || busy !== ""}>
              {busy === "stop" ? <Spinner /> : t.projects.stop}
            </button>
          </div>
          {!project && <p className="muted">{t.projects.pickProject}</p>}
          {project && !file && <p className="muted">{t.projects.pickFile}</p>}
          {file && file.encoding !== "utf-8" && <p className="muted">{t.projects.binary}</p>}
          {file && file.encoding === "utf-8" && (
            <CodeEditor
              key={`${devId}/${project}/${file.path}`}
              path={file.path}
              label={t.projects.editor}
              value={text}
              onChange={(v) => {
                setText(v);
                setDirty(true);
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void act("save", save);
                } else if (e.key === "F6" && !e.shiftKey) {
                  e.preventDefault();
                  void runProject();
                } else if (e.key === "F6" && e.shiftKey) {
                  e.preventDefault();
                  void stopProject();
                }
              }}
            />
          )}
          <div className="section-head" style={{ marginTop: "var(--sp-3)" }}>
            <h2>{t.projects.logs}</h2>
            <span className="grow" />
            <button className="small" onClick={() => setLogs([])}>
              {t.projects.clear}
            </button>
          </div>
          <pre className="logs" ref={logRef} aria-label={t.projects.logs} aria-live="polite">
            {logs.length === 0 ? <span className="muted">{t.projects.noLogs}</span> : logs.map((l) => <span key={l.seq} className={l.stream === "stderr" ? "err" : ""}>{l.line.endsWith("\n") ? l.line : l.line + "\n"}</span>)}
          </pre>
        </section>
      </div>
    </div>
  );
}
