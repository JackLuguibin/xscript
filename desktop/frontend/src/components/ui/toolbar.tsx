import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** A wrapping action row; uses ordinary tab order so form controls retain native keyboard behavior. */
export function Toolbar({ label, children, actions, className }: { label: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return <div role="group" aria-label={label} className={cn("ui-toolbar", className)}>
    <div className="ui-toolbar-controls">{children}</div>
    {actions && <div className="ui-toolbar-actions">{actions}</div>}
  </div>;
}
