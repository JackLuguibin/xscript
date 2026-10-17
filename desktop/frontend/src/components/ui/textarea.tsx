import type { TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-24 w-full rounded-sm border border-line-strong bg-surface px-sp-3 py-sp-2 text-fg transition-[border-color,box-shadow] duration-fast ease-snap placeholder:text-muted hover:border-primary",
        className,
      )}
      {...props}
    />
  );
}
