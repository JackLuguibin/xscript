"""Error-path matrix: every way a device can misbehave, from the DeviceClient up through DeviceManager and the RPC layer to the
structured error the page receives ({code, message, retryable}). Uses the deterministic FakeDevice (tests/fake_device.py)."""
from __future__ import annotations

import asyncio
import json

import pytest

from xscript_desktop.context import AppContext
from xscript_desktop.services.adb import AdbService
from xscript_desktop.services.device_client import DeviceClient, DeviceError, DeviceTarget
from xscript_desktop.services.device_manager import DeviceManager, lan_hosts

from .conftest import FakeAdb
from .fake_device import FakeDevice


def make_ctx(fd: FakeDevice | None = None, adb: FakeAdb | None = None, timeout: float = 5.0) -> AppContext:
    fake = adb or FakeAdb([])
    ctx = AppContext(adb=AdbService(runner=fake), poll_interval=60)

    def factory(t: DeviceTarget) -> DeviceClient:
        port = fake.target_for.get(t.port, t.port) if hasattr(fake, "target_for") else t.port
        if fd is not None and t.host == "192.0.2.77":  # a "LAN" address that is really the local fake
            port = fd.port
        return DeviceClient(DeviceTarget("127.0.0.1" if (fd is not None and t.host == "192.0.2.77") else t.host, port))

    ctx.devices._factory = factory
    if timeout != 5.0:
        orig = ctx.devices._probe_client

        def probe(target, timeout_=timeout):
            c = factory(target)
            c.timeout = timeout_
            c._http.timeout = timeout_
            return c

        ctx.devices._probe_client = probe  # type: ignore[assignment]
    return ctx


async def call(ctx: AppContext, method: str, **params) -> dict:
    return json.loads(await ctx.dispatcher.handle(json.dumps({"id": 1, "method": method, "params": params})))


# (fake mode, expected rpc error code, retryable)
MODES = [("bad_json", "device.protocol", False), ("non_object", "device.protocol", False), ("html", "device.protocol", False),
         ("empty", "device.protocol", False), ("429", "device.http", True), ("500", "device.http", False), ("503", "device.http", True),
         ("reset", "device.unreachable", True)]


@pytest.mark.parametrize("mode,code,retryable", MODES)
async def test_lan_connect_error_codes(mode, code, retryable):
    """M-xx: one connect attempt per misbehaviour → one precise, user-presentable error code (+ retryable hint)."""
    fd = FakeDevice()
    try:
        fd.mode = mode
        ctx = make_ctx(fd)
        r = await call(ctx, "device.connect", transport="lan", address="192.0.2.77:9860")
        assert r["ok"] is False and r["error"]["code"] == code and r["error"]["retryable"] is retryable, r
        assert ctx.devices.list() == []  # nothing half-registered
    finally:
        fd.close()


async def test_lan_connect_timeout_is_device_timeout():
    fd = FakeDevice()
    try:
        fd.mode, fd.delay = "slow", 1.5
        ctx = make_ctx(fd, timeout=0.3)
        r = await call(ctx, "device.connect", transport="lan", address="192.0.2.77:9860")
        assert r["error"]["code"] == "device.timeout" and r["error"]["retryable"] is True
    finally:
        fd.close()


async def test_nothing_listens_is_unreachable():
    ctx = make_ctx()
    # port 1 on loopback: connection refused immediately
    r = await call(ctx, "device.connect", transport="lan", address="127.0.0.1:1")
    assert r["error"]["code"] == "device.unreachable"


async def test_connect_address_rejects_a_non_xscript_json_server():
    """A random local web server that answers JSON is not an XScript device (hardening found while writing the matrix)."""
    fd = FakeDevice(status={})
    try:
        fd.status.clear()
        fd.status["hello"] = "world"
        ctx = make_ctx(fd)
        r = await call(ctx, "device.connect", transport="lan", address="192.0.2.77:9860")
        assert r["error"]["code"] == "device.protocol" and "不像 XScript" in r["error"]["message"]
        assert ctx.devices.list() == []
    finally:
        fd.close()


async def test_connect_adb_to_non_xscript_server_removes_the_forward():
    fd = FakeDevice()
    try:
        fd.status.clear()
        fd.status["hello"] = "world"
        adb = FakeAdb([("emulator-5554", "device", fd.port)])
        ctx = make_ctx(fd, adb)
        r = await call(ctx, "device.connect", transport="adb", serial="emulator-5554")
        assert r["error"]["code"] == "device.protocol"
        assert adb.forwards == {}  # the forward we created is gone again
    finally:
        fd.close()


@pytest.mark.parametrize("address", ["127.0.0.1:%d", "localhost:%d"])
async def test_loopback_addresses_get_no_lan_warning(address):
    fd = FakeDevice()
    try:
        ctx = make_ctx(fd)
        r = await call(ctx, "device.connect", transport="lan", address=address % fd.port)
        assert r["ok"] and r["result"]["warning"] == ""
    finally:
        fd.close()


async def test_open_lan_device_without_pairing_gets_the_warning():
    fd = FakeDevice()
    try:
        ctx = make_ctx(fd)
        r = await call(ctx, "device.connect", transport="lan", address="192.0.2.77:9860")
        # FakeDevice is an older/open device (no "pairing" in /status): anyone on the LAN could run code
        assert r["ok"] and "关闭了配对" in r["result"]["warning"] and r["result"]["transport"] == "lan"
    finally:
        fd.close()


