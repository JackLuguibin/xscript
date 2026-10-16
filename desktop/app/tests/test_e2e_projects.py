"""E2E for the Projects page in the real shell against scripts/mock_device.py: Monaco loads from the bundle (no CDN, under the
real CSP), edit → save → run → logs → stop. Skipped when the frontend has not been built."""
from __future__ import annotations

import json

import pytest

pytest.importorskip("PySide6.QtWebEngineWidgets")

from xscript_desktop.services.device_client import DeviceClient, DeviceTarget

from .harness import build_shell, close_shell, have_build

pytestmark = [pytest.mark.qt, pytest.mark.skipif(not have_build(), reason="frontend not built (cd desktop/frontend && npm run build)")]


@pytest.fixture()
def shell(qapp, qtbot, mock_device):
    sh = build_shell()
    sh.fake.devices = [("emulator-5554", "device", mock_device)]
    sh.fake._next = 41000
    sh.redirect[41000] = mock_device
    sh.mock_port = mock_device
    sh.wait_url(qtbot)
    sh.wait_js(qtbot, "document.body.innerText.includes('emulator-5554')", timeout=15000)
    yield sh
    close_shell(sh)


def click_js(sh, qtbot, selector_js: str) -> None:
    qtbot.waitUntil(lambda: bool(sh._eval(qtbot, "(() => { const b = %s; if (!b) return false; b.click(); return true; })()" % selector_js)), timeout=8000)


def btn_starting(text: str) -> str:
    return "[...document.querySelectorAll('button')].find(b => !b.disabled && b.textContent.trim().startsWith(%s))" % json.dumps(text)


def test_e2e_p01_monaco_edit_save_run_logs_stop(shell, qtbot):
    sh = shell

    async def seed():
        c = DeviceClient(DeviceTarget("127.0.0.1", sh.mock_port))
        try:
            await c.create_project("e2e_proj")
        finally:
            await c.aclose()

    sh.run_async(seed())
    sh.click(qtbot, "连接 emulator-5554")
    sh.wait_text(qtbot, "在线")
    click_js(sh, qtbot, btn_starting("工程"))
    click_js(sh, qtbot, btn_starting("e2e_proj"))
    click_js(sh, qtbot, btn_starting("__init__.py"))
    # Monaco replaced the textarea fallback, rendered by the bundled chunk (the CSP forbids any CDN)
    sh.wait_js(qtbot, "document.querySelector('.monaco-host[data-ready=true] .monaco-editor')", timeout=20000)
    assert sh.js(qtbot, "document.querySelector('textarea.code') === null") is True
    # type: Monaco reads its hidden textarea on `input` events (offscreen Qt drops synthetic OS key events); Ctrl+S is a DOM
    # keydown that goes through Monaco's onKeyDown → the page's save handler
    ta = "document.querySelector('.monaco-host textarea')"
    sh._eval(qtbot, "(() => { const t = %s; t.focus(); t.value = 'print(42)'; t.setSelectionRange(9, 9); t.dispatchEvent(new InputEvent('input', {bubbles: true, data: 'print(42)', inputType: 'insertText'})); return true; })()" % ta)
    sh.wait_text(qtbot, "未保存")
    sh._eval(qtbot, "(() => { %s.dispatchEvent(new KeyboardEvent('keydown', {key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true, bubbles: true})); return true; })()" % ta)
    sh.wait_text(qtbot, "已保存")

    async def read():
        c = DeviceClient(DeviceTarget("127.0.0.1", sh.mock_port))
        try:
            return await c.read_file("e2e_proj", "__init__.py")
        finally:
            await c.aclose()

    assert "print(42)" in sh.run_async(read())["content"]
    sh.click(qtbot, "保存并运行")
    sh.wait_text(qtbot, "settings_search", timeout=10000)  # mock_device logs a line on run, followed through device.logs
    sh.click(qtbot, "停止")
    sh.wait_js(qtbot, "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '停止')?.disabled === true", timeout=10000)
