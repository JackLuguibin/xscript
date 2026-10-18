import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

const badgeVariants = cva(
  "badge inline-flex min-h-5 items-center gap-sp-1 rounded-pill px-sp-2 align-middle text-xs font-semibold leading-5",
  {
    variants: {
      tone: {
        neutral: "bg-neutral-bg text-neutral-fg",
        ok: "ok bg-success-bg text-success-fg",
        bad: "bad bg-danger-bg text-danger-fg",
        warn: "warn bg-warning-bg text-warning-fg",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

/** Status pill: colour is never the only signal — there is always the text, and the dot is decorative. */
export function Badge({
  tone = "neutral",
  busy = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; busy?: boolean; children: ReactNode }) {
  return (
    <span className={cn(badgeVariants({ tone }), busy && "busy", className)} {...props}>
      <span
        className={cn(
          "dot size-2 shrink-0 rounded-full bg-current",
          tone === "ok" && "bg-success-dot",
          tone === "bad" && "bg-danger-dot",
          busy && "animate-badge-pulse",
        )}
        aria-hidden="true"
      />
      {children}
    </span>
  );
}
