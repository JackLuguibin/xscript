// Hand-off from other pages to the flow canvas (design §11.1: "drop a control onto the canvas").
// The screen page queues a picked control; the shell switches to the flow page, which takes the queue.
import type { UiNode } from "../ui-tree";

export type CanvasPick = Pick<UiNode, "id" | "text" | "desc" | "type" | "path" | "clickable">;

let pending: CanvasPick[] = [];
const listeners = new Set<() => void>();

export function sendToCanvas(pick: CanvasPick): void {
  const { id, text, desc, type, path, clickable } = pick;
  pending.push({ id, text, desc, type, path, clickable });
  for (const listener of [...listeners]) listener();
}

/** Everything queued so far, oldest first; the queue is emptied. */
export function takeCanvasPicks(): CanvasPick[] {
  const out = pending;
  pending = [];
  return out;
}

export function onCanvasPick(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only. */
export function resetCanvasInbox(): void {
  pending = [];
  listeners.clear();
}
