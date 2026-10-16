"""Coarse performance budgets. Limits are deliberately generous (CI machines are slow and noisy): they catch accidental O(n²) /
blocking-the-loop regressions, not 10 % drifts. Real-device numbers live in docs/桌面端设计.md §14.1 / §14.4."""
from __future__ import annotations

import asyncio
import json
import time

import pytest

from xscript_desktop.rpc import Dispatcher
from xscript_desktop.services.adb import AdbService, parse_devices
from xscript_desktop.services.device_client import DeviceClient, DeviceTarget
from xscript_desktop.services.device_manager import DeviceManager, lan_hosts

from .fake_device import FakeDevice

pytestmark = pytest.mark.perf


def timed(fn):
    t = time.perf_counter()
    out = fn()
    return time.perf_counter() - t, out


async def test_rpc_dispatch_throughput_5000_calls_under_3s():
    d = Dispatcher()
    d.register("echo", lambda p: p)
    t = time.perf_counter()
    await asyncio.gather(*(d.handle(json.dumps({"id": i, "method": "echo", "params": {"i": i}})) for i in range(5000)))
    assert time.perf_counter() - t < 3.0


def test_parse_devices_with_5000_lines_is_fast():
    out = "List of devices attached\n" + "".join("serial%04d\tdevice product:p model:m device:d transport_id:%d\n" % (i, i) for i in range(5000))
    dt, devs = timed(lambda: parse_devices(out))
    assert len(devs) == 5000 and dt < 1.0


def test_lan_hosts_rejects_a_huge_range_instantly():
    dt, _ = timed(lambda: pytest.raises(ValueError, lan_hosts, "10.0.0.0/8"))
    assert dt < 0.2  # regression: used to materialise 16 M addresses first (≈10 s)


async def test_screenshot_fetch_20_sequential_under_5s_and_status_50_concurrent_under_5s():
    fd = FakeDevice()
    try:
        c = DeviceClient(DeviceTarget("127.0.0.1", fd.port))
        t = time.perf_counter()
        for _ in range(20):
            body, _m = await c.screen("png", 60, 360)
            assert body[:4] == b"\x89PNG"
        assert time.perf_counter() - t < 5.0
        t = time.perf_counter()
        r = await asyncio.gather(*(c.status() for _ in range(50)))
        assert len(r) == 50 and time.perf_counter() - t < 5.0
        await c.aclose()
    finally:
        fd.close()


async def test_polling_20_devices_does_not_block_the_loop():
    fd = FakeDevice()
    try:
        m = DeviceManager(AdbService(), client_factory=lambda t: DeviceClient(DeviceTarget("127.0.0.1", fd.port)), poll_interval=0.05)
        for i in range(20):
            await m.connect_address("192.0.2.%d:9860" % (i + 1))
        m.start_polling()
        ticks = []

        async def heartbeat():
            for _ in range(10):
                t = time.perf_counter()
                await asyncio.sleep(0.02)
                ticks.append(time.perf_counter() - t)

        await heartbeat()
        assert max(ticks) < 0.5  # the loop stayed responsive while 20 devices were polled
        await m.shutdown()
    finally:
        fd.close()


async def test_scan_of_a_closed_range_is_fast():
    m = DeviceManager(AdbService(), client_factory=lambda t: DeviceClient(t))
    t = time.perf_counter()
    found = await m.scan(["127.0.0.1"], ports=tuple(range(9860, 9870)))
    assert found == [] and time.perf_counter() - t < 3.0
