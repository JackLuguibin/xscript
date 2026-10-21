from __future__ import annotations

import asyncio

import pytest

from xscript_desktop.services.adb import AdbError, AdbService
from xscript_desktop.services.device_client import DeviceClient, DeviceError, DeviceTarget
from xscript_desktop.services.device_manager import DeviceManager, lan_hosts

from .conftest import FakeAdb


def make_manager(fake: FakeAdb, events: list, poll: float = 0.05) -> DeviceManager:
    def factory(target: DeviceTarget) -> DeviceClient:
        # the fake adb "forwards" local port N to the mock server's real port
        port = getattr(fake, "target_for", {}).get(target.port, target.port)
        return DeviceClient(DeviceTarget(target.host, port))

    return DeviceManager(AdbService(runner=fake), emit=lambda t, d: events.append((t, d)), client_factory=factory, poll_interval=poll)


async def test_connect_adb_shows_device_info_and_cleans_up(mock_device):
    fake = FakeAdb([("emulator-5554", "device", mock_device)])
    events: list = []
    m = make_manager(fake, events)
    rec = await m.connect_adb("emulator-5554")
    d = rec.to_dict()
    assert d["id"] == "adb:emulator-5554" and d["state"] == "online" and d["transport"] == "adb"
    assert d["forwardPort"] == 41000 and d["info"]["model"] == "XScript Mock" and d["info"]["sdk"] == 34
    assert any(t == "device.state" for t, _ in events)
    assert fake.forwards  # our forward exists
    await m.shutdown()
    assert fake.forwards == {}  # and is removed on shutdown


async def test_connect_adb_failures(mock_device):
    fake = FakeAdb([("emulator-5554", "device", mock_device), ("R5", "unauthorized", mock_device)])
    m = make_manager(fake, [])
    with pytest.raises(AdbError) as e:
        await m.connect_adb("nope")
    assert e.value.code == "adb.no_such_device"
    with pytest.raises(AdbError) as e:
        await m.connect_adb("R5")
    assert e.value.code == "adb.not_ready"


async def test_connect_adb_app_not_listening_removes_forward():
    # forward target port with nothing listening -> probe fails -> our forward must not leak
    fake = FakeAdb([("emulator-5554", "device", 1)])
    m = make_manager(fake, [])
    with pytest.raises(DeviceError) as e:
        await m.connect_adb("emulator-5554")
    assert e.value.kind == "connect"
    assert fake.forwards == {}


async def test_reconnect_replaces_existing(mock_device):
    fake = FakeAdb([("emulator-5554", "device", mock_device)])
    m = make_manager(fake, [])
    await m.connect_adb("emulator-5554")
    await m.connect_adb("emulator-5554")
    assert len(m.list()) == 1 and len(fake.forwards) == 1
    await m.shutdown()


async def test_connect_address_lan_warns_unless_loopback(mock_device):
    m = make_manager(FakeAdb([]), [])
    rec = await m.connect_address("127.0.0.1:%d" % mock_device)
    assert rec.state == "online" and rec.warning == ""
    rec2 = await m.connect_address("localhost:%d" % mock_device)
    assert rec2.warning == ""
    with pytest.raises(DeviceError):
        await m.connect_address("127.0.0.1:1")
    with pytest.raises(DeviceError):
        await m.connect_address("host:99999")
    await m.shutdown()


async def test_lan_non_loopback_warning_text():
    assert DeviceManager._is_loopback("127.0.0.1") and not DeviceManager._is_loopback("192.168.1.9")
    assert DeviceManager._is_loopback("::1") and DeviceManager._is_loopback("localhost")


async def test_polling_marks_offline_and_back_online(mock_device):
    import mock_device as md  # loaded by the fixture

    fake = FakeAdb([("emulator-5554", "device", mock_device)])
    events: list = []
    m = make_manager(fake, events)
    rec = await m.connect_adb("emulator-5554")
    m.start_polling()
    md.STATE["running"] = "demo"
    for _ in range(40):
        await asyncio.sleep(0.05)
        if rec.status.get("running"):
            break
    assert rec.status.get("running") is True
    assert any(d["info"]["running"] for t, d in events if t == "device.state")
    md.STATE["running"] = None
    await m.shutdown()


