import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "../app-context";
import { bpKey, hasBpOptions, wireBreakpoints } from "../api";
import type { BpOptions, BreakpointOptions, Breakpoints, DebugStep, FileContent, LogEntry, ProjectFiles, ProjectSummary, SearchMatch } from "../api";
import { t } from "../strings";
import { useBusy } from "../useBusy";
import { useCurrentDevice } from "../device-context";
import { Badge } from "./Badge";
import { CodeEditor } from "./CodeEditor";
import { useConfirm } from "./ConfirmDialog";
import { DebugPanel, useDebugSession } from "./DebugPanel";
import { ErrorBanner } from "./ErrorBanner";
import { ProjectSearch } from "./ProjectSearch";
import { RecentRuns } from "./RecentRuns";
import { SyncPanel } from "./SyncPanel";
import { EmptyState } from "./EmptyState";
import { IconAlert, IconFolder, IconMark, IconPhone, IconRefresh, Spinner } from "./icons";
import { useToast } from "./Toast";

/** Folders with more files than this are deleted without an undo copy. */
const UNDO_MAX_FILES = 50;
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const MAX_LOG_LINES = 2000; // the device keeps about the same window (design §14)
export const LOG_POLL_MS = 1000;

/**
 * Device projects: list → files → edit/save → run/stop → follow /logs (the P1 "edit, sync, run, logs" loop, design §12.1).
 * `onDirtyChange` reports whether the open file has unsaved edits (the shell marks the nav item and guards window close).
 */
