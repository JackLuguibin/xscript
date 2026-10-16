from __future__ import annotations

import json

from xscript_desktop.context import AppContext
from xscript_desktop.services.adb import AdbService
from xscript_desktop.services.device_client import DeviceClient, DeviceTarget

from .conftest import FakeAdb


async def rpc(ctx: AppContext, method: str, **params):
    out = json.loads(await ctx.dispatcher.handle(json.dumps({"id": 1, "method": method, "params": params})))
    return out


def make_ctx(fake: FakeAdb) -> AppContext:
    ctx = AppContext(adb=AdbService(runner=fake), poll_interval=60)
    ctx.devices._factory = lambda t: DeviceClient(DeviceTarget(t.host, getattr(fake, "target_for", {}).get(t.port, t.port)))
    return ctx


async def test_ping_and_hello():
    ctx = make_ctx(FakeAdb([]))
    assert (await rpc(ctx, "app.ping", echo=5))["result"]["pong"] == 5
    assert not ctx.ui_ready.is_set()
    r = await rpc(ctx, "app.hello")
    assert ctx.ui_ready.is_set() and "device.connect" in r["result"]["methods"]


async def test_full_flow_list_connect_info_disconnect(mock_device):
    fake = FakeAdb([("emulator-5554", "device", mock_device)])
    ctx = make_ctx(fake)
    lst = (await rpc(ctx, "device.adb.list"))["result"]
    assert lst["devices"][0]["serial"] == "emulator-5554"
    con = await rpc(ctx, "device.connect", transport="adb", serial="emulator-5554")
    assert con["ok"] and con["result"]["info"]["model"] == "XScript Mock"
    assert (await rpc(ctx, "device.list"))["result"]["devices"][0]["id"] == "adb:emulator-5554"
    assert (await rpc(ctx, "device.refresh", id="adb:emulator-5554"))["result"]["state"] == "online"
    assert (await rpc(ctx, "device.disconnect", id="adb:emulator-5554"))["result"] == {"removed": True}
    assert fake.forwards == {}
    await ctx.shutdown()


async def test_error_mapping():
    ctx = make_ctx(FakeAdb([]))
    r = await rpc(ctx, "device.connect", transport="adb", serial="ghost")
    assert r["error"]["code"] == "adb.no_such_device"
    r = await rpc(ctx, "device.connect", transport="lan", address="127.0.0.1:1")
    assert r["error"]["code"] == "device.unreachable" and r["error"]["retryable"] is True
    r = await rpc(ctx, "device.connect", transport="lan", address="x:99999")
    assert r["error"]["code"] == "device.protocol"
    r = await rpc(ctx, "device.connect", transport="ftp")
    assert r["error"]["code"] == "rpc.bad_params"
    r = await rpc(ctx, "device.connect")
    assert r["error"]["code"] == "rpc.bad_params"
    r = await rpc(ctx, "device.refresh", id="nope")
    assert r["error"]["code"] == "device.not_found"


async def test_scan_rpc(mock_device):
    ctx = make_ctx(FakeAdb([]))
    r = await rpc(ctx, "device.scan", hosts=["127.0.0.1"])
    # default ports 9860-9869: the mock listens elsewhere, so nothing found, but the call must succeed
    assert r["ok"] and isinstance(r["result"]["found"], list)
    r = await rpc(ctx, "device.scan", hosts="nope")
    assert r["error"]["code"] == "rpc.bad_params"


async def test_adb_missing_reports_structured_error(monkeypatch):
    monkeypatch.setenv("PATH", "")
    monkeypatch.delenv("XSCRIPT_ADB", raising=False)
    monkeypatch.delenv("ANDROID_HOME", raising=False)
    monkeypatch.delenv("ANDROID_SDK_ROOT", raising=False)
    monkeypatch.setenv("HOME", "/nonexistent-home")
    ctx = AppContext()
    r = await rpc(ctx, "device.adb.list")
    assert r["error"]["code"] == "adb.not_found"
