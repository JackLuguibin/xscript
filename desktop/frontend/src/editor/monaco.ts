// Monaco adapter (loaded lazily by CodeEditor; never in jsdom tests, which use the textarea fallback).
import * as monaco from "./monaco-lean";
import EditorWorker from "monaco-esm/editor/editor.worker.js?worker";
import stubs from "../generated/stub-completions.json";
import { complete, StubIndex, type ItemKind, type StubData } from "./completions";
import { builtinSpecs } from "../flow/specs";
import { mapOffset, textEdit } from "../flow/history";
import { parse } from "../flow/dsl";
import { completeXflow, definitionOf, hoverXflow, outputRefs, pinTypes, wantedPinType, xflowContext, XFLOW_KEYWORDS } from "../flow/xflow-language";

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

function tokenAt(line: string, column: number): string {
  const index = column - 1;
  const re = /[A-Za-z_][A-Za-z0-9_.]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    if (match.index <= index && re.lastIndex >= index) return match[0];
  }
  return "";
}

function parsedFlow(text: string) {
  try {
    return parse(text);
  } catch {
    return null;
  }
}

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
  registerXflow();
}

function registerXflow(): void {
  monaco.languages.register({ id: "xflow" });
  const specs = [...builtinSpecs().values()];
  const aliases = specs.map((spec) => spec.dsl.alias);
  monaco.languages.setMonarchTokensProvider("xflow", {
    keywords: [...XFLOW_KEYWORDS],
    aliases,
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/'[^']*'/, "string"],
        [/-?\d+(?:\.\d+)?/, "number"],
        [/[A-Za-z_][\w]*\.[A-Za-z_][\w]*/, "variable"],
        [/[A-Za-z_][\w]*/, { cases: { "@keywords": "keyword", "@aliases": "type", "@default": "identifier" } }],
      ],
    },
  });
  monaco.languages.registerCompletionItemProvider("xflow", {
    triggerCharacters: [" ", "."],
    provideCompletionItems(model, position) {
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const prefix = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(before)?.[0] ?? "";
      const ids = [...model.getValue().matchAll(/\b([A-Za-z_][A-Za-z0-9_]*):/g)].map((item) => item[1]);
      const graph = parsedFlow(model.getValue());
      const specMap = builtinSpecs();
      const start = position.column - prefix.length;
      return {
        suggestions: completeXflow(prefix, aliases, ids, {
          pins: specs.flatMap((spec) => spec.inputs.map((pin) => pin.name)),
          refs: graph ? outputRefs(graph, specMap) : [],
          want: wantedPinType(before, specs),
        }).map((label) => ({
          label,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: label,
          range: new monaco.Range(position.lineNumber, start, position.lineNumber, position.column),
        })),
      };
    },
  });
  monaco.languages.registerHoverProvider("xflow", {
    provideHover(model, position) {
      const token = tokenAt(model.getLineContent(position.lineNumber), position.column);
      if (!token) return null;
      const graph = parsedFlow(model.getValue());
      const text = hoverXflow(token, specs, {
        runs: xflowContext.runs,
        pins: graph ? pinTypes(graph, builtinSpecs()) : undefined,
      });
      if (!text) return null;
      return { contents: [{ value: text }] };
    },
  });
  monaco.languages.registerDefinitionProvider("xflow", {
    provideDefinition(model, position) {
      const token = tokenAt(model.getLineContent(position.lineNumber), position.column);
      const ids = [...model.getValue().matchAll(/\b([A-Za-z_][A-Za-z0-9_]*):/g)].map((item) => item[1] ?? "");
      const id = definitionOf(token, ids);
      if (!id) return null;
      xflowContext.locate(id);
      const found = new RegExp("\\b" + id + ":").exec(model.getValue());
      if (!found || found.index === undefined) return null;
      const pos = model.getPositionAt(found.index);
      return { uri: model.uri, range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column + id.length) };
    },
  });
}

export interface EditorHandle {
  getValue(): string;
  setValue(v: string): void;
  setTheme(dark: boolean): void;
  /** gutter breakpoint dots (1-based lines) */
  setBreakpoints(lines: number[]): void;
  /** the paused line (highlighted and revealed), or null */
  setCurrentLine(line: number | null): void;
  dispose(): void;
}

export function createEditor(
  el: HTMLElement,
  opts: { value: string; language: string; dark: boolean; label: string; onChange: (v: string) => void; onKey: (e: KeyboardEvent) => void;
    breakpoints?: number[]; currentLine?: number | null; onToggleBreakpoint?: (line: number) => void; toggleLabel?: string },
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
    glyphMargin: true,
  });
  const bpDeco = ed.createDecorationsCollection();
  const lineDeco = ed.createDecorationsCollection();
  const setBreakpoints = (lines: number[]) =>
    bpDeco.set(lines.map((ln) => ({ range: new monaco.Range(ln, 1, ln, 1), options: { glyphMarginClassName: "bp-glyph", glyphMarginHoverMessage: { value: `breakpoint ${ln}` }, stickiness: 1 } })));
  const setCurrentLine = (line: number | null) => {
    lineDeco.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: "dbg-current-line", glyphMarginClassName: "dbg-current-glyph" } }] : []);
    if (line) ed.revealLineInCenterIfOutsideViewport(line);
  };
  setBreakpoints(opts.breakpoints ?? []);
  setCurrentLine(opts.currentLine ?? null);
  ed.onMouseDown((e) => {
    const T = monaco.editor.MouseTargetType;
    if ((e.target.type === T.GUTTER_GLYPH_MARGIN || e.target.type === T.GUTTER_LINE_NUMBERS) && e.target.position) {
      opts.onToggleBreakpoint?.(e.target.position.lineNumber);
    }
  });
  ed.addAction({
    id: "xscript.toggleBreakpoint",
    label: opts.toggleLabel ?? "Toggle breakpoint",
    keybindings: [monaco.KeyCode.F9],
    run: (e) => {
      const pos = e.getPosition();
      if (pos) opts.onToggleBreakpoint?.(pos.lineNumber);
    },
  });
  let silent = false;
  ed.onDidChangeModelContent(() => {
    if (!silent) opts.onChange(ed.getValue());
  });
  ed.onKeyDown((e) => opts.onKey(e.browserEvent));
  return {
    getValue: () => ed.getValue(),
    setValue: (v) => {
      const model = ed.getModel();
      if (!model) return;
      const edit = textEdit(model.getValue(), v);
      if (!edit) return;
      silent = true;
      const start = model.getPositionAt(edit.start);
      const end = model.getPositionAt(edit.end);
      const caret = ed.getPosition();
      const caretOffset = caret ? model.getOffsetAt(caret) : 0;
      ed.executeEdits("xflow", [
        {
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          text: edit.text,
        },
      ]);
      const next = model.getPositionAt(Math.min(mapOffset(caretOffset, edit), model.getValue().length));
      ed.setPosition(next);
      silent = false;
    },
    setTheme: (dark) => monaco.editor.setTheme(dark ? "vs-dark" : "vs"),
    setBreakpoints,
    setCurrentLine,
    dispose: () => {
      ed.getModel()?.dispose();
      ed.dispose();
    },
  };
}

export function languageFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ({ py: "python", pyi: "python", xflow: "xflow", json: "json", md: "markdown", html: "html", js: "javascript", css: "css", txt: "plaintext" } as Record<string, string>)[ext] ?? "plaintext";
}
