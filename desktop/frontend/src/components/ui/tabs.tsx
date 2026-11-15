import { useId, useRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";

/** Controlled tabs with automatic activation and one tab stop in the tab list. */
export function Tabs<T extends string>({ label, value, onValueChange, items, children, className, panelClassName }: {
  label: string; value: T; onValueChange: (value: T) => void;
  items: { value: T; label: string; disabled?: boolean }[]; children: ReactNode; className?: string; panelClassName?: string;
}) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const enabled = items.filter((item) => !item.disabled);
  return <div className={cn("ui-tabs", className)}>
    <div ref={list} className="ui-tab-list" role="tablist" aria-label={label} onKeyDown={(event) => {
      const index = enabled.findIndex((item) => item.value === value);
      let next: number;
      if (event.key === "ArrowRight") next = (index + 1) % enabled.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + enabled.length) % enabled.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = enabled.length - 1;
      else return;
      if (!enabled.length) return;
      event.preventDefault();
      const item = enabled[next];
      onValueChange(item.value);
      list.current?.querySelector<HTMLElement>(`[id="${id}-tab-${items.findIndex((entry) => entry.value === item.value)}"]`)?.focus();
    }}>
      {items.map((item, index) => <Button key={item.value} id={`${id}-tab-${index}`} role="tab" size="sm"
        disabled={item.disabled} aria-selected={value === item.value} aria-controls={`${id}-panel`}
        tabIndex={value === item.value ? 0 : -1} variant={value === item.value ? "primary" : "ghost"}
        onClick={() => onValueChange(item.value)}>{item.label}</Button>)}
    </div>
    <div className={cn("ui-tab-panel", panelClassName)} role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${items.findIndex((item) => item.value === value)}`} tabIndex={0}>
      {children}
    </div>
  </div>;
}
