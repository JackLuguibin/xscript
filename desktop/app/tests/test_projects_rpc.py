"""project.* / device.logs / device.action / device.eval RPC methods against scripts/mock_device.py."""
from __future__ import annotations

import pytest

from xscript_desktop.services.device_client import DeviceClient

from .conftest import FakeAdb
from .test_context import make_ctx, rpc


@pytest.fixture()
async def ctx_dev(mock_device):
    ctx = make_ctx(FakeAdb([("emulator-5554", "device", mock_device)]))
    con = await rpc(ctx, "device.connect", transport="adb", serial="emulator-5554")
    assert con["ok"], con
    try:
        yield ctx, "adb:emulator-5554"
    finally:
        await ctx.shutdown()


async def test_create_list_files_read_write(ctx_dev):
    ctx, dev = ctx_dev
    assert (await rpc(ctx, "project.create", id=dev, project="demo_x"))["ok"]
    names = [p.get("name") for p in (await rpc(ctx, "project.list", id=dev))["result"]["projects"]]
    assert "demo_x" in names
    w = await rpc(ctx, "project.write", id=dev, project="demo_x", path="utils/net.py", content="X = 1\n")
    assert w["ok"], w
    files = (await rpc(ctx, "project.files", id=dev, project="demo_x"))["result"]
    assert {f["path"] for f in files["files"]} >= {"__init__.py", "utils/net.py"} and "utils" in files["dirs"]
    r = (await rpc(ctx, "project.read", id=dev, project="demo_x", path="utils/net.py"))["result"]
    assert r["content"] == "X = 1\n" and r["encoding"] == "utf-8"


async def test_create_only_conflict_is_http_error(ctx_dev):
    ctx, dev = ctx_dev
    await rpc(ctx, "project.create", id=dev, project="demo_y")
    r = await rpc(ctx, "project.write", id=dev, project="demo_y", path="__init__.py", content="", create=True)
    assert not r["ok"] and r["error"]["code"] == "device.http" and r["error"]["details"]["status"] == 409


@pytest.mark.parametrize("bad", ["", "/abs.py", "../x.py", "a//b.py", "a/./b.py", "a\\b.py"])
async def test_path_validation(ctx_dev, bad):
    ctx, dev = ctx_dev
    r = await rpc(ctx, "project.read", id=dev, project="demo", path=bad)
    assert r["error"]["code"] == "rpc.bad_params"


async def test_write_rejects_bad_encoding_and_huge(ctx_dev):
    ctx, dev = ctx_dev
    assert (await rpc(ctx, "project.write", id=dev, project="p", path="a.py", content="", encoding="latin1"))["error"]["code"] == "rpc.bad_params"
    big = "x" * (2 * 1024 * 1024 + 1)
    assert (await rpc(ctx, "project.write", id=dev, project="p", path="a.py", content=big))["error"]["code"] in ("rpc.too_large",)


async def test_run_logs_stop(ctx_dev):
    ctx, dev = ctx_dev
    events: list = []
    ctx.dispatcher.set_event_sink(lambda t, d: events.append((t, d)))
    await rpc(ctx, "project.create", id=dev, project="runme")
    run = await rpc(ctx, "project.run", id=dev, project="runme")
    assert run["ok"] and run["result"]["running"] is True
    assert ctx.devices.get(dev).status.get("running")
    assert any(t == "device.state" and d["status"].get("running") for t, d in events)
    again = await rpc(ctx, "project.run", id=dev, project="runme")  # 409 is passed through, not an error
    assert again["ok"] and again["result"].get("error") == "already running"
    logs = (await rpc(ctx, "device.logs", id=dev, since=0))["result"]
    assert logs["entries"] and logs["next"] >= logs["entries"][-1]["seq"]
    later = (await rpc(ctx, "device.logs", id=dev, since=logs["next"]))["result"]
    assert later["entries"] == [] and later["next"] == logs["next"]
    assert (await rpc(ctx, "device.logs", id=dev, since=-1))["error"]["code"] == "rpc.bad_params"
    stop = await rpc(ctx, "project.stop", id=dev, project="runme")
    assert stop["ok"] and stop["result"]["running"] is False


async def test_action_validation_and_forwarding(ctx_dev):
    ctx, dev = ctx_dev
    assert (await rpc(ctx, "device.action", id=dev, type="click", x=10, y=20))["ok"]
    assert (await rpc(ctx, "device.action", id=dev, type="key", name="home"))["ok"]
    assert (await rpc(ctx, "device.action", id=dev, type="rm -rf"))["error"]["code"] == "rpc.bad_params"
    assert (await rpc(ctx, "device.action", id=dev, type="click", x="10"))["error"]["code"] == "rpc.bad_params"


