"""The flow document schema matches the sign-in example in the design (§8.3)."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

jsonschema = pytest.importorskip("jsonschema")

ROOT = Path(__file__).resolve().parents[2] / "schema"
ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def test_signin_example_matches_the_schema_and_has_no_secret_values():
    schema = json.loads((ROOT / "xflow.schema.json").read_text())
    doc = json.loads((ROOT / "examples" / "daily_signin.xflow.json").read_text())
    jsonschema.Draft202012Validator(schema).validate(doc)
    assert doc["xflow"] == 1
    ids = [n["id"] for n in doc["nodes"]]
    assert ids == sorted(ids) and len(ids) == len(set(ids))
    pairs = [(e["from"], e["to"]) for e in doc["edges"]]
    assert pairs == sorted(pairs)
    assert all(ID.fullmatch(i) for i in ids)
    blob = json.dumps(doc)
    assert "secret" not in blob
    layout = {
        "xflowLayout": 1,
        "viewport": {"x": 0, "y": 0, "zoom": 0.8},
        "nodes": {"start": {"x": 0, "y": 0}, "attempt": {"x": 880, "y": 0, "collapsed": False}},
    }
    layout_schema = json.loads((ROOT / "xflow.layout.schema.json").read_text())
    jsonschema.Draft202012Validator(layout_schema).validate(layout)


def test_schema_rejects_a_coordinate_smuggled_into_the_semantic_file():
    schema = json.loads((ROOT / "xflow.schema.json").read_text())
    doc = json.loads((ROOT / "examples" / "daily_signin.xflow.json").read_text())
    doc["nodes"][0]["x"] = 10
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.Draft202012Validator(schema).validate(doc)