export function ProjectsPage({ pollMs = LOG_POLL_MS, onDirtyChange }: { pollMs?: number; onDirtyChange?: (dirty: boolean) => void }) {
  const { api } = useServices();
  const { confirm, dialog } = useConfirm();
  const { toast, toasts, runLatestAction } = useToast();
  // the device comes from the shell (top-bar switcher); switching while dirty asks there (design §14.5)
  const { devices, devId } = useCurrentDevice();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [project, setProject] = useState("");
  const projectRef = useRef(project);
  projectRef.current = project;
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
  const [bpOptions, setBpOptions] = useState<BreakpointOptions>({});
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
    setBpOptions({});
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
      setBpOptions({});
      setFile(null);
      setDirty(false);
      setFiles(await api.files(devId, name));
    });
  };

  const openFile = async (path: string, ask = true) => {
    if (ask && !(await confirmDiscard())) return;
    setReveal(null);
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
      const dev = devId;
      const proj = project;
      const from = f.from;
      if (f.mode === "new") {
        toast(t.files.created(to), {
          label: t.files.undo,
          run: () =>
            void act("undo", async () => {
              // only an untouched new file is removed: anything typed into it since is kept
              const now = await api.readFile(dev, proj, to);
              if (now.content !== "") {
                setNotice(t.files.undoCreateChanged(to));
                return;
              }
              await api.deleteFile(dev, proj, to);
              if (proj !== projectRef.current) return;
              setFile((cur) => (cur?.path === to ? null : cur));
              await reloadFiles();
              toast(t.files.undone);
            }),
        });
      } else {
        toast(t.files.renamed(from, to), {
          label: t.files.undo,
          run: () =>
            void act("undo", async () => {
              await api.moveFile(dev, proj, to, from);
              if (proj !== projectRef.current) return;
              setFile((cur) => (cur?.path === to ? { ...cur, path: from } : cur));
              await reloadFiles();
              toast(t.files.undone);
            }),
        });
      }
    });
  };

  // 在工程中搜索: a result opens its file (asking about unsaved edits) and selects the match
  const searchInput = useRef<HTMLInputElement>(null);
  const [reveal, setReveal] = useState<{ path: string; line: number; column: number; length: number } | null>(null);
  const openMatch = async (m: SearchMatch) => {
    if (file?.path !== m.path) {
      if (!(await confirmDiscard())) return;
      await openFile(m.path, false);
    }
    setReveal({ path: m.path, line: m.line, column: m.column, length: m.length });
  };
  // Ctrl/Cmd+Shift+F anywhere on the page (the code editor included) focuses the search box
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "f" || !(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || !searchInput.current) return;
      e.preventDefault();
      e.stopPropagation();
      searchInput.current.focus();
      searchInput.current.select();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Ctrl/Cmd+Z outside text fields and the code editor undoes the latest file operation that still offers 撤销.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "z" || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .monaco-editor"))) return;
      if (runLatestAction()) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runLatestAction]);

  const deleteFile = async (path: string) => {
    if (!(await confirm({ message: t.files.confirmDelete(path), confirmLabel: t.confirm.del, danger: true }))) return;
    void act("del:" + path, async () => {
      const saved = await snapshot([path]);
      await api.deleteFile(devId, project, path);
      if (file?.path === path) {
        setFile(null);
        setDirty(false);
      }
      await reloadFiles();
      offerUndo(t.files.deleted(path), saved);
    });
  };

  /** Copies of the files about to be deleted, kept in memory for the undo toast; null when there are too many. */
  const snapshot = async (paths: string[]): Promise<FileContent[] | null> => {
    if (paths.length > UNDO_MAX_FILES) return null;
    try {
      return await Promise.all(paths.map((p) => api.readFile(devId, project, p)));
    } catch {
      return null; // a file that cannot be read just means no undo
    }
  };

  const offerUndo = (text: string, saved: FileContent[] | null) => {
    if (!saved) return toast(text);
    const dev = devId;
    const proj = project;
    toast(text, {
      label: t.files.undo,
      run: () =>
        void act("undo", async () => {
          for (const f of saved) {
            try {
              await api.writeFile(dev, proj, f.path, f.content, true, f.encoding);
            } catch (e) {
              setError(e);
              setNotice(t.files.restoreFailed(f.path));
              return;
            }
          }
          if (proj === projectRef.current) await reloadFiles();
          toast(t.files.restored(saved.length));
        }),
    });
  };

  /** Every folder that holds a file, parents before children (the device lists files only). */
  const folders = useMemo(() => {
    const out = new Map<string, number>();
    for (const f of files?.files ?? []) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join("/");
        out.set(d, (out.get(d) ?? 0) + 1);
      }
    }
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files]);

  const deleteFolder = async (dir: string) => {
    const inside = (files?.files ?? []).map((f) => f.path).filter((p) => p.startsWith(dir + "/"));
    const shown = inside.slice(0, 15).join("\n") + (inside.length > 15 ? "\n" + t.files.more(inside.length - 15) : "");
    if (!(await confirm({ message: t.files.confirmDeleteFolder(dir, inside.length, shown), confirmLabel: t.confirm.del, danger: true }))) return;
    void act("deldir:" + dir, async () => {
      const saved = await snapshot(inside);
      await api.deleteFolder(devId, project, dir);
      if (file && file.path.startsWith(dir + "/")) {
        setFile(null);
        setDirty(false);
      }
      await reloadFiles();
      offerUndo(t.files.deletedFolder(dir, inside.length), saved);
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
      setBpOptions({});
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

  const pushBreakpoints = (path: string, lines: number[], opts: BreakpointOptions) => {
    if (debuggingHere) void api.debugSetBreakpoints(devId, path, wireBreakpoints(path, lines, opts)).catch((e) => setError(e));
  };
  const toggleBreakpoint = (path: string, line: number) => {
    const cur = breakpoints[path] ?? [];
    const removing = cur.includes(line);
    const lines = removing ? cur.filter((n) => n !== line) : [...cur, line].sort((a, b) => a - b);
    const next = { ...breakpoints };
    if (lines.length) next[path] = lines;
    else delete next[path];
    const opts = { ...bpOptions };
    if (removing) delete opts[bpKey(path, line)];
    setBreakpoints(next);
    setBpOptions(opts);
    pushBreakpoints(path, lines, opts);
  };
  /** Set (or clear, with empty options) a breakpoint's condition / hit count / log message; adds the breakpoint if missing. */
  const editBreakpoint = (path: string, line: number, o: BpOptions) => {
    const cur = breakpoints[path] ?? [];
    const lines = cur.includes(line) ? cur : [...cur, line].sort((a, b) => a - b);
    const opts = { ...bpOptions };
    if (hasBpOptions(o)) opts[bpKey(path, line)] = o;
    else delete opts[bpKey(path, line)];
    setBreakpoints({ ...breakpoints, [path]: lines });
    setBpOptions(opts);
    pushBreakpoints(path, lines, opts);
  };
  const bpKinds = (path: string) => {
    const out: Record<number, "cond" | "log"> = {};
    for (const ln of breakpoints[path] ?? []) {
      const o = bpOptions[bpKey(path, ln)];
      if (hasBpOptions(o)) out[ln] = o.logMessage?.trim() ? "log" : "cond";
    }
    return out;
  };

  const startDebug = () =>
    act("debug", async () => {
      if (dirty) await save(); // debug what is in the editor
      debug.clearOutput();
      const wire = Object.fromEntries(Object.entries(breakpoints).map(([p, lines]) => [p, wireBreakpoints(p, lines, bpOptions)]));
      debug.setState(await api.debugStart(devId, project, wire));
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
        <Alert tone="warn" role="status">
          <IconAlert size={16} />
          <span className="grow">{notice}</span>
          <Button variant="ghost" size="sm" className="icon-btn" aria-label={t.errors.dismiss} onClick={() => setNotice("")}>
            <IconMark size={14} />
          </Button>
        </Alert>
      )}

      <div className="row toolbar">
        {running && <Badge tone="ok">{`${t.projects.running}${runningProject ? `：${runningProject}` : ""}`}</Badge>}
        <span className="grow" />
        <span className="muted">{t.projects.keys}</span>
        {(["back", "home", "recents"] as const).map((k) => (
          <Button key={k} size="sm" onClick={() => void key(k)} disabled={!devId || has("key:" + k)}>
            {t.projects[k]}
          </Button>
        ))}
      </div>

      <div className="projects-grid">
        <section aria-labelledby="h-projects" className="panel">
          <div className="section-head">
            <h2 id="h-projects">
              <IconFolder size={16} /> {t.projects.list}
            </h2>
            <span className="grow" />
            <Button size="sm" aria-label={t.refresh} onClick={() => void loadProjects()} disabled={!devId}>
              <IconRefresh size={14} />
            </Button>
          </div>
          {projects === null && <div className="skeleton" style={{ height: "3rem" }} aria-busy="true" />}
          {projects !== null && projects.length === 0 && <p className="muted" role="status">{t.projects.empty}</p>}
          <ul className="list" aria-label={t.projects.list}>
            {(projects ?? []).map((p) => (
              <li key={p.name}>
                <Button variant="bare" className={"list-btn" + (p.name === project ? " active" : "")} aria-current={p.name === project ? "true" : undefined} onClick={() => void openProject(p.name)}>
                  <span className="list-name" title={p.name}>{p.name}</span>
                  {running && runningProject === p.name && <Badge tone="ok">{t.projects.running}</Badge>}
                </Button>
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
            <Input aria-label={t.projects.newName} className="grow w-auto" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t.projects.newName} spellCheck={false} />
            <Button type="submit" disabled={!newName.trim() || has("create")}>
              {has("create") ? <Spinner /> : t.projects.create}
            </Button>
          </form>
          {files && (
            <>
              <div className="section-head">
                <h3 className="sub-head grow">{t.projects.files}</h3>
                <Button size="sm" onClick={() => setFileForm({ mode: "new", from: "", value: "" })} disabled={has("fileform")}>
                  {t.files.newFile}
                </Button>
              </div>
              <ProjectSearch key={`${devId}/${project}`} devId={devId} project={project} inputRef={searchInput} onOpen={(m) => void openMatch(m)} onError={(e) => setError(e)} />
              {fileForm && (
                <form
                  className="row"
                  style={{ marginBottom: "var(--sp-2)" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitFileForm();
                  }}
                >
                  <Input
                    autoFocus
                    aria-label={fileForm.mode === "new" ? t.files.newFilePrompt : t.files.renamePrompt}
                    placeholder={fileForm.mode === "new" ? t.files.newFilePrompt : t.files.renamePrompt}
                    className="grow mono w-auto"
                    value={fileForm.value}
                    spellCheck={false}
                    onChange={(e) => setFileForm({ ...fileForm, value: e.target.value })}
                    onKeyDown={(e) => e.key === "Escape" && setFileForm(null)}
                  />
                  <Button type="submit" variant="primary" size="sm" disabled={!fileForm.value.trim() || has("fileform")}>
                    {has("fileform") ? <Spinner /> : "OK"}
                  </Button>
                  <Button size="sm" onClick={() => setFileForm(null)}>
                    ✕
                  </Button>
                </form>
              )}
              {folders.length > 0 && (
                <ul className="list" aria-label={t.files.folders}>
                  {folders.map(([d, n]) => (
                    <li key={d} className="file-row">
                      <span className="ui-btn list-btn mono folder-label">
                        <span className="list-name" title={`${d}/`}>📁 {d}/</span>
                        <span className="muted">{t.files.fileCount(n)}</span>
                      </span>
                      <Button variant="ghost" size="sm" className="text-danger-fg hover:bg-danger-bg"
                        aria-label={`${t.files.delFolder} ${d}/`}
                        title={t.files.delFolder}
                        disabled={has("deldir:" + d)}
                        onClick={() => void deleteFolder(d)}
                      >
                        {has("deldir:" + d) ? <Spinner /> : "🗑"}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <ul className="list" aria-label={t.projects.files}>
                {files.files.map((f) => {
                  const entry = f.path === "__init__.py";
                  return (
                    <li key={f.path} className="file-row">
                      <Button variant="bare" className={"list-btn mono" + (file?.path === f.path ? " active" : "")} onClick={() => void openFile(f.path)}
                        aria-keyshortcuts={entry ? undefined : "Delete"}
                        onKeyDown={(e) => {
                          if (entry || !(e.key === "Delete" || (e.key === "Backspace" && e.metaKey))) return;
                          e.preventDefault();
                          void deleteFile(f.path);
                        }}
                      >
                        <span className="list-name" title={f.path}>{f.path}</span>
                        <span className="muted">{f.size} B</span>
                      </Button>
                      <Button variant="ghost" size="sm"
                       
                        aria-label={`${t.files.rename} ${f.path}`}
                        title={entry ? t.files.entryProtected : t.files.rename}
                        disabled={entry || has("fileform") || has("del:" + f.path)}
                        onClick={() => setFileForm({ mode: "rename", from: f.path, value: f.path })}
                      >
                        ✎
                      </Button>
                      <Button variant="ghost" size="sm" className="text-danger-fg hover:bg-danger-bg"
                       
                        aria-label={`${t.files.del} ${f.path}`}
                        title={entry ? t.files.entryProtected : t.files.del}
                        disabled={entry || has("del:" + f.path) || (fileForm?.mode === "rename" && has("fileform"))}
                        onClick={() => void deleteFile(f.path)}
                      >
                        {has("del:" + f.path) ? <Spinner /> : "🗑"}
                      </Button>
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
              <RecentRuns devId={devId} project={project} refresh={running} onError={(e) => setError(e)} />
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
            <Button onClick={() => void act("save", save)} disabled={!file || !dirty || has("save") || has("run")}>
              {has("save") ? <Spinner /> : t.projects.save}
            </Button>
            <Button variant="primary" onClick={() => void runProject()} disabled={!project || has("run") || has("save")}>
              {has("run") ? <Spinner /> : t.projects.run}
            </Button>
            {/* 停止 never waits on another action: usable while running, while a run is starting, and while saving */}
            <Button variant="danger" onClick={() => void stopProject()} disabled={!(running || has("run")) || has("stop")}>
              {has("stop") ? <Spinner /> : t.projects.stop}
            </Button>
          </div>
          {!project && <EmptyState icon={<IconFolder size={26} />} title={t.projects.pickProject} />}
          {project && !file && <EmptyState icon={<IconFolder size={26} />} title={t.projects.pickFile} />}
          {file && file.encoding !== "utf-8" && <p className="muted">{t.projects.binary}</p>}
          {file && file.encoding === "utf-8" && (
            <CodeEditor
              key={`${devId}/${project}/${file.path}`}
              path={file.path}
              label={t.projects.editor}
              value={text}
              breakpoints={breakpoints[file.path]}
              breakpointKinds={bpKinds(file.path)}
              currentLine={currentLine}
              onToggleBreakpoint={(ln) => toggleBreakpoint(file.path, ln)}
              reveal={reveal && reveal.path === file.path ? reveal : null}
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
              breakpointOptions={bpOptions}
              onEditBreakpoint={editBreakpoint}
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
            <Button size="sm" onClick={() => setLogs([])}>
              {t.projects.clear}
            </Button>
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
