"""Local folder sync: the port of ide/vscode-extension/src/sync.ts (same cases as its sync.test.ts) + the sync.* RPCs
against scripts/mock_device.py."""
from __future__ import annotations

import json

import pytest

from xscript_desktop.context import AppContext
from xscript_desktop.services import sync as s

from .conftest import FakeAdb
from .test_context import make_ctx, rpc


def test_syncignore_same_cases_as_vscode_extension():
    r = s.IgnoreRules("# c\n*.log\n/build/\ndocs/*.md\n**/tmp/\n!keep.log\nsecret?.txt\n\n!\n/\n")
    assert r.ignores("a.log", False) and r.ignores("sub/b.log", False)
    assert not r.ignores("keep.log", False)
    assert r.ignores("build", True) and not r.ignores("build", False) and not r.ignores("lib/build", True)
    assert r.ignores("docs/readme.md", False) and not r.ignores("docs/deep/readme.md", False)
    assert r.ignores("x/y/tmp", True)
    assert r.ignores("secret1.txt", False) and not r.ignores("secret12.txt", False)
    assert s.IgnoreRules("a**b\nx+y.py\n").ignores("a/q/b", False) and s.IgnoreRules("x+y.py").ignores("x+y.py", False)


def test_collect_files_skips_and_encodes(tmp_path):
    (tmp_path / "__init__.py").write_text("print(1)\n")
    (tmp_path / "lib").mkdir()
    (tmp_path / "lib" / "a.py").write_text("A = '中'\n", "utf-8")
    (tmp_path / "img.png").write_bytes(b"\x89PNG\x00\xff")
    (tmp_path / "bad.txt").write_bytes(b"\xff\xfe")
    for skip in ("__pycache__", "node_modules", ".git", "venv"):
        (tmp_path / skip).mkdir()
        (tmp_path / skip / "x.py").write_text("x")
    (tmp_path / "m.pyc").write_bytes(b"x")
    (tmp_path / ".hidden").write_text("x")
    (tmp_path / "out.log").write_text("x")
    (tmp_path / ".vscode").mkdir()
    (tmp_path / ".vscode" / ".syncignore").write_text("*.log\n")
    files = s.collect_files(tmp_path, s.load_ignore_rules(tmp_path))
    assert [f.path for f in files] == ["__init__.py", "bad.txt", "img.png", "lib/a.py"]
    bodies = {f.path: f.upload_body() for f in files}
    assert bodies["lib/a.py"] == {"path": "lib/a.py", "content": "A = '中'\n", "encoding": "utf-8"}
    assert bodies["img.png"]["encoding"] == "base64" and bodies["bad.txt"]["encoding"] == "base64"
    assert s.load_ignore_rules(tmp_path / "nope").rules == []


def test_collect_files_refuses_huge_folders(tmp_path, monkeypatch):
    monkeypatch.setattr(s, "MAX_FILES", 2)
    for i in range(4):
        (tmp_path / ("f%d.py" % i)).write_text("x")
    with pytest.raises(s.SyncError) as e:
        s.collect_files(tmp_path)
    assert e.value.code == "sync.too_large"


def test_plan_upload_same_rules_as_vscode_extension(tmp_path):
    (tmp_path / "__init__.py").write_text("print(1)\n")
    (tmp_path / "b.py").write_text("B = 1\n")
    files = s.collect_files(tmp_path)
    first = s.plan_upload(files, None, {})
    assert len(first.upload) == 2  # project missing on the device: everything goes
    remote = [{"path": f.path, "size": len(f.data)} for f in files]
    assert len(s.plan_upload(files, remote, {}).upload) == 2  # no cache: everything goes
    same = s.plan_upload(files, remote, first.hashes)
    assert same.upload == [] and same.skipped == ["__init__.py", "b.py"]
    (tmp_path / "b.py").write_text("B = 2\n")  # same size, new content
    assert [f.path for f in s.plan_upload(s.collect_files(tmp_path), remote, first.hashes).upload] == ["b.py"]
    assert [f.path for f in s.plan_upload(files, [r for r in remote if r["path"] != "b.py"], first.hashes).upload] == ["b.py"]
    resized = [dict(r, size=99) if r["path"] == "b.py" else r for r in remote]
    assert [f.path for f in s.plan_upload(files, resized, first.hashes).upload] == ["b.py"]
    assert first.summary()["bytes"] == 15


def test_batches_split_by_size():
    fs = [s.LocalFile("f%d" % i, b"x" * 40) for i in range(5)]
    assert [len(b) for b in s.batches(fs, 100)] == [2, 2, 1]
    assert s.batches([], 100) == []
    assert [len(b) for b in s.batches([s.LocalFile("big", b"x" * 500)], 100)] == [1]


@pytest.mark.parametrize("bad", ["", "/a", "../a", "a/../b", "a//b", "a\\b", "./a"])
def test_safe_relative(bad):
    assert not s.safe_relative(bad)
    assert s.safe_relative("lib/a.py")


def test_pull_diff_and_write_only_changes(tmp_path):
    (tmp_path / "same.py").write_bytes(b"1")
    (tmp_path / "chg.py").write_bytes(b"old")
    (tmp_path / "local_only.py").write_bytes(b"keep")
    pulled = [("same.py", b"1"), ("chg.py", b"new"), ("sub/new.py", b"n"), ("../evil.py", b"x")]
    d = s.diff_against_local(tmp_path, pulled[:3])
    assert d == {"added": ["sub/new.py"], "changed": ["chg.py"], "unchanged": ["same.py"]}
    d["added"].append("../evil.py")
    assert s.write_pulled(tmp_path, pulled, d) == 2
    assert (tmp_path / "chg.py").read_bytes() == b"new" and (tmp_path / "sub" / "new.py").read_bytes() == b"n"
    assert (tmp_path / "local_only.py").read_bytes() == b"keep"
    assert not (tmp_path.parent / "evil.py").exists()


