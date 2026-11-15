import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

/** Semantic table primitives; sizing and overflow belong to the containing workspace. */
export function Table({ className, ...props }: ComponentProps<"table">) {
  return <table className={cn("ui-table", className)} {...props} />;
}
export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return <th scope="col" className={cn("ui-table-head", className)} {...props} />;
}
export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("ui-table-cell", className)} {...props} />;
}
