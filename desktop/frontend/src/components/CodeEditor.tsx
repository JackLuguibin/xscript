import { useEffect, useRef, useState } from "react";
import type { BpKind, EditorHandle } from "../editor/monaco";

type MonacoModule = Pick<typeof import("../editor/monaco"), "createEditor" | "languageFor">;

/** How Monaco is loaded. Tests swap it; under jsdom (no layout, no workers) the textarea fallback stays. */
export const editorLoader: { load: () => Promise<MonacoModule | null> } = {
  load: () => (/jsdom/i.test(navigator.userAgent) ? Promise.resolve(null) : import("../editor/monaco")),
};

function isDark(): boolean {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr) return attr === "dark";
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

interface Props {
  path: string;
  value: string;
  label: string;
  onChange: (v: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  breakpoints?: number[];
  /** conditional / log points among `breakpoints` (gutter glyph shape) */
  breakpointKinds?: Record<number, BpKind>;
  currentLine?: number | null;
  onToggleBreakpoint?: (line: number) => void;
  /** jump here (e.g. a search result); a new object each time, so the same place can be revealed again */
  reveal?: { line: number; column: number; length: number } | null;
}

const NO_LINES: number[] = [];
const NO_KINDS: Record<number, BpKind> = {};

/** 1-based line of the caret in a textarea */
export function caretLine(el: HTMLTextAreaElement): number {
  return el.value.slice(0, el.selectionStart ?? 0).split("\n").length;
}

/** Monaco with Python completion from ide/python-stubs; a plain textarea until (or unless) Monaco has loaded. Remount per file (key=path). */
export function CodeEditor({ path, value, label, onChange, onKeyDown, breakpoints = NO_LINES, breakpointKinds = NO_KINDS, currentLine = null, onToggleBreakpoint, reveal = null }: Props) {
  const area = useRef<HTMLTextAreaElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<EditorHandle | null>(null);
  const cb = useRef({ onChange, onKeyDown, onToggleBreakpoint });
  cb.current = { onChange, onKeyDown, onToggleBreakpoint };
  const initial = useRef(value);
  const dbg = useRef({ breakpoints, breakpointKinds, currentLine });
  dbg.current = { breakpoints, breakpointKinds, currentLine };
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void editorLoader
      .load()
      .then((m) => {
        if (!alive || !m || !host.current) return;
        handle.current = m.createEditor(host.current, {
          value: initial.current,
          language: m.languageFor(path),
          dark: isDark(),
          label,
          onChange: (v) => cb.current.onChange(v),
          onKey: (e) => cb.current.onKeyDown(e),
          breakpoints: dbg.current.breakpoints,
          breakpointKinds: dbg.current.breakpointKinds,
          currentLine: dbg.current.currentLine,
          onToggleBreakpoint: (ln) => cb.current.onToggleBreakpoint?.(ln),
        });
        setReady(true);
      })
      .catch(() => undefined); // stay on the textarea
    const obs = new MutationObserver(() => handle.current?.setTheme(isDark()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      alive = false;
      obs.disconnect();
      handle.current?.dispose();
      handle.current = null;
    };
  }, [path, label]);

  // keep Monaco in sync when the parent replaces the text (e.g. a reload after sync)
  useEffect(() => {
    const h = handle.current;
    if (h && h.getValue() !== value) h.setValue(value);
  }, [value]);

  useEffect(() => {
    handle.current?.setBreakpoints(breakpoints, breakpointKinds);
  }, [breakpoints, breakpointKinds, ready]);
  useEffect(() => {
    handle.current?.setCurrentLine(currentLine);
  }, [currentLine, ready]);

  useEffect(() => {
    if (!reveal) return;
    if (handle.current) {
      handle.current.reveal(reveal.line, reveal.column, reveal.length);
      return;
    }
    const el = area.current;
    if (!el) return;
    const lines = el.value.split("\n");
    const start = lines.slice(0, reveal.line - 1).reduce((n, l) => n + l.length + 1, 0) + reveal.column - 1;
    el.focus();
    el.setSelectionRange(start, start + reveal.length);
  }, [reveal, ready]);

  return (
    <>
      <div ref={host} className="monaco-host" data-ready={ready ? "true" : "false"} hidden={!ready} />
      {!ready && (
        <textarea
          ref={area}
          aria-label={label}
          className="code"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "F9" && onToggleBreakpoint) {
              e.preventDefault();
              onToggleBreakpoint(caretLine(e.currentTarget));
              return;
            }
            onKeyDown(e.nativeEvent);
          }}
        />
      )}
      {!ready && currentLine !== null && (
        <p className="muted mono" data-testid="current-line">
          ➜ {currentLine}: {value.split("\n")[currentLine - 1] ?? ""}
        </p>
      )}
    </>
  );
}
