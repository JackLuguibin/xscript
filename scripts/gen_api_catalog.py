#!/usr/bin/env python3
"""Build api_catalog.json (MCP server + backend AI 写脚本) from ide/python-stubs and a curated source.

The stubs are generated from android/python-runtime by gen_stubs.py, so every signature here comes from the
runtime. scripts/api_catalog_src.json keeps what the stubs cannot say: the notes, module descriptions, compact
docs for the AI prompt, return types, class method lists and the AScript `unsupported` list.

Per stub module (xscript.android.*) the source lists functions as
    {"name": "click", "returns": "bool", "doc": "..."}         signature = stub signature + " -> bool"
    {"names": [["back", "bool"], ["home", "bool"]], "doc": ...}  one entry, signatures joined by "; "
    {"name": "on_key", "decorator": true}                       "@on_key(...)"
    {"name": "install", "hide": ["log"]}                        drops internal parameters
    {"name": "to_wgs84", "from": "xscript.android.coords"}     a name the module re-exports from another stub
A missing doc falls back to the first paragraph of the stub docstring. Every public stub function must be
listed or named in "omit", every public stub class listed in "classes" or "omit_classes", and every listed
name must exist, so a new or removed runtime API fails --check until the source is updated. Modules with
"stub": false (ascript.android, devtools) are copied as written.

    python3 scripts/gen_api_catalog.py           # write both copies
    python3 scripts/gen_api_catalog.py --check   # exit 1 if a copy is stale or the source has drifted
"""
from __future__ import annotations

import argparse
import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STUBS = ROOT / "ide" / "python-stubs"
SRC = ROOT / "scripts" / "api_catalog_src.json"
OUTS = (ROOT / "ide" / "mcp-server" / "xscript_mcp" / "api_catalog.json",
        ROOT / "backend" / "xscript_server" / "api_catalog.json")
DOC_MAX = 240


class CatalogError(Exception):
    pass


def _stub_tree(module: str) -> ast.Module:
    base = STUBS / module.replace(".", "/")
    for p in (base.with_suffix(".pyi"), base / "__init__.pyi"):
        if p.is_file():
            return ast.parse(p.read_text(encoding="utf-8"))
    raise CatalogError("%s: no stub under ide/python-stubs" % module)


def _first_paragraph(node: ast.AST) -> str:
    doc = (ast.get_docstring(node) or "").strip()  # type: ignore[arg-type]
    para = " ".join(doc.split("\n\n")[0].split())
    return para if len(para) <= DOC_MAX else para[:DOC_MAX - 1].rstrip() + "…"


def _signature(fn: ast.FunctionDef, hide: list[str]) -> str:
    args = fn.args
    if hide:
        missing = [h for h in hide if h not in {a.arg for a in args.args + args.kwonlyargs}]
        if missing:
            raise CatalogError("%s: hide names unknown parameters %s" % (fn.name, missing))
        args = ast.arguments(**{f: getattr(args, f) for f in args._fields})
        keep = [(a, d) for a, d in zip(args.args, [None] * (len(args.args) - len(args.defaults)) + args.defaults)
                if a.arg not in hide]
        args.args = [a for a, _ in keep]
        args.defaults = [d for _, d in keep if d is not None]
        kw = [(a, d) for a, d in zip(args.kwonlyargs, args.kw_defaults) if a.arg not in hide]
        args.kwonlyargs = [a for a, _ in kw]
        args.kw_defaults = [d for _, d in kw]
    return "%s(%s)" % (fn.name, ast.unparse(args))


