import { useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "./dialog";
import { Button } from "./button";

/** Fit a thumbnail in its parent; open the same source at native pixels without another download. */
export function ImagePreview({ ready, viewLabel, fitLabel, closeLabel, ...props }: ComponentProps<"img"> & {
  ready: boolean; viewLabel: string; fitLabel: string; closeLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [fit, setFit] = useState(false);
  const restoreFocus = useRef(true);
  return <>
    <button type="button" className="ui-image-preview" aria-label={viewLabel} title={viewLabel} aria-haspopup="dialog" disabled={!ready}
      onClick={() => { setFit(false); setOpen(true); }}><img {...props} /></button>
    {open && createPortal(<Dialog title={viewLabel} closeLabel={closeLabel} onClose={() => setOpen(false)} restoreFocus={restoreFocus}
      ownsKeys size="wide" className="image-viewer max-w-[calc(100vw-2rem)]">
      <div className="ui-image-tools"><Button size="sm" aria-pressed={!fit} onClick={() => setFit(false)}>100%</Button>
        <Button size="sm" aria-pressed={fit} onClick={() => setFit(true)}>{fitLabel}</Button></div>
      <div className={`ui-image-viewport${fit ? " is-fit" : ""}`}><img src={props.src} alt={props.alt} /></div>
    </Dialog>, document.body)}
  </>;
}
