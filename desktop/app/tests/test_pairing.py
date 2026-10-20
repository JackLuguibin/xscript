"""Device pairing: bearer code on every request, auto-pairing over USB, the pairing RPC and the tool window URL."""
from __future__ import annotations

import httpx
import pytest

from xscript_desktop.services.adb import AdbService, parse_pairing_reply
from xscript_desktop.services.device_client import DeviceClient, DeviceError, DeviceTarget, needs_pairing, normalize_code, valid_code
from xscript_desktop.services.device_manager import LAN_WARNING, DeviceManager, MemoryPairing
from xscript_desktop.services.secrets import MemoryBackend, NameIndex, SecretStore
from xscript_desktop.services.tool_pages import paired_url

from .conftest import FakeAdb


def manager(fake: FakeAdb, pairing: MemoryPairing | None = None, events: list | None = None) -> DeviceManager:
    def factory(target: DeviceTarget) -> DeviceClient:
        port = getattr(fake, "target_for", {}).get(target.port, target.port)
        return DeviceClient(DeviceTarget(target.host, port))

    sink = events if events is not None else []
    return DeviceManager(AdbService(runner=fake), emit=lambda t, d: sink.append((t, d)), client_factory=factory,
                         poll_interval=60, pairing=pairing or MemoryPairing())


def test_code_helpers():
    assert normalize_code(" abcd-efgh ") == "ABCDEFGH"
    assert valid_code("abcd-efgh") and not valid_code("abc") and not valid_code("ABCD-EFGH-I")
    assert needs_pairing({"pairing": True, "paired": False})
    assert not needs_pairing({"pairing": True, "paired": True})
    assert not needs_pairing({"pairing": False, "paired": False})
    assert not needs_pairing({"model": "old app without pairing"})


def test_parse_pairing_reply():
    assert parse_pairing_reply('{"required": true, "code": "abcdefgh"}\n') == "ABCDEFGH"
    assert parse_pairing_reply('{"required": false}') == ""
    assert parse_pairing_reply('{"error": "adb only"}') == ""
    assert parse_pairing_reply('{"required": true, "code": "x; rm"}') == ""
    assert parse_pairing_reply("") == "" and parse_pairing_reply("not json") == ""


async def test_client_sends_bearer_and_maps_401(paired_mock_device):
    c = DeviceClient(DeviceTarget("127.0.0.1", paired_mock_device))
    st = await c.status()
    assert needs_pairing(st) and "running" not in st
    with pytest.raises(DeviceError) as e:
        await c.projects()
    assert e.value.kind == "auth" and e.value.code == "device.unpaired" and e.value.status == 401
    assert not e.value.retryable
    c.set_token("abcd-efgh")
    assert c._http.headers["Authorization"] == "Bearer ABCDEFGH"
    assert isinstance(await c.projects(), list)
    assert (await c.status())["paired"] is True
    c.set_token("")
    assert "Authorization" not in c._http.headers
    await c.aclose()


async def test_lan_device_waits_for_the_code_then_pairs(paired_mock_device):
    events: list = []
    store = MemoryPairing()
    m = manager(FakeAdb([]), store, events)
    rec = await m.connect_address("127.0.0.1:%d" % paired_mock_device)
    assert rec.state == "unpaired" and rec.error_code == "device.unpaired"
    assert rec.to_dict()["info"]["model"] == "XScript Mock"
    with pytest.raises(DeviceError) as e:
        await m.pair(rec.id, "WRONG123")
    assert e.value.code == "device.unpaired" and "不正确" in str(e.value)
    with pytest.raises(DeviceError):
        await m.pair(rec.id, "short")
    assert rec.client is not None and rec.client.token == ""  # a refused code is not kept
    rec = await m.pair(rec.id, "abcd-efgh")
    assert rec.state == "online" and rec.error == "" and rec.status["paired"] is True
    assert store.codes[rec.id] == "ABCDEFGH"
    assert any(t == "device.state" and d["state"] == "online" for t, d in events)
    await m.shutdown()

    # next time the saved code is used without asking
    m2 = manager(FakeAdb([]), store)
    rec2 = await m2.connect_address("127.0.0.1:%d" % paired_mock_device)
    assert rec2.state == "online" and rec2.status["paired"] is True
    await m2.shutdown()


