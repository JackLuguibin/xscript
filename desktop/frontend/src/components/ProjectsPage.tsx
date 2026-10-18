import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "../app-context";
import type { Breakpoints, DebugStep, FileContent, LogEntry, ProjectFiles, ProjectSummary } from "../api";
import { t } from "../strings";
import { useBusy } from "../useBusy";
import { useCurrentDevice } from "../device-context";
import { Badge } from "./Badge";
import { CodeEditor } from "./CodeEditor";
import { useConfirm } from "./ConfirmDialog";
import { DebugPanel, useDebugSession } from "./DebugPanel";
import { ErrorBanner } from "./ErrorBanner";
import { SyncPanel } from "./SyncPanel";
import { EmptyState } from "./EmptyState";
import { IconAlert, IconFolder, IconMark, IconPhone, IconRefresh, Spinner } from "./icons";
import { useToast } from "./Toast";

const MAX_LOG_LINES = 2000; // the device keeps about the same window (design §14)
export const LOG_POLL_MS = 1000;

/**
 * Device projects: list → files → edit/save → run/stop → follow /logs (the P1 "edit, sync, run, logs" loop, design §12.1).
 * `onDirtyChange` reports whether the open file has unsaved edits (the shell marks the nav item and guards window close).
 */
export function ProjectsPage({ pollMs = LOG_POLL_MS, onDirtyChange }: { pollMs?: number; onDirtyChange?: (dirty: boolean) => void }) {
  const { api } = useServices();
  const { confirm, dialog } = useConfirm();
  const { toast, toasts } = useToast();
  // the device comes from the shell (top-bar switcher); switching while dirty asks there (design §14.5)
  const { devices, devId } = useCurrentDevice();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [project, setProject] = useState("");
  const [files, setFiles] = useState<ProjectFiles | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  // per-item busy keys: open:<p>, file:<path>, fileform, del:<path>, save, create, run, stop, key:<k>, debug
  const { has, track } = useBusy();
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [newName, setNewName] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const cursor = useRef<number | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const [breakpoints, setBreakpoints] = useState<Breakpoints>({});
  const debug = useDebugSession(devId);

  const online = devices.filter((d) => d.state === "online");
  const device = devices.find((d) => d.id === devId);

  const act = async (key: string, fn: () => Promise<void>) => {
    try {
      await track(key, async () => {
        setError(null);
        setNotice("");
        await fn();
      });
    } catch (e) {
      setError(e);
    }
  };

  const loadProjects = useCallback(async () => {
    if (!devId) return;
    try {
      setProjects((await api.projects(devId)).projects);
    } catch (e) {
      setProjects([]);
      setError(e);
    }
  }, [api, devId]);

  useEffect(() => {
    setProjects(null);
    setProject("");
    setFiles(null);
    setFile(null);
    setText("");
    setDirty(false); // the switcher already asked before taking the device away
    setLogs([]);
    setBreakpoints({});
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

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const confirmDiscard = async () =>
    !dirty || (await confirm({ message: t.confirmDiscard, confirmLabel: t.confirm.discard, danger: true }));

  const openProject = async (name: string) => {
    if (!(await confirmDiscard())) return;
    void act("open:" + name, async () => {
      setProject(name);
      setBreakpoints({});
      setFile(null);
      setDirty(false);
      setFiles(await api.files(devId, name));
    });
  };

  const openFile = async (path: string, ask = true) => {
    if (ask && !(await confirmDiscard())) return;
    void act("file:" + path, async () => {
      const f = await api.readFile(devId, project, path);
      setFile(f);
      setText(f.encoding === "utf-8" ? f.content : "");
      setDirty(false);
    });
  };

  const [fileForm, setFileForm] = useState<{ mode: "new" | "rename"; from: string; value: string } | null>(null);
  const reloadFiles = async () => setFiles(await api.files(devId, project));

  const submitFileForm = () => {
    const f = fileForm;
    if (!f || !f.value.trim()) return;
    const to = f.value.trim();
    void act("fileform", async () => {
      if (f.mode === "new") {
        await api.writeFile(devId, project, to, "", true);
      } else {
        await api.moveFile(devId, project, f.from, to);
        if (file?.path === f.from) setFile({ ...file, path: to });
      }
      setFileForm(null);
      await reloadFiles();
    });
  };

  const deleteFile = async (path: string) => {
    if (!(await confirm({ message: t.files.confirmDelete(path), confirmLabel: t.confirm.del, danger: true }))) return;
    void act("del:" + path, async () => {
      await api.deleteFile(devId, project, path);
      if (file?.path === path) {
        setFile(null);
        setDirty(false);
      }
      await reloadFiles();
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
      setBreakpoints({});
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
      else toast(t.projects.started(project));
    });
  const stopProject = () => act("stop", async () => void (await api.stop(devId, runningProject || project)));
  const key = (name: string) => act("key:" + name, async () => void (await api.key(devId, name)));

  // ---- debugging -------------------------------------------------------------------------------------------------------------
  const dbgState = debug.state;
  const debuggingHere = debug.active && (!dbgState.project || dbgState.project === project);

  const toggleBreakpoint = (path: string, line: number) => {
    const cur = breakpoints[path] ?? [];
    const lines = cur.includes(line) ? cur.filter((n) => n !== line) : [...cur, line].sort((a, b) => a - b);
    const next = { ...breakpoints };
    if (lines.length) next[path] = lines;
    else delete next[path];
    setBreakpoints(next);
    if (debuggingHere) void api.debugSetBreakpoints(devId, path, lines).catch((e) => setError(e));
  };

  const startDebug = () =>
    act("debug", async () => {
      if (dirty) await save(); // debug what is in the editor
      debug.clearOutput();
      debug.setState(await api.debugStart(devId, project, breakpoints));
    });
  const onDebugError = useCallback((e: unknown) => setError(e), []);
  const debugStep = (cmd: DebugStep) => void api.debugStep(devId, cmd).catch((e) => setError(e));
  const stopDebug = (terminate: boolean) => void api.debugStop(devId, terminate).catch((e) => setError(e));

  const openLocation = (path: string) => {
    if (file?.path !== path) void openFile(path);
  };

  // follow the paused location into the editor (only when that does not throw away edits)
  useEffect(() => {
    const p = dbgState.state === "stopped" ? dbgState.path : null;
    if (p && project && file?.path !== p && !dirty) void openFile(p, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbgState]);

  const currentLine = dbgState.state === "stopped" && file && dbgState.path === file.path ? dbgState.line ?? null : null;

  const debugKeys = (e: KeyboardEvent): boolean => {
    const stoppedNow = dbgState.state === "stopped";
    if (e.key === "F5" && e.shiftKey) {
      if (debug.active) stopDebug(true);
    } else if (e.key === "F5") {
      if (stoppedNow) debugStep("continue");
      else if (!debug.active && project) void startDebug();
    } else if (e.key === "F10" && stoppedNow) debugStep("next");
    else if (e.key === "F11" && e.shiftKey && stoppedNow) debugStep("stepOut");
    else if (e.key === "F11" && stoppedNow) debugStep("stepIn");
    else return false;
    e.preventDefault();
    return true;
  };

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
      {error !== null && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
      {notice && (
        <div className="banner warn" role="status">
          <IconAlert size={16} />
          <span className="grow">{notice}</span>
          <button type="button" className="small ghost icon-btn" aria-label={t.errors.dismiss} onClick={() => setNotice("")}>
            <IconMark size={14} />
          </button>
        </div>
      )}

      <div className="row toolbar">
        {running && <Badge tone="ok">{`${t.projects.running}${runningProject ? `：${runningProject}` : ""}`}</Badge>}
        <span className="grow" />
        <span className="muted">{t.projects.keys}</span>
        {(["back", "home", "recents"] as const).map((k) => (
          <button key={k} className="small" onClick={() => void key(k)} disabled={!devId || has("key:" + k)}>
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
                <button className={"list-btn" + (p.name === project ? " active" : "")} aria-current={p.name === project ? "true" : undefined} onClick={() => void openProject(p.name)}>
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
            <button type="submit" disabled={!newName.trim() || has("create")}>
              {has("create") ? <Spinner /> : t.projects.create}
            </button>
          </form>
          {files && (
            <>
              <div className="section-head">
                <h3 className="sub-head grow">{t.projects.files}</h3>
                <button className="small" onClick={() => setFileForm({ mode: "new", from: "", value: "" })} disabled={has("fileform")}>
                  {t.files.newFile}
                </button>
              </div>
              {fileForm && (
                <form
                  className="row"
                  style={{ marginBottom: "var(--sp-2)" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitFileForm();
                  }}
                >
                  <input
                    autoFocus
                    aria-label={fileForm.mode === "new" ? t.files.newFilePrompt : t.files.renamePrompt}
                    placeholder={fileForm.mode === "new" ? t.files.newFilePrompt : t.files.renamePrompt}
                    className="grow mono"
                    value={fileForm.value}
                    spellCheck={false}
                    onChange={(e) => setFileForm({ ...fileForm, value: e.target.value })}
                    onKeyDown={(e) => e.key === "Escape" && setFileForm(null)}
                  />
                  <button type="submit" className="small primary" disabled={!fileForm.value.trim() || has("fileform")}>
                    {has("fileform") ? <Spinner /> : "OK"}
                  </button>
                  <button type="button" className="small" onClick={() => setFileForm(null)}>
                    ✕
                  </button>
                </form>
              )}
              <ul className="list" aria-label={t.projects.files}>
                {files.files.map((f) => {
                  const entry = f.path === "__init__.py";
                  return (
                    <li key={f.path} className="file-row">
                      <button className={"list-btn mono" + (file?.path === f.path ? " active" : "")} onClick={() => void openFile(f.path)}>
                        {f.path}
                        <span className="muted">{f.size} B</span>
                      </button>
                      <button
                        className="small ghost"
                        aria-label={`${t.files.rename} ${f.path}`}
                        title={entry ? t.files.entryProtected : t.files.rename}
                        disabled={entry || has("fileform") || has("del:" + f.path)}
                        onClick={() => setFileForm({ mode: "rename", from: f.path, value: f.path })}
                      >
                        ✎
                      </button>
                      <button
                        className="small ghost danger"
                        aria-label={`${t.files.del} ${f.path}`}
                        title={entry ? t.files.entryProtected : t.files.del}
                        disabled={entry || has("del:" + f.path) || (fileForm?.mode === "rename" && has("fileform"))}
                        onClick={() => void deleteFile(f.path)}
                      >
                        {has("del:" + f.path) ? <Spinner /> : "🗑"}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <SyncPanel
                devId={devId}
                project={project}
                onError={(e) => setError(e)}
                onSynced={() => void api.files(devId, project).then(setFiles).catch(() => undefined)}
              />
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
            <button onClick={() => void act("save", save)} disabled={!file || !dirty || has("save") || has("run")}>
              {has("save") ? <Spinner /> : t.projects.save}
            </button>
            <button className="primary" onClick={() => void runProject()} disabled={!project || has("run") || has("save")}>
              {has("run") ? <Spinner /> : t.projects.run}
            </button>
            {/* 停止 never waits on another action: usable while running, while a run is starting, and while saving */}
            <button className="danger" onClick={() => void stopProject()} disabled={!(running || has("run")) || has("stop")}>
              {has("stop") ? <Spinner /> : t.projects.stop}
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
              breakpoints={breakpoints[file.path]}
              currentLine={currentLine}
              onToggleBreakpoint={(ln) => toggleBreakpoint(file.path, ln)}
              onChange={(v) => {
                setText(v);
                setDirty(true);
              }}
              onKeyDown={(e) => {
                if (debugKeys(e)) return;
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
          {project && (
            <DebugPanel
              devId={devId}
              project={project}
              session={debug}
              breakpoints={breakpoints}
              busy={has("debug")}
              onStart={() => void startDebug()}
              onStep={debugStep}
              onStop={stopDebug}
              onRemoveBreakpoint={toggleBreakpoint}
              onOpenLocation={openLocation}
              onError={onDebugError}
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
      {dialog}
      {toasts}
    </div>
  );
}
