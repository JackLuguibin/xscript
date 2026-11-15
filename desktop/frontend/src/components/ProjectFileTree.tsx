import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { ProjectFiles, ProjectSummary } from "../api";
import { t } from "../strings";
import { Badge } from "./Badge";
import { Button } from "./ui/button";
import { ContextMenu, type ContextAction } from "./ui/context-menu";

type FileEntry = ProjectFiles["files"][number];
export interface FileBranch { path: string; name: string; children: FileBranch[]; file?: FileEntry; count: number }
/** Build directories once, including intermediate parents; folders sort before files. */
export function buildFileTree(files: FileEntry[], directories: string[] = []): FileBranch[] {
  const root: FileBranch = { path: "", name: "", children: [], count: 0 };
  for (const directory of directories) {
    let parent = root;
    const parts = directory.split("/").filter(Boolean);
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let node = parent.children.find((child) => child.name === name);
      if (!node) { node = { path, name, children: [], count: 0 }; parent.children.push(node); }
      parent = node;
    });
  }
  for (const file of files) {
    let parent = root;
    const parts = file.path.split("/");
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join("/");
      const leaf = index === parts.length - 1;
      let node = parent.children.find((child) => child.name === name);
      if (!node) { node = { path, name, children: [], count: 0 }; parent.children.push(node); }
      node.count++;
      if (leaf) node.file = file;
      parent = node;
    });
  }
  const sort = (nodes: FileBranch[]) => {
    nodes.sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    nodes.forEach((node) => sort(node.children));
  };
  sort(root.children);
  return root.children;
}

/** Small editor-style file marks; all icons are local SVGs. */
function FileMark({ path }: { path: string }) {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "py") return <svg className="project-file-icon python" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M7.8 1.5c-3 0-2.8 1.3-2.8 1.3v1.4h2.9v.5H3.8S1.5 4.4 1.5 7.5s2 3 2 3h1.2V8.9s-.1-2 2-2h3.5s1.9 0 1.9-1.8V3.3s.3-1.8-4.3-1.8ZM6.3 2.6a.6.6 0 1 1 0 1.2.6.6 0 0 1 0-1.2Z"/><path fill="currentColor" opacity=".65" d="M8.2 14.5c3 0 2.8-1.3 2.8-1.3v-1.4H8.1v-.5h4.1s2.3.3 2.3-2.8-2-3-2-3h-.1v1.6s.1 2-2 2H6.9S5 9.1 5 10.9v1.8s-.3 1.8 3.2 1.8Zm1.5-1.1a.6.6 0 1 1 0-1.2.6.6 0 0 1 0 1.2Z"/></svg>;
  const kind = extension === "json" ? "json" : ["md", "txt"].includes(extension ?? "") ? "text" : ["html", "js", "ts", "css"].includes(extension ?? "") ? "code" : "generic";
  return <svg className={`project-file-icon ${kind}`} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4zM9 1.5V5h3"/>{kind === "code" || kind === "json" ? <path d="m6.8 7.5-1.3 2 1.3 2m2.4-4 1.3 2-1.3 2"/> : <path d="M6 8h4M6 10h4M6 12h3"/>}</svg>;
}