async def test_adb_pairs_automatically(paired_mock_device):
    fake = FakeAdb([("emulator-5554", "device", paired_mock_device)])
    fake.pairing["emulator-5554"] = "ABCDEFGH"
    store = MemoryPairing()
    m = manager(fake, store)
    rec = await m.connect_adb("emulator-5554")
    assert rec.state == "online" and rec.status["paired"] is True
    assert store.codes["adb:emulator-5554"] == "ABCDEFGH"
    fw = [c for c in fake.calls if c[2:3] == ["forward"] and c[-1].startswith("localabstract:")]
    assert fw and fw[0][-1] == "localabstract:xscript-pair.com.xscript.app.mock"
    assert fake.forwards.keys() == {41000}  # the pairing forward is gone again; only the API forward stays
    await m.shutdown()


async def test_adb_without_provider_falls_back_to_the_form(paired_mock_device):
    fake = FakeAdb([("emulator-5554", "device", paired_mock_device)])  # provider refuses (older app)
    m = manager(fake)
    rec = await m.connect_adb("emulator-5554")
    assert rec.state == "unpaired"
    rec = await m.pair(rec.id, "ABCD-EFGH")
    assert rec.state == "online"
    await m.shutdown()


async def test_stale_saved_code_is_replaced_over_adb(paired_mock_device):
    fake = FakeAdb([("emulator-5554", "device", paired_mock_device)])
    fake.pairing["emulator-5554"] = "ABCDEFGH"
    store = MemoryPairing()
    store.codes["adb:emulator-5554"] = "OLDCODE1"
    m = manager(fake, store)
    rec = await m.connect_adb("emulator-5554")
    assert rec.state == "online" and store.codes["adb:emulator-5554"] == "ABCDEFGH"
    await m.shutdown()


async def test_poll_notices_a_regenerated_code(paired_mock_device):
    store = MemoryPairing()
    store.codes["lan:127.0.0.1:%d" % paired_mock_device] = "ABCDEFGH"
    m = manager(FakeAdb([]), store)
    rec = await m.connect_address("127.0.0.1:%d" % paired_mock_device)
    assert rec.state == "online"
    assert rec.client is not None
    rec.client.set_token("ZZZZZZZZ")  # as if the phone regenerated its code
    await m.poll_once()
    assert rec.state == "unpaired" and rec.error_code == "device.unpaired"
    await m.shutdown()


async def test_open_device_keeps_the_lan_warning(mock_device):
    m = manager(FakeAdb([]))
    rec = await m.connect_address("127.0.0.1:%d" % mock_device)
    assert rec.state == "online" and rec.warning == ""  # loopback
    rec.target = DeviceTarget("192.168.1.5", mock_device)
    assert m._warning(rec) == LAN_WARNING  # pairing switched off on a LAN device
    rec.status = dict(rec.status, pairing=True)
    assert m._warning(rec) == ""
    await m.shutdown()


async def test_keychain_failure_does_not_break_connecting(paired_mock_device):
    class Broken:
        def get(self, device_id):
            raise RuntimeError("keychain locked")

        def put(self, device_id, code):
            raise RuntimeError("keychain locked")

    m = manager(FakeAdb([]), Broken())  # type: ignore[arg-type]
    rec = await m.connect_address("127.0.0.1:%d" % paired_mock_device)
    assert rec.state == "unpaired"
    rec = await m.pair(rec.id, "ABCDEFGH")
    assert rec.state == "online"
    await m.shutdown()


def test_secret_reveal_is_in_process_only():
    s = SecretStore(MemoryBackend(), NameIndex(None))
    s.set("device", "lan:192.168.1.5:9860", "ABCDEFGH")
    assert s.reveal("device", "lan:192.168.1.5:9860") == "ABCDEFGH"
    assert s.reveal("device", "adb:nope") is None
    assert "ABCDEFGH" not in repr(s.list_slots())


def test_paired_url():
    url = "http://127.0.0.1:41000/tools/ui/color.html"
    assert paired_url(url, "") == url
    assert paired_url(url, "ABCDEFGH") == "http://127.0.0.1:41000/pair?code=ABCDEFGH&next=%2Ftools%2Fui%2Fcolor.html"
    assert paired_url("http://[::1]:9860/tools/", "X") == "http://[::1]:9860/pair?code=X&next=%2Ftools%2F"


async def test_pair_page_sets_cookie_for_the_tool_window(paired_mock_device):
    base = "http://127.0.0.1:%d" % paired_mock_device
    async with httpx.AsyncClient(trust_env=False) as h:
        r = await h.post(base + "/pair", json={"code": "abcd-efgh"})
        assert r.status_code == 200 and "xs_pair=ABCDEFGH" in r.headers["set-cookie"]
