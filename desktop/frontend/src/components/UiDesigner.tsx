import { useEffect, useRef, useState } from "react";
import { getLanguage, t } from "../strings";
import { uiDesigner, type DesignerHandle } from "../ui-designer";
import { uiForm } from "../ui-form";
import { Button } from "./ui/button";

/** Edits closer together than this (typing in a property field) undo as one step. */
export const UNDO_MERGE_MS = 600;
const HISTORY_LIMIT = 200;

function isTextField(el: EventTarget | null) {
  const e = el as HTMLElement | null;
  return !!e && (e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.tagName === "SELECT" || e.isContentEditable);
}

/** The shared form designer (palette, field list, properties, sandboxed preview) editing a `.ui.json` file's text.
 * The text stays the source of truth: every designer edit becomes new text (onChange), and new text is fed back in.
 * Undo / redo (buttons, Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, Ctrl+Y) step through the designer's edits of this file; inside a
 * property field the keys keep their usual meaning for that field. */
export function UiDesigner({ text, onChange }: { text: string; onChange: (text: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const handle = useRef<DesignerHandle | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const last = useRef<string | null>(null);
  const current = useRef(text);
  current.current = text;
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const lastEditAt = useRef(0);
  const [, rerender] = useState(0);

  const show = (next: string) => {
    last.current = next;
    change.current(next);
    handle.current?.receive(uiDesigner.messageFor(next, uiForm, t.projects.uiDesignerFixInText));
  };

  useEffect(() => {
    if (!box.current) return;
    handle.current = uiDesigner.mount(box.current, {
      lang: getLanguage(),
      form: uiForm,
      post: (m) => {
        if (m.type !== "edit") return;
        const next = uiForm.serializeSpec(m.spec);
        const prev = last.current ?? current.current;
        if (next === prev) return;
        const now = Date.now();
        if (now - lastEditAt.current > UNDO_MERGE_MS || past.current.length === 0) {
          past.current.push(prev);
          if (past.current.length > HISTORY_LIMIT) past.current.shift();
        }
        lastEditAt.current = now;
        future.current = [];
        show(next);
        rerender((n) => n + 1);
      },
    });
    return () => {
      handle.current = null;
      box.current?.replaceChildren();
    };
  }, []);

  useEffect(() => {
    if (text === last.current) return; // our own edit, already shown
    if (last.current !== null) {
      // edited as JSON while the designer was hidden: one undo step, and it ends any redo
      past.current.push(last.current);
      future.current = [];
      lastEditAt.current = 0;
      rerender((n) => n + 1);
    }
    last.current = text;
    handle.current?.receive(uiDesigner.messageFor(text, uiForm, t.projects.uiDesignerFixInText));
  }, [text]);

  const step = (from: React.MutableRefObject<string[]>, to: React.MutableRefObject<string[]>) => {
    const target = from.current.pop();
    if (target === undefined) return;
    to.current.push(last.current ?? current.current);
    lastEditAt.current = 0;
    show(target);
    rerender((n) => n + 1);
  };
  const undo = () => step(past, future);
  const redo = () => step(future, past);

  return (
    <div
      onKeyDown={(e) => {
        if (!(e.metaKey || e.ctrlKey) || isTextField(e.target)) return;
        const k = e.key.toLowerCase();
        if (k === "z" && !e.shiftKey) {
          e.preventDefault();
          undo();
        } else if ((k === "z" && e.shiftKey) || (k === "y" && e.ctrlKey)) {
          e.preventDefault();
          redo();
        }
      }}
    >
      <div className="row" style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-2)" }}>
        <Button size="sm" onClick={undo} disabled={past.current.length === 0} title={t.projects.uiUndoHint}>
          {t.flow.undo}
        </Button>
        <Button size="sm" onClick={redo} disabled={future.current.length === 0} title={t.projects.uiRedoHint}>
          {t.flow.redo}
        </Button>
      </div>
      <div ref={box} className="ui-designer" aria-label={t.projects.uiDesigner} tabIndex={-1} />
    </div>
  );
}