async def test_eval_validation_and_forwarding(ctx_dev):
    """Flow step-run: the snippet goes to POST /eval as-is, the answer comes back as {ok, result, error}."""
    ctx, dev = ctx_dev
    r = await rpc(ctx, "device.eval", id=dev, code="_result = 1 + 1", timeoutMs=3000)
    assert r["ok"], r
    assert r["result"] == {"ok": True, "result": "2", "error": ""}
    assert (await rpc(ctx, "device.eval", id=dev, code="_result = 2"))["result"]["ok"] is True  # default timeout
    for bad in ({"code": ""}, {"code": "   "}, {"code": 1}, {"code": "x", "timeoutMs": 199}, {"code": "x", "timeoutMs": 15001},
                {"code": "x", "timeoutMs": "8000"}, {"code": "x", "timeoutMs": True}):
        assert (await rpc(ctx, "device.eval", id=dev, **bad))["error"]["code"] == "rpc.bad_params", bad
    assert (await rpc(ctx, "device.eval", id=dev, code="x" * (64 * 1024 + 1)))["error"]["code"] == "rpc.too_large"
    assert (await rpc(ctx, "device.eval", id="adb:nope", code="_result = 1"))["error"]["code"] == "device.not_found"


async def test_eval_timeout_and_device_failure_are_answers(ctx_dev, monkeypatch):
    ctx, dev = ctx_dev
    seen: list = []

    async def slow(self, code, timeout_ms=8000):
        seen.append((code, timeout_ms))
        return {"ok": False, "error": "timeout"}

    monkeypatch.setattr(DeviceClient, "eval_python", slow)
    r = await rpc(ctx, "device.eval", id=dev, code="while 1: pass", timeoutMs=200)
    assert r["result"] == {"ok": False, "result": "", "error": "timeout"}
    assert seen == [("while 1: pass", 200)]


async def test_unknown_device(ctx_dev):
    ctx, _ = ctx_dev
    assert (await rpc(ctx, "project.list", id="adb:nope"))["error"]["code"] == "device.not_found"


async def test_delete_and_move_files(ctx_dev):
    ctx, dev = ctx_dev
    await rpc(ctx, "project.create", id=dev, project="mv")
    await rpc(ctx, "project.write", id=dev, project="mv", path="a.py", content="A\n")
    m = await rpc(ctx, "project.move", id=dev, project="mv", **{"from": "a.py", "to": "pkg/b.py"})
    assert m["ok"], m
    paths = {f["path"] for f in (await rpc(ctx, "project.files", id=dev, project="mv"))["result"]["files"]}
    assert "pkg/b.py" in paths and "a.py" not in paths
    assert (await rpc(ctx, "project.move", id=dev, project="mv", **{"from": "x.py", "to": "x.py"}))["error"]["code"] == "rpc.bad_params"
    assert (await rpc(ctx, "project.move", id=dev, project="mv", **{"from": "../x", "to": "y"}))["error"]["code"] == "rpc.bad_params"
    d = await rpc(ctx, "project.deleteFile", id=dev, project="mv", path="pkg/b.py")
    assert d["ok"], d
    paths = {f["path"] for f in (await rpc(ctx, "project.files", id=dev, project="mv"))["result"]["files"]}
    assert "pkg/b.py" not in paths
    # the device refuses deleting the entry point: surfaced as an HTTP error with its message
    e = await rpc(ctx, "project.deleteFile", id=dev, project="mv", path="__init__.py")
    assert not e["ok"] and e["error"]["code"] == "device.http"
    # recursive: a folder with everything in it, the reply counts the files
    for p in ("lib/a.py", "lib/sub/b.py"):
        await rpc(ctx, "project.write", id=dev, project="mv", path=p, content="x\n")
    d = await rpc(ctx, "project.deleteFile", id=dev, project="mv", path="lib")
    assert not d["ok"], "a non-empty folder needs recursive"
    d = await rpc(ctx, "project.deleteFile", id=dev, project="mv", path="lib", recursive=True)
    assert d["ok"] and d["result"]["deleted"] == 2, d
    paths = {f["path"] for f in (await rpc(ctx, "project.files", id=dev, project="mv"))["result"]["files"]}
    assert not any(p.startswith("lib/") for p in paths)
    assert (await rpc(ctx, "project.deleteFile", id=dev, project="mv", path="lib", recursive="yes"))["error"]["code"] == "rpc.bad_params"
