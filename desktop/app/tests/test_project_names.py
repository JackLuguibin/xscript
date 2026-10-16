from __future__ import annotations

import sys

import pytest

from xscript_desktop.services.project_names import validate_project_name as v


@pytest.mark.parametrize("name", ["daily_signin", "签到", "demo2", "_private", "Flow", "ok_2"])
def test_valid_names(name):
    r = v(name)
    assert r.ok and r.code == "" and bool(r)


@pytest.mark.parametrize("name, code", [
    ("", "name.empty"),
    ("x" * 65, "name.too_long"),
    ("1abc", "name.syntax"), ("a-b", "name.syntax"), ("a b", "name.syntax"), ("a.b", "name.syntax"), ("a/b", "name.syntax"), ("../x", "name.syntax"),
    ("__init__", "name.dunder"),
    ("class", "name.keyword"), ("lambda", "name.keyword"),
    ("json", "name.stdlib"), ("random", "name.stdlib"), ("colorsys", "name.stdlib"), ("os", "name.stdlib"), ("sys", "name.stdlib"),  # measured on both emulators: shadows the stdlib
    ("xscript", "name.reserved"), ("ascript", "name.reserved"), ("numpy", "name.reserved"), ("NumPy", "name.reserved"), ("cv2", "name.reserved"),
    ("CON", "name.windows"), ("nul", "name.windows"), ("COM1", "name.windows"), ("lpt9", "name.windows"),
])
def test_refused_names(name, code):
    r = v(name)
    assert not r.ok and r.code == code and r.message and not bool(r)


def test_existing_names_are_compared_case_insensitively():
    assert v("Demo", ["demo"]).code == "name.exists"
    assert v("demo2", ["demo"]).ok


def test_non_nfc_and_non_string_are_refused():
    assert v("e\u0301").code == "name.syntax"  # decomposed é
    assert v(None).code == "name.empty"  # type: ignore[arg-type]


def test_every_stdlib_module_name_is_refused():
    names = [n for n in sys.stdlib_module_names if n.isidentifier() and not n.startswith("_")]
    assert names and all(v(n).code in ("name.stdlib", "name.keyword", "name.windows", "name.reserved") for n in names)
