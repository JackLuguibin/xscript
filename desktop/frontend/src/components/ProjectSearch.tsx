import { useMemo, useState, type RefObject } from "react";
import type { SearchMatch, SearchResult } from "../api";
import { useServices } from "../app-context";
import { t } from "../strings";
import { IconMark, Spinner } from "./icons";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface Props {
  devId: string;
  project: string;
  /** open the file and select the match */
  onOpen: (m: SearchMatch) => void;
  onError: (e: unknown) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}

/** 在工程中搜索: text (or regex) search over the project's text files on the device, results grouped by file. */
export function ProjectSearch({ devId, project, onOpen, onError, inputRef }: Props) {
  const { api } = useServices();
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ query: string; data: SearchResult } | null>(null);

  const groups = useMemo(() => {
    const m = new Map<string, SearchMatch[]>();
    for (const hit of result?.data.matches ?? []) m.set(hit.path, [...(m.get(hit.path) ?? []), hit]);
    return [...m.entries()];
  }, [result]);

  const run = async () => {
    const q = query;
    if (!q.trim() || busy) return;
    setBusy(true);
    try {
      setResult({ query: q, data: await api.searchProject(devId, project, q, { regex, caseSensitive }) });
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (on: boolean, set: (v: boolean) => void, label: string, text: string) => (
    <Button variant="ghost" size="sm" className={"mono" + (on ? " active" : "")} aria-pressed={on} aria-label={label} title={label} onClick={() => set(!on)}>
      {text}
    </Button>
  );

  return (
    <div className="project-search" role="search" aria-label={t.search.title}>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Input
          ref={inputRef}
          type="search"
          className="grow w-auto"
          aria-label={t.search.title}
          aria-keyshortcuts="Control+Shift+F Meta+Shift+F"
          placeholder={t.search.placeholder}
          title={`${t.search.title} (${t.search.shortcut})`}
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && result) {
              e.preventDefault();
              setResult(null);
            }
          }}
        />
        {toggle(caseSensitive, setCaseSensitive, t.search.caseSensitive, "Aa")}
        {toggle(regex, setRegex, t.search.regex, ".*")}
        <Button type="submit" size="sm" disabled={!query.trim() || busy}>
          {busy ? <Spinner /> : t.search.run}
        </Button>
      </form>
      {result && (
        <div className="search-results">
          <div className="row">
            <span className="muted grow" role="status">
              {result.data.matches.length === 0 ? t.search.none(result.query) : t.search.summary(result.data.matches.length, groups.length)}
              {result.data.truncated ? ` · ${t.search.truncated}` : ""}
            </span>
            <Button variant="ghost" size="sm" className="icon-btn" aria-label={t.search.clear} title={t.search.clear} onClick={() => setResult(null)}>
              <IconMark size={12} />
            </Button>
          </div>
          {result.data.filesSkipped > 0 && <p className="muted small">{t.search.skipped(result.data.filesSkipped)}</p>}
          {groups.length > 0 && (
            <ul className="list search-list" aria-label={t.search.results}>
              {groups.map(([path, hits]) => (
                <li key={path}>
                  <div className="search-file mono" title={path}>
                    <span className="list-name">{path}</span> <span className="muted">{hits.length}</span>
                  </div>
                  <ul className="list">
                    {hits.map((h) => (
                      <li key={`${h.line}:${h.column}`}>
                        <Button variant="bare" className="list-btn mono search-hit" aria-label={t.search.open(h.path, h.line)} onClick={() => onOpen(h)}>
                          <span className="muted search-line">{h.line}</span>
                          <span className="list-name">
                            {h.text.slice(0, h.offset).trimStart()}
                            <mark>{h.text.slice(h.offset, h.offset + h.length)}</mark>
                            {h.text.slice(h.offset + h.length)}
                          </span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
