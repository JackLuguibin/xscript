"""PR 4 device flow (design §14.5 / §5.2): parallel startup reconnect, parallel health polling with a per-call budget,
ADB hotplug auto-connect of saved devices, and the LAN scan's streamed progress / found / cancel."""
from __future__ import annotations

import asyncio
import json
import time

from xscript_desktop.context import AppContext
from xscript_desktop.services.adb import AdbService
from xscript_desktop.services.device_client import DeviceClient, DeviceError, DeviceTarget
from xscript_desktop.services.device_manager import DeviceManager, DeviceRecord

from .conftest import FakeAdb


def _ctx(fake: FakeAdb, data_dir) -> AppContext:
    ctx = AppContext(adb=AdbService(runner=fake), poll_interval=60, data_dir=data_dir)

    def factory(target: DeviceTarget) -> DeviceClient:
        port = getattr(fake, "target_for", {}).get(target.port, target.port)
        return DeviceClient(DeviceTarget(target.host, port))

    ctx.devices._factory = factory
    return ctx


async def rpc(ctx: AppContext, method: str, **params):
    return json.loads(await ctx.dispatcher.handle(json.dumps({"id": 1, "method": method, "params": params})))


async def _until(pred, timeout: float = 5.0) -> None:
    end = time.monotonic() + timeout
    while not pred():
        if time.monotonic() > end:
            raise AssertionError("condition not met in %.1f s" % timeout)
        await asyncio.sleep(0.02)


# ---- startup reconnect ------------------------------------------------------------------------------------------------------------


async def test_connect_saved_runs_devices_in_parallel_and_times_out_each_one(tmp_path):
    ctx = AppContext(poll_interval=60, data_dir=tmp_path)
    events: list[tuple[str, dict]] = []
    ctx.dispatcher.set_event_sink(lambda t, d: events.append((t, d)))
    for host in ("10.0.0.1", "10.0.0.2", "10.0.0.3"):
        ctx.store.remember("lan:%s:9860" % host, "lan", "%s:9860" % host, "", "Pixel", 1, auto_connect=True)

    async def connect_address(address: str) -> DeviceRecord:
        if address.startswith("10.0.0.3"):
            await asyncio.sleep(30)  # never answers: must not hold up the other two
        await asyncio.sleep(0.4)
        return DeviceRecord(id="lan:" + address, transport="lan", target=DeviceTarget.parse(address), state="online",
                            status={"device_id": address, "model": "Pixel"}, last_seen=time.time())

    ctx.devices.connect_address = connect_address  # type: ignore[method-assign]
    try:
        t0 = time.monotonic()
        got = await ctx.connect_saved(timeout=0.8)
        took = time.monotonic() - t0
        by_id = {d["id"]: d for d in got}
        assert by_id["lan:10.0.0.1:9860"]["state"] == "online" and by_id["lan:10.0.0.2:9860"]["state"] == "online"
        slow = by_id["lan:10.0.0.3:9860"]
        assert slow["state"] == "offline" and slow["errorCode"] == "device.timeout"
        assert took < 1.3, took  # serial would be 0.4 + 0.4 + 0.8
        connecting = [d["id"] for t, d in events if t == "device.state" and d["state"] == "connecting"]
        assert sorted(connecting) == sorted(by_id)  # every card says "connecting" before any result
    finally:
        await ctx.shutdown()


# ---- health polling ---------------------------------------------------------------------------------------------------------------


class _SlowClient:
    def __init__(self, delay: float, fail: bool = False):
        self.delay, self.fail, self.calls = delay, fail, 0

    async def status(self):
        self.calls += 1
        await asyncio.sleep(self.delay)
        if self.fail:
            raise DeviceError("refused", kind="connect")
        return {"device_id": "x", "model": "Pixel", "running": False}

    async def aclose(self):
        pass


