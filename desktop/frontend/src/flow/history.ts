import type { FlowGraph } from "./dsl";
import type { FlowLayout } from "./layout";

/** One committed editor state. The canvas and the text tab share these. */
export interface EditorSnapshot {
  graph: FlowGraph;
  text: string;
  layout: FlowLayout;
}

export interface UndoStack {
  past: EditorSnapshot[];
  future: EditorSnapshot[];
  /** Set after the cap drops an entry, so the status hint is shown only once. */
  noticedDrop: boolean;
}

export const UNDO_CAP = 200;

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export function emptyUndo(): UndoStack {
  return { past: [], future: [], noticedDrop: false };
}

/** Remember `before`. A new edit clears the redo list. Past the cap, the oldest entry is dropped. */
export function pushUndo(stack: UndoStack, before: EditorSnapshot): { stack: UndoStack; dropped: boolean } {
  const past = stack.past.length >= UNDO_CAP ? stack.past.slice(stack.past.length - UNDO_CAP + 1) : stack.past.slice();
  past.push(before);
  const dropped = stack.past.length >= UNDO_CAP && !stack.noticedDrop;
  return { stack: { past, future: [], noticedDrop: stack.noticedDrop || dropped }, dropped };
}

export function undoEdit(stack: UndoStack, current: EditorSnapshot): { stack: UndoStack; snapshot: EditorSnapshot } | null {
  const snapshot = stack.past[stack.past.length - 1];
  if (!snapshot) return null;
  return {
    stack: { ...stack, past: stack.past.slice(0, -1), future: [...stack.future, current] },
    snapshot,
  };
}

export function redoEdit(stack: UndoStack, current: EditorSnapshot): { stack: UndoStack; snapshot: EditorSnapshot } | null {
  const snapshot = stack.future[stack.future.length - 1];
  if (!snapshot) return null;
  return {
    stack: { ...stack, past: [...stack.past, current], future: stack.future.slice(0, -1) },
    snapshot,
  };
}

/** One middle replacement, so an editor can keep a caret that sits outside the change. */
export function textEdit(current: string, next: string): TextEdit | null {
  if (current === next) return null;
  let start = 0;
  const min = Math.min(current.length, next.length);
  while (start < min && current.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  let end = current.length;
  let nextEnd = next.length;
  while (end > start && nextEnd > start && current.charCodeAt(end - 1) === next.charCodeAt(nextEnd - 1)) {
    end -= 1;
    nextEnd -= 1;
  }
  return { start, end, text: next.slice(start, nextEnd) };
}

/** Where a caret moves after `textEdit`. A caret inside the edit lands at the end of the insertion. */
export function mapOffset(offset: number, edit: TextEdit): number {
  if (offset <= edit.start) return offset;
  if (offset >= edit.end) return offset - (edit.end - edit.start) + edit.text.length;
  return edit.start + edit.text.length;
}
