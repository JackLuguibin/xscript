"""Global shortcuts inside the real shell (design §14.13).

Offscreen Qt drops synthetic OS key events, so this dispatches DOM KeyboardEvents — the same path the page's
capture listener uses. It does not prove that QtWebEngine lets ⌘K / Ctrl+K through from the operating system.
No screen stream is opened.
"""
from __future__ import annotations

import pytest

pytest.importorskip("PySide6.QtWebEngineWidgets")

from .fake_device import STATUS, FakeDevice
from .harness import build_shell, close_shell, have_build

pytestmark = [pytest.mark.qt, pytest.mark.skipif(not have_build(), reason="frontend not built (cd desktop/frontend && npm run build)")]

_PRESS = r"""
(() => {
  const apple = /Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);
  window.__press = (key, mod, shift) => {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: key, bubbles: true, cancelable: true,
      metaKey: !!(mod && apple), ctrlKey: !!(mod && !apple), shiftKey: !!shift,
    }));
    return true;
  };
  return true;
})()
"""


@pytest.fixture(scope="module")
def _shell(qapp):
    fd = FakeDevice()
    sh = build_shell()
    sh.fake_device = fd
    yield sh
    close_shell(sh)
    fd.close()


@pytest.fixture()
def ui(_shell, qtbot):
    sh = _shell
    fd = sh.fake_device
    fd.mode, fd.screen_mode, fd.delay = "ok", "ok", 0.0
    fd.status.clear()
    fd.status.update(STATUS)
    fd.requests.clear()
    sh.run_async(sh.ctx.devices.shutdown())
    sh.ctx.store.forget_all()
    sh.fake.forwards.clear()
    sh.fake.devices = [("emulator-5554", "device", fd.port)]
    sh.fake._next = 41000
    sh.ctx.adb._runner = sh.fake
    sh.redirect.clear()
    sh.redirect[41000] = fd.port
    sh.win.resize(1100, 720)
    sh.win.load()
    qtbot.wait(100)
    sh.wait_url(qtbot)
    sh.wait_js(qtbot, "document.querySelector('main') && document.body.innerText.includes('emulator-5554')", timeout=15000)
    sh.js(qtbot, _PRESS)
    return sh


def _adb_lists(ui) -> int:
    return sum(1 for call in ui.fake.calls if call[:2] == ["devices", "-l"])


def test_e2e_shortcuts_palette_nav_sidebar_help_and_settings(ui, qtbot):
    """Command palette, F5 refresh, nav chords, sidebar, help, and settings — synthetic key events in the real page."""
    before = _adb_lists(ui)
    ui.js(qtbot, "window.__press('F5', false)")
    qtbot.waitUntil(lambda: _adb_lists(ui) > before, timeout=8000)

    ui.js(qtbot, "window.__press('k', true)")
    ui.wait_text(qtbot, "命令面板")
    ui.js(qtbot, "window.__press('Escape', false)")
    ui.wait_js(qtbot, "!document.querySelector('[role=\"dialog\"]')")

    ui.js(qtbot, "window.__press('4', true)")
    ui.wait_js(qtbot, "document.querySelector('h1').textContent === '设备墙'")
    ui.js(qtbot, "window.__press('5', true)")
    ui.wait_js(qtbot, "document.querySelector('h1').textContent === '流程'")
    assert ui.js(qtbot, "[...document.querySelectorAll('nav button')].some(b => !b.disabled && b.textContent.includes('流程'))") is True

    ui.js(qtbot, "window.__press('3', true)")
    ui.wait_text(qtbot, "还没有在线设备")
    stayed = _adb_lists(ui)
    ui.js(qtbot, "window.__press('F5', false)")
    qtbot.wait(250)
    assert _adb_lists(ui) == stayed

    ui.js(qtbot, "window.__press('b', true)")
    ui.wait_js(qtbot, "document.querySelector('.app').classList.contains('sidebar-collapsed')")
    ui.js(qtbot, "window.__press('b', true)")
    ui.wait_js(qtbot, "!document.querySelector('.app').classList.contains('sidebar-collapsed')")

    ui.js(qtbot, "window.__press('?', false)")
    ui.wait_text(qtbot, "按键按当前系统显示")
    ui.js(qtbot, "window.__press('Escape', false)")
    ui.wait_js(qtbot, "!document.querySelector('[role=\"dialog\"]')")
    ui.js(qtbot, "window.__press(',', true)")
    ui.wait_text(qtbot, "adb 路径")
    ui.js(qtbot, "window.__press('Escape', false)")
    ui.wait_js(qtbot, "!document.querySelector('[role=\"dialog\"]')")