async def test_poll_once_is_parallel_and_one_hung_device_only_costs_its_own_budget():
    mgr = DeviceManager(AdbService(runner=FakeAdb([])), poll_timeout=0.3)
    states: list[tuple[str, str, str]] = []
    mgr._emit = lambda topic, d: states.append((d["id"], d["state"], d["errorCode"]))
    hung, fast, dead = _SlowClient(10), _SlowClient(0.05), _SlowClient(0.05, fail=True)
    for name, client in (("hung", hung), ("fast", fast), ("dead", dead)):
        mgr._devices[name] = DeviceRecord(id=name, transport="lan", target=DeviceTarget("10.0.0.9", 9860), state="online", client=client)  # type: ignore[arg-type]
    t0 = time.monotonic()
    await mgr.poll_once()
    assert time.monotonic() - t0 < 0.6  # serial with the old 10 s timeout: > 10 s
    assert mgr.get("fast").state == "online" and mgr.get("fast").last_seen > 0
    assert (mgr.get("hung").state, mgr.get("hung").error_code) == ("offline", "device.timeout")
    assert (mgr.get("dead").state, mgr.get("dead").error_code) == ("offline", "device.unreachable")
    assert ("hung", "offline", "device.timeout") in states


async def test_poll_result_for_a_device_disconnected_mid_request_is_dropped():
    mgr = DeviceManager(AdbService(runner=FakeAdb([])), poll_timeout=1)
    client = _SlowClient(0.2)
    rec = DeviceRecord(id="d", transport="lan", target=DeviceTarget("10.0.0.9", 9860), state="online", client=client)  # type: ignore[arg-type]
    mgr._devices["d"] = rec
    emitted: list[str] = []
    mgr._emit = lambda topic, d: emitted.append(d["state"])
    task = asyncio.ensure_future(mgr.poll_once())
    await asyncio.sleep(0.05)
    mgr._devices.pop("d")
    await task
    assert emitted == [] and rec.status == {}


# ---- ADB hotplug ------------------------------------------------------------------------------------------------------------------


async def test_hotplug_connects_a_saved_device_when_it_appears(mock_device, tmp_path):
    fake = FakeAdb([])
    ctx = _ctx(fake, tmp_path)
    ctx.store.remember("adb:emulator-5554", "adb", "emulator-5554", "", "Pixel", 1, auto_connect=True)
    ctx.store.remember("adb:manual", "adb", "manual", "", "Pixel", 1, auto_connect=False)
    try:
        first = (await rpc(ctx, "device.adb.list"))["result"]
        assert first["devices"] == [] and first["autoConnecting"] == []
        fake.devices.extend([("emulator-5554", "device", mock_device), ("manual", "device", mock_device), ("stranger", "device", mock_device)])
        res = (await rpc(ctx, "device.adb.list"))["result"]
        assert res["autoConnecting"] == ["adb:emulator-5554"]  # not the opted-out one, not an unknown one
        await _until(lambda: any(r.id == "adb:emulator-5554" and r.state == "online" for r in ctx.devices.list()))
        assert [r.id for r in ctx.devices.list()] == ["adb:emulator-5554"]
        # still plugged in: the next listing does not reconnect it again
        assert (await rpc(ctx, "device.adb.list"))["result"]["autoConnecting"] == []
    finally:
        await ctx.shutdown()


async def test_hotplug_on_authorize_and_replug_but_not_with_the_switch_off(mock_device, tmp_path):
    fake = FakeAdb([("emulator-5554", "unauthorized", mock_device)])
    ctx = _ctx(fake, tmp_path)
    ctx.store.remember("adb:emulator-5554", "adb", "emulator-5554", "", "Pixel", 1, auto_connect=True)
    try:
        await rpc(ctx, "device.adb.list")  # baseline: unauthorized
        fake.devices[0] = ("emulator-5554", "device", mock_device)  # user tapped "allow USB debugging"
        assert (await rpc(ctx, "device.adb.list"))["result"]["autoConnecting"] == ["adb:emulator-5554"]
        await _until(lambda: any(r.state == "online" for r in ctx.devices.list()))
        # unplug: gone from adb, the live record goes offline on its next health check
        fake.devices.clear()
        await rpc(ctx, "device.adb.list")
        ctx.devices.get("adb:emulator-5554").state = "offline"
        fake.devices.append(("emulator-5554", "device", mock_device))
        assert (await rpc(ctx, "device.adb.list"))["result"]["autoConnecting"] == ["adb:emulator-5554"]
        # connect_adb drops the stale record before probing again, so look it up without get()
        await _until(lambda: any(r.id == "adb:emulator-5554" and r.state == "online" and r.forward_port for r in ctx.devices.list()))
        # with the global switch off a replug is left alone
        await rpc(ctx, "app.settings.set", autoReconnect=False)
        fake.devices.clear()
        await rpc(ctx, "device.adb.list")
        fake.devices.append(("emulator-5554", "device", mock_device))
        assert (await rpc(ctx, "device.adb.list"))["result"]["autoConnecting"] == []
    finally:
        await ctx.shutdown()


