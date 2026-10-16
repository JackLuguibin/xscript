"""Build src/generated/stub-completions.json from ide/python-stubs (the same data the VS Code extension ships).

Run: python3 scripts/gen_stub_completions.py [--check]. Pure stdlib (ast); output is deterministic.
"""
from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUBS = HERE.parents[2] / "ide" / "python-stubs"
OUT = HERE.parent / "src" / "generated" / "stub-completions.json"


def _sig(fn: ast.FunctionDef | ast.AsyncFunctionDef, drop_self: bool) -> str:
    args = ast.unparse(fn.args)
    if drop_self:
        parts = [a.strip() for a in args.split(",")] if args else []
        if parts and parts[0] in ("self", "cls"):
            parts = parts[1:]
        args = ", ".join(parts)
    return "%s(%s)" % (fn.name, args)


def _doc(node: ast.AST) -> str:
    d = ast.get_docstring(node) or ""  # type: ignore[arg-type]
    return d.strip()[:600]


def _members(body: list[ast.stmt], in_class: bool) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for n in body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and not n.name.startswith("_"):
            out[n.name] = {"kind": "method" if in_class else "function", "detail": _sig(n, in_class), "doc": _doc(n)}
        elif isinstance(n, ast.ClassDef) and not n.name.startswith("_"):
            out[n.name] = {"kind": "class", "detail": "class " + n.name, "doc": _doc(n), "members": _members(n.body, True)}
        elif isinstance(n, (ast.Assign, ast.AnnAssign)):
            targets = n.targets if isinstance(n, ast.Assign) else [n.target]
            for t in targets:
                if isinstance(t, ast.Name) and not t.id.startswith("_") and t.id != "__all__":
                    out[t.id] = {"kind": "variable", "detail": t.id, "doc": ""}
    return out


def build() -> dict:
    modules: dict[str, dict] = {}
    for f in sorted(STUBS.rglob("*.pyi")):
        rel = f.relative_to(STUBS).with_suffix("")
        parts = list(rel.parts)
        if parts[-1] == "__init__":
            parts = parts[:-1]
        name = ".".join(parts)
        tree = ast.parse(f.read_text("utf-8"))
        members = _members(tree.body, False)
        for n in tree.body:  # re-exports: `from x import a, b` in a package __init__
            if isinstance(n, ast.ImportFrom) and n.module and n.level == 0 and n.module.split(".")[0] in ("xscript", "ascript"):
                for a in n.names:
                    nm = a.asname or a.name
                    if not nm.startswith("_") and nm not in members:
                        members[nm] = {"kind": "ref", "detail": "%s.%s" % (n.module, a.name), "doc": ""}
        modules[name] = {"doc": _doc(tree), "members": members}
    return {"modules": modules}


def main() -> int:
    text = json.dumps(build(), ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    if "--check" in sys.argv:
        ok = OUT.exists() and OUT.read_text("utf-8") == text
        print("stub completions up to date" if ok else "stub completions are stale: run scripts/gen_stub_completions.py")
        return 0 if ok else 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, "utf-8")
    print("wrote %s (%d modules)" % (OUT, len(json.loads(text)["modules"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
