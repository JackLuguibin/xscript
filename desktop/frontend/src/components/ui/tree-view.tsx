import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pagination } from "./pagination";

export interface TreeEntry<T> { id: string; label: string; value: T; children?: TreeEntry<T>[]; searchText?: string }

/** Bounded tree with expand/collapse, ancestor-preserving search and keyboard navigation. */
export function TreeView<T>({ label, entries, query = "", selected, onSelect, previousLabel, nextLabel, pageSummary }: {
  label: string; entries: TreeEntry<T>[]; query?: string; selected: T | null; onSelect: (value: T) => void;
  previousLabel: string; nextLabel: string; pageSummary: (page: number, pages: number) => string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [capacity, setCapacity] = useState(8);
  const viewport = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const matches = (entry: TreeEntry<T>): boolean => (entry.searchText || entry.label).toLocaleLowerCase().includes(search) || Boolean(entry.children?.some(matches));
  const rows: { entry: TreeEntry<T>; level: number; parent?: string; pos: number; count: number }[] = [];
  const walk = (list: TreeEntry<T>[], level: number, parent?: string) => {
    list.forEach((entry, index) => {
      if (search && !matches(entry)) return;
      rows.push({ entry, level, parent, pos: index + 1, count: list.length });
      if (entry.children && (search || !collapsed.has(entry.id))) walk(entry.children, level + 1, entry.id);
    });
  };
  walk(entries, 1);
  const pages = Math.max(1, Math.ceil(rows.length / capacity));
  const current = Math.min(page, pages);
  const visible = rows.slice((current - 1) * capacity, current * capacity);
  const toggle = (id: string) => setCollapsed((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  useEffect(() => { setPage(1); }, [search, entries]);
  useEffect(() => {
    if (!viewport.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.height > 0) setCapacity(Math.max(1, Math.floor(entry.contentRect.height / 28))); });
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  const move = (id: string) => {
    const index = rows.findIndex((row) => row.entry.id === id);
    if (index < 0) return;
    setFocus(id); setPage(Math.floor(index / capacity) + 1);
    requestAnimationFrame(() => viewport.current?.querySelectorAll<HTMLElement>('[role="treeitem"]').forEach((el) => { if (el.dataset.treeId === id) el.focus(); }));
  };
  const content: ReactNode = visible.map(({ entry, level, parent, pos, count }, index) => {
    const branch = Boolean(entry.children?.length);
    const expanded = Boolean(search || !collapsed.has(entry.id));
    return <div key={entry.id} role="treeitem" data-tree-id={entry.id} aria-label={entry.label} aria-level={level} aria-posinset={pos} aria-setsize={count}
      aria-selected={selected === entry.value} aria-expanded={branch ? expanded : undefined} className="ui-tree-row"
      tabIndex={focus === entry.id || (!visible.some((row) => row.entry.id === focus) && index === 0) ? 0 : -1}
      style={{ paddingLeft: Math.min(level - 1, 12) * 12 + 4 }} onFocus={() => setFocus(entry.id)}
      onClick={() => onSelect(entry.value)} onKeyDown={(event) => {
        const at = rows.findIndex((row) => row.entry.id === entry.id);
        if (event.key === "ArrowDown") move(rows[Math.min(at + 1, rows.length - 1)].entry.id);
        else if (event.key === "ArrowUp") move(rows[Math.max(0, at - 1)].entry.id);
        else if (event.key === "Home") move(rows[0].entry.id);
        else if (event.key === "End") move(rows[rows.length - 1].entry.id);
        else if (event.key === "ArrowRight") { if (branch && !expanded) toggle(entry.id); else if (branch && rows[at + 1]) move(rows[at + 1].entry.id); }
        else if (event.key === "ArrowLeft") { if (branch && expanded) toggle(entry.id); else if (parent) move(parent); }
        else if (event.key === "Enter" || event.key === " ") onSelect(entry.value);
        else return;
        event.preventDefault();
      }}>
      <span className="ui-tree-toggle" aria-hidden="true" onClick={(event) => { event.stopPropagation(); if (branch) toggle(entry.id); }}>{branch ? (expanded ? "▾" : "▸") : "·"}</span>
      <span className="ui-tree-label" title={entry.label}>{entry.label}</span>
    </div>;
  });
  return <div className="ui-tree-view"><div ref={viewport} role="tree" aria-label={label} className="ui-tree-viewport">{content}</div>
    <Pagination label={label} page={current} pages={pages} onPageChange={setPage} previousLabel={previousLabel} nextLabel={nextLabel} summary={pageSummary(current, pages)} />
  </div>;
}
