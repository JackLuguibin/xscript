import { useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "../app-context";
import type { Device } from "../api";
import { deployPlan, isEntryStub, pushPlan } from "../flow/deploy";
import { packBundle, readBundle } from "../flow/bundle";
import { builtinSpecs } from "../flow/specs";
import { parse, printFlow, type FlowGraph } from "../flow/dsl";
import { layoutFromGraph, type FlowLayout } from "../flow/layout";
import type { FlowBreakpoint } from "../flow/breakpoints";
import type { FlowSourceMap } from "../flow/map";
import { errorLine } from "../errors";
import { getLanguage } from "../strings";
import { useConfirm } from "./ConfirmDialog";
import { DebugPanel, useDebugSession } from "./DebugPanel";
import { Button } from "./ui/button";
import { Select } from "./ui/select";

/** Portable documents and device delivery share the compiler and the existing overwrite guard. */
export function FlowDelivery({
  graph,
  layout,
  text,
  breaks,
  currentDevice,
  onOpen,
  onPick,
  onRun,
  onRemoveBreakpoint,
}: {
  graph: FlowGraph;
  layout: FlowLayout;
  text: string;
  breaks: FlowBreakpoint[];
  currentDevice: string;
  onOpen: (graph: FlowGraph, layout: FlowLayout) => void;
  onPick: (ids: string[]) => void;
  onRemoveBreakpoint?: (node: string) => void;
  onRun: (
    id: string,
    project: string,
    map: FlowSourceMap,
    cursor: number,
  ) => void;
}) {
  const { api, inShell } = useServices();
  const en = getLanguage() === "en";
  const word = (zh: string, english: string) => (en ? english : zh);
  const [devices, setDevices] = useState<Device[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [target, setTarget] = useState(currentDevice);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<
    Array<{ id: string; message: string }>
  >([]);
  const [handle, setHandle] = useState("");
  const [saved, setSaved] = useState(() => JSON.stringify([text, layout]));
  const signature = JSON.stringify([text, layout]);
  const dirty = signature !== saved;
  const latest = useRef({ graph, layout, text, signature });
  latest.current = { graph, layout, text, signature };
  const { confirm, dialog } = useConfirm();
  const [debugMap, setDebugMap] = useState<FlowSourceMap | null>(null);
  const [debugDevice, setDebugDevice] = useState("");
  const debug = useDebugSession(debugDevice);
  const specs = useMemo(builtinSpecs, []);
  const plan = (() => {
    try {
      return deployPlan(parse(text), specs, layout);
    } catch (error) {
      return { ok: false as const, detail: errorLine(error) };
    }
  })();
  const breakpointLines = useMemo(() => {
    if (!debugMap) return {};
    return {
      [debugMap.file]: [
        ...new Set(
          breaks
            .filter((b) => b.enabled)
            .flatMap((b) =>
              (debugMap.nodes[b.node] || []).slice(0, 1).map(Number),
            ),
        ),
      ],
    };
  }, [debugMap, breaks]);
  useEffect(() => {
    if (!inShell) return;
    void api.setUnsaved(dirty, en ? "en" : "zh").catch(() => undefined);
  }, [api, dirty, en, inShell]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .listDevices()
        .then((r) => {
          if (alive) setDevices(r.devices.filter((d) => d.state === "online"));
        })
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [api]);
  useEffect(() => {
    if (currentDevice) setTarget(currentDevice);
  }, [currentDevice]);
  useEffect(() => {
    if (!debugDevice || !debugMap || !debug.active) return;
    void api
      .debugSetBreakpoints(
        debugDevice,
        debugMap.file,
        (breakpointLines[debugMap.file] || []).map((line) => ({ line })),
      )
      .catch((e) => setMessage(errorLine(e)));
  }, [api, debugDevice, debugMap, breakpointLines, debug.active]);
  useEffect(() => {
    if (debug.state.state !== "stopped" || !debugMap) return;
    const frame = debug.state.frames.find((f) => f.path === debugMap.file);
    const mark = frame && debugMap.lines[String(frame.line)];
    if (mark) onPick([mark.split("(")[0]]);
  }, [debug.state, debugMap, onPick]);
  const work = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(errorLine(e));
    } finally {
      setBusy(false);
    }
  };
  const replace = async (next: FlowGraph, position: FlowLayout) => {
    if (
      dirty &&
      !(await confirm({
        message: word(
          "当前流程尚未保存，替换它？",
          "Replace the unsaved flow?",
        ),
      }))
    )
      return false;
    onOpen(next, position);
    return true;
  };
  const save = (as = false, bundle = false) =>
    work(async () => {
      const snapshot = latest.current;
      const prepared = deployPlan(parse(snapshot.text), specs, snapshot.layout);
      if (!prepared.ok) throw Error(prepared.detail);
      const content = bundle
        ? JSON.stringify(
            packBundle(prepared, {
              createdAt: new Date().toISOString(),
              app: "0.6.0",
            }),
          )
        : snapshot.text;
      const r = await api.flowSaveDocument(
        snapshot.graph.name + (bundle ? ".xflowpkg" : ".xflow"),
        content,
        as || bundle ? "" : handle,
        bundle ? undefined : snapshot.layout,
      );
      if (!r.cancelled && !bundle) {
        setHandle(r.handle);
        setSaved(snapshot.signature);
      }
      if (!r.cancelled) setMessage(word("已保存：", "Saved: ") + r.name);
    });
  const open = () =>
    work(async () => {
      const r = await api.flowOpenDocument();
      if (r.cancelled) return;
      if (r.name.endsWith(".xflowpkg")) {
        const opened = readBundle(r.content);
        if (!opened.ok) throw Error(opened.reason + ": " + opened.detail);
        if (
          !(await confirm({
            message:
              `${opened.bundle.project} · ${opened.bundle.createdAt} · ${opened.bundle.app || "XScript"}\n` +
              word(
                "此流程包包含可执行代码，确认来源可信并导入？",
                "This bundle contains executable code. Trust its source and import?",
              ),
          }))
        )
          return;
        if (
          await replace(
            opened.graph,
            opened.layout || layoutFromGraph(opened.graph),
          )
        ) {
          setHandle("");
          setSaved(
            JSON.stringify([
              printFlow(opened.graph),
              opened.layout || layoutFromGraph(opened.graph),
            ]),
          );
        }
      } else {
        const next = parse(r.content);
        const position = r.layout || layoutFromGraph(next);
        if (await replace(next, position)) {
          setHandle(r.handle);
          setSaved(JSON.stringify([r.content, position]));
        }
      }
    });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save(event.shiftKey);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });
  const deploy = (run: boolean, debugging = false) =>
    work(async () => {
      if (!plan.ok) throw Error(plan.detail);
      const ids = debugging ? [target] : targets.length ? targets : [target];
      setResults([]);
      for (const id of ids.filter(Boolean)) {
        try {
          const device = devices.find((d) => d.id === id);
          if (device?.info.version && String(device.info.version) !== "0.6.0")
            setMessage(
              word(
                "设备版本不同，请检查节点兼容性：",
                "Device version differs; check node compatibility: ",
              ) + device.info.version,
            );
          const pushed = await pushPlan(api, id, plan);
          if (!pushed.ok)
            throw Error(
              word("拒绝覆盖其他工程", "Refused to overwrite another project"),
            );
          if (debugging) {
            setDebugMap(plan.map);
            setDebugDevice(id);
            const lines = breaks
              .filter((b) => b.enabled)
              .flatMap((b) =>
                (plan.map.nodes[b.node] || [])
                  .slice(0, 1)
                  .map((line) => ({ line: Number(line) })),
              );
            await api.debugStart(id, plan.project, { [plan.map.file]: lines });
          } else if (run) {
            const logs = await api.logs(id, 0);
            const r = await api.run(id, plan.project);
            if (r.error) throw Error(r.error);
            onRun(id, plan.project, plan.map, logs.next);
          }
          setResults((rows) => [
            ...rows,
            { id, message: word("成功", "Success") },
          ]);
        } catch (e) {
          setResults((rows) => [...rows, { id, message: errorLine(e) }]);
        }
      }
    });
  const pull = () =>
    work(async () => {
      for (const project of (await api.projects(target)).projects) {
        const files = (await api.files(target, project.name)).files;
        if (!files.some((f) => f.path === "__init__.py")) continue;
        if (
          !isEntryStub(
            (await api.readFile(target, project.name, "__init__.py")).content,
          )
        )
          continue;
        if (
          !(await confirm({
            message:
              word("读回设备流程：", "Open device flow: ") + project.name + "?",
          }))
        )
          continue;
        const next = parse(
          (
            await api.readFile(
              target,
              project.name,
              `flows/${project.name}.xflow`,
            )
          ).content,
        );
        let position = layoutFromGraph(next);
        const sidecar = `flows/${project.name}.xflow.layout.json`;
        if (files.some((f) => f.path === sidecar))
          position = JSON.parse(
            (await api.readFile(target, project.name, sidecar)).content,
          );
        if (await replace(next, position)) {
          setHandle("");
          setMessage(
            word(
              "已读回，请保存本机副本",
              "Opened device flow; save a local copy",
            ),
          );
        }
        return;
      }
      setMessage(word("没有可读回的流程", "No flow selected"));
    });
  return (
    <section
      className="panel"
      aria-label={word("流程文件与设备", "Flow files and devices")}
    >
      <div className="row toolbar">
        <Button disabled={busy} onClick={() => void open()}>
          {word("打开 / 导入", "Open / Import")}
        </Button>
        <Button disabled={busy} onClick={() => void save()}>
          {word("保存", "Save")}
          {dirty ? " *" : ""}
        </Button>
        <Button disabled={busy} onClick={() => void save(true)}>
          {word("另存为", "Save as")}
        </Button>
        <Button disabled={busy} onClick={() => void save(true, true)}>
          {word("导出流程包", "Export bundle")}
        </Button>
        <Select
          aria-label={word("目标设备", "Target device")}
          value={target}
          disabled={busy || debug.active}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="">{word("选择设备", "Select device")}</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name || d.id}
            </option>
          ))}
        </Select>
        <Button disabled={busy || !target} onClick={() => void pull()}>
          {word("从设备读回", "Open from device")}
        </Button>
        <Button
          disabled={busy || (!target && !targets.length)}
          onClick={() => void deploy(false)}
        >
          {word("推送", "Push")}
        </Button>
        <Button
          disabled={busy || (!target && !targets.length)}
          onClick={() => void deploy(true)}
        >
          {word("推送并运行", "Push and run")}
        </Button>
        <Button
          disabled={busy || !target || debug.active}
          onClick={() => void deploy(false, true)}
        >
          {word("设备节点调试", "Debug nodes on device")}
        </Button>
      </div>
      <fieldset>
        <legend>{word("批量推送目标", "Batch targets")}</legend>
        {devices.map((d) => (
          <label key={d.id}>
            <input
              type="checkbox"
              checked={targets.includes(d.id)}
              disabled={busy}
              onChange={(e) =>
                setTargets((ids) =>
                  e.target.checked
                    ? [...ids, d.id]
                    : ids.filter((id) => id !== d.id),
                )
              }
            />
            {d.name || d.id}{" "}
          </label>
        ))}
      </fieldset>
      {message && <p role="status">{message}</p>}
      {!!results.length && (
        <table>
          <thead>
            <tr>
              <th>{word("设备", "Device")}</th>
              <th>{word("结果", "Result")}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {debugDevice && (
        <DebugPanel
          devId={debugDevice}
          project={graph.name}
          session={debug}
          breakpoints={breakpointLines}
          busy={busy}
          onStart={() => void deploy(false, true)}
          onStep={(cmd) =>
            void api
              .debugStep(debugDevice, cmd)
              .catch((e) => setMessage(errorLine(e)))
          }
          onStop={(terminate) =>
            void api
              .debugStop(debugDevice, terminate)
              .catch((e) => setMessage(errorLine(e)))
          }
          onRemoveBreakpoint={(path, line) => {const mark = path === debugMap?.file && debugMap.lines[String(line)]; if (mark) onRemoveBreakpoint?.(mark.split("(")[0]);}}
          onOpenLocation={(path, line) => {
            const mark =
              path === debugMap?.file && debugMap.lines[String(line)];
            if (mark) onPick([mark.split("(")[0]]);
          }}
          onError={(e) => setMessage(errorLine(e))}
        />
      )}
      {dialog}
    </section>
  );
}
