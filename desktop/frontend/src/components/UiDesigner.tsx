import { useEffect, useRef } from "react";
import { getLanguage, t } from "../strings";
import { uiDesigner, type DesignerHandle } from "../ui-designer";
import { uiForm } from "../ui-form";

/** The shared form designer (palette, field list, properties, sandboxed preview) editing a `.ui.json` file's text.
 * The text stays the source of truth: every designer edit becomes new text (onChange), and new text is fed back in. */
export function UiDesigner({ text, onChange }: { text: string; onChange: (text: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const handle = useRef<DesignerHandle | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (!box.current) return;
    handle.current = uiDesigner.mount(box.current, {
      lang: getLanguage(),
      form: uiForm,
      post: (m) => {
        if (m.type !== "edit") return;
        const next = uiForm.serializeSpec(m.spec);
        last.current = next;
        change.current(next);
        handle.current?.receive(uiDesigner.messageFor(next, uiForm));
      },
    });
    return () => {
      handle.current = null;
      box.current?.replaceChildren();
    };
  }, []);

  useEffect(() => {
    if (text === last.current) return; // our own edit, already shown
    last.current = text;
    handle.current?.receive(uiDesigner.messageFor(text, uiForm, t.projects.uiDesignerFixInText));
  }, [text]);

  return <div ref={box} className="ui-designer" aria-label={t.projects.uiDesigner} />;
}
