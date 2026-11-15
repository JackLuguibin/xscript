import type { ComponentProps } from "react";
import { IconSearch } from "../icons";
import { Button } from "./button";
import { Input } from "./input";

/** Search with an accessible name and explicit reset; callers own the query. */
export function SearchField({ label, clearLabel, value, onValueChange, ...props }: Omit<ComponentProps<"input">, "value" | "onChange" | "type"> & {
  label: string; clearLabel: string; value: string; onValueChange: (value: string) => void;
}) {
  return <div className="ui-search-field">
    <IconSearch size={16} />
    <Input {...props} type="search" aria-label={label} value={value} onChange={(e) => onValueChange(e.target.value)} />
    {value && <Button variant="ghost" size="sm" aria-label={clearLabel} onClick={() => onValueChange("")}>{clearLabel}</Button>}
  </div>;
}
