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

export function keepDraft(next: FlowDraft): void {
  draft = next;
}

export function readDraft(): FlowDraft | null {
  return draft;
}

export function clearDraft(): void {
  draft = null;
}
