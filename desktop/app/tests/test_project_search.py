"""project.search: the pure helpers and the RPC against scripts/mock_device.py."""
from __future__ import annotations

import pytest

from xscript_desktop.services import project_search as ps

from .conftest import FakeAdb
from .test_context import make_ctx, rpc


def test_searchable_files():
    assert ps.is_searchable("main.py", 10)
    assert ps.is_searchable("res/conf.JSON", 10)
    assert ps.is_searchable("LICENSE", 10)
    assert not ps.is_searchable("res/img/btn.png", 10)
    assert not ps.is_searchable("big.py", ps.MAX_FILE_BYTES + 1)


@pytest.mark.parametrize("query,regex,err", [("", False, "empty"), ("   ", False, "empty"), ("x" * 201, False, "longer"),
                                             ("(", True, "invalid regular expression")])
def test_bad_queries(query, regex, err):
    with pytest.raises(ValueError, match=err):
        ps.compile_query(query, regex)


def test_plain_text_is_literal_and_case_insensitive_by_default():
    pat = ps.compile_query("a.b(")
    got = ps.search_text("x.py", "A.B( here\naxb(\n", pat)
    assert [(m["line"], m["column"], m["length"]) for m in got] == [(1, 1, 4)]
    assert ps.search_text("x.py", "A.B(", ps.compile_query("a.b(", case_sensitive=True)) == []


def test_regex_several_matches_per_line_and_empty_matches_skipped():
    got = ps.search_text("x.py", "click(1); click(22)\n", ps.compile_query(r"click\(\d+\)", regex=True))
    assert [(m["column"], m["length"]) for m in got] == [(1, 8), (11, 9)]
    assert ps.search_text("x.py", "a\nb\n", ps.compile_query("^", regex=True)) == []


def test_long_lines_are_shortened_around_the_match():
    line = "x" * 300 + "NEEDLE" + "y" * 300
    m = ps.search_text("x.py", line, ps.compile_query("needle"))[0]
    assert m["column"] == 301
    assert m["text"].startswith("…") and m["text"].endswith("…")
    assert m["text"][m["offset"]:m["offset"] + m["length"]] == "NEEDLE"
    assert len(m["text"]) <= 2 * ps.CONTEXT + 6 + 2


def test_limit():
    assert len(ps.search_text("x.py", "a\n" * 10, ps.compile_query("a"), limit=3)) == 3


@pytest.fixture()
async def ctx_dev(mock_device):
    ctx = make_ctx(FakeAdb([("emulator-5554", "device", mock_device)]))
    con = await rpc(ctx, "device.connect", transport="adb", serial="emulator-5554")
    assert con["ok"], con
    try:
        yield ctx, "adb:emulator-5554"
    finally:
        await ctx.shutdown()


async def test_rpc_search(ctx_dev):
    ctx, dev = ctx_dev
    await rpc(ctx, "project.create", id=dev, project="s1")
    await rpc(ctx, "project.write", id=dev, project="s1", path="__init__.py", content="from .util import tap\ntap(1)\n")
    await rpc(ctx, "project.write", id=dev, project="s1", path="util.py", content="def tap(n):\n    print('TAP', n)\n")
    r = await rpc(ctx, "project.search", id=dev, project="s1", query="tap")
    assert r["ok"], r
    res = r["result"]
    got = sorted((m["path"], m["line"], m["column"]) for m in res["matches"])
    assert got == [("__init__.py", 1, 19), ("__init__.py", 2, 1), ("util.py", 1, 5), ("util.py", 2, 12)]
    assert res["filesSearched"] == 2 and not res["truncated"]
    r = await rpc(ctx, "project.search", id=dev, project="s1", query="TAP", caseSensitive=True)
    assert [(m["path"], m["line"]) for m in r["result"]["matches"]] == [("util.py", 2)]


async def test_rpc_search_rejects_bad_regex(ctx_dev):
    ctx, dev = ctx_dev
    r = await rpc(ctx, "project.search", id=dev, project="s1", query="(", regex=True)
    assert r["error"]["code"] == "rpc.bad_params"
