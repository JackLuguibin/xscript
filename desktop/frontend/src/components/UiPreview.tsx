import { useMemo } from "react";
import { t } from "../strings";
import { uiForm } from "../ui-form";

/** `res/ui/<name>.ui.json` → what ui.Window will show, read-only. The page comes from a project file, so it goes into a
 * sandboxed iframe with no permissions at all (no scripts, opaque origin) and never into this page's DOM. */
export function UiPreview({ text }: { text: string }) {
  const r = useMemo(() => {
    try {
      const spec = uiForm.parseSpec(text);
      return { html: uiForm.renderHtml(spec), problems: uiForm.validateSpec(spec), error: "" };
    } catch (e) {
      return { html: "", problems: [] as string[], error: (e as Error).message };
    }
  }, [text]);
  return (
    <section className="ui-preview" aria-label={t.projects.uiPreview} style={{ marginTop: "var(--sp-3)" }}>
      <h3 className="sub-head">{t.projects.uiPreview}</h3>
      <p className="muted">{t.projects.uiPreviewNote}</p>
      {r.error ? (
        <p role="alert" className="err">{t.projects.uiPreviewBad(r.error)}</p>
      ) : (
        <>
          {r.problems.length > 0 && (
            <div role="alert">
              <ul aria-label={t.projects.uiProblems} className="err">
                {r.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          <iframe
            title={t.projects.uiPreview}
            sandbox=""
            srcDoc={r.html}
            style={{ width: "100%", height: 360, border: "1px solid var(--border, #ddd)", borderRadius: 8, background: "#fff" }}
          />
        </>
      )}
    </section>
  );
}
