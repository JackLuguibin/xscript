import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "../app-context";
import { bpKey, hasBpOptions } from "../api";
import type { BpOptions, BreakpointOptions, Breakpoints, DebugScope, DebugState, DebugStep, DebugVar } from "../api";
import { t } from "../strings";
import { Badge } from "./Badge";
import { Spinner } from "./icons";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

const MAX_OUT = 1000;
const IDLE: DebugState = { id: "", state: "idle", frames: [] };

export interface DebugOutput {
  n: number;
  category: string;
  text: string;
}

/** Follows debug.state / debug.output for one device (the Python DebugSession is the DAP client; see services/debugger.py). */
export function useDebugSession(devId: string) {
  const { rpc, api } = useServices();
  const [state, setState] = useState<DebugState>(IDLE);
  const [output, setOutput] = useState<DebugOutput[]>([]);
  const n = useRef(0);

  useEffect(() => {
    setState(IDLE);
    if (!devId) return;
    let alive = true;
    api.debugStatus(devId).then((s) => alive && setState(s)).catch(() => undefined);
    const offState = rpc.on("debug.state", (d) => {
      const s = d as DebugState;
      if (s.id === devId) setState(s);
    });
    const offOut = rpc.on("debug.output", (d) => {
      const o = d as { id: string; category: string; text: string };
      if (o.id === devId) setOutput((cur) => [...cur, { n: ++n.current, category: o.category, text: o.text }].slice(-MAX_OUT));
    });
    return () => {
      alive = false;
      offState();
      offOut();
    };
  }, [rpc, api, devId]);

  const active = state.state === "starting" || state.state === "running" || state.state === "stopped";
  return { state, setState, output, clearOutput: () => setOutput([]), active };
}

