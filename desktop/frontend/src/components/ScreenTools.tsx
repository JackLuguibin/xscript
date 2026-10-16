import { useEffect, useState } from "react";
import { useServices } from "../app-context";
import type { Device } from "../api";
import { RpcError } from "../bridge/types";
import { t } from "../strings";
import { flattenTree, hitTest, nodeLabel, nodeXPath, rectPercent, selectorCode, type UiNode, type UiRect, type UiTree } from "../ui-tree";

export type PointerMode = "control" | "inspect" | "color";

const TOOL_PAGES = ["color", "label", "mirror", "home"] as const;

function errText(e: unknown): string {
  if (e instanceof RpcError) return `${e.message} [${e.code}]`;
  return e instanceof Error ? e.message : String(e);
}

export function ScreenTools({
  device,
  mode,
  onMode,
  hover,
  picked,
  onHit,
}: {
  device: Device;
  mode: PointerMode;
  onMode: (m: PointerMode) => void;
  hover: { x: number; y: number } | null;
  picked: { x: number; y: number; n: number } | null;
  onHit: (rect: UiRect | null, screen: { w: number; h: number } | null) => void;
}) {
  const { api, inShell } = useServices();
  const [tree, setTree] = useState<UiTree | null>(null);
  const [selected, setSelected] = useState<UiNode | null>(null);
  const [miss, setMiss] = useState(false);
  const [color, setColor] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const devId = device.id;

  useEffect(() => {
    setTree(null);
    setSelected(null);
    setMiss(false);
    setColor(null);
    setNotice("");
    setError("");
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
    setError("");
    const data = (await api.uiTree(devId, 0)) as UiTree;
    applyTree(data, point);
  };

  useEffect(() => {
    if (!picked) return;
    let dead = false;
    if (mode === "inspect") {
      void refresh(picked).catch((e) => {
        if (!dead) setError(errText(e));
      });
    } else if (mode === "color") {
      setColor(null);
      void api
        .pixel(devId, picked.x, picked.y)
        .then((r) => {
          if (!dead) setColor(r.color);
        })
        .catch((e) => {
          if (!dead) setError(errText(e));
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
    setError("");
    setNotice("");
    try {
      await api.copyText(text);
      setNotice(t.inspect.copied);
    } catch (e) {
      setError(errText(e));
    }
  };

  const openTool = async (page: (typeof TOOL_PAGES)[number]) => {
    setError("");
    setNotice("");
    try {
      const res = await api.toolsOpen(devId, page);
      const name = t.tools[page];
      const opened = inShell ? t.tools.opened(name) : `${t.tools.demo} ${res.url}`;
      setNotice(res.warning ? `${opened} ${res.warning}` : opened);
    } catch (e) {
      setError(errText(e));
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
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="hint" role="status">
          {notice}
        </p>
      )}
      <div className="row wrap">
        <button type="button" className="small" onClick={() => void refresh().catch((e) => setError(errText(e)))}>
          {t.inspect.refresh}
        </button>
        <button
          type="button"
          className="small"
          onClick={() => {
            setError("");
            setNotice("");
            void api
              .saveScreenshot(devId)
              .then((r) => setNotice(r.saved && r.path ? t.inspect.savedShot(r.path) : t.inspect.saveCancelled))
              .catch((e) => setError(errText(e)));
          }}
        >
          {t.inspect.saveShot}
        </button>
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
                <button
                  key={`${row.node.path || i}`}
                  type="button"
                  role="treeitem"
                  className="tree-item"
                  aria-selected={selected === row.node}
                  style={{ paddingLeft: `${8 + row.depth * 12}px` }}
                  onClick={() => {
                    setSelected(row.node);
                    setMiss(false);
                    onHit(row.node.rect ?? null, { w: tree?.width || 0, h: tree?.height || 0 });
                  }}
                >
                  {nodeLabel(row.node)}
                </button>
              ),
            )}
          </div>
        )}
        {selected && (
          <>
            <textarea className="code-snip" aria-label={t.inspect.code} readOnly value={code} rows={3} />
            <p className="hint">{t.inspect.codeHint}</p>
            <div className="row wrap">
              <button type="button" className="small" onClick={() => void copy(selectorCode(selected))}>
                {t.inspect.copySelector}
              </button>
              <button type="button" className="small" onClick={() => void copy(xpath)}>
                {t.inspect.copyXpath}
              </button>
              <button type="button" className="small" onClick={() => void copy(code)}>
                {t.inspect.copyCode}
              </button>
            </div>
          </>
        )}
      </div>
      <div className="panel tight">
        <h2>{t.tools.title}</h2>
        <p className="hint">{t.tools.hint}</p>
        <div className="row wrap">
          {TOOL_PAGES.map((page) => (
            <button key={page} type="button" className="small" onClick={() => void openTool(page)}>
              {t.tools[page]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export { rectPercent };
