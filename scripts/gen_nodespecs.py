#!/usr/bin/env python3
"""通用节点规格生成器（设计 §8.7）。

用 ast 读 ``android/python-runtime/xscript/android`` 的公开函数和类方法，
写出 ``desktop/nodes/generated/<type>.json``。规格是声明式 JSON，不是可执行代码。

``desktop/nodes/builtin/`` 里同 type 的手写规格是 overlay，生成器跳过它们。
带 ``*args`` / ``**kwargs`` 的函数没有稳定引脚，记在 ``_skipped.json``，不硬编一个错误模板。

``availability`` 用 ``docs/功能对照.md`` 第 2 节状态表里、状态列前一格的路径做最长前缀匹配
（✅ ok、🟡 partial、⛔ stub、🚫/❌ hidden）。对不上的函数在运行时里真实存在，标 ok。

``--check`` 只比对，不写盘。
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "android" / "python-runtime" / "xscript" / "android"
BUILTIN = ROOT / "desktop" / "nodes" / "builtin"
OUT = ROOT / "desktop" / "nodes" / "generated"
STATUS_DOC = ROOT / "docs" / "功能对照.md"
SINCE = "0.2.6"

_ANN = {
    "str": "string",
    "int": "int",
    "float": "float",
    "bool": "bool",
    "list": "list",
    "List": "list",
    "dict": "any",
    "Dict": "any",
    "Any": "any",
}
_UI = {"string": "text", "int": "number", "float": "number", "bool": "toggle"}
_STATUS = {"✅": "ok", "🟡": "partial", "⛔": "stub", "🚫": "hidden", "❌": "hidden"}
_RANK = {"ok": 0, "partial": 1, "stub": 2, "hidden": 3}
_RESERVED_PIN = {"node", "id"}


def builtin_types() -> set[str]:
    if not BUILTIN.is_dir():
        return set()
    return {p.stem for p in BUILTIN.glob("*.json")}


def _ann(node: ast.expr | None) -> str:
    if isinstance(node, ast.Name):
        return _ANN.get(node.id, "any")
    if isinstance(node, ast.Constant) and node.value is None:
        return "any"
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name):
        return _ANN.get(node.value.id, "any")
    return "any"


def _return_type(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> str | None:
    ann = fn.returns
    if ann is None:
        return "any"
    if isinstance(ann, ast.Constant) and ann.value is None:
        return None
    if isinstance(ann, ast.Name) and ann.id == "None":
        return None
    return _ann(ann)


def _literal(node: ast.expr) -> tuple[bool, object]:
    try:
        value = ast.literal_eval(node)
    except (ValueError, SyntaxError):
        return False, None
    if value is None or isinstance(value, (bool, int, float, str)):
        return True, value
    return False, None


def _pin(arg: ast.arg, default: ast.expr | None) -> dict:
    kind = _ann(arg.annotation)
    pin: dict = {"name": arg.arg, "type": kind}
    ui = _UI.get(kind)
    if ui:
        pin["ui"] = ui
    if default is not None:
        ok, value = _literal(default)
        if ok:
            pin["default"] = value
    return pin


def _params(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> list[dict] | None:
    a = fn.args
    if a.vararg or a.kwarg:
        return None
    raw = [*a.posonlyargs, *a.args]
    defaults = list(a.defaults)
    pins: list[dict] = []
    for arg in raw:
        if arg.arg in ("self", "cls"):
            continue
        di = raw.index(arg) - (len(raw) - len(defaults))
        pins.append(_pin(arg, defaults[di] if di >= 0 else None))
    for arg, default in zip(a.kwonlyargs, a.kw_defaults):
        if arg.arg in ("self", "cls"):
            continue
        pins.append(_pin(arg, default))
    return pins


def _doc(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    text = ast.get_docstring(fn) or ""
    line = text.strip().splitlines()[0].strip() if text.strip() else ""
    return line or fn.name


def _hole(name: str) -> str:
    # `{node}` / `{id}` 在模板里是节点 id。同名引脚改用 `{p_node}`。
    if name in _RESERVED_PIN:
        return "{p_" + name + "}"
    return "{" + name + "}"


def _spec(module: str, qual: str, fn: ast.FunctionDef | ast.AsyncFunctionDef, params: list[dict], availability: str) -> dict:
    type_id = f"{module}.{qual}"
    call_args = []
    for i, pin in enumerate(params):
        hole = _hole(pin["name"])
        call_args.append(hole if i == 0 else f"{pin['name']}={hole}")
    call = f"{module}.{qual}({', '.join(call_args)})"
    returned = _return_type(fn)
    outputs = [] if returned is None else [{"name": "value" if any(p["name"] == "result" for p in params) else "result", "type": returned}]
    stmt = call if returned is None else "{id} = " + call
    doc = _doc(fn)
    latent = "wait" in fn.name or fn.name == "sleep" or any(p["name"] == "timeout" for p in params)
    spec = {
        "type": type_id,
        "category": module,
        "title": {"zh": type_id, "en": type_id},
        "doc": {"zh": doc, "en": doc},
        "exec": {"in": ["exec"], "out": ["then"]},
        "inputs": params,
        "outputs": outputs,
        "py": {"imports": [f"from xscript.android import {module}"], "stmt": stmt},
        "dsl": {"alias": type_id},
        "since": SINCE,
        "origin": f"xscript.android.{module}.{qual}",
        "availability": availability,
    }
    if latent:
        spec["latent"] = True
        # 插到 schema 示例的位置附近：title 之后、exec 之前。上面字面量顺序已固定，latent 放最后也能过 schema。
    return spec


def _segments(path: str) -> list[str]:
    path = path.strip().strip("`").replace("\\", "/")
    path = re.sub(r"\*+$", "", path).strip("/")
    if not path or re.search(r"\s", path):
        return []
    parts = []
    for seg in path.replace("/", ".").split("."):
        seg = re.sub(r"[^a-z0-9]", "", seg.replace("_", "").replace("-", "").lower())
        if seg:
            parts.append(seg)
    return parts


def status_rows(text: str) -> list[tuple[list[str], str]]:
    """功能对照表里「状态列前一格」的路径。最长前缀匹配用。"""
    rows: list[tuple[list[str], str]] = []
    for line in text.splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        status_i = next((i for i, cell in enumerate(cells) if any(cell.startswith(m) for m in _STATUS)), None)
        if status_i is None or status_i == 0:
            continue
        status = next(name for mark, name in _STATUS.items() if cells[status_i].startswith(mark))
        for raw in re.findall(r"`([^`]+)`", cells[status_i - 1]):
            seg = _segments(raw)
            if seg:
                rows.append((seg, status))
    return rows


def availability_for(type_id: str, rows: list[tuple[list[str], str]]) -> str:
    segs = _segments(type_id)
    best = "ok"
    best_len = 0
    best_rank = -1
    for path, status in rows:
        if not path or len(path) > len(segs) or segs[: len(path)] != path:
            continue
        rank = _RANK[status]
        if len(path) > best_len or (len(path) == best_len and rank > best_rank):
            best = status
            best_len = len(path)
            best_rank = rank
    return best


def collect(rows: list[tuple[list[str], str]] | None = None) -> tuple[dict[str, dict], list[dict]]:
    if rows is None:
        rows = status_rows(STATUS_DOC.read_text(encoding="utf-8")) if STATUS_DOC.is_file() else []
    skip_types = builtin_types()
    specs: dict[str, dict] = {}
    skipped: list[dict] = []
    for path in sorted(SRC.glob("*.py")):
        if path.name == "__init__.py":
            continue
        module = path.stem
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name.startswith("_"):
                    continue
                _add(specs, skipped, skip_types, rows, module, node.name, node)
            elif isinstance(node, ast.ClassDef):
                if node.name.startswith("_"):
                    continue
                for item in node.body:
                    if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        continue
                    if item.name.startswith("_"):
                        continue
                    _add(specs, skipped, skip_types, rows, module, f"{node.name}.{item.name}", item)
    skipped.sort(key=lambda item: item["origin"])
    return specs, skipped


def _add(specs, skipped, skip_types, rows, module, qual, fn) -> None:
    type_id = f"{module}.{qual}"
    origin = f"xscript.android.{module}.{qual}"
    if type_id in skip_types:
        return
    params = _params(fn)
    if params is None:
        skipped.append({"origin": origin, "reason": "varargs"})
        return
    specs[type_id] = _spec(module, qual, fn, params, availability_for(type_id, rows))


def dumps(data: object) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def emit(specs: dict[str, dict], skipped: list[dict]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    wanted = {f"{type_id}.json" for type_id in specs} | {"_skipped.json"}
    for name in OUT.glob("*.json"):
        if name.name not in wanted:
            name.unlink()
    for type_id, spec in specs.items():
        (OUT / f"{type_id}.json").write_text(dumps(spec), encoding="utf-8")
    (OUT / "_skipped.json").write_text(dumps(skipped), encoding="utf-8")


def check(specs: dict[str, dict], skipped: list[dict]) -> list[str]:
    problems = []
    wanted = {f"{type_id}.json" for type_id in specs}
    have = {p.name for p in OUT.glob("*.json")} - {"_skipped.json"} if OUT.is_dir() else set()
    for name in sorted(wanted - have):
        problems.append(f"missing {name}")
    for name in sorted(have - wanted):
        problems.append(f"stale {name}")
    for type_id, spec in specs.items():
        path = OUT / f"{type_id}.json"
        if path.is_file() and path.read_text(encoding="utf-8") != dumps(spec):
            problems.append(f"outdated {type_id}.json")
    skip_path = OUT / "_skipped.json"
    if not skip_path.is_file():
        problems.append("missing _skipped.json")
    elif skip_path.read_text(encoding="utf-8") != dumps(skipped):
        problems.append("outdated _skipped.json")
    return problems


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--check", action="store_true")
    args = p.parse_args(argv)
    specs, skipped = collect()
    if args.check:
        problems = check(specs, skipped)
        if problems:
            print("\n".join(problems), file=sys.stderr)
            return 1
        print(f"ok {len(specs)} generated, {len(skipped)} skipped")
        return 0
    emit(specs, skipped)
    print(f"wrote {len(specs)} specs, skipped {len(skipped)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
