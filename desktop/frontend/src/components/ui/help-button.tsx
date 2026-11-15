import { useRef, useState, type ReactNode } from "react";
import { Button } from "./button";
import { Dialog } from "./dialog";

/** Keep long instructions out of bounded workspaces while leaving them accessible. */
export function HelpButton({ title, closeLabel, children }: { title: string; closeLabel: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const restoreFocus = useRef(true);
  return <><Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog">{title}</Button>
    {open && <Dialog title={title} closeLabel={closeLabel} onClose={() => setOpen(false)} restoreFocus={restoreFocus} ownsKeys>{children}</Dialog>}</>;
}
