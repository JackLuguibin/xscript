import { useId, type ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Section heading shared by inventory, connection panels and settings. */
export function SectionHeader({ title, titleId, level = 2, count, actions }: {
  title: ReactNode; titleId?: string; level?: 2 | 3; count?: number; actions?: ReactNode;
}) {
  const Heading = level === 3 ? "h3" : "h2";
  return <div className="section-head ui-section-header">
    <Heading id={titleId}>{title}</Heading>
    {count !== undefined && <span className="count">{count}</span>}
    {actions && <div className="ui-section-actions">{actions}</div>}
  </div>;
}

export function Panel({ title, titleId, level, actions, children, className }: {
  title: ReactNode; titleId?: string; level?: 2 | 3; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  const autoId = useId();
  const id = titleId ?? autoId;
  return <section className={cn("ui-panel", className)} aria-labelledby={id}>
    <SectionHeader title={title} titleId={id} level={level} actions={actions} />
    {children}
  </section>;
}
