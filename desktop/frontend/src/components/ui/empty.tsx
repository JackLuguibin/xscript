import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Empty / error placeholder: icon + title + explanation + optional actions. `tone="error"` for failures the user can act on. */
export function EmptyState({ icon, title, children, actions, tone = "info", role }: { icon: ReactNode; title: string; children?: ReactNode; actions?: ReactNode; tone?: "info" | "error"; role?: "status" | "alert" }) {
  const error = tone === "error";
  return (
    <div
      className={cn(
        "empty flex flex-col items-center gap-sp-2 rounded-lg border border-dashed border-line-strong bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] px-sp-4 py-sp-6 text-center",
        error && "error",
      )}
      role={role}
    >
      <div className={cn("art mb-sp-1 grid size-14 place-items-center rounded-full bg-primary-soft text-primary", error && "bg-danger-bg text-danger-fg")}>{icon}</div>
      <p className="title text-lg font-[650]">{title}</p>
      {children && <p className="desc max-w-[34rem] text-muted">{children}</p>}
      {actions && <div className="actions mt-sp-2 flex gap-sp-2">{actions}</div>}
    </div>
  );
}
