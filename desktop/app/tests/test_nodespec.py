"""Node specs are declarative JSON and their templates only name real pins (design §8.7)."""
from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

jsonschema = pytest.importorskip("jsonschema")

ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT.parent
BUILTIN = ROOT / "nodes" / "builtin"
GENERATED = ROOT / "nodes" / "generated"
PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def test_builtin_specs_match_the_schema_and_do_not_share_aliases():
    schema = json.loads((ROOT / "schema" / "nodespec.schema.json").read_text())
    validator = jsonschema.Draft202012Validator(schema)
    aliases: dict[str, str] = {}
    files = sorted(BUILTIN.glob("*.json"))
    assert len(files) >= 8
    for path in files:
        spec = json.loads(path.read_text())
        validator.validate(spec)
        alias = spec["dsl"]["alias"]
        assert alias not in aliases, alias
        aliases[alias] = spec["type"]
        pins = [p["name"] for p in spec["inputs"] + spec["outputs"]]
        assert len(pins) == len(set(pins))
        execs = spec["exec"]["in"] + spec["exec"]["out"]
        assert len(execs) == len(set(execs))
        allowed = set(pins) | {"node", "id"}
        if "py" in spec:
            for name in PLACEHOLDER.findall(spec["py"]["stmt"]):
                assert name in allowed, "%s template uses unknown {%s}" % (spec["type"], name)
            assert "eval(" not in spec["py"]["stmt"] and "exec(" not in spec["py"]["stmt"]


def _generator():
    path = REPO / "scripts" / "gen_nodespecs.py"
    spec = importlib.util.spec_from_file_location("gen_nodespecs", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_generated_call_nodes_match_the_runtime_and_the_status_table():
    """Generic nodes are regenerated from xscript.android; hand specs and varargs stay out."""
    gen = _generator()
    specs, skipped = gen.collect()
    assert gen.check(specs, skipped) == []
    schema = json.loads((ROOT / "schema" / "nodespec.schema.json").read_text())
    validator = jsonschema.Draft202012Validator(schema)
    aliases = {}
    for path in sorted(BUILTIN.glob("*.json")):
        spec = json.loads(path.read_text())
        aliases[spec["dsl"]["alias"]] = spec["type"]
    files = sorted(p for p in GENERATED.glob("*.json") if not p.name.startswith("_"))
    assert len(files) == len(specs) and len(files) > 100
    builtin_types = {p.stem for p in BUILTIN.glob("*.json")}
    for path in files:
        spec = json.loads(path.read_text())
        validator.validate(spec)
        assert spec["type"] not in builtin_types
        alias = spec["dsl"]["alias"]
        assert alias not in aliases, alias
        aliases[alias] = spec["type"]
        pins = [p["name"] for p in spec["inputs"] + spec["outputs"]]
        assert len(pins) == len(set(pins))
        allowed = set(pins) | {"node", "id"}
        for name in PLACEHOLDER.findall(spec["py"]["stmt"]):
            pin = name[2:] if name.startswith("p_") else name
            assert name in allowed or pin in pins, spec["type"]
        assert "eval(" not in spec["py"]["stmt"] and ".exec(" not in spec["py"]["stmt"]
    swipe = json.loads((GENERATED / "action.swipe.json").read_text())
    assert swipe["py"]["stmt"] == "{id} = action.swipe({x1}, y1={y1}, x2={x2}, y2={y2}, dur={dur})"
    assert swipe["inputs"][-1]["default"] == 300
    within = json.loads((GENERATED / "node.Selector.within.json").read_text())
    assert within["py"]["stmt"] == "{id} = node.Selector.within({p_node})"
    assert not (GENERATED / "action.click.json").exists()
    rows = gen.status_rows((REPO / "docs" / "功能对照.md").read_text(encoding="utf-8"))
    assert gen.availability_for("action.Hid.click", rows) == "partial"
    assert gen.availability_for("screen.vlm.ask", rows) == "ok"  # AI 识屏 ✅ since screen.ai_find
    assert gen.availability_for("action.swipe", rows) == "ok"
    assert gen.availability_for("service.db.query", rows) == "hidden"
    assert {item["origin"] for item in skipped} >= {"xscript.android.event.on", "xscript.android.event.wait"}
    assert {item["reason"] for item in skipped} == {"varargs"}


def test_gen_nodespecs_check_exits_clean():
    """The CI entry point reports the generated tree as current."""
    proc = subprocess.run([sys.executable, str(REPO / "scripts" / "gen_nodespecs.py"), "--check"], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
