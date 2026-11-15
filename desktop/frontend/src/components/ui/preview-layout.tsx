import type { ReactNode } from "react";

/** Media-first detail layout: a prominent preview and a compact inspector alongside it. */
export function PreviewLayout({ preview, children }: { preview?: ReactNode; children: ReactNode }) {
  return <div className={`ui-preview-layout${preview ? "" : " without-preview"}`}>
    {preview && <div className="ui-preview-stage">{preview}</div>}
    <div className="ui-preview-inspector">{children}</div>
  </div>;
}
