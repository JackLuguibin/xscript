import type { SelectHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** Native select styled like Input. Keeps the combobox role and keyboard behavior. */
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn("ui-select min-h-9 w-full rounded-sm border border-line-strong bg-surface px-sp-3 py-sp-1 pr-8 text-fg transition-[border-color,box-shadow] duration-fast ease-snap hover:border-primary", className)} {...props} />;
}