function VarTree({ devId, vars, depth }: { devId: string; vars: DebugVar[]; depth: number }) {
  const { api } = useServices();
  const [open, setOpen] = useState<Record<string, DebugVar[] | "loading">>({});
  const toggle = (v: DebugVar) => {
    const k = v.name;
    if (open[k]) {
      setOpen(({ [k]: _drop, ...rest }) => rest);
      return;
    }
    setOpen((o) => ({ ...o, [k]: "loading" }));
    api
      .debugVariables(devId, v.ref)
      .then((r) => setOpen((o) => ({ ...o, [k]: r.variables })))
      .catch(() => setOpen(({ [k]: _drop, ...rest }) => rest));
  };
  return (
    <ul className="var-tree" role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? t.debug.vars : undefined}>
      {vars.map((v) => {
        const kids = open[v.name];
        return (
          <li key={v.name} role="treeitem" aria-expanded={v.ref > 0 ? !!kids : undefined}>
            {v.ref > 0 ? (
              <Button variant="bare" className="twisty" aria-label={kids ? t.debug.collapse(v.name) : t.debug.expand(v.name)} onClick={() => toggle(v)}>
                {kids ? "▾" : "▸"}
              </Button>
            ) : (
              <span className="twisty" aria-hidden="true">
                {" "}
              </span>
            )}
            <span className="var-name mono">{v.name}</span>
            <span className="mono">{` = ${v.value}`}</span>
            {v.type && <span className="muted">{` ${v.type}`}</span>}
            {kids === "loading" && <Spinner />}
            {Array.isArray(kids) && <VarTree devId={devId} vars={kids} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

type BpField = "condition" | "hitCondition" | "logMessage";
const BP_FIELDS: BpField[] = ["condition", "hitCondition", "logMessage"];

/** Short description of a breakpoint's options for the list ("条件: i > 3 · 命中: 2"). */
function describeBp(o: BpOptions | undefined): string {
  if (!hasBpOptions(o)) return "";
  return BP_FIELDS.filter((k) => o[k]?.trim()).map((k) => `${t.debug.bpField[k]}: ${o[k]!.trim()}`).join(" · ");
}

/** Inline editor of one breakpoint: kind (condition / hit count / log message) + value, like VS Code's breakpoint widget. */
function BreakpointEditor({ where, initial, onSave, onCancel }: { where: string; initial: BpOptions | undefined; onSave: (o: BpOptions) => void; onCancel: () => void }) {
  const [field, setField] = useState<BpField>(() => BP_FIELDS.find((k) => initial?.[k]?.trim()) ?? "condition");
  const [values, setValues] = useState<BpOptions>(() => ({ ...initial }));
  return (
    <form
      className="bp-editor row"
      aria-label={t.debug.editBp(where)}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(values);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <Select aria-label={t.debug.bpKind} className="w-auto" value={field} onChange={(e) => setField(e.target.value as BpField)}>
        {BP_FIELDS.map((k) => (
          <option key={k} value={k}>
            {t.debug.bpField[k]}
          </option>
        ))}
      </Select>
      <Input
        key={field}
        autoFocus
        aria-label={t.debug.bpField[field]}
        className="grow mono w-auto"
        spellCheck={false}
        placeholder={t.debug.bpPlaceholder[field]}
        value={values[field] ?? ""}
        onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
      />
      <Button size="sm" type="submit" variant="primary">
        {t.debug.bpSave}
      </Button>
      <Button size="sm" type="button" onClick={onCancel}>
        {t.debug.bpCancel}
      </Button>
    </form>
  );
}

const WATCH_KEY = (project: string) => `xscript.watch.${project}`;
function readWatches(project: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(WATCH_KEY(project)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
  } catch {
    return [];
  }
}

interface Props {
  devId: string;
  project: string;
  session: ReturnType<typeof useDebugSession>;
  breakpoints: Breakpoints;
  breakpointOptions?: BreakpointOptions;
  onEditBreakpoint?: (path: string, line: number, o: BpOptions) => void;
  busy: boolean;
  onStart: () => void;
  onStep: (cmd: DebugStep) => void;
  onStop: (terminate: boolean) => void;
  onRemoveBreakpoint: (path: string, line: number) => void;
  onOpenLocation: (path: string, line: number) => void;
  onError: (e: unknown) => void;
}

/** Toolbar + call stack + variables (+ evaluate) + debug console. */
export function DebugPanel({ devId, project, session, breakpoints, breakpointOptions = {}, onEditBreakpoint, busy, onStart, onStep, onStop, onRemoveBreakpoint, onOpenLocation, onError }: Props) {
  const { api } = useServices();
  const { state, output, active } = session;
  const stopped = state.state === "stopped";
  const [frameId, setFrameId] = useState<number | null>(null);
  const [scopes, setScopes] = useState<Array<DebugScope & { vars?: DebugVar[] }>>([]);
  const [expr, setExpr] = useState("");
  const [evals, setEvals] = useState<Array<{ expr: string; result: string; error?: boolean }>>([]);
  const outRef = useRef<HTMLPreElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // watch expressions: kept per project (localStorage), re-evaluated in the selected frame whenever the script pauses
  const [watches, setWatches] = useState<string[]>(() => readWatches(project));
  const [watchExpr, setWatchExpr] = useState("");
  const [watchVals, setWatchVals] = useState<Record<string, { result: string; error?: boolean }>>({});
  useEffect(() => setWatches(readWatches(project)), [project]);
  const saveWatches = (next: string[]) => {
    setWatches(next);
    try {
      localStorage.setItem(WATCH_KEY(project), JSON.stringify(next));
    } catch {
      /* storage full or disabled: keep them for this session */
    }
  };

  const loadFrame = useCallback(
    async (id: number) => {
      setFrameId(id);
      try {
        const sc = (await api.debugScopes(devId, id)).scopes;
        // cheap scopes are expanded right away (Locals); expensive ones (Globals) on demand
        const filled = await Promise.all(sc.map(async (s) => (s.expensive || s.ref <= 0 ? s : { ...s, vars: (await api.debugVariables(devId, s.ref)).variables })));
        setScopes(filled);
      } catch (e) {
        setScopes([]);
        onError(e);
      }
    },
    [api, devId, onError],
  );

  const top = state.frames[0]?.id;
  useEffect(() => {
    if (stopped && top !== undefined) void loadFrame(top);
    else {
      setFrameId(null);
      setScopes([]);
    }
  }, [stopped, top, state, loadFrame]);

  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  useEffect(() => {
    if (!stopped || frameId === null || watches.length === 0) {
      setWatchVals({});
      return;
    }
    let alive = true;
    void Promise.all(
      watches.map(async (w) => {
        try {
          return [w, { result: (await api.debugEvaluate(devId, w, frameId, "watch")).result }] as const;
        } catch (err) {
          return [w, { result: err instanceof Error ? err.message : String(err), error: true }] as const;
        }
      }),
    ).then((pairs) => alive && setWatchVals(Object.fromEntries(pairs)));
    return () => {
      alive = false;
    };
  }, [api, devId, stopped, frameId, watches, state]);

  const addWatch = () => {
    const w = watchExpr.trim();
    if (!w) return;
    if (!watches.includes(w)) saveWatches([...watches, w].slice(-50));
    setWatchExpr("");
  };

  const loadScope = async (i: number) => {
    const s = scopes[i];
    try {
      const vars = (await api.debugVariables(devId, s.ref)).variables;
      setScopes((cur) => cur.map((x, j) => (j === i ? { ...x, vars } : x)));
    } catch (e) {
      onError(e);
    }
  };

  const evaluate = async () => {
    const e = expr.trim();
    if (!e) return;
    try {
      const r = await api.debugEvaluate(devId, e, frameId ?? undefined);
      setEvals((cur) => [...cur, { expr: e, result: r.result }].slice(-50));
      setExpr("");
    } catch (err) {
      setEvals((cur) => [...cur, { expr: e, result: err instanceof Error ? err.message : String(err), error: true }].slice(-50));
    }
  };

  const bpList = Object.entries(breakpoints).flatMap(([p, lines]) => lines.map((ln) => [p, ln] as const));
  const tone = stopped ? "warn" : state.state === "running" ? "ok" : "neutral";

  return (
    <section className="debug-panel" aria-labelledby="h-debug">
      <div className="section-head row debug-toolbar">
        <h2 id="h-debug">{t.debug.title}</h2>
        <Badge tone={tone as "ok"}>{t.debug.state[state.state] ?? state.state}</Badge>
        {stopped && state.path && state.line ? <span className="muted mono">{t.debug.pausedAt(state.path, state.line)}</span> : null}
        <span className="grow" />
        {!active && (
          <Button variant="primary" onClick={onStart} disabled={!project || busy}>
            {busy ? <Spinner /> : t.debug.start}
          </Button>
        )}
        {active && (
          <>
            {stopped ? (
              <Button variant="primary" onClick={() => onStep("continue")}>{t.debug.cont}</Button>
            ) : (
              <Button onClick={() => onStep("pause")} disabled={state.state !== "running"}>{t.debug.pause}</Button>
            )}
            <Button onClick={() => onStep("next")} disabled={!stopped}>{t.debug.next}</Button>
            <Button onClick={() => onStep("stepIn")} disabled={!stopped}>{t.debug.stepIn}</Button>
            <Button onClick={() => onStep("stepOut")} disabled={!stopped}>{t.debug.stepOut}</Button>
            <Button onClick={() => onStop(false)}>{t.debug.detach}</Button>
            <Button variant="danger" onClick={() => onStop(true)}>{t.debug.stop}</Button>
          </>
        )}
      </div>
      <p className="muted">{t.debug.keys}</p>
      {state.state === "ended" && (state.error || state.reason) && (
        <p className={state.error ? "banner error" : "muted"} role="status">
          {state.error || state.reason}
        </p>
      )}
      {stopped && state.reason === "exception" && state.error && (
        <Alert tone="error" role="alert">
          {state.error}
        </Alert>
      )}

      <div className="debug-grid">
        <div>
          <h3 className="sub-head">{t.debug.stack}</h3>
          {state.frames.length === 0 ? (
            <p className="muted">{t.debug.noStack}</p>
          ) : (
            <ul className="list" aria-label={t.debug.stack}>
              {state.frames.map((f) => (
                <li key={f.id}>
                  <Button
                    variant="bare"
                    className={"list-btn mono" + (f.id === frameId ? " active" : "")}
                    aria-current={f.id === frameId ? "true" : undefined}
                    onClick={() => {
                      void loadFrame(f.id);
                      if (f.path) onOpenLocation(f.path, f.line);
                    }}
                  >
                    {f.name}
                    <span className="muted">{`${f.path ?? f.file + " " + t.debug.external}:${f.line}`}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <h3 className="sub-head">{t.debug.breakpoints}</h3>
          {bpList.length === 0 ? (
            <p className="muted">{t.debug.noBreakpoints}</p>
          ) : (
            <ul className="list" aria-label={t.debug.breakpoints}>
              {bpList.map(([p, ln]) => {
                const k = bpKey(p, ln);
                const o = breakpointOptions[k];
                const log = !!o?.logMessage?.trim();
                return (
                  <li key={k}>
                    <div className="file-row">
                      <Button variant="bare" className="list-btn mono" onClick={() => onOpenLocation(p, ln)}>
                        <span className={"bp-mark" + (log ? " log" : hasBpOptions(o) ? " cond" : "")}>{`${log ? "◆" : "●"} ${p}:${ln}`}</span>
                        {hasBpOptions(o) && <span className="muted bp-desc">{describeBp(o)}</span>}
                      </Button>
                      {onEditBreakpoint && (
                        <Button variant="ghost" size="sm" aria-label={t.debug.editBp(`${p}:${ln}`)} aria-expanded={editing === k} onClick={() => setEditing(editing === k ? null : k)}>
                          ✎
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" aria-label={t.debug.removeBp(p, ln)} onClick={() => onRemoveBreakpoint(p, ln)}>
                        ✕
                      </Button>
                    </div>
                    {editing === k && onEditBreakpoint && (
                      <BreakpointEditor
                        where={`${p}:${ln}`}
                        initial={o}
                        onCancel={() => setEditing(null)}
                        onSave={(next) => {
                          onEditBreakpoint(p, ln, next);
                          setEditing(null);
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div>
          <h3 className="sub-head">{t.debug.watch}</h3>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              addWatch();
            }}
          >
            <Input aria-label={t.debug.watchAdd} className="grow mono w-auto" value={watchExpr} placeholder={t.debug.watchPlaceholder} spellCheck={false} onChange={(e) => setWatchExpr(e.target.value)} />
            <Button size="sm" type="submit" disabled={!watchExpr.trim()}>
              {t.debug.watchAdd}
            </Button>
          </form>
          {watches.length === 0 ? (
            <p className="muted">{t.debug.noWatch}</p>
          ) : (
            <ul className="var-tree watch-list" aria-label={t.debug.watch}>
              {watches.map((w) => {
                const v = watchVals[w];
                return (
                  <li key={w} className="file-row">
                    <span className="grow">
                      <span className="var-name mono">{w}</span>
                      <span className={v?.error ? "err mono" : "mono"}>{v ? ` = ${v.result}` : stopped ? " …" : ` ${t.debug.watchIdle}`}</span>
                    </span>
                    <Button variant="ghost" size="sm" aria-label={t.debug.watchRemove(w)} onClick={() => saveWatches(watches.filter((x) => x !== w))}>
                      ✕
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <h3 className="sub-head">{t.debug.vars}</h3>
          {scopes.length === 0 ? (
            <p className="muted">{t.debug.noVars}</p>
          ) : (
            scopes.map((s, i) => (
              <div key={s.name} className="scope">
                <div className="row">
                  <strong>{s.name}</strong>
                  {!s.vars && s.ref > 0 && (
                    <Button variant="ghost" size="sm" aria-label={t.debug.expand(s.name)} onClick={() => void loadScope(i)}>
                      ▸
                    </Button>
                  )}
                </div>
                {s.vars && <VarTree devId={devId} vars={s.vars} depth={0} />}
              </div>
            ))
          )}
          <form
            className="row"
            style={{ marginTop: "var(--sp-2)" }}
            onSubmit={(e) => {
              e.preventDefault();
              void evaluate();
            }}
          >
            <Input aria-label={t.debug.evaluate} className="grow mono w-auto" value={expr} placeholder={t.debug.evalPlaceholder} spellCheck={false} onChange={(e) => setExpr(e.target.value)} disabled={!stopped} />
            <Button size="sm" type="submit" disabled={!stopped || !expr.trim()}>
              {t.debug.evaluate}
            </Button>
          </form>
          {evals.length > 0 && (
            <ul className="var-tree" aria-label={t.debug.evaluate}>
              {evals.map((ev, i) => (
                <li key={i} className={ev.error ? "err mono" : "mono"}>{`${ev.expr} → ${ev.result}`}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <h3 className="sub-head">{t.debug.console}</h3>
      <pre className="logs debug-console" ref={outRef} aria-label={t.debug.console}>
        {output.map((o) => (
          <span key={o.n} className={o.category === "stderr" ? "err" : ""}>
            {o.text}
          </span>
        ))}
      </pre>
    </section>
  );
}
