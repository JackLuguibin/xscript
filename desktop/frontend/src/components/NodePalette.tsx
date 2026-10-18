import { useMemo, useRef, useState } from "react";
import { paletteTree, userFunctions, NODE_DRAG, type PaletteDrag, type UserTemplate } from "../flow/palette";
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
  return (
    <section className="flow-palette" aria-label={t.flow.palette}>
      <Input aria-label={t.flow.paletteSearch} value={query} placeholder={t.flow.paletteSearch} onChange={(event) => setQuery(event.target.value)} />
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
                          <span aria-hidden="true"> {group.specs.length}</span>
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
