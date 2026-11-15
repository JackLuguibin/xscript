import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Shared page context with wrapping actions for narrow desktop windows. */
export function PageHeader({ title, description, eyebrow, actions, className }: {
  title: string; description?: string; eyebrow?: string; actions?: ReactNode; className?: string;
}) {
  return <header className={cn("topbar ui-page-header", className)}>
    <div className="page-heading">
      {eyebrow && <span className="workspace-caption">{eyebrow}</span>}
      <h1>{title}</h1>
      {description && <p className="sub">{description}</p>}
    </div>
    {actions && <div className="topbar-tools">{actions}</div>}
  </header>;
}
