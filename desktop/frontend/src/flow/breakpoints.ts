/** Local node breakpoints. They stay on this machine and never enter the flow file. */

export interface FlowBreakpoint {
  node: string;
  enabled: boolean;
}

const KEY = "xscript.flow.breakpoints";

export function readBreakpoints(flow: string, storage: Pick<Storage, "getItem"> = localStorage): FlowBreakpoint[] {
  try {
    const all = JSON.parse(storage.getItem(KEY) || "{}") as Record<string, FlowBreakpoint[]>;
    return (all[flow] ?? []).filter((item) => typeof item?.node === "string" && typeof item.enabled === "boolean");
  } catch {
    return [];
  }
}

export function writeBreakpoints(flow: string, items: readonly FlowBreakpoint[], storage: Pick<Storage, "getItem" | "setItem"> = localStorage): void {
  let all: Record<string, FlowBreakpoint[]> = {};
  try {
    all = JSON.parse(storage.getItem(KEY) || "{}") as Record<string, FlowBreakpoint[]>;
  } catch {
    all = {};
  }
  all[flow] = [...items];
  storage.setItem(KEY, JSON.stringify(all));
}

/** F9: give every selected node an enabled breakpoint. If they all already have one, remove those. */
export function toggleBreakpoints(items: readonly FlowBreakpoint[], ids: readonly string[]): FlowBreakpoint[] {
  const selected = [...new Set(ids)];
  if (!selected.length) return [...items];
  const present = new Set(items.filter((item) => selected.includes(item.node)).map((item) => item.node));
  if (selected.every((id) => present.has(id))) return items.filter((item) => !selected.includes(item.node));
  const next = items.filter((item) => !selected.includes(item.node));
  for (const id of selected) {
    if (!present.has(id)) next.push({ node: id, enabled: true });
  }
  return next;
}

/** Corner click: absent becomes enabled, enabled becomes hollow, hollow becomes enabled again. */
export function cycleBreakpoint(items: readonly FlowBreakpoint[], id: string): FlowBreakpoint[] {
  const current = items.find((item) => item.node === id);
  if (!current) return [...items, { node: id, enabled: true }];
  return items.map((item) => (item.node === id ? { ...item, enabled: !item.enabled } : item));
}
