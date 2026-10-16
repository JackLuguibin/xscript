// Monaco adapter (loaded lazily by CodeEditor; never in jsdom tests, which use the textarea fallback).
import * as monaco from "./monaco-lean";
import EditorWorker from "monaco-esm/editor/editor.worker.js?worker";
import stubs from "../generated/stub-completions.json";
import { complete, StubIndex, type ItemKind, type StubData } from "./completions";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

const index = new StubIndex(stubs as StubData);
let registered = false;

const KIND: Record<ItemKind, monaco.languages.CompletionItemKind> = {
  module: monaco.languages.CompletionItemKind.Module,
  function: monaco.languages.CompletionItemKind.Function,
  method: monaco.languages.CompletionItemKind.Method,
  class: monaco.languages.CompletionItemKind.Class,
  variable: monaco.languages.CompletionItemKind.Variable,
};

function register(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: ["."],
    provideCompletionItems(model, position) {
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const items = complete(index, model.getValue(), before);
      return {
        suggestions: items.map((it) => ({
          label: it.label,
          kind: KIND[it.kind],
          detail: it.detail,
          documentation: it.doc || undefined,
          insertText: it.label,
          range: new monaco.Range(position.lineNumber, position.column - it.replace, position.lineNumber, position.column),
        })),
      };
    },
  });
}

export interface EditorHandle {
  getValue(): string;
  setValue(v: string): void;
  setTheme(dark: boolean): void;
  dispose(): void;
}

export function createEditor(
  el: HTMLElement,
  opts: { value: string; language: string; dark: boolean; label: string; onChange: (v: string) => void; onKey: (e: KeyboardEvent) => void },
): EditorHandle {
  register();
  const ed = monaco.editor.create(el, {
    value: opts.value,
    language: opts.language,
    theme: opts.dark ? "vs-dark" : "vs",
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    tabSize: 4,
    insertSpaces: true,
    scrollBeyondLastLine: false,
    ariaLabel: opts.label,
    // the hidden-textarea input path: EditContext support varies across QtWebEngine builds (IME on Windows untested)
    editContext: false,
  });
  let silent = false;
  ed.onDidChangeModelContent(() => {
    if (!silent) opts.onChange(ed.getValue());
  });
  ed.onKeyDown((e) => opts.onKey(e.browserEvent));
  return {
    getValue: () => ed.getValue(),
    setValue: (v) => {
      silent = true;
      ed.setValue(v);
      silent = false;
    },
    setTheme: (dark) => monaco.editor.setTheme(dark ? "vs-dark" : "vs"),
    dispose: () => {
      ed.getModel()?.dispose();
      ed.dispose();
    },
  };
}

export function languageFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ({ py: "python", pyi: "python", json: "json", md: "markdown", html: "html", js: "javascript", css: "css", txt: "plaintext" } as Record<string, string>)[ext] ?? "plaintext";
}
