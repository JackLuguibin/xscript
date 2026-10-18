import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "min-h-9 w-full rounded-sm border border-line-strong bg-surface px-sp-3 py-sp-1 text-fg transition-[border-color,box-shadow] duration-fast ease-snap placeholder:text-muted hover:border-primary",
        className,
      )}
      {...props}
    />
  );
}