export function ProjectFileTree({ projects, project, files, selectedFile, runningProject, busy, onProject, onFile, onRename, onDelete, onDeleteFolder, onCreate }: {
  projects: ProjectSummary[]; project: string; files: ProjectFiles | null; selectedFile?: string; runningProject?: string;
  busy: (key: string) => boolean; onProject: (name: string) => void; onFile: (path: string) => void;
  onCreate: (kind: "new" | "directory" | "form", parent: string) => void;
  onRename: (path: string) => void; onDelete: (path: string) => void; onDeleteFolder: (path: string) => void;
}) {
  const branches = useMemo(() => buildFileTree(files?.files ?? [], files?.dirs ?? []), [files]);
  const [closedFolders, setClosedFolders] = useState<Set<string>>(new Set());
  const [closedProjects, setClosedProjects] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState("");
  const tree = useRef<HTMLUListElement>(null);
  const [context, setContext] = useState<{ x: number; y: number; path: string; kind: "project" | "directory" | "file"; project: string } | null>(null);
  useEffect(() => { setContext(null); }, [project]);
  const openMenu = (e: MouseEvent<HTMLElement>, path: string, kind: "project" | "directory" | "file", owner = project) => {
    e.preventDefault(); e.stopPropagation(); e.currentTarget.focus();
    setContext({ x: e.clientX, y: e.clientY, path, kind, project: owner });
  };
  useEffect(() => {
    setClosedFolders(new Set());
    setClosedProjects((old) => { const next = new Set(old); next.delete(project); return next; });
  }, [project]);
  useEffect(() => {
    if (!selectedFile) return;
    setFocused(selectedFile);
    setClosedProjects((old) => { const next = new Set(old); next.delete(project); return next; });
    setClosedFolders((old) => new Set([...old].filter((path) => !selectedFile.startsWith(path + "/"))));
  }, [project, selectedFile]);
  const toggleFolder = (path: string) => setClosedFolders((old) => { const next = new Set(old); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const toggleProject = (name: string) => {
    if (name !== project) { onProject(name); return; }
    setClosedProjects((old) => { const next = new Set(old); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  };
  const visibleIds: string[] = [];
  for (const p of projects) {
    visibleIds.push(`project:${p.name}`);
    const walk = (nodes: FileBranch[]) => nodes.forEach((node) => { visibleIds.push(node.path); if (!node.file && !closedFolders.has(node.path)) walk(node.children); });
    if (p.name === project && !closedProjects.has(p.name)) walk(branches);
  }
  const focusId = visibleIds.includes(focused) ? focused : visibleIds[0];
  const navigate = (event: KeyboardEvent<HTMLLIElement>, id: string, branch: boolean, expanded: boolean, activate: () => void, remove?: () => void) => {
    const target = event.target as HTMLElement;
    if (target.closest('[role="treeitem"]') !== event.currentTarget || target.closest(".project-tree-actions")) return;
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault(); event.stopPropagation();
      const box = event.currentTarget.getBoundingClientRect();
      const kind = id.startsWith("project:") ? "project" : branch ? "directory" : "file";
      setContext({ x: box.left + 20, y: box.top + 28, path: kind === "project" ? "" : id, kind, project: kind === "project" ? id.slice(8) : project });
      return;
    }
    const rows = [...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
    const index = rows.indexOf(event.currentTarget);
    const focus = (row?: HTMLElement | null) => row?.focus();
    if (event.key === "ArrowDown") focus(rows[Math.min(index + 1, rows.length - 1)]);
    else if (event.key === "ArrowUp") focus(rows[Math.max(0, index - 1)]);
    else if (event.key === "Home") focus(rows[0]);
    else if (event.key === "End") focus(rows.at(-1));
    else if (event.key === "ArrowRight") { if (branch && !expanded) activate(); else if (branch) focus(rows[index + 1]); }
    else if (event.key === "ArrowLeft") { if (branch && expanded) activate(); else focus(event.currentTarget.parentElement?.closest<HTMLElement>('[role="treeitem"]')); }
    else if (event.key === "Enter" || event.key === " ") activate();
    else if ((event.key === "Delete" || (event.key === "Backspace" && event.metaKey)) && remove) remove();
    else return;
    event.preventDefault(); event.stopPropagation(); setFocused(id);
    // focus handlers set the destination row after keyboard navigation.
    if (document.activeElement?.getAttribute("data-tree-id")) setFocused(document.activeElement.getAttribute("data-tree-id")!);
  };
  const renderNodes = (nodes: FileBranch[], level: number) => nodes.map((node) => {
    const directory = !node.file;
    const expanded = directory && !closedFolders.has(node.path);
    const protectedEntry = node.path === "__init__.py";
    const activate = () => directory ? toggleFolder(node.path) : onFile(node.path);
    return <li key={node.path} role="treeitem" aria-label={directory ? `${node.path}/` : node.path} aria-level={level}
      aria-expanded={directory ? expanded : undefined} aria-selected={!directory && selectedFile === node.path} data-tree-id={node.path}
      tabIndex={focusId === node.path ? 0 : -1} onFocus={(e) => { if (e.target === e.currentTarget) setFocused(node.path); }}
      onContextMenu={(e) => { if ((e.target as HTMLElement).closest('[role="treeitem"]') === e.currentTarget) openMenu(e, node.path, directory ? "directory" : "file"); }}
      onKeyDown={(e) => navigate(e, node.path, directory, expanded, activate, directory ? () => onDeleteFolder(node.path) : protectedEntry ? undefined : () => onDelete(node.path))}>
      <div className={"project-tree-row" + (selectedFile === node.path ? " active" : "")} style={{ paddingLeft: (level - 1) * 10 + 2 }}>
        <Button variant="bare" tabIndex={-1} className="project-tree-open" aria-keyshortcuts={!directory && !protectedEntry ? "Delete" : undefined} aria-label={directory ? `${node.path}/` : `${node.path} ${node.file!.size} B`} onClick={activate}>
          <span className="project-tree-chevron" aria-hidden="true">{directory ? expanded ? "▾" : "▸" : ""}</span>
          {!directory && <FileMark path={node.path} />}
          <span className="list-name" title={directory ? `${node.path}/` : node.path}>{node.name}</span>
          {node.file && <span className="project-tree-size">{node.file.size} B</span>}
        </Button>

      </div>
      {expanded && <ul role="group">{renderNodes(node.children, level + 1)}</ul>}
    </li>;
  });
  const actions: ContextAction[] = [];
  if (context) {
    const parent = context.kind === "file" ? context.path.split("/").slice(0, -1).join("/") : context.path;
    const ready = context.project === project && files !== null && !busy("fileform");
    const create = (kind: "new" | "directory" | "form") => {
      setClosedProjects((old) => { const next = new Set(old); next.delete(project); return next; });
      setClosedFolders((old) => new Set([...old].filter((path) => path !== parent && !parent.startsWith(path + "/"))));
      onCreate(kind, kind === "form" ? "" : parent);
    };
    if (context.kind === "project" && context.project !== project) actions.push({ label: t.projects.openProject, run: () => onProject(context.project) });
    actions.push(
      { label: t.files.newFile, disabled: !ready, run: () => create("new") },
      { label: t.files.newDirectory, disabled: !ready, run: () => create("directory") },
      { label: t.files.newForm, disabled: !ready, run: () => create("form") },
    );
    if (context.kind === "file") actions.push({ label: t.files.rename, disabled: context.path === "__init__.py" || busy("del:" + context.path), run: () => onRename(context.path) });
    if (context.kind !== "project") actions.push({ label: t.files.del, danger: true, disabled: context.path === "__init__.py" || busy((context.kind === "directory" ? "deldir:" : "del:") + context.path), run: () => context.kind === "directory" ? onDeleteFolder(context.path) : onDelete(context.path) });
  }
  return <><ul ref={tree} role="tree" aria-label={t.projects.list} className="project-file-tree" onContextMenu={(e) => { if (!(e.target as HTMLElement).closest('[role="treeitem"]') && project) openMenu(e, "", "project"); }}>
    {projects.map((p) => {
      const expanded = p.name === project && !closedProjects.has(p.name);
      return <li key={p.name} role="treeitem" aria-label={p.name} aria-level={1} aria-expanded={expanded} aria-selected={p.name === project && !selectedFile} data-tree-id={`project:${p.name}`}
        tabIndex={focusId === `project:${p.name}` ? 0 : -1} onFocus={(e) => { if (e.target === e.currentTarget) setFocused(`project:${p.name}`); }} onContextMenu={(e) => { if ((e.target as HTMLElement).closest('[role="treeitem"]') === e.currentTarget) openMenu(e, "", "project", p.name); }} onKeyDown={(e) => navigate(e, `project:${p.name}`, true, expanded, () => toggleProject(p.name))}>
        <div className={"project-tree-row project-tree-root" + (p.name === project ? " current" : "")}>
          <Button variant="bare" tabIndex={-1} className="project-tree-open" aria-label={p.name} aria-current={p.name === project ? "true" : undefined} onClick={() => toggleProject(p.name)}>
            <span className="project-tree-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span><span className="list-name" title={p.name}>{p.name}</span>
            {runningProject === p.name && <Badge tone="ok">{t.projects.running}</Badge>}
          </Button>
        </div>
        {expanded && <ul role="group">{renderNodes(branches, 2)}</ul>}
      </li>;
    })}
  </ul>
    {context && <ContextMenu x={context.x} y={context.y} label={t.files.actions} actions={actions} onClose={() => setContext(null)} />}
  </>;
}