# ---- LAN scan -----------------------------------------------------------------------------------------------------------------------


async def test_scan_probes_the_default_port_on_every_host_first(monkeypatch):
    order: list[tuple[str, int]] = []

    async def refuse(host, port):
        order.append((host, port))
        raise OSError("refused")

    monkeypatch.setattr(asyncio, "open_connection", refuse)
    mgr = DeviceManager(AdbService(runner=FakeAdb([])))
    progress: list[tuple[int, int]] = []
    hosts = ["10.0.0.%d" % i for i in range(1, 6)]
    assert await mgr.scan(hosts, ports=(9860, 9861, 9862), concurrency=2, on_progress=lambda d, t: progress.append((d, t))) == []
    assert {p for _, p in order[:5]} == {9860} and len(order) == 15
    assert progress[-1] == (15, 15) and [d for d, _ in progress] == list(range(1, 16))


async def test_scan_streams_hits_and_can_be_cancelled(mock_device):
    mgr = DeviceManager(AdbService(runner=FakeAdb([])))
    hits: list[dict] = []
    got = await mgr.scan(["127.0.0.1"], ports=(mock_device, 1), on_found=hits.append)
    assert [h["port"] for h in got] == [mock_device] and hits == got and hits[0]["info"]["model"]

    cancel = asyncio.Event()
    cancel.set()
    progress: list[int] = []
    assert await mgr.scan(["127.0.0.1"] * 4, ports=(mock_device,), cancel=cancel, on_progress=lambda d, t: progress.append(d)) == []
    assert progress[-1] == 4  # skipped probes still count, so the bar reaches the end


async def test_scan_rpc_emits_found_and_progress_and_cancel_stops_it(mock_device, monkeypatch):
    ctx = AppContext(poll_interval=60)
    events: list[tuple[str, dict]] = []
    ctx.dispatcher.set_event_sink(lambda t, d: events.append((t, d)))
    real_open = asyncio.open_connection

    async def slow_open(host, port):
        if host != "127.0.0.1":
            await asyncio.sleep(0.5)  # an unroutable host: hangs until the per-probe timeout
            raise OSError("timeout")
        return await real_open(host, port)

    monkeypatch.setattr(asyncio, "open_connection", slow_open)
    monkeypatch.setattr("xscript_desktop.services.device_manager.SCAN_PORTS", (mock_device, 9999))
    try:
        hosts = ["127.0.0.1"] + ["192.0.2.%d" % i for i in range(1, 200)]
        call = asyncio.ensure_future(ctx.dispatcher.handle(json.dumps({"id": 7, "method": "device.scan", "params": {"scanId": "s1", "hosts": hosts}})))
        await _until(lambda: any(t == "device.scan.found" for t, _ in events))
        found = next(d for t, d in events if t == "device.scan.found")
        assert found["scanId"] == "s1" and found["device"]["port"] == mock_device
        assert (await rpc(ctx, "device.scan.cancel", scanId="s1"))["result"] == {"cancelled": True}
        t0 = time.monotonic()
        res = json.loads(await call)["result"]
        assert time.monotonic() - t0 < 2.0  # the 400 queued probes were skipped, not waited for
        assert res["cancelled"] is True and [h["port"] for h in res["found"]] == [mock_device]
        prog = [d for t, d in events if t == "device.scan.progress"]
        assert prog and prog[-1]["total"] == 400 and all(p["scanId"] == "s1" for p in prog)
        assert (await rpc(ctx, "device.scan.cancel", scanId="s1"))["result"] == {"cancelled": False}
    finally:
        await ctx.shutdown()
