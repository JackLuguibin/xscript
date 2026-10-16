"""End-to-end against REAL adb devices/emulators (skipped unless XSCRIPT_DEVICE_TESTS=1).

    XSCRIPT_DEVICE_TESTS=1 .venv/bin/python -m pytest -m device -v

Safety: only `adb devices`, `adb forward` (auto port) and `adb forward --remove` of OUR forward are issued, plus the device HTTP API
(`/status`, and for the entry test an `xsprobe_e2e` project that is created and deleted again). Nothing is installed/uninstalled,
no data is cleared, and forwards created by other tools (VS Code's 19860, …) are never touched.
"""
from __future__ import annotations

import asyncio
import io
import os
import subprocess
import zipfile

import pytest

from xscript_desktop.services.adb import AdbService
from xscript_desktop.services.device_client import DeviceClient
from xscript_desktop.services.device_manager import DeviceManager

from .harness import have_build

pytestmark = [pytest.mark.device, pytest.mark.skipif(os.environ.get("XSCRIPT_DEVICE_TESTS") != "1", reason="set XSCRIPT_DEVICE_TESTS=1 to run against real devices")]


def forward_list(adb: str) -> list[str]:
    return sorted(subprocess.run([adb, "forward", "--list"], capture_output=True, text=True, check=True).stdout.split("\n"))


@pytest.fixture()
def adb_service() -> AdbService:
    svc = AdbService()
    if svc.path() is None:
        pytest.skip("adb not found")
    return svc


async def ready_serials(svc: AdbService) -> list[str]:
    return [d.serial for d in await svc.devices() if d.state == "device"]


async def test_connect_each_adb_device_and_clean_up(adb_service):
    serials = await ready_serials(adb_service)
    if not serials:
        pytest.skip("no adb device online")
    before = forward_list(adb_service.path())
    m = DeviceManager(adb_service, poll_interval=60)
    connected = 0
    for serial in serials:
        try:
            rec = await m.connect_adb(serial)
        except Exception as e:  # app not running on this device: report, do not fail the others
            print("skip %s: %s" % (serial, e))
            continue
        connected += 1
        info = rec.to_dict()["info"]
        assert rec.state == "online" and rec.forward_port > 0 and rec.target.host == "127.0.0.1"
        assert info["model"] and info["version"] and info["sdk"] and info["width"] and info["deviceId"]
        print(serial, info["model"], "API", info["sdk"], info["width"], "x", info["height"], "XScript", info["version"])
        assert (await m.refresh(rec.id)).state == "online"
    assert connected, "XScript app is not reachable on any adb device"
    await m.shutdown()
    assert forward_list(adb_service.path()) == before  # our forwards removed, foreign ones untouched


async def test_loopback_manual_address_via_existing_forward(adb_service):
    """The task's canonical path: adb forward tcp:19860 tcp:9860 made elsewhere, then connect by address."""
    if "tcp:19860 tcp:9860" not in " ".join(forward_list(adb_service.path())):
        pytest.skip("no pre-made 19860 forward")
    m = DeviceManager(adb_service, poll_interval=60)
    rec = await m.connect_address("localhost:19860")
    assert rec.state == "online" and rec.warning == "" and rec.status.get("version")
    await m.shutdown()


async def test_design_entry_stub_runs_on_device(adb_service):
    """§10.2 format: __init__.py stub `from flows.x import main; main()` runs and logs through /logs."""
    serials = await ready_serials(adb_service)
    if not serials:
        pytest.skip("no adb device online")
    fw = await adb_service.forward(serials[0])
    c = DeviceClient.__new__(DeviceClient)
    from xscript_desktop.services.device_client import DeviceTarget

    c.__init__(DeviceTarget("127.0.0.1", fw.local_port), timeout=20)
    name = "xsprobe_e2e"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("__init__.py", "from flows.hello import main\nmain()\n")
        zf.writestr("flows/__init__.py", "")
        zf.writestr("flows/hello.py", "def main():\n    print('e2e-flow-main ' + __name__)\n")
    try:
        if (await c.status()).get("running"):
            pytest.skip("a script is already running on the device")
        await c.upload_zip(name, buf.getvalue())
        since = (await c.logs(0))["next"]
        await c.run_project(name)
        for _ in range(60):
            await asyncio.sleep(0.5)
            if not (await c.status()).get("running"):
                break
        await asyncio.sleep(0.8)
        lines = [e["line"].strip() for e in (await c.logs(since))["entries"]]
        assert "e2e-flow-main flows.hello" in lines
        assert "xscript: finished " + name in lines
    finally:
        try:
            await c.delete_project(name)
        finally:
            await c.aclose()
            await adb_service.cleanup()


async def test_screen_endpoint_returns_an_image_or_a_clean_capture_error(adb_service):
    """One GET /screen per ready device (no streams: the stream slot leak measured in docs §14.4 is not exercised here)."""
    serials = await ready_serials(adb_service)
    if not serials:
        pytest.skip("no adb device online")
    m = DeviceManager(adb_service, poll_interval=60)
    try:
        for serial in serials:
            try:
                rec = await m.connect_adb(serial)
            except Exception as e:
                print("skip %s: %s" % (serial, e))
                continue
            try:
                body, mime = await rec.client.screen("jpg", 60, 360)
                assert body[:3] == b"\xff\xd8\xff" and mime.startswith("image/")
            except Exception as e:
                # an app without the screen-capture grant answers 503 capture_unavailable: that is a valid, reported state
                assert getattr(e, "status", None) == 503, e
    finally:
        await m.shutdown()


@pytest.mark.skipif(not have_build(), reason="frontend not built")
def test_real_shell_selftest_connects_a_real_emulator():
    """`python -m xscript_desktop --selftest --connect-adb <serial>` against the first ready device: exit 0, state online."""
    import json
    import sys
    from pathlib import Path

    svc = AdbService()
    if svc.path() is None:
        pytest.skip("adb not found")
    serials = asyncio.run(ready_serials(svc))
    if not serials:
        pytest.skip("no adb device online")
    before = forward_list(svc.path())
    env = dict(os.environ, QT_QPA_PLATFORM="offscreen", QTWEBENGINE_CHROMIUM_FLAGS="--disable-gpu")
    r = subprocess.run([sys.executable, "-m", "xscript_desktop", "--selftest", "--connect-adb", serials[0], "--timeout", "40"],
                       cwd=Path(__file__).resolve().parents[1], env=env, capture_output=True, text=True, timeout=90)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out["state"] == "online" and out["device"]["deviceId"]
    assert forward_list(svc.path()) == before  # the app removed the forward it created
