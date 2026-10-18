"""Device cards carry a machine-readable `errorCode` next to the raw `error`, so the page maps both the same way (H6)."""
from __future__ import annotations

from xscript_desktop.context import AppContext, error_code
from xscript_desktop.services.adb import AdbError, AdbService
from xscript_desktop.services.device_client import DeviceClient, DeviceError, DeviceTarget
from xscript_desktop.services.device_manager import DeviceManager, DeviceRecord
from xscript_desktop.services.store import SavedDevice, StoreError

from .conftest import FakeAdb


def test_device_error_code_matches_the_rpc_mapping():
    assert DeviceError("x", kind="connect").code == "device.unreachable"
    assert DeviceError("x", kind="timeout").code == "device.timeout"
    assert DeviceError("x", kind="protocol").code == "device.protocol"
    assert DeviceError("x", status=409).code == "device.http"


def test_error_code_for_service_errors():
    assert error_code(DeviceError("x", kind="timeout")) == "device.timeout"
    assert error_code(AdbError("adb.no_such_device", "gone")) == "adb.no_such_device"
    assert error_code(StoreError("db.not_found", "x")) == "device.not_found"
    assert error_code(StoreError("db.newer", "x")) == "db.newer"
    assert error_code(RuntimeError("boom")) == "rpc.internal"


async def test_refresh_puts_the_code_on_the_offline_record():
    events: list = []
    m = DeviceManager(AdbService(runner=FakeAdb([])), emit=lambda t, d: events.append((t, d)), poll_interval=60)
    c = DeviceClient(DeviceTarget("127.0.0.1", 1))
    m._devices["lan:x"] = DeviceRecord(id="lan:x", transport="lan", target=DeviceTarget("127.0.0.1", 1), state="online", client=c)
    try:
        rec = await m.refresh("lan:x")
        assert rec.state == "offline" and rec.error and rec.error_code == "device.unreachable"
        assert events[-1][1]["errorCode"] == "device.unreachable" and events[-1][1]["error"] == rec.error
        # back online clears both
        m._set_state(rec, "online")
        assert rec.to_dict()["errorCode"] == "" and rec.to_dict()["error"] == ""
    finally:
        await c.aclose()
        await m.shutdown()


def test_offline_view_code_only_with_an_error():
    row = SavedDevice(id="adb:s", name="", grp="", transport="adb", address="s", device_id="", model="", note="",
                      auto_connect=1, sort_order=0, created_at=0.0, last_seen=None)
    assert AppContext._offline_view(row)["errorCode"] == ""
    assert AppContext._offline_view(row, "", "device.timeout")["errorCode"] == ""
    v = AppContext._offline_view(row, "gone", "adb.no_such_device")
    assert v["error"] == "gone" and v["errorCode"] == "adb.no_such_device"


async def test_auto_connect_failure_card_has_the_code(tmp_path):
    ctx = AppContext(adb=AdbService(runner=FakeAdb([])), poll_interval=60, data_dir=tmp_path)
    try:
        ctx.store.remember("adb:gone", "adb", "gone", "", "Pixel", 1)
        ctx.store.update("adb:gone", {"auto_connect": 1})
        got = await ctx.connect_saved()
        assert got[0]["state"] == "offline" and got[0]["errorCode"] == "adb.no_such_device" and got[0]["error"]
    finally:
        await ctx.shutdown()
