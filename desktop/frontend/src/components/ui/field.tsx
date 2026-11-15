import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Label wraps its control, preserving native click-to-focus behavior. */
export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return <label className={cn("ui-field stack", className)}>
    <span className="ui-field-label">{label}</span>
    {children}
    {hint && <span className="hint">{hint}</span>}
  </label>;
}

export function FormActions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("ui-form-actions", className)}>{children}</div>;
}
