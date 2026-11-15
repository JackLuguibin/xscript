import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useServices } from "../app-context";
import type { Device } from "../api";
import { t } from "../strings";
import { ErrorBanner } from "./ErrorBanner";
import { useToast } from "./Toast";
import { flattenTree, hitTest, nodeLabel, nodeXPath, rectPercent, selectorCode, type UiNode, type UiRect, type UiTree } from "../ui-tree";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Panel } from "./ui/panel";
import { HelpButton } from "./ui/help-button";
import { TreeView, type TreeEntry } from "./ui/tree-view";
import { Textarea } from "./ui/textarea";
import { sendToCanvas } from "../flow/inbox";

export type PointerMode = "control" | "inspect" | "color";

export function ScreenTools({
  compact = false,
  inputContent,
  renderLayout,
  device,
  mode,
  onMode,
  hover,
  picked,
  onHit,
  toast: toastProp,
}: {
  compact?: boolean;
  inputContent?: ReactNode;
  renderLayout?: (controls: ReactNode, tree: ReactNode) => ReactNode;
  device: Device;
  mode: PointerMode;
  onMode: (m: PointerMode) => void;
  hover: { x: number; y: number } | null;
  picked: { x: number; y: number; n: number } | null;
  onHit: (rect: UiRect | null, screen: { w: number; h: number } | null) => void;
  /** The host page's toast; without one the panel shows its own. */
  toast?: (text: string) => void;
}) {
  const { api } = useServices();
  const [fullTree, setFullTree] = useState(true);
  const [noSystem, setNoSystem] = useState(false);
  const [query, setQuery] = useState("");
  const request = useRef(0);
  const treeMode = (fullTree ? 1 : 0) | (noSystem ? 2 : 0);
  const [tree, setTree] = useState<UiTree | null>(null);
  const [selected, setSelected] = useState<UiNode | null>(null);
  const [miss, setMiss] = useState(false);
  const [color, setColor] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<unknown>(null);
  const local = useToast();
  const toast = toastProp ?? local.toast;
  const devId = device.id;

  useEffect(() => {
    request.current += 1;
    setQuery("");
    setTree(null);
    setSelected(null);
    setMiss(false);
    setColor(null);
    setNotice("");
    setError(null);
    onHit(null, null);
    // The highlight belongs to the previous device.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devId]);

  const applyTree = (data: UiTree, point?: { x: number; y: number }) => {
    setTree(data);
    const screen = { w: data.width || 0, h: data.height || 0 };
    if (!point) {
      setSelected(null);
      setMiss(false);
      onHit(null, screen);
      return;
    }
    const hit = hitTest(data.roots ?? [], point.x, point.y);
    setSelected(hit);
    setMiss(!hit);
    onHit(hit?.rect ?? null, screen);
  };

  const refresh = async (point?: { x: number; y: number }) => {
    setError(null);
    const token = ++request.current;
    setSelected(null);
    onHit(null, null);
    try {
      const data = (await api.uiTree(devId, treeMode)) as UiTree;
      if (token !== request.current) return;
      if (data.error) throw new Error(t.inspect.readError(data.error));
      applyTree({ ...data, mode: treeMode }, point);
    } catch (e) {
      if (token !== request.current) return;
      setTree(null);
      setMiss(false);
      setError(e);
    }
  };

  useEffect(() => {
    request.current += 1;
    setTree(null);
    setSelected(null);
    setMiss(false);
    onHit(null, null);
    if (mode === "inspect" || tree) void refresh();
    return () => { request.current += 1; };
    // A mode / device switch invalidates every pending read, including manual refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devId, mode, treeMode]);

  useEffect(() => {
    if (!picked) return;
    let dead = false;
    if (mode === "inspect") {
      void refresh(picked).catch((e) => {
        if (!dead) setError(e);
      });
    } else if (mode === "color") {
      setColor(null);
      void api
        .pixel(devId, picked.x, picked.y)
        .then((r) => {
          if (!dead) setColor(r.color);
        })
        .catch((e) => {
          if (!dead) setError(e);
        });
    }
    return () => {
      dead = true;
    };
    // refresh identity changes every render; picked.n is the trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.n, mode, devId]);

  const code = selected ? selectorCode(selected, tree?.roots, tree?.mode) : "";
  const xpath = selected ? nodeXPath(selected, tree?.roots) : "";
  const allRows = tree ? flattenTree(tree.roots ?? []) : [];
  const search = query.trim().toLocaleLowerCase();
  const matches = search ? allRows.filter(({ node }) => [node.text, node.desc, node.id, node.type, node.path].some((v) => v?.toLocaleLowerCase().includes(search))) : allRows;
  const entries = (nodes: UiNode[], prefix = ""): TreeEntry<UiNode>[] => nodes.map((node, index) => ({
    id: `${prefix}/${index}`, label: nodeLabel(node), value: node,
    searchText: [node.text, node.desc, node.id, node.type, node.path].filter(Boolean).join(" "),
    children: node.children ? entries(node.children, `${prefix}/${index}`) : undefined,
  }));
  const treeEntries = useMemo(() => entries(tree?.roots ?? []), [tree]);
  const selectNode = (node: UiNode) => {
    setSelected(node); setMiss(false);
    onHit(node.rect ?? null, { w: tree?.width || 0, h: tree?.height || 0 });
  };

  const copy = async (text: string) => {
    setError(null);
    setNotice("");
    try {
      await api.copyText(text);
      toast(t.inspect.copied);
    } catch (e) {
      setError(e);
    }
  };

  const treePanel = (
      <Panel title={t.inspect.tree} className="inspect-tree-panel" actions={
        <Button size="sm" onClick={() => { void refresh().catch((e) => setError(e)); }}>
          {t.inspect.refresh}
        </Button>
      }>
        <div className="row wrap">
          <label><input type="checkbox" checked={fullTree} onChange={(e) => setFullTree(e.target.checked)} />{t.inspect.fullTree}</label>
          <label><input type="checkbox" checked={noSystem} onChange={(e) => setNoSystem(e.target.checked)} />{t.inspect.noSystem}</label>
        </div>
        <Input type="search" aria-label={t.inspect.search} placeholder={t.inspect.search} value={query} onChange={(e) => { setQuery(e.target.value); }} />
        {tree && <p className="hint" role="status">{t.inspect.count(matches.length, allRows.length)}</p>}
        {tree && allRows.length === 0 && <p className="muted">{t.inspect.noNodes}</p>}
        {tree && allRows.length > 0 && matches.length === 0 && <p className="muted">{t.inspect.noMatch}</p>}
        {!tree && <p className="muted">{t.inspect.empty}</p>}
        {miss && !selected && <p className="muted">{t.inspect.noHit}</p>}
        {tree && allRows.length > 0 && <TreeView label={t.inspect.tree} entries={treeEntries} query={query} selected={selected} onSelect={selectNode}
          previousLabel={t.deviceFlow.previousPage} nextLabel={t.deviceFlow.nextPage} pageSummary={t.deviceFlow.pageSummary} />}

      </Panel>
  );

  const controls = (
      <div className="inspector-control-region">
      {inputContent}
      <fieldset className="mode-row">
        <legend>{t.inspect.mode}</legend>
        {(
          [
            ["control", t.inspect.control],
            ["inspect", t.inspect.pick],
            ["color", t.inspect.color],
          ] as const
        ).map(([m, label]) => (
          <label key={m}>
            <input type="radio" name="pointer-mode" checked={mode === m} onChange={() => onMode(m)} />
            {label}
          </label>
        ))}
      {compact && <HelpButton title={t.mirror.interactionHelp} closeLabel={t.shortcuts.close}><p className="hint">{t.mirror.hint}</p></HelpButton>}
      </fieldset>
      <p className="hint" role="status">
        {t.inspect.coords}：{hover ? `(${hover.x}, ${hover.y})` : compact ? "—" : t.inspect.none}
        {color ? ` · ${t.inspect.colorLabel} ${color}` : ""}
      </p>
      {color && <span className="swatch" style={{ background: color }} aria-hidden="true" />}
      {error !== null && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
      {notice && (
        <p className="hint" role="status">
          {notice}
        </p>
      )}
      <div className="row wrap">
        <Button size="sm"
          type="button"

          onClick={() => {
            setError(null);
            setNotice("");
            void api
              .saveScreenshot(devId)
              .then((r) => toast(r.saved && r.path ? t.inspect.savedShot(r.path) : t.inspect.saveCancelled))
              .catch((e) => setError(e));
          }}
        >
          {t.inspect.saveShot}
        </Button>
      </div>
      <Panel title={t.inspect.attributes} className="inspect-attributes-panel">
        {selected && (
          <>
            <dl className="grid gap-sp-1 text-sm">
              {Object.entries(selected).filter(([key]) => key !== "children").map(([key, value]) => (
                <div key={key} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-sp-2"><dt className="text-muted">{key}</dt><dd className="m-0 break-all">{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>
              ))}
            </dl>
            <Textarea className="code-snip" aria-label={t.inspect.code} readOnly value={code} rows={3} />
            <p className="hint">{t.inspect.codeHint}</p>
            <div className="row wrap">
              <Button size="sm" variant="primary" type="button" onClick={() => { sendToCanvas(selected, tree?.roots, tree?.mode); toast(t.inspect.sentToCanvas); }}>
                {t.inspect.toCanvas}
              </Button>
              <Button size="sm" type="button" onClick={() => void copy(selectorCode(selected, tree?.roots, tree?.mode))}>
                {t.inspect.copySelector}
              </Button>
              <Button size="sm" type="button" onClick={() => void copy(xpath)}>
                {t.inspect.copyXpath}
              </Button>
              <Button size="sm" type="button" onClick={() => void copy(code)}>
                {t.inspect.copyCode}
              </Button>
            </div>
          </>
        )}

      </Panel>
      </div>
  );

  return (
    <>
      {renderLayout ? renderLayout(controls, treePanel) : (
        <div className={compact ? "screen-tools screen-tools-split" : "screen-tools"}>
          {controls}
          {treePanel}
        </div>
      )}
      {!toastProp && local.toasts}
    </>
  );
}

export { rectPercent };
