import { useEffect, useRef, useState } from "react";
import type { EditorHandle } from "../editor/monaco";

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
  currentLine?: number | null;
  onToggleBreakpoint?: (line: number) => void;
}

const NO_LINES: number[] = [];

/** 1-based line of the caret in a textarea */
export function caretLine(el: HTMLTextAreaElement): number {
  return el.value.slice(0, el.selectionStart ?? 0).split("\n").length;
}

/** Monaco with Python completion from ide/python-stubs; a plain textarea until (or unless) Monaco has loaded. Remount per file (key=path). */
export function CodeEditor({ path, value, label, onChange, onKeyDown, breakpoints = NO_LINES, currentLine = null, onToggleBreakpoint }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<EditorHandle | null>(null);
  const cb = useRef({ onChange, onKeyDown, onToggleBreakpoint });
  cb.current = { onChange, onKeyDown, onToggleBreakpoint };
  const initial = useRef(value);
  const dbg = useRef({ breakpoints, currentLine });
  dbg.current = { breakpoints, currentLine };
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
    handle.current?.setBreakpoints(breakpoints);
  }, [breakpoints, ready]);
  useEffect(() => {
    handle.current?.setCurrentLine(currentLine);
  }, [currentLine, ready]);

  return (
    <>
      <div ref={host} className="monaco-host" data-ready={ready ? "true" : "false"} hidden={!ready} />
      {!ready && (
        <textarea
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
