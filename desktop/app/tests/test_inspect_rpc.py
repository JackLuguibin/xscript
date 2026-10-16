"""Inspector, color pick, screenshot save, and the device-tools URL (mock device, no Qt window)."""
from __future__ import annotations

import json
from pathlib import Path

from xscript_desktop.context import AppContext
from xscript_desktop.services.adb import AdbService
from xscript_desktop.services.device_client import DeviceClient, DeviceTarget

from .conftest import FakeAdb


async def rpc(ctx: AppContext, method: str, **params):
    return json.loads(await ctx.dispatcher.handle(json.dumps({"id": 1, "method": method, "params": params})))


def make_ctx(fake: FakeAdb) -> AppContext:
    ctx = AppContext(adb=AdbService(runner=fake), poll_interval=60)
    ctx.devices._factory = lambda t: DeviceClient(DeviceTarget(t.host, getattr(fake, "target_for", {}).get(t.port, t.port)))
    return ctx


async def online(mock_device):
    fake = FakeAdb([("emulator-5554", "device", mock_device)])
    ctx = make_ctx(fake)
    assert (await rpc(ctx, "device.connect", transport="adb", serial="emulator-5554"))["ok"]
    return ctx


async def test_ui_tree_and_pixel_and_rejected_modes(mock_device):
    ctx = await online(mock_device)
    tree = await rpc(ctx, "device.uiTree", id="adb:emulator-5554", mode=0)
    assert tree["ok"] and tree["result"]["roots"][0]["text"] == "Search"
    bad = await rpc(ctx, "device.uiTree", id="adb:emulator-5554", mode=2)
    assert bad["error"]["code"] == "rpc.bad_params"
    pix = await rpc(ctx, "device.pixel", id="adb:emulator-5554", x=0, y=0)
    assert pix["result"] == {"color": "#336699", "x": 0, "y": 0}
    assert SECRET_ABSENT(pix)
    outside = await rpc(ctx, "device.pixel", id="adb:emulator-5554", x=4, y=4)
    assert outside["result"]["color"] is None
    assert (await rpc(ctx, "device.pixel", id="adb:emulator-5554", x=-1, y=0))["error"]["code"] == "rpc.bad_params"
    await ctx.shutdown()


def SECRET_ABSENT(payload) -> bool:
    return "super-secret-value" not in json.dumps(payload)


async def test_tools_open_uses_the_connected_device_not_a_page_supplied_url(mock_device):
    ctx = await online(mock_device)
    missing = await rpc(ctx, "tools.open", id="adb:emulator-5554", page="color")
    assert missing["error"]["code"] == "app.unavailable"
    seen = {}

    async def opener(host, port, url, title):
        seen["url"] = url
        seen["title"] = title
        seen["host"] = host

    ctx.open_tools = opener
    opened = await rpc(ctx, "tools.open", id="adb:emulator-5554", page="color", url="http://evil.test/tools/")
    assert opened["ok"]
    assert opened["result"]["url"].startswith("http://127.0.0.1:")
    assert opened["result"]["url"].endswith("/tools/ui/color.html")
    assert "evil" not in opened["result"]["url"]
    assert seen["url"] == opened["result"]["url"]
    assert seen["host"] == "127.0.0.1"
    assert (await rpc(ctx, "tools.open", id="adb:emulator-5554", page="editor"))["error"]["code"] == "rpc.bad_params"
    await ctx.shutdown()


async def test_save_screenshot_writes_a_png_the_dialog_chose(mock_device, tmp_path):
    ctx = await online(mock_device)
    dest = tmp_path / "shot.png"

    async def save():
        return str(dest)

    ctx.save_file = save
    saved = await rpc(ctx, "device.saveScreenshot", id="adb:emulator-5554")
    assert saved["result"]["saved"] is True
    assert Path(saved["result"]["path"]).read_bytes().startswith(b"\x89PNG")
    assert "iVBOR" not in json.dumps(saved["result"])  # the PNG itself is not in the RPC result

    async def cancel():
        return None

    ctx.save_file = cancel
    assert (await rpc(ctx, "device.saveScreenshot", id="adb:emulator-5554"))["result"] == {"saved": False}
    await ctx.shutdown()


async def test_copy_does_not_echo_and_secret_rpc_omits_the_value(tmp_path):
    ctx = AppContext(data_dir=tmp_path, poll_interval=60)
    secret = "super-secret-value"
    raw = await ctx.dispatcher.handle(json.dumps({
        "id": 1, "method": "secret.set", "params": {"kind": "env", "name": "API_TOKEN", "value": secret},
    }))
    assert secret not in raw
    listed = await rpc(ctx, "secret.list")
    assert listed["result"]["slots"] == [{"kind": "env", "name": "API_TOKEN"}]
    assert secret not in json.dumps(listed)
    seen = []

    async def copy(text):
        seen.append(text)

    ctx.copy_text = copy
    copied = await rpc(ctx, "app.copyText", text="node.Selector().id('ok')")
    assert copied["result"] == {"ok": True}
    assert "Selector" not in json.dumps(copied["result"])
    assert seen == ["node.Selector().id('ok')"]
    await ctx.shutdown()
    blob = b"".join(p.read_bytes() for p in tmp_path.iterdir() if p.is_file())
    assert secret.encode() not in blob
