// Hand-off from other pages to the flow canvas (design §11.1: "drop a control onto the canvas").
// The screen page queues a picked control; the shell switches to the flow page, which takes the queue.
import { selectorChain, selectorWhy, volatileText, type UiNode } from "../ui-tree";

export type CanvasPick = Pick<UiNode, "id" | "text" | "desc" | "type" | "path" | "clickable"> & {
  /** Worked out against the screen's tree when the control is sent (the tree itself is not queued). */
  where?: {
    /** The text alone finds this control: no other node on the screen has the same text. */
    textUnique: boolean;
    /** Selector calls after `Selector()` that find only this control, e.g. `.id('android:id/title').text('Apps')`. */
    chain: string;
    /** Python comment saying why the chain has these calls (see selectorWhy); old queued picks lack it. */
    why?: string;
  };
};

/** Count the nodes of `roots` whose text equals `text`. */
function sameText(roots: UiNode[], text: string): number {
  let n = 0;
  const walk = (node: UiNode) => {
    if ((node.text ?? "") === text) n += 1;
    (node.children ?? []).forEach(walk);
  };
  roots.forEach(walk);
  return n;
}

let pending: CanvasPick[] = [];
const listeners = new Set<() => void>();

/** Queue a control for the flow canvas. `roots` (the screen's tree) lets the canvas pick a selector that finds this
 *  control rather than the first one sharing its text or resource id. */
export function sendToCanvas(pick: CanvasPick, roots?: UiNode[]): void {
  const { id, text, desc, type, path, clickable } = pick;
  const where = roots
    ? { textUnique: !!text && !volatileText(pick) && sameText(roots, text) === 1, chain: selectorChain(pick, "", roots).slice(".Selector()".length), why: selectorWhy(pick, roots) }
    : pick.where;
  pending.push({ id, text, desc, type, path, clickable, ...(where ? { where } : {}) });
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
