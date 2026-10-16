"""E2E for breakpoint debugging in the real shell: the page drives debug.* over QWebChannel, Python speaks DAP to a scripted
debugpy behind a fake /debug/* bridge (tests/fake_debug_device.py). Skipped when the frontend has not been built."""
from __future__ import annotations

import pytest

pytest.importorskip("PySide6.QtWebEngineWidgets")

from .fake_debug_device import REMOTE_ROOT, FakeDebugDevice
from .harness import build_shell, close_shell, have_build
from .test_e2e_projects import btn_starting, click_js

pytestmark = [pytest.mark.qt, pytest.mark.skipif(not have_build(), reason="frontend not built (cd desktop/frontend && npm run build)")]


@pytest.fixture()
def shell(qapp, qtbot):
    dev = FakeDebugDevice()
    sh = build_shell()
    sh.fake.devices = [("dbg01", "device", dev.port)]
    sh.fake._next = 41000
    sh.redirect[41000] = dev.port
    sh.dev = dev
    sh.wait_url(qtbot)
    sh.wait_js(qtbot, "document.body.innerText.includes('dbg01')", timeout=15000)
    yield sh
    close_shell(sh)
    dev.close()


def test_e2e_d01_gutter_breakpoint_pause_variables_step_stop(shell, qtbot):
    sh = shell
    sh.click(qtbot, "连接 dbg01")
    sh.wait_text(qtbot, "在线")
    click_js(sh, qtbot, btn_starting("工程"))
    click_js(sh, qtbot, btn_starting("dbg"))
    click_js(sh, qtbot, btn_starting("__init__.py"))
    sh.wait_js(qtbot, "document.querySelector('.monaco-host[data-ready=true] .monaco-editor')", timeout=20000)
    # click the glyph margin of line 3 (Monaco's own mouse handling → onToggleBreakpoint)
    sh.wait_js(qtbot, "document.querySelectorAll('.monaco-host .view-line').length >= 3", timeout=10000)
    clicked = sh._eval(qtbot, """(() => {
      const host = document.querySelector('.monaco-host');
      const lines = [...host.querySelectorAll('.margin-view-overlays > div')].sort((a, b) => a.offsetTop - b.offsetTop);
      const glyph = host.querySelector('.glyph-margin') || host.querySelector('.margin');
      const g = glyph.getBoundingClientRect(), l = lines[2].getBoundingClientRect();
      const x = g.left + Math.min(8, g.width / 2), y = l.top + l.height / 2;
      const target = document.elementFromPoint(x, y);
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        const Ev = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        target.dispatchEvent(new Ev(type, {bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type.endsWith('down') ? 1 : 0}));
      }
      return true;
    })()""")
    assert clicked
    sh.wait_text(qtbot, "● __init__.py:3", timeout=8000)
    sh.wait_js(qtbot, "document.querySelector('.monaco-host .bp-glyph') !== null", timeout=5000)

    click_js(sh, qtbot, "[...document.querySelectorAll('button')].find(b => !b.disabled && b.textContent.trim() === '调试')")
    sh.wait_text(qtbot, "暂停于 __init__.py:3", timeout=20000)
    assert sh.dev.bps[REMOTE_ROOT + "/__init__.py"] == [3]
    sh.wait_js(qtbot, "document.querySelector('.monaco-host .dbg-current-line') !== null", timeout=5000)
    sh.wait_text(qtbot, "total", timeout=8000)  # Locals of the top frame
    sh.wait_text(qtbot, "= 30")
    sh.click(qtbot, "单步跳过")
    sh.wait_text(qtbot, "暂停于 __init__.py:4", timeout=10000)
    sh.click(qtbot, "停止调试")
    sh.wait_text(qtbot, "已停止", timeout=10000)
    assert sh.dev.stopped_project
    assert any(b.get("command") == "disconnect" for _m, _p, b in sh.dev.requests)
