import type { SelectHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** Native select styled like Input. Keeps the combobox role and keyboard behavior. */
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn("ui-select", className)} {...props} />;
}
