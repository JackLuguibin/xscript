import { useEffect, useState } from "react";
import { useServices } from "../app-context";
import type { Device } from "../api";
import { t } from "../strings";
import { ErrorBanner } from "./ErrorBanner";
import { useToast } from "./Toast";
import { flattenTree, hitTest, nodeLabel, nodeXPath, rectPercent, selectorCode, type UiNode, type UiRect, type UiTree } from "../ui-tree";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export type PointerMode = "control" | "inspect" | "color";

const TOOL_PAGES = ["color", "label", "mirror", "home"] as const;

export function ScreenTools({
  device,
  mode,
  onMode,
  hover,
  picked,
  onHit,
  toast: toastProp,
}: {
  device: Device;
  mode: PointerMode;
  onMode: (m: PointerMode) => void;
  hover: { x: number; y: number } | null;
  picked: { x: number; y: number; n: number } | null;
  onHit: (rect: UiRect | null, screen: { w: number; h: number } | null) => void;
  /** The host page's toast; without one the panel shows its own. */
  toast?: (text: string) => void;
}) {
  const { api, inShell } = useServices();
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
    const data = (await api.uiTree(devId, 0)) as UiTree;
    applyTree(data, point);
  };

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

  const code = selected ? selectorCode(selected) : "";
  const xpath = selected ? nodeXPath(selected) : "";
  const rows = tree ? flattenTree(tree.roots ?? []) : [];

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

  const openTool = async (page: (typeof TOOL_PAGES)[number]) => {
    setError(null);
    setNotice("");
    try {
      const res = await api.toolsOpen(devId, page);
      const name = t.tools[page];
      const opened = inShell ? t.tools.opened(name) : `${t.tools.demo} ${res.url}`;
      // a warning (e.g. plain-HTTP LAN) must stay readable, so only the plain success becomes a toast
      if (res.warning) setNotice(`${opened} ${res.warning}`);
      else toast(opened);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="screen-tools">
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
      </fieldset>
      <p className="hint" role="status">
        {t.inspect.coords}：{hover ? `(${hover.x}, ${hover.y})` : t.inspect.none}
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
        <Button size="sm" onClick={() => void refresh().catch((e) => setError(e))}>
          {t.inspect.refresh}
        </Button>
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
      <div className="panel tight">
        <h2>{t.inspect.tree}</h2>
        {!tree && <p className="muted">{t.inspect.empty}</p>}
        {miss && !selected && <p className="muted">{t.inspect.noHit}</p>}
        {rows.length > 0 && (
          <div className="tree-scroll" role="tree" aria-label={t.inspect.tree}>
            {rows.map((row, i) =>
              row.truncated ? (
                <p key="more" className="muted">
                  …
                </p>
              ) : (
                <Button variant="bare" className="tree-item"
                  key={`${row.node.path || i}`}
                  type="button"
                  role="treeitem"
                 
                  aria-selected={selected === row.node}
                  style={{ paddingLeft: `${8 + row.depth * 12}px` }}
                  onClick={() => {
                    setSelected(row.node);
                    setMiss(false);
                    onHit(row.node.rect ?? null, { w: tree?.width || 0, h: tree?.height || 0 });
                  }}
                >
                  {nodeLabel(row.node)}
                </Button>
              ),
            )}
          </div>
        )}
        {selected && (
          <>
            <Textarea className="code-snip font-mono" aria-label={t.inspect.code} readOnly value={code} rows={3} />
            <p className="hint">{t.inspect.codeHint}</p>
            <div className="row wrap">
              <Button size="sm" type="button" onClick={() => void copy(selectorCode(selected))}>
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
      </div>
      <div className="panel tight">
        <h2>{t.tools.title}</h2>
        <p className="hint">{t.tools.hint}</p>
        <div className="row wrap">
          {TOOL_PAGES.map((page) => (
            <Button size="sm" key={page} type="button" onClick={() => void openTool(page)}>
              {t.tools[page]}
            </Button>
          ))}
        </div>
      </div>
      {!toastProp && local.toasts}
    </div>
  );
}

export { rectPercent };
