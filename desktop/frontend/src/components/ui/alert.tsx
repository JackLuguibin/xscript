import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** Page-level notice. Keeps the `banner` class so the workspace layout and forced-colors rules still match. */
export function Alert({ tone = "warn", className, ...props }: HTMLAttributes<HTMLDivElement> & { tone?: "warn" | "error" }) {
  return (
    <div
      className={cn(
        "banner flex items-start gap-sp-2 rounded-md border px-sp-3 py-sp-2",
        tone === "warn" && "warn border-[color-mix(in_srgb,var(--warning-fg)_25%,transparent)] bg-warning-bg text-warning-fg",
        tone === "error" && "error border-[color-mix(in_srgb,var(--danger-fg)_25%,transparent)] bg-danger-bg text-danger-fg",
        className,
      )}
      {...props}
    />
  );
}
