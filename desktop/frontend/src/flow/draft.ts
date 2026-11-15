// The flow being edited outlives the flow page: switching pages unmounts it, and coming back restores
// the text and layout from here (in memory, for this window only).
import type { FlowLayout } from "./layout";

export interface FlowDraft {
  /** What the text editor showed, possibly mid-edit (the text→canvas sync is debounced). */
  text: string;
  /** The last text that parsed, used when `text` does not. */
  valid: string;
  layout: FlowLayout;
}

let draft: FlowDraft | null = null;
const KEY = "xscript.flow.draft.v1";

export function keepDraft(next: FlowDraft): void {
  draft = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage may be full */ }
}

export function readDraft(): FlowDraft | null {
  if (draft) return draft;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && typeof saved.text === "string" && typeof saved.valid === "string" && saved.layout?.xflowLayout === 1) draft = saved;
  } catch { /* corrupted drafts do not prevent opening the editor */ }
  return draft;
}

export function clearDraft(): void {
  draft = null;
  try { localStorage.removeItem(KEY); } catch { /* storage disabled */ }
}
