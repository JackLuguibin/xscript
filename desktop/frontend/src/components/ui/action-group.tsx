import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Compact inline actions with consistent spacing and separators for table cells. */
export function ActionGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <div role="group" aria-label={label} className={cn("ui-action-group", className)}>{children}</div>;
}
