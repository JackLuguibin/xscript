import type { ReactNode } from "react";

/** Empty / error placeholder: icon + title + explanation + optional actions. `tone="error"` for failures the user can act on. */
export function EmptyState({ icon, title, children, actions, tone = "info", role }: { icon: ReactNode; title: string; children?: ReactNode; actions?: ReactNode; tone?: "info" | "error"; role?: "status" | "alert" }) {
  return (
    <div className={`empty ${tone === "error" ? "error" : ""}`} role={role}>
      <div className="art">{icon}</div>
      <p className="title">{title}</p>
      {children && <p className="desc">{children}</p>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
