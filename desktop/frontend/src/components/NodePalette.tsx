import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { paletteStep, paletteTree, userFunctions, NODE_DRAG, type PaletteDrag, type UserTemplate } from "../flow/palette";
import { searchNodes, type MenuSpec } from "../flow/search";
import type { FlowGraph } from "../flow/dsl";
import { t } from "../strings";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function categoryName(id: string): string {
  return id in t.flow.categories ? t.flow.categories[id as keyof typeof t.flow.categories] : id;
}

function familyName(id: string): string {
  return id in t.flow.families ? t.flow.families[id as keyof typeof t.flow.families] : id;
}

function Leaf({ label, drag, hint, onPick }: { label: string; drag: PaletteDrag; hint?: string; onPick: (drag: PaletteDrag) => void }) {
  const dragged = useRef(false);
  return (
    <button
      type="button"
      className="flow-leaf"
      draggable
      title={hint ?? t.flow.dragNode}
      onDragStart={(event) => {
        event.dataTransfer.setData(NODE_DRAG, JSON.stringify(drag));
        event.dataTransfer.effectAllowed = "copy";
      }}
      onDragEnd={() => {
        dragged.current = true;
      }}
      onClick={() => {
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        onPick(drag);
      }}
    >
      <span>{label}</span>
      {hint ? <span className="flow-leaf-meta" aria-hidden="true">{hint}</span> : null}
    </button>
  );
}

/** Rows the arrow keys walk through, in document order: group toggles and node leaves (not the "mine" form). */
const ROWS = ".flow-family, .flow-cat, .flow-leaves .flow-leaf";

export function NodePalette({
  specs,
  recent,
  graph,
  templates,
  onCreateFunction,
  onCreateNode,
  onPick,
}: {
  specs: readonly MenuSpec[];
  recent: readonly string[];
  graph: FlowGraph;
  templates: readonly UserTemplate[];
  onCreateFunction: (name: string) => void;
  onCreateNode: (name: string) => void;
  onPick: (drag: PaletteDrag) => void;
}) {
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [openFamilies, setOpenFamilies] = useState<string[]>(["flow"]);
  const [openCats, setOpenCats] = useState<string[]>([]);
  const tree = useMemo(() => paletteTree(specs, recent), [specs, recent]);
  const hits = query.trim() ? searchNodes(query, specs, recent).slice(0, 40) : [];
  const functions = userFunctions(graph);
  const toggle = (list: string[], id: string, set: (next: string[]) => void) => {
    set(list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
  };
  const submit = (kind: "function" | "node") => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (kind === "function") onCreateFunction(trimmed);
    else onCreateNode(trimmed);
    setName("");
  };
  const root = useRef<HTMLElement | null>(null);
  const rows = () => [...(root.current?.querySelectorAll<HTMLButtonElement>(ROWS) ?? [])];
  // Tree-view keys (WAI-ARIA): ↑/↓/Home/End move, → opens a folded group, ← folds an open one or goes to its group.
  const onRowKey = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (!target.matches?.(ROWS)) return;
    const list = rows();
    const index = list.indexOf(target as HTMLButtonElement);
    const twist = target.classList.contains("flow-twist");
    const open = target.getAttribute("aria-expanded") === "true";
    let next: HTMLElement | undefined;
    if (event.key === "ArrowRight" && twist) {
      if (!open) target.click();
      else next = list[index + 1];
    } else if (event.key === "ArrowLeft") {
      if (twist && open) target.click();
      else next = list.slice(0, index).reverse().find((row) => row.classList.contains("flow-twist") && row.getAttribute("aria-expanded") === "true" && (!target.classList.contains("flow-cat") || row.classList.contains("flow-family")));
    } else {
      const step = paletteStep(event.key, index, list.length);
      if (step === null) return;
      next = list[step];
    }
    event.preventDefault();
    next?.focus();
  };
  return (
    <section className="flow-palette" aria-label={t.flow.palette} ref={root} onKeyDown={onRowKey}>
      <Input
        aria-label={t.flow.paletteSearch}
        value={query}
        placeholder={t.flow.paletteSearch}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.preventDefault();
            event.stopPropagation();
            setQuery("");
          } else if (event.key === "Enter" && hits[0]) {
            event.preventDefault();
            onPick({ kind: "spec", type: hits[0].type });
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            rows()[0]?.focus();
          }
        }}
      />
      <div className="flow-mine">
        <p className="flow-kicker">{t.flow.mine}</p>
        {functions.length ? (
          <div className="flow-leaves" aria-label={t.flow.myFunctions}>
            {functions.map((item) => (
              <Leaf key={item.id} label={item.id} drag={{ kind: "call", type: item.id }} onPick={onPick} />
            ))}
          </div>
        ) : null}
        {templates.length ? (
          <div className="flow-leaves" aria-label={t.flow.myNodes}>
            {templates.map((item) => (
              <Leaf key={item.name} label={item.title} drag={{ kind: "custom", type: item.name, title: item.title }} onPick={onPick} />
            ))}
          </div>
        ) : null}
        <label className="flow-custom">
          {t.flow.customName}
          <Input aria-label={t.flow.customName} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="flow-switch">
          <Button variant="ghost" type="button" onClick={() => submit("function")}>
            {t.flow.newFunction}
          </Button>
          <Button variant="ghost" type="button" onClick={() => submit("node")}>
            {t.flow.newNode}
          </Button>
        </div>
      </div>
      {query.trim() ? (
        <div className="flow-leaves">
          {hits.map((spec) => (
            <Leaf key={spec.type} label={spec.title} drag={{ kind: "spec", type: spec.type }} hint={categoryName(spec.category)} onPick={onPick} />
          ))}
        </div>
      ) : (
        <>
        {!query.trim() && tree.recent.length ? (
          <div className="flow-leaves" aria-label={t.flow.recentNodes}>
            {tree.recent.map((spec) => (
              <Leaf key={"recent-" + spec.type} label={spec.title} drag={{ kind: "spec", type: spec.type }} hint={categoryName(spec.category)} onPick={onPick} />
            ))}
          </div>
        ) : null}
        {tree.families.map((family) => {
          const open = openFamilies.includes(family.id);
          const label = familyName(family.id);
          return (
            <section key={family.id}>
              <button type="button" className="flow-family flow-twist" aria-expanded={open} aria-label={t.flow.palette + " " + label} onClick={() => toggle(openFamilies, family.id, setOpenFamilies)}>
                {label}
              </button>
              {open
                ? family.groups.map((group) => {
                    const cat = family.id + "/" + group.category;
                    const shown = openCats.includes(cat);
                    const catLabel = categoryName(group.category);
                    return (
                      <div key={group.category} className="flow-branch">
                        <button type="button" className="flow-cat flow-twist" aria-expanded={shown} aria-label={t.flow.category + " " + catLabel} onClick={() => toggle(openCats, cat, setOpenCats)}>
                          {catLabel}
                          <span className="flow-cat-count" aria-hidden="true">{group.specs.length}</span>
                        </button>
                        {shown ? (
                          <div className="flow-leaves">
                            {group.specs.map((spec) => (
                              <Leaf key={spec.type} label={spec.title} drag={{ kind: "spec", type: spec.type }} onPick={onPick} />
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                : null}
            </section>
          );
        })}
        </>
      )}
    </section>
  );
}