async def test_refresh_offline_when_device_gone():
    fake = FakeAdb([("emulator-5554", "device", 1)])
    m = make_manager(fake, [])
    from xscript_desktop.services.device_manager import DeviceRecord

    c = DeviceClient(DeviceTarget("127.0.0.1", 1))
    m._devices["lan:x"] = DeviceRecord(id="lan:x", transport="lan", target=DeviceTarget("127.0.0.1", 1), state="online", client=c)
    rec = await m.refresh("lan:x")
    assert rec.state == "offline" and rec.error
    with pytest.raises(KeyError):
        m.get("missing")


async def test_scan_finds_only_xscript_devices(mock_device):
    m = make_manager(FakeAdb([]), [])
    found = await m.scan(["127.0.0.1"], ports=(mock_device, mock_device + 1000 if mock_device < 60000 else 1))
    assert [f["port"] for f in found] == [mock_device]
    assert found[0]["info"]["model"] == "XScript Mock"


async def test_scan_ignores_non_xscript_http_server():
    import http.server
    import threading

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"hello": "world"}')

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        m = make_manager(FakeAdb([]), [])
        assert await m.scan(["127.0.0.1"], ports=(srv.server_address[1],)) == []
    finally:
        srv.shutdown()
        srv.server_close()


def test_lan_hosts():
    assert lan_hosts("192.168.5.0/30") == ["192.168.5.1", "192.168.5.2"]
    with pytest.raises(ValueError):
        lan_hosts("10.0.0.0/16")


def _steps(res: dict) -> dict:
    return {s["id"]: s["ok"] for s in res["steps"]}


async def test_check_adb_all_green_and_leaves_nothing_behind(mock_device):
    fake = FakeAdb([("emulator-5554", "device", mock_device)])
    m = make_manager(fake, [])
    res = await m.check("adb", "emulator-5554")
    assert res["ok"] is True
    assert [s["id"] for s in res["steps"]] == ["adb", "device", "authorized", "forward", "app", "xscript", "pairing"]
    assert all(s["ok"] for s in res["steps"])
    assert fake.forwards == {} and m.list() == []  # a check never connects
    await m.shutdown()


async def test_check_adb_stops_at_the_first_failure(mock_device):
    fake = FakeAdb([("R5", "unauthorized", mock_device), ("emulator-5554", "device", 1)])
    m = make_manager(fake, [])
    res = await m.check("adb", "nope")
    assert _steps(res) == {"adb": True, "device": False, "authorized": None, "forward": None, "app": None, "xscript": None, "pairing": None}
    res = await m.check("adb", "R5")
    assert _steps(res)["authorized"] is False and res["steps"][2]["detail"] == "unauthorized"
    res = await m.check("adb", "emulator-5554")  # forward fine, nothing listening behind it
    assert _steps(res)["forward"] is True and _steps(res)["app"] is False and res["ok"] is False
    assert fake.forwards == {}
    await m.shutdown()


async def test_check_adb_without_adb():
    async def runner(argv):
        raise AdbError("adb.not_found", "找不到 adb")

    m = DeviceManager(AdbService(runner=runner), emit=lambda t, d: None)
    res = await m.check("adb", "x")
    assert _steps(res)["adb"] is False and _steps(res)["device"] is None


async def test_check_lan(mock_device):
    m = make_manager(FakeAdb([]), [])
    res = await m.check("lan", "127.0.0.1:%d" % mock_device)
    assert res["ok"] is True and [s["id"] for s in res["steps"]] == ["address", "reach", "app", "xscript", "pairing"]
    res = await m.check("lan", "127.0.0.1:1")
    assert _steps(res) == {"address": True, "reach": False, "app": None, "xscript": None, "pairing": None}
    assert res["steps"][1]["detail"] == "refused"
    res = await m.check("lan", "host:99999")
    assert _steps(res)["address"] is False
    assert m.list() == []
    await m.shutdown()
