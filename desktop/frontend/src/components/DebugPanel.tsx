import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "../app-context";
import type { Breakpoints, DebugScope, DebugState, DebugStep, DebugVar } from "../api";
import { t } from "../strings";
import { Badge } from "./Badge";
import { Spinner } from "./icons";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

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

interface Props {
  devId: string;
  project: string;
  session: ReturnType<typeof useDebugSession>;
  breakpoints: Breakpoints;
  busy: boolean;
  onStart: () => void;
  onStep: (cmd: DebugStep) => void;
  onStop: (terminate: boolean) => void;
  onRemoveBreakpoint: (path: string, line: number) => void;
  onOpenLocation: (path: string, line: number) => void;
  onError: (e: unknown) => void;
}

/** Toolbar + call stack + variables (+ evaluate) + debug console. */
export function DebugPanel({ devId, project, session, breakpoints, busy, onStart, onStep, onStop, onRemoveBreakpoint, onOpenLocation, onError }: Props) {
  const { api } = useServices();
  const { state, output, active } = session;
  const stopped = state.state === "stopped";
  const [frameId, setFrameId] = useState<number | null>(null);
  const [scopes, setScopes] = useState<Array<DebugScope & { vars?: DebugVar[] }>>([]);
  const [expr, setExpr] = useState("");
  const [evals, setEvals] = useState<Array<{ expr: string; result: string; error?: boolean }>>([]);
  const outRef = useRef<HTMLPreElement>(null);

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
              {bpList.map(([p, ln]) => (
                <li key={`${p}:${ln}`} className="file-row">
                  <Button variant="bare" className="list-btn mono" onClick={() => onOpenLocation(p, ln)}>
                    {`● ${p}:${ln}`}
                  </Button>
                  <Button variant="ghost" size="sm" aria-label={t.debug.removeBp(p, ln)} onClick={() => onRemoveBreakpoint(p, ln)}>
                    ✕
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
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
