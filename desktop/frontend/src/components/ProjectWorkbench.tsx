import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { DockviewReact, DockviewDefaultTab, themeLight, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps, type IDockviewPanelHeaderProps } from "dockview-react";
import { t } from "../strings";
import { Button } from "./ui/button";
type Tool = "run" | "debug";
type Slot = "project" | "editor" | Tool;
const Content = createContext<Record<Slot, ReactNode>>({ project: null, editor: null, run: null, debug: null });
function Panel({ api }: IDockviewPanelProps) { return <div className={`workbench-panel workbench-${api.id}`}>{useContext(Content)[api.id as Slot]}</div>; }
function Tab(props: IDockviewPanelHeaderProps) { return <DockviewDefaultTab {...props} hideClose />; }
const components = { content: Panel };
const theme = { ...themeLight, name: "xscript", className: "dockview-theme-light xscript-dock-theme" };
const STORAGE_KEY = "xscript.project-layout.v1";
/** Stable renderers preserve React state when panels are moved or hidden. */
export function ProjectWorkbench({ project, editor, run, debug, editorTitle, tool, onToolChange }: {
  project: ReactNode; editor: ReactNode; run: ReactNode; debug: ReactNode;
  editorTitle: string; tool: Tool | null; onToolChange: (tool: Tool | null) => void;
}) {
  const [api, setApi] = useState<DockviewApi | null>(null);
  const change = useRef(onToolChange); change.current = onToolChange;
  const switching = useRef(false);
  const initialize = (dock: DockviewApi) => {
    dock.clear();
    dock.addPanel({ id: "editor", component: "content", title: editorTitle, renderer: "always", minimumWidth: 240 });
    dock.addPanel({ id: "project", component: "content", title: t.projects.list, renderer: "always", initialWidth: 260, minimumWidth: 190, position: { referencePanel: "editor", direction: "left" } });
    dock.addPanel({ id: "run", component: "content", title: t.projects.logs, renderer: "always", initialHeight: 260, minimumHeight: 120, position: { referencePanel: "editor", direction: "below" } });
    dock.addPanel({ id: "debug", component: "content", title: t.debug.title, renderer: "always", position: { referencePanel: "run", direction: "within" } });
    dock.getPanel("editor")?.api.setActive();
  };
  const ready = ({ api: dock }: DockviewReadyEvent) => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        dock.fromJSON(JSON.parse(saved));
        if (["project", "editor", "run", "debug"].some((id) => !dock.getPanel(id)) || dock.panels.length !== 4) throw new Error("Invalid workspace layout");
      } else initialize(dock);
    } catch { initialize(dock); }
    setApi(dock);
  };
  useEffect(() => {
    if (!api) return;
    api.getPanel("editor")?.api.setTitle(editorTitle);
    api.getPanel("project")?.api.setTitle(t.projects.list);
    api.getPanel("run")?.api.setTitle(t.projects.logs);
    api.getPanel("debug")?.api.setTitle(t.debug.title);
  }, [api, editorTitle]);
  useEffect(() => {
    if (!api) return;
    switching.current = true;
    const groups = new Set([api.getPanel("run")?.group, api.getPanel("debug")?.group]);
    // Never hide an editor if a tool has been docked into its group.
    for (const group of groups) {
      if (!group) continue;
      const contentPanel = group.panels.find((panel) => panel.id !== "run" && panel.id !== "debug");
      if (!contentPanel) group.api.setVisible(tool !== null);
      else if (!tool && (group.activePanel?.id === "run" || group.activePanel?.id === "debug")) contentPanel.api.setActive();
    }
    if (tool) api.getPanel(tool)?.api.setActive();
    switching.current = false;
  }, [api, tool]);
  useEffect(() => {
    if (!api) return;
    let timer: ReturnType<typeof setTimeout>;
    const active = api.onDidActivePanelChange(({ panel, origin }) => {
      if (origin === "user" && !switching.current && (panel?.id === "run" || panel?.id === "debug")) change.current(panel.id);
    });
    const save = api.onDidLayoutChange(() => {
      clearTimeout(timer);
      timer = setTimeout(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(api.toJSON())); } catch { /* storage may be unavailable */ } }, 250);
    });
    return () => { clearTimeout(timer); active.dispose(); save.dispose(); };
  }, [api]);
  return <Content.Provider value={{ project, editor, run, debug }}>
    <div className="project-workbench"><DockviewReact components={components} defaultTabComponent={Tab} onReady={ready} theme={theme} disableFloatingGroups /></div>
    <div className="workbench-tools" role="group" aria-label={t.projects.toolWindows}>
      <Button variant="ghost" size="sm" aria-pressed={tool === "run"} onClick={() => onToolChange(tool === "run" ? null : "run")}>{t.projects.logs}</Button>
      <Button variant="ghost" size="sm" aria-pressed={tool === "debug"} onClick={() => onToolChange(tool === "debug" ? null : "debug")}>{t.debug.title}</Button>
      <span className="grow" />
      {tool && <Button variant="ghost" size="sm" aria-label={t.projects.hideToolWindow} onClick={() => onToolChange(null)}>−</Button>}
      <Button variant="ghost" size="sm" onClick={() => { if (api) { switching.current = true; initialize(api); api.getPanel("run")?.group.api.setVisible(false); switching.current = false; onToolChange(null); } }}>{t.projects.resetLayout}</Button>
    </div>
  </Content.Provider>;
}
