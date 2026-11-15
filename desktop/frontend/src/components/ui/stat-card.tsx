import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";

/** A summary metric can optionally double as a labelled, keyboard-accessible filter. */
export function StatCard({ label, value, tone = "neutral", selected, onClick }: {
  label: string; value: ReactNode; tone?: "neutral" | "success"; selected?: boolean; onClick?: () => void;
}) {
  const body = <><span className="muted">{label}</span>{" "}<strong>{value}</strong></>;
  const className = cn("ui-stat-card", tone === "success" && "is-success");
  return onClick
    ? <Button variant="bare" className={className} aria-pressed={selected} onClick={onClick}>{body}</Button>
    : <div className={className}>{body}</div>;
}
