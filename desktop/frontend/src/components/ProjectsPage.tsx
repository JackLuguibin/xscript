import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "../app-context";
import { bpKey, hasBpOptions, wireBreakpoints } from "../api";
import type { BpOptions, BreakpointOptions, Breakpoints, DebugStep, FileContent, LogEntry, ProjectFiles, ProjectSummary, SearchMatch } from "../api";
import { t } from "../strings";
import { useBusy } from "../useBusy";
import { useCurrentDevice } from "../device-context";
import { Badge } from "./Badge";
import { CodeEditor } from "./CodeEditor";
import { ProjectWorkbench } from "./ProjectWorkbench";
import { ProjectFileTree } from "./ProjectFileTree";
import { useConfirm } from "./ConfirmDialog";
import { DebugPanel, useDebugSession } from "./DebugPanel";
import { ErrorBanner } from "./ErrorBanner";
import { ProjectSearch } from "./ProjectSearch";
import { RecentRuns } from "./RecentRuns";
import { UiDesigner } from "./UiDesigner";
import { UiPreview } from "./UiPreview";
import { uiForm } from "../ui-form";
import { SyncPanel } from "./SyncPanel";
import { EmptyState } from "./EmptyState";
import { IconAlert, IconFolder, IconMark, IconPhone, IconRefresh, Spinner } from "./icons";
import { useToast } from "./Toast";