def test_sync_cache_persists_and_survives_garbage(tmp_path):
    p = tmp_path / "c" / "sync-cache.json"
    c = s.SyncCache(p)
    c.put("dev:proj", {"a.py": "h"})
    assert s.SyncCache(p).get("dev:proj") == {"a.py": "h"}
    p.write_text("not json")
    assert s.SyncCache(p).get("dev:proj") == {}
    p.write_text(json.dumps({"k": 1, "ok": {"x": "y"}}))
    assert s.SyncCache(p).get("k") == {} and s.SyncCache(p).get("ok") == {"x": "y"}
    mem = s.SyncCache(None)
    mem.put("k", {"a": "b"})
    assert mem.get("k") == {"a": "b"}


# ---- RPC --------------------------------------------------------------------------------------------------------------------------------


@pytest.fixture()
async def dev(mock_device, tmp_path):
    ctx = make_ctx(FakeAdb([("emulator-5554", "device", mock_device)]))
    ctx.sync_cache = s.SyncCache(tmp_path / "state" / "sync-cache.json")
    assert (await rpc(ctx, "device.connect", transport="adb", serial="emulator-5554"))["ok"]
    try:
        yield ctx, "adb:emulator-5554"
    finally:
        await ctx.shutdown()


def make_project(root):
    root.mkdir()
    (root / "__init__.py").write_text("print('hi')\n")
    (root / "lib").mkdir()
    (root / "lib" / "util.py").write_text("U = 1\n")
    (root / "res.bin").write_bytes(bytes(range(256)))
    return root


async def test_rpc_upload_incremental_then_pull(dev, tmp_path):
    ctx, d = dev
    root = make_project(tmp_path / "proj")
    events: list = []
    ctx.dispatcher.set_event_sink(lambda t, data: events.append((t, data)))
    pv = (await rpc(ctx, "sync.preview", id=d, project="synced", dir=str(root)))["result"]
    assert pv["upload"] == ["__init__.py", "lib/util.py", "res.bin"] and pv["skipped"] == []
    up = (await rpc(ctx, "sync.upload", id=d, project="synced", dir=str(root)))["result"]
    assert up["uploaded"] == 3 and events[-1][0] == "sync.progress" and events[-1][1]["sent"] == 3
    again = (await rpc(ctx, "sync.upload", id=d, project="synced", dir=str(root)))["result"]
    assert again["uploaded"] == 0 and len(again["skipped"]) == 3
    (root / "lib" / "util.py").write_text("U = 2\n")
    assert (await rpc(ctx, "sync.preview", id=d, project="synced", dir=str(root)))["result"]["upload"] == ["lib/util.py"]
    assert len((await rpc(ctx, "sync.preview", id=d, project="synced", dir=str(root), full=True))["result"]["upload"]) == 3
    r = (await rpc(ctx, "project.read", id=d, project="synced", path="res.bin"))["result"]
    assert r["encoding"] == "base64"
    # pull into an empty folder, then nothing changes on a second pull
    dest = tmp_path / "pulled"
    dest.mkdir()
    dry = (await rpc(ctx, "sync.pull", id=d, project="synced", dir=str(dest), dryRun=True))["result"]
    assert dry["written"] == 0 and sorted(dry["added"]) == ["__init__.py", "lib/util.py", "res.bin"] and not (dest / "__init__.py").exists()
    pulled = (await rpc(ctx, "sync.pull", id=d, project="synced", dir=str(dest)))["result"]
    assert pulled["written"] == 3 and (dest / "res.bin").read_bytes() == bytes(range(256))
    assert (await rpc(ctx, "sync.pull", id=d, project="synced", dir=str(dest)))["result"]["written"] == 0


async def test_rpc_sync_errors(dev, tmp_path):
    ctx, d = dev
    notproj = tmp_path / "np"
    notproj.mkdir()
    assert (await rpc(ctx, "sync.preview", id=d, project="x", dir=str(notproj)))["error"]["code"] == "sync.not_project"
    assert (await rpc(ctx, "sync.preview", id=d, project="x", dir=str(tmp_path / "missing")))["error"]["code"] == "sync.no_dir"
    assert (await rpc(ctx, "sync.preview", id=d, project="x", dir="relative/dir"))["error"]["code"] == "rpc.bad_params"
    assert (await rpc(ctx, "sync.pull", id=d, project="nope_never", dir=str(notproj)))["error"]["code"] == "sync.no_project"


async def test_pick_directory_hook():
    ctx = AppContext(adb=None, poll_interval=60)
    assert (await rpc(ctx, "app.pickDirectory"))["error"]["code"] == "app.unavailable"

    async def pick(title):
        return "/tmp/chosen:" + title

    ctx.pick_directory = pick
    assert (await rpc(ctx, "app.pickDirectory", title="t"))["result"] == {"path": "/tmp/chosen:t"}


def test_app_context_data_dir_holds_the_cache(tmp_path):
    ctx = AppContext(adb=None, poll_interval=60, data_dir=tmp_path)
    assert ctx.store.path == tmp_path / "desktop.db"
    ctx.store.close()