async def test_poll_goes_offline_on_each_failure_mode_then_recovers():
    fd = FakeDevice()
    try:
        ctx = make_ctx(fd)
        ctx.devices._poll_interval = 0.05
        events = []
        ctx.dispatcher.set_event_sink(lambda t, d: events.append((t, d["state"] if isinstance(d, dict) and "state" in d else None)))
        await call(ctx, "device.connect", transport="lan", address="192.0.2.77:9860")
        async def reaches(state: str, timeout: float = 5.0) -> str:
            # wait for the poller instead of a fixed sleep: on a busy CI runner one 50 ms poll can take >0.25 s
            loop = asyncio.get_running_loop()
            end = loop.time() + timeout
            while ctx.devices.list()[0].state != state and loop.time() < end:
                await asyncio.sleep(0.02)
            return ctx.devices.list()[0].state

        for mode in ("500", "bad_json", "reset"):
            fd.mode = mode
            assert await reaches("offline") == "offline", mode
            fd.mode = "ok"
            assert await reaches("online") == "online", mode
        assert ("device.state", "offline") in events and ("device.state", "online") in events
        await ctx.shutdown()
    finally:
        fd.close()


async def test_refresh_unknown_device_is_not_found_and_disconnect_unknown_is_false():
    ctx = make_ctx()
    assert (await call(ctx, "device.refresh", id="lan:nope"))["error"]["code"] == "device.not_found"
    assert (await call(ctx, "device.disconnect", id="lan:nope"))["result"] == {"removed": False}


async def test_reconnect_same_address_replaces_the_record():
    fd = FakeDevice()
    try:
        ctx = make_ctx(fd)
        a = await call(ctx, "device.connect", transport="lan", address="192.0.2.77:9860")
        b = await call(ctx, "device.connect", transport="lan", address="192.0.2.77:9860")
        assert a["ok"] and b["ok"] and len(ctx.devices.list()) == 1
        await ctx.shutdown()
    finally:
        fd.close()


async def test_adb_state_errors_have_distinct_codes():
    fd = FakeDevice()
    try:
        adb = FakeAdb([("R58M", "unauthorized", fd.port), ("emulator-5556", "offline", fd.port)])
        ctx = make_ctx(fd, adb)
        assert (await call(ctx, "device.connect", transport="adb", serial="R58M"))["error"]["code"] == "adb.not_ready"
        assert (await call(ctx, "device.connect", transport="adb", serial="emulator-5556"))["error"]["code"] == "adb.not_ready"
        assert (await call(ctx, "device.connect", transport="adb", serial="ghost"))["error"]["code"] == "adb.no_such_device"
        assert adb.forwards == {}
    finally:
        fd.close()


async def test_adb_command_failure_is_reported_not_raised():
    async def broken(argv):
        return 1, "", "error: protocol fault (couldn't read status): Connection reset by peer"

    ctx = AppContext(adb=AdbService(runner=broken), poll_interval=60)
    r = await call(ctx, "device.adb.list")
    assert r["ok"] is False and r["error"]["code"] == "adb.failed" and "Connection reset" in r["error"]["message"]


@pytest.mark.parametrize("params,code", [
    ({}, "rpc.bad_params"), ({"transport": "ble"}, "rpc.bad_params"), ({"transport": "adb"}, "rpc.bad_params"),
    ({"transport": "adb", "serial": 5}, "rpc.bad_params"), ({"transport": "lan", "address": "host:99999"}, "device.protocol"),
    ({"transport": "adb", "serial": "x", "localPort": True}, "rpc.bad_params"),
])
async def test_connect_param_validation(params, code):
    ctx = make_ctx()
    r = await call(ctx, "device.connect", **params)
    assert r["ok"] is False and r["error"]["code"] == code


@pytest.mark.parametrize("hosts", ["x", [1], ["a"] * 1025, {"a": 1}])
async def test_scan_rejects_bad_hosts(hosts):
    r = await call(make_ctx(), "device.scan", hosts=hosts)
    assert r["error"]["code"] == "rpc.bad_params"


async def test_scan_finds_the_fake_and_skips_noise():
    fd = FakeDevice()
    try:
        m = DeviceManager(AdbService(runner=FakeAdb([])), client_factory=lambda t: DeviceClient(t))
        found = await m.scan(["127.0.0.1"], ports=(fd.port, 1))
        assert [f["port"] for f in found] == [fd.port] and found[0]["info"]["deviceId"] == "ae10e6ed9b09580c"
        fd.mode = "html"
        assert await m.scan(["127.0.0.1"], ports=(fd.port,)) == []
    finally:
        fd.close()


def test_lan_hosts_limits_and_ranges():
    assert lan_hosts("192.0.2.0/30") == ["192.0.2.1", "192.0.2.2"]
    assert len(lan_hosts("10.0.0.0/22")) == 1022
    with pytest.raises(ValueError):
        lan_hosts("10.0.0.0/16")
    with pytest.raises(ValueError):
        lan_hosts("not a cidr")


async def test_scan_rpc_range_error_maps_to_bad_params():
    r = await call(make_ctx(), "device.scan", cidr="10.0.0.0/8")
    assert r["error"]["code"] == "rpc.bad_params" and "too large" in r["error"]["message"]


async def test_screen_error_paths_via_context():
    fd = FakeDevice()
    try:
        ctx = make_ctx(fd)
        await call(ctx, "device.connect", transport="lan", address="192.0.2.77:9860")
        dev = ctx.devices.list()[0].id
        body, mime = await ctx.screen(dev, 360)
        assert body.startswith(b"\x89PNG") and mime == "image/png"
        fd.screen_mode = "503"
        with pytest.raises(DeviceError) as e:
            await ctx.screen(dev, 360)
        assert e.value.status == 503 and e.value.detail == "capture_unavailable"
        with pytest.raises(KeyError):
            await ctx.screen("lan:nope")
        await ctx.shutdown()
    finally:
        fd.close()