/** Folders with more files than this are deleted without an undo copy. */
const UNDO_MAX_FILES = 50;
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Toolbar } from "./ui/toolbar";
import { SectionHeader } from "./ui/panel";
import { Disclosure } from "./ui/disclosure";
import { Dialog, isModalOpen } from "./ui/dialog";
import { Field, FormActions } from "./ui/field";
import { UI_TRY_PROJECT, uiTryMain } from "../ui-try";


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
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const createRestoreFocus = useRef(true);
  const [toolWindow, setToolWindow] = useState<"run" | "debug" | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const cursor = useRef<number | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const [breakpoints, setBreakpoints] = useState<Breakpoints>({});
  const [bpOptions, setBpOptions] = useState<BreakpointOptions>({});
  const debug = useDebugSession(devId);
  useEffect(() => { if (debug.active) setToolWindow("debug"); }, [debug.active]);

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
  }, [logs, toolWindow]);

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
      setFiles(null);
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

  const [formText, setFormText] = useState(false); // .ui.json: false = designer, true = raw JSON
  const [fileForm, setFileForm] = useState<{ mode: "new" | "rename" | "form" | "directory"; from: string; value: string } | null>(null);
  const fileRestoreFocus = useRef(true);
  const reloadFiles = async () => setFiles(await api.files(devId, project));

  const submitFileForm = () => {
    const f = fileForm;
    if (!f || !f.value.trim()) return;
    let to = f.value.trim();
    if (f.mode === "directory") {
      void act("fileform", async () => {
        await api.createDirectory(devId, project, to);
        setFileForm(null);
        await reloadFiles();
        toast(t.files.created(to + "/"));
      });
      return;
    }
    const isForm = f.mode === "form";
    if (isForm) {
      // 新建界面: a name, not a path; the designer files go to res/ui/<name>.ui.json (+ .html, ui_<name>.py on save)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(to)) {
        setNotice(t.files.formNameInvalid);
        return;
      }
      to = `res/ui/${to}.ui.json`;
      if ((files?.files ?? []).some((x) => x.path === to)) {
        setNotice(t.files.formExists(to));
        return;
      }
    }
    const isNew = f.mode !== "rename";
    void act("fileform", async () => {
      const seed = isNew && uiForm.formName(to) ? uiForm.serializeSpec(uiForm.newSpec(isForm ? f.value.trim() : undefined)) : "";
      if (isNew) {
        await api.writeFile(devId, project, to, seed, true);
      } else {
        await api.moveFile(devId, project, f.from, to);
        if (file?.path === f.from) setFile({ ...file, path: to });
      }
      setFileForm(null);
      await reloadFiles();
      if (isForm) await openFile(to);
      const dev = devId;
      const proj = project;
      const from = f.from;
      if (isNew) {
        toast(t.files.created(to), {
          label: t.files.undo,
          run: () =>
            void act("undo", async () => {
              // only an untouched new file is removed: anything typed into it since is kept
              const now = await api.readFile(dev, proj, to);
              if (now.content !== seed) {
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
  const [reveal, setReveal] = useState<{ path: string; line: number; column: number; length: number; wholeLine?: boolean } | null>(null);
  const openMatch = async (m: SearchMatch) => {
    if (file?.path !== m.path) {
      if (!(await confirmDiscard())) return;
      await openFile(m.path, false);
    }
    setReveal({ path: m.path, line: m.line, column: m.column, length: m.length });
  };
  // 最近运行 → 跳到出错行: open the file (asking about unsaved edits) and select that line
  const openLine = async (path: string, line: number) => {
    if (file?.path !== path) {
      if (!(await confirmDiscard())) return;
      await openFile(path, false);
    }
    setReveal({ path, line, column: 1, length: 0, wholeLine: true });
  };
  // Ctrl/Cmd+Shift+F anywhere on the page (the code editor included) focuses the search box
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isModalOpen()) return;
      if (e.key.toLowerCase() !== "f" || !(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || !searchInput.current) return;
      e.preventDefault();
      e.stopPropagation();
      const searchDetails = searchInput.current.closest("details");
      if (searchDetails) searchDetails.open = true;
      searchInput.current.focus();
      searchInput.current.select();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Ctrl/Cmd+Z outside text fields and the code editor undoes the latest file operation that still offers 撤销.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isModalOpen()) return;
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

  const offerUndo = (text: string, saved: FileContent[] | null, directories: string[] = []) => {
    if (!saved) return toast(text);
    const dev = devId;
    const proj = project;
    toast(text, {
      label: t.files.undo,
      run: () =>
        void act("undo", async () => {
          if (directories.length) {
            const existing = new Set((await api.files(dev, proj)).dirs);
            for (const directory of directories) {
              if (!existing.has(directory)) {
                await api.createDirectory(dev, proj, directory);
                directory.split("/").forEach((_, index, parts) => existing.add(parts.slice(0, index + 1).join("/")));
              }
            }
          }
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
          toast(directories.length && saved.length === 0 ? t.files.undone : t.files.restored(saved.length));
        }),
    });
  };

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
      offerUndo(t.files.deletedFolder(dir, inside.length), saved, [dir, ...(files?.dirs ?? []).filter((path) => path.startsWith(dir + "/"))].sort((a, b) => a.split("/").length - b.split("/").length));
    });
  };

  const save = async () => {
    if (!file || file.encoding !== "utf-8" || !dirty) return;
    await api.writeFile(devId, project, file.path, text);
    setFile({ ...file, content: text });
    setDirty(false);
    const form = uiForm.formName(file.path);
    if (form) await generateForm(form, text);
  };

  /** Saving res/ui/<name>.ui.json also writes the page and the Python that shows it, like the other designers. */
  const generateForm = async (name: string, spec: string) => {
    let parsed;
    try {
      parsed = uiForm.parseSpec(spec);
    } catch {
      return setNotice(t.projects.uiNotGenerated);
    }
    if (uiForm.validateSpec(parsed).length) return setNotice(t.projects.uiNotGenerated);
    const out = uiForm.outputs(parsed, name);
    for (const [path, content] of Object.entries(out)) await api.writeFile(devId, project, path, content);
    setNotice(t.projects.uiGenerated(Object.keys(out)));
    await reloadFiles();
  };

  /** 在手机上试运行: the form's generated files go into a scratch project with a tiny __init__.py that shows the form
   * and prints what it returns; the user's own project (and its entry point) is not touched. */
  const tryForm = () =>
    act("tryform", async () => {
      if (!file) return;
      const name = uiForm.formName(file.path);
      if (!name) return;
      let parsed;
      try {
        parsed = uiForm.parseSpec(text);
      } catch {
        return setNotice(t.projects.uiTryBad);
      }
      if (uiForm.validateSpec(parsed).length) return setNotice(t.projects.uiTryBad);
      if (dirty) await save();
      const out = uiForm.outputs(parsed, name);
      try {
        await api.createProject(devId, UI_TRY_PROJECT);
      } catch {
        // already there from an earlier try: its files are overwritten below
      }
      for (const [path, content] of Object.entries(out)) await api.writeFile(devId, UI_TRY_PROJECT, path, content);
      await api.writeFile(devId, UI_TRY_PROJECT, "__init__.py", uiTryMain(name));
      const r = await api.run(devId, UI_TRY_PROJECT);
      if (r.error) setNotice(`${t.projects.alreadyRunning}${r.project ? `：${r.project}` : ""}`);
      else toast(t.projects.uiTryStarted(name));
    });

  const create = async () => {
    const name = newName.trim();
    if (!name || has("create") || !(await confirmDiscard())) return;
    let created = false;
    try {
      await track("create", async () => {
        setCreateError(null);
        await api.createProject(devId, name);
        created = true;
        setCreateOpen(false);
        setNewName("");
        await loadProjects();
        setProject(name);
        setBreakpoints({});
        setBpOptions({});
        setFile(null);
        setDirty(false);
        setFiles(await api.files(devId, name));
      });
    } catch (e) {
      if (created) setError(e);
      else setCreateError(e);
    }
  };
  const closeCreate = () => { if (!has("create")) setCreateOpen(false); };

  const running = !!device?.info.running;
  const runningProject = device?.info.project ?? "";

  const runProject = () =>
    act("run", async () => {
      setToolWindow("run");
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
    <div className="page projects-page">
      {error !== null && !fileForm && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
      {notice && !fileForm && (
        <Alert tone="warn" role="status">
          <IconAlert size={16} />
          <span className="grow">{notice}</span>
          <Button variant="ghost" size="sm" className="icon-btn" aria-label={t.errors.dismiss} onClick={() => setNotice("")}>
            <IconMark size={14} />
          </Button>
        </Alert>
      )}

      <Toolbar label={t.projects.editor} className="projects-toolbar" actions={<>
        <details className="project-device-keys"><summary>{t.projects.keys}</summary><div>
        {(["back", "home", "recents"] as const).map((k) => (
          <Button key={k} size="sm" onClick={() => void key(k)} disabled={!devId || has("key:" + k)}>{t.projects[k]}</Button>
        ))}
        </div></details>
      </>}>
        <Button className="project-create-trigger" size="sm" disabled={!devId} onClick={() => { setNewName(""); setCreateError(null); setCreateOpen(true); }}>+ {t.projects.newProject}</Button>
        <IconFolder size={16} /><span className="workspace-name">{project || t.projects.workspace}</span>
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
        {running && <Badge tone="ok">{`${t.projects.running}${runningProject ? `：${runningProject}` : ""}`}</Badge>}
      </Toolbar>

      <ProjectWorkbench
        editorTitle={(file ? file.path.split("/").at(-1)! : t.projects.editor) + (dirty ? " ●" : "")}
        tool={toolWindow} onToolChange={setToolWindow}
        project={
        <section aria-labelledby="h-projects" className="panel project-sidebar">
          <SectionHeader title={<><IconFolder size={16} /> {t.projects.list}</>} titleId="h-projects" actions={
            <Button variant="ghost" size="sm" aria-label={t.refresh} title={t.refresh} onClick={() => void loadProjects()} disabled={!devId}><IconRefresh size={14} /></Button>
          } />
          {projects === null && <div className="skeleton" style={{ height: "3rem" }} aria-busy="true" />}
          {projects !== null && projects.length === 0 && <p className="muted" role="status">{t.projects.empty}</p>}

          <ProjectFileTree key={devId} projects={projects ?? []} project={project} files={files} selectedFile={file?.path}
            runningProject={running ? runningProject : undefined} busy={has}
            onProject={(name) => void openProject(name)} onFile={(path) => void openFile(path)}
            onCreate={(mode, parent) => { setError(null); setNotice(""); setFileForm({ mode, from: "", value: parent ? parent + "/" : "" }); }}
            onRename={(path) => { setError(null); setFileForm({ mode: "rename", from: path, value: path }); }}
            onDelete={(path) => void deleteFile(path)} onDeleteFolder={(path) => void deleteFolder(path)} />
          {files && (
            <>
              <details className="project-search-disclosure"><summary>{t.search.title}</summary>
              <ProjectSearch key={`${devId}/${project}`} devId={devId} project={project} inputRef={searchInput} onOpen={(m) => void openMatch(m)} onError={(e) => setError(e)} />
              </details>

              <Disclosure title={t.sync.title}>
              <SyncPanel
                devId={devId}
                project={project}
                onError={(e) => setError(e)}
                onSynced={() => void api.files(devId, project).then(setFiles).catch(() => undefined)}
              />
              </Disclosure>
              <Disclosure title={t.projects.recentRuns}>
              <RecentRuns devId={devId} project={project} refresh={running} onError={(e) => setError(e)} onOpenLine={(p, ln) => void openLine(p, ln)} />
              </Disclosure>
            </>
          )}
        </section>}
        editor={
        <section className="editor-panel" aria-label={t.projects.editor}>
          {file && <div className="editor-breadcrumb"><IconFolder size={13} /><span>{project}/{file.path}</span></div>}
          <div className="project-edit-surface">
          {!project && <div className="project-editor-welcome"><span className="welcome-code" aria-hidden="true">{ "{ }" }</span><h3>{t.projects.pickProject}</h3>
            <p>{t.projects.workspaceHint}</p>
            <div className="editor-shortcuts"><span>{t.projects.save}<kbd>⌘ / Ctrl + S</kbd></span><span>{t.projects.run}<kbd>F6</kbd></span><span>{t.projects.searchHint}<kbd>⌘ / Ctrl + Shift + F</kbd></span></div>
          </div>}
          {project && !file && <div className="project-editor-welcome"><span className="welcome-code" aria-hidden="true">{ "{ }" }</span><h3>{t.projects.pickFile}</h3><p>{project} · {files?.files.length ?? 0} {t.projects.files}</p><span className="welcome-shortcut">{t.projects.searchHint} <kbd>⌘ / Ctrl + Shift + F</kbd></span></div>}
          {file && file.encoding !== "utf-8" && <p className="muted">{t.projects.binary}</p>}
          {file && file.encoding === "utf-8" && uiForm.formName(file.path) && (
            <div className="row" style={{ justifyContent: "flex-end", marginBottom: "var(--sp-2)" }}>
              <Button size="sm" onClick={() => void tryForm()} disabled={has("tryform") || has("run")} title={t.projects.uiTryHint}>
                {has("tryform") ? <Spinner /> : t.projects.uiTry}
              </Button>
              <Button size="sm" aria-pressed={!formText} onClick={() => setFormText((v) => !v)}>
                {formText ? t.projects.uiViewDesign : t.projects.uiViewText}
              </Button>
            </div>
          )}
          {file && file.encoding === "utf-8" && uiForm.formName(file.path) && (
            <div
              hidden={formText}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void act("save", save);
                }
              }}
            >
              <UiDesigner
                key={`${devId}/${project}/${file.path}`}
                text={text}
                onChange={(v) => {
                  setText(v);
                  setDirty(true);
                }}
              />
            </div>
          )}
          {file && file.encoding === "utf-8" && (!uiForm.formName(file.path) || formText) && (
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
          {file && file.encoding === "utf-8" && uiForm.formName(file.path) && formText && <UiPreview text={text} />}
          </div>
        </section>}
        debug={<div className="project-debug-surface">
            {project && <DebugPanel
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
            />}</div>}
        run={<div className="project-log-surface"><div className="workbench-output-actions"><Button variant="ghost" size="sm" onClick={() => setLogs([])}>{t.projects.clear}</Button></div>
          <pre id="project-output" className="logs" ref={logRef} aria-label={t.projects.logs} aria-live="polite">
            {logs.length === 0 ? <span className="muted">{t.projects.noLogs}</span> : logs.map((l) => <span key={l.seq} className={l.stream === "stderr" ? "err" : ""}>{l.line.endsWith("\n") ? l.line : l.line + "\n"}</span>)}
          </pre></div>}
      />
      <footer className="editor-statusbar">{file && <span>{dirty ? t.projects.unsaved : t.projects.saved}</span>}<span>{project || t.projects.workspace}</span><span className="grow" /><span>{file ? (file.path.endsWith(".py") ? "Python" : file.path.split(".").at(-1)?.toUpperCase()) : "XScript"}</span>{file && <span>{file.encoding.toUpperCase()}</span>}</footer>
      {fileForm && <Dialog title={fileForm.mode === "directory" ? t.files.newDirectory : fileForm.mode === "rename" ? t.files.rename : fileForm.mode === "form" ? t.files.newForm : t.files.newFile}
        closeLabel={t.shortcuts.close} restoreFocus={fileRestoreFocus} initialFocus="#project-file-path" ownsKeys closeButton={false} onClose={() => { if (!has("fileform")) setFileForm(null); }}>
        {error !== null && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
        {notice && <Alert tone="warn" role="status">{notice}</Alert>}
        <form className="project-create-dialog" aria-busy={has("fileform")} onSubmit={(e) => { e.preventDefault(); submitFileForm(); }}>
          <Field label={fileForm.mode === "directory" ? t.files.directoryPrompt : fileForm.mode === "rename" ? t.files.renamePrompt : fileForm.mode === "form" ? t.files.newFormPrompt : t.files.newFilePrompt}>
            <Input id="project-file-path" className="mono" value={fileForm.value} onChange={(e) => setFileForm({ ...fileForm, value: e.target.value })} disabled={has("fileform")} autoComplete="off" spellCheck={false} required />
          </Field>
          <FormActions><Button disabled={has("fileform")} onClick={() => setFileForm(null)}>{t.confirm.cancel}</Button><Button type="submit" variant="primary" disabled={!fileForm.value.trim() || has("fileform")}>{has("fileform") ? <Spinner /> : "OK"}</Button></FormActions>
        </form>
      </Dialog>}
      {createOpen && <Dialog title={t.projects.newProject} closeLabel={t.shortcuts.close} onClose={closeCreate} restoreFocus={createRestoreFocus} initialFocus="#new-project-name" ownsKeys closeButton={false} describedBy="new-project-description">
        <p id="new-project-description" className="muted">{t.projects.createDescription}</p>
        {createError !== null && <ErrorBanner error={createError} onDismiss={() => setCreateError(null)} />}
        <form className="project-create-dialog" onSubmit={(e) => { e.preventDefault(); void create(); }} aria-busy={has("create")}>
          <Field label={t.projects.newName} hint={t.projects.createHint}>
            <Input aria-label={t.projects.newName} id="new-project-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t.projects.nameExample} spellCheck={false} autoComplete="off" disabled={has("create")} required />
          </Field>
          <FormActions>
            <Button onClick={closeCreate} disabled={has("create")}>{t.confirm.cancel}</Button>
            <Button type="submit" variant="primary" disabled={!newName.trim() || has("create")}>{has("create") ? <Spinner /> : t.projects.create}</Button>
          </FormActions>
        </form>
      </Dialog>}
      {dialog}
      {toasts}
    </div>
  );
}
