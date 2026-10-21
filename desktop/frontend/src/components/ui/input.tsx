import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "ui-input",
        className,
      )}
      {...props}
    />
  );
}
