"""Real stdio integration: no Qt display or keychain required."""
import asyncio
import json
import sys

import pytest


@pytest.mark.asyncio
async def test_stdio_roundtrip_native_and_shutdown(tmp_path):
    proc = await asyncio.create_subprocess_exec(
        sys.executable, '-m', 'xscript_desktop.electron_host', '--data-dir', str(tmp_path), '--memory-secrets',
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)

    async def send(message):
        proc.stdin.write((json.dumps(message) + '\n').encode())
        await proc.stdin.drain()

    async def receive():
        return json.loads(await asyncio.wait_for(proc.stdout.readline(), 15))

    try:
        await send({'id': 1, 'method': 'app.ping', 'params': {'echo': 'electron'}})
        assert (await receive())['result']['pong'] == 'electron'
        await send({'id': 2, 'method': 'app.copyText', 'params': {'text': 'hello'}})
        native = await receive()
        assert native['native'] == 'clipboard'
        assert native['args'] == ['hello']
        await send({'id': 3, 'method': 'app.ping'})
        assert (await receive())['id'] == 3
        await send({'nativeResult': native['nativeId'], 'result': None})
        assert (await receive())['ok'] is True
        await send({'id': 4, 'method': 'update.install'})
        assert (await receive())['error']['code'] == 'update.install'
        await send({'_host': 'resource', 'id': 5, 'url': '/_frame/%2e%2e'})
        assert 'error' in await receive()
        await send({'_host': 'state', 'id': 6})
        assert (await receive())['result']['unsaved'] is False
        await send({'_host': 'shutdown', 'id': 7})
        assert (await receive())['hostResult'] == 7
        assert await asyncio.wait_for(proc.wait(), 15) == 0
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


@pytest.mark.asyncio
@pytest.mark.parametrize("query, expected_size, expected_quality", [
    ("max=1920&quality=95", 1920, 95),
    ("max=9999&quality=999", 2400, 100),
    ("max=480", 480, 60),
])
async def test_screenshot_resource_preserves_requested_quality(query, expected_size, expected_quality):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock
    from xscript_desktop.electron_host import ElectronHost

    screen = AsyncMock(return_value=(b"image", "image/jpeg"))
    ctx = SimpleNamespace(dispatcher=Mock(), screen=screen)
    host = ElectronHost(ctx)
    resource = await host.resource(f"/_shot/adb%3Aphone.jpg?{query}")
    screen.assert_awaited_once_with("adb:phone", expected_size, expected_quality)
    assert resource["mime"] == "image/jpeg"


@pytest.mark.asyncio
async def test_native_png_does_not_resize_or_apply_jpeg_compression():
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock
    from xscript_desktop.electron_host import ElectronHost

    screen = AsyncMock(return_value=(b"png", "image/png"))
    host = ElectronHost(SimpleNamespace(dispatcher=Mock(), screen=screen))
    result = await host.resource("/_shot/adb%3Aphone.jpg?max=native&format=png")
    screen.assert_awaited_once_with("adb:phone", None, 100, fmt="png")
    assert result["mime"] == "image/png"
