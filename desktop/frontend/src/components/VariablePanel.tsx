import { useState } from "react";
import type { FlowGraph, FlowVariable } from "../flow/dsl";
import { addEnvBinding, addFlowVariable, addLocal, addProjectParam, insertGet, insertSet, runPayload, VAR_DRAG, variableRows, type VarDrag } from "../flow/variables";
import { t } from "../strings";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

const TONES = new Set(["any", "bool", "color", "dict", "float", "image", "int", "node", "point", "rect", "string"]);
/** Type names map onto the pin tone tokens so a variable reads the same colour as its wire. */
export function toneOf(type: string): string {
  return TONES.has(type) ? type : "any";
}

export function VariablePanel({ graph, onChange }: { graph: FlowGraph; onChange: (graph: FlowGraph) => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("string");
  const [fallback, setFallback] = useState("");
  const [doc, setDoc] = useState("");
  const [category, setCategory] = useState("");
  const [editable, setEditable] = useState(false);
  const [runs, setRuns] = useState<Record<string, string>>({});
  const [envName, setEnvName] = useState("");
  const [secret, setSecret] = useState(false);
  const [paramName, setParamName] = useState("");
  const [paramType, setParamType] = useState("string");
  const [paramDefault, setParamDefault] = useState("");
  const [scope, setScope] = useState("");
  const [localName, setLocalName] = useState("");
  const [form, setForm] = useState<"" | "var" | "env" | "param" | "local">("");
  const toggle = (next: "var" | "env" | "param" | "local") => setForm((cur) => (cur === next ? "" : next));
  const rows = variableRows(graph);
  const exposed = (graph.variables ?? []).filter((item) => item.editable);
  const scopes = graph.nodes.filter((node) => node.type === "flow.def" || node.type === "flow.macro").map((node) => node.id);
  const addVar = () => {
    const trimmed = name.trim();
    let value: string | number | boolean | null = fallback;
    if (type === "int") value = Number.parseInt(fallback, 10);
    else if (type === "float") value = Number.parseFloat(fallback);
    else if (type === "bool") value = fallback === "true";
    if ((type === "int" || type === "float") && Number.isNaN(value)) return;
    const variable: FlowVariable = { name: trimmed, type, default: value };
    if (doc.trim()) variable.doc = doc.trim();
    if (category.trim()) variable.category = category.trim();
    if (editable) variable.editable = true;
    const next = addFlowVariable(graph, variable);
    if (next === graph) return;
    setName("");
    setFallback("");
    setDoc("");
    setCategory("");
    setEditable(false);
    setForm("");
    onChange(next);
  };
  const addEnv = () => {
    const next = addEnvBinding(graph, { name: envName.trim(), secret });
    if (next === graph) return;
    setEnvName("");
    setSecret(false);
    setForm("");
    onChange(next);
  };
  const typed = (kind: string, raw: string): string | number | boolean | null => {
    if (kind === "int") return Number.parseInt(raw, 10);
    if (kind === "float") return Number.parseFloat(raw);
    if (kind === "bool") return raw === "true";
    return raw;
  };
  const addParam = () => {
    const value = typed(paramType, paramDefault);
    if ((paramType === "int" || paramType === "float") && Number.isNaN(value)) return;
    const next = addProjectParam(graph, { name: paramName.trim(), type: paramType, default: value });
    if (next === graph) return;
    setParamName("");
    setParamDefault("");
    setForm("");
    onChange(next);
  };
  const addScoped = () => {
    const next = addLocal(graph, scope || scopes[0] || "", { name: localName.trim(), type: "int", default: 0 });
    if (next === graph) return;
    setLocalName("");
    setForm("");
    onChange(next);
  };
  return (
    <fieldset className="flow-vars">
      <legend>{t.flow.variables}</legend>
      <ul>
        {rows.map((row) => (
          <li
            key={row.kind + row.name}
            draggable
            title={t.flow.dragVar}
            onDragStart={(event) => {
              const payload: VarDrag = { name: row.name, writable: row.writable };
              event.dataTransfer.setData(VAR_DRAG, JSON.stringify(payload));
              event.dataTransfer.effectAllowed = "copy";
            }}
          >
            <span className="flow-var-kind" data-kind={row.kind}>{t.flow.varKinds[row.kind]}</span>
            <span className="flow-var-main" title={row.doc || undefined}>
              <span className="flow-var-name">
                {row.category ? <span className="flow-var-cat">{row.category} / </span> : null}
                {row.name}
              </span>
              <span className="flow-var-meta">
                <span className="flow-var-type" style={{ color: "var(--tone-" + toneOf(row.type) + ")" }}>{row.type}</span>
                {row.detail ? <span className="flow-var-detail">{row.detail}</span> : null}
              </span>
            </span>
            <span className="flow-var-actions">
              <Button type="button" onClick={() => onChange(insertGet(graph, row.name))} aria-label={t.flow.readVar + " " + row.name}>
                {t.flow.readVar}
              </Button>
              {row.writable ? (
                <Button type="button" onClick={() => onChange(insertSet(graph, row.name))} aria-label={t.flow.writeVar + " " + row.name}>
                  {t.flow.writeVar}
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <div className="flow-switch" role="group" aria-label={t.flow.variables}>
        <Button variant="ghost" type="button" aria-expanded={form === "var"} onClick={() => toggle("var")}>
          {t.flow.newVar}
        </Button>
        <Button variant="ghost" type="button" aria-expanded={form === "env"} onClick={() => toggle("env")}>
          {t.flow.newEnv}
        </Button>
        <Button variant="ghost" type="button" aria-expanded={form === "param"} onClick={() => toggle("param")}>
          {t.flow.newParam}
        </Button>
        {scopes.length ? (
          <Button variant="ghost" type="button" aria-expanded={form === "local"} onClick={() => toggle("local")}>
            {t.flow.newLocal}
          </Button>
        ) : null}
      </div>
      {form === "var" ? (
      <div className="flow-block">
        <div className="flow-fields">
          <label className="wide">
            {t.flow.varName}
            <Input aria-label={t.flow.varName} value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            {t.flow.varType}
            <Select aria-label={t.flow.varType} value={type} onChange={(event) => setType(event.target.value)}>
              <option value="string">string</option>
              <option value="int">int</option>
              <option value="float">float</option>
              <option value="bool">bool</option>
            </Select>
          </label>
          <label>
            {t.flow.varDefault}
            <Input aria-label={t.flow.varDefault} value={fallback} onChange={(event) => setFallback(event.target.value)} />
          </label>
          <label className="wide">
            {t.flow.varDoc}
            <Input aria-label={t.flow.varDoc} value={doc} onChange={(event) => setDoc(event.target.value)} />
          </label>
          <label className="wide">
            {t.flow.varCategory}
            <Input aria-label={t.flow.varCategory} value={category} onChange={(event) => setCategory(event.target.value)} />
          </label>
        </div>
        <label className="flow-check">
          <input type="checkbox" checked={editable} onChange={(event) => setEditable(event.target.checked)} />
          {t.flow.instanceEditable}
        </label>
        <Button variant="primary" type="button" onClick={addVar}>
          {t.flow.addVar}
        </Button>
      </div>
      ) : null}
      {exposed.length ? (
        <fieldset aria-label={t.flow.runArgs}>
          <legend>{t.flow.runArgs}</legend>
          {exposed.map((item) => (
            <label key={item.name}>
              {item.name}
              <Input
                aria-label={t.flow.runArg + " " + item.name}
                value={runs[item.name] ?? (item.default === null || item.default === undefined ? "" : String(item.default))}
                onChange={(event) => setRuns({ ...runs, [item.name]: event.target.value })}
              />
            </label>
          ))}
          <pre aria-label={t.flow.runPayload}>{JSON.stringify(runPayload(graph, runs))}</pre>
        </fieldset>
      ) : null}
      {form === "env" ? (
      <div className="flow-block">
        <label className="wide">
          {t.flow.envName}
          <Input aria-label={t.flow.envName} value={envName} onChange={(event) => setEnvName(event.target.value)} />
        </label>
        <label className="flow-check">
          <input type="checkbox" checked={secret} onChange={(event) => setSecret(event.target.checked)} />
          {t.flow.secret}
        </label>
        <Button variant="primary" type="button" onClick={addEnv}>
          {t.flow.addEnv}
        </Button>
      </div>
      ) : null}
      {form === "param" ? (
      <div className="flow-block">
        <div className="flow-fields">
          <label className="wide">
            {t.flow.paramName}
            <Input aria-label={t.flow.paramName} value={paramName} onChange={(event) => setParamName(event.target.value)} />
          </label>
          <label>
            {t.flow.paramType}
            <Select aria-label={t.flow.paramType} value={paramType} onChange={(event) => setParamType(event.target.value)}>
              <option value="string">string</option>
              <option value="int">int</option>
              <option value="float">float</option>
              <option value="bool">bool</option>
            </Select>
          </label>
          <label>
            {t.flow.paramDefault}
            <Input aria-label={t.flow.paramDefault} value={paramDefault} onChange={(event) => setParamDefault(event.target.value)} />
          </label>
        </div>
        <Button variant="primary" type="button" onClick={addParam}>
          {t.flow.addParam}
        </Button>
      </div>
      ) : null}
      {form === "local" && scopes.length ? (
        <div className="flow-block">
          <label>
            {t.flow.localScope}
            <Select aria-label={t.flow.localScope} value={scope || scopes[0]} onChange={(event) => setScope(event.target.value)}>
              {scopes.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </Select>
          </label>
          <label>
            {t.flow.localName}
            <Input aria-label={t.flow.localName} value={localName} onChange={(event) => setLocalName(event.target.value)} />
          </label>
          <Button variant="primary" type="button" onClick={addScoped}>
            {t.flow.addLocal}
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
