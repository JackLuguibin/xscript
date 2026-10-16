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
}

/** Monaco with Python completion from ide/python-stubs; a plain textarea until (or unless) Monaco has loaded. Remount per file (key=path). */
export function CodeEditor({ path, value, label, onChange, onKeyDown }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<EditorHandle | null>(null);
  const cb = useRef({ onChange, onKeyDown });
  cb.current = { onChange, onKeyDown };
  const initial = useRef(value);
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
          onKeyDown={(e) => onKeyDown(e.nativeEvent)}
        />
      )}
    </>
  );
}