def _module(spec: dict) -> dict:
    name = spec["name"]
    if not spec.get("stub", True):
        return {k: v for k, v in spec.items() if k != "stub"}
    tree = _stub_tree(name)
    fns = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef) and not n.name.startswith("_")}
    classes = {n.name for n in tree.body if isinstance(n, ast.ClassDef) and not n.name.startswith("_")}
    seen: set[str] = set()
    named: set[str] = set()
    sources: dict[str, dict[str, ast.FunctionDef]] = {}  # other stubs this module re-exports from ("from")

    def stub_fn(fname: str, source: str | None = None) -> ast.FunctionDef:
        if fname in named:
            raise CatalogError("%s.%s is listed twice" % (name, fname))
        named.add(fname)
        if source:
            if source not in sources:
                sources[source] = {n.name: n for n in _stub_tree(source).body
                                   if isinstance(n, ast.FunctionDef) and not n.name.startswith("_")}
            if fname not in sources[source]:
                raise CatalogError("%s.%s: not defined in the %s stub" % (name, fname, source))
            return sources[source][fname]
        if fname not in fns:
            raise CatalogError("%s.%s is in api_catalog_src.json but not in the stubs" % (name, fname))
        seen.add(fname)
        return fns[fname]

    out_fns = []
    for f in spec.get("functions", []):
        hide = f.get("hide", [])
        if "names" in f:
            parts, sigs, first = [], [], None
            for fname, ret in f["names"]:
                fn = stub_fn(fname, f.get("from"))
                first = first or fn
                parts.append(fname)
                sigs.append(_signature(fn, hide) + (" -> " + ret if ret else ""))
            entry = {"name": " / ".join(parts), "signature": "; ".join(sigs),
                     "doc": f.get("doc") or _first_paragraph(first)}
        else:
            fn = stub_fn(f["name"], f.get("from"))
            sig = ("@" if f.get("decorator") else "") + _signature(fn, hide)
            if f.get("returns"):
                sig += " -> " + f["returns"]
            entry = {"name": f["name"], "signature": sig, "doc": f.get("doc") or _first_paragraph(fn)}
        out_fns.append(entry)
    for fname in spec.get("omit", []):
        if fname not in fns and not any(fname in d for d in sources.values()):
            raise CatalogError("%s: omit names %s, which is not in the stubs" % (name, fname))
        seen.add(fname)
    for source, defs in sources.items():  # a module that re-exports from a stub covers all of it
        new = sorted(set(defs) - named - set(spec.get("omit", [])))
        if new:
            raise CatalogError("%s: %s functions %s are neither in the catalog nor in \"omit\"" % (name, source, new))
    new = sorted(set(fns) - seen)
    if new:
        raise CatalogError("%s: public functions %s are neither in the catalog nor in \"omit\"" % (name, new))
    listed = [c["name"] for c in spec.get("classes", [])] + spec.get("omit_classes", [])
    unknown = sorted(set(listed) - classes)
    if unknown:
        raise CatalogError("%s: classes %s are not in the stubs" % (name, unknown))
    new = sorted(classes - set(listed))
    if new:
        raise CatalogError("%s: public classes %s are neither in the catalog nor in \"omit_classes\"" % (name, new))
    out = {"name": name, "description": spec["description"], "functions": out_fns}
    if spec.get("classes"):
        out["classes"] = spec["classes"]
    if spec.get("unsupported"):
        out["unsupported"] = spec["unsupported"]
    return out


def build(src: dict | None = None) -> str:
    src = src if src is not None else json.loads(SRC.read_text(encoding="utf-8"))
    cat = {"notes": src["notes"], "modules": [_module(m) for m in src["modules"]]}
    return json.dumps(cat, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="compare only; exit 1 if stale")
    args = ap.parse_args(argv)
    try:
        text = build()
    except CatalogError as e:
        print("api catalog: %s" % e, file=sys.stderr)
        return 1
    stale = [p for p in OUTS if not p.is_file() or p.read_text(encoding="utf-8") != text]
    if args.check:
        if stale:
            print("api catalog is stale: run scripts/gen_api_catalog.py (%s)"
                  % ", ".join(str(p.relative_to(ROOT)) for p in stale), file=sys.stderr)
            return 1
        print("api catalog up to date")
        return 0
    for p in stale:
        p.write_text(text, encoding="utf-8")
    print("wrote %d file(s)" % len(stale) if stale else "api catalog up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
