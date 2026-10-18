"""E2E for the mirror page in the real shell against scripts/mock_device.py: window fit (H3) and the natural controls (M9)."""
from __future__ import annotations

import pytest

pytest.importorskip("PySide6.QtWebEngineWidgets")

from .harness import have_build
from .test_e2e_projects import btn_starting, click_js, shell  # noqa: F401  (shell is the shared fixture)

pytestmark = [pytest.mark.qt, pytest.mark.skipif(not have_build(), reason="frontend not built (cd desktop/frontend && npm run build)")]


def test_e2e_m01_mirror_fits_window_and_wheel_rightclick_keyboard(shell, qtbot):
    """H3 + M9 in the real shell: the whole picture is inside the window (aspect kept), wheel = swipe, right-click = back,
    typing on the focused frame + Enter = one input action."""
    sh = shell
    mock = __import__("mock_device")
    sh.click(qtbot, "连接 emulator-5554")
    sh.wait_text(qtbot, "在线")
    click_js(sh, qtbot, btn_starting("屏幕"))
    img = "document.querySelector('img[alt=\"设备屏幕\"]')"
    sh.wait_js(qtbot, "%s && %s.complete && %s.naturalWidth > 0" % (img, img, img), timeout=15000)
    sh.wait_js(qtbot, "(() => { const r = %s.getBoundingClientRect(); return r.height > 50 && r.bottom <= window.innerHeight + 1; })()" % img, timeout=8000)
    geo = sh.js(qtbot, "(() => { const i = %s; const r = i.getBoundingClientRect(); return [r.width, r.height, i.naturalWidth, i.naturalHeight, window.innerHeight, document.scrollingElement.scrollHeight]; })()" % img)
    w, h, nw, nh, inner, _ = geo
    assert abs(w / h - nw / nh) < 0.02, geo  # aspect ratio kept
    assert h <= inner, geo

    before = len(mock.STATE["actions"])
    sh._eval(qtbot, "(() => { const i = %s; const r = i.getBoundingClientRect(); "
                    "i.dispatchEvent(new WheelEvent('wheel', {bubbles: true, cancelable: true, deltaY: 120, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2})); return true; })()" % img)
    qtbot.waitUntil(lambda: len(mock.STATE["actions"]) > before, timeout=8000)
    sw = mock.STATE["actions"][-1]
    assert sw["type"] == "swipe" and sw["x1"] == sw["x2"] and sw["y2"] < sw["y1"], sw  # scroll down = finger up

    sh._eval(qtbot, "(() => { %s.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2})); return true; })()" % img)
    qtbot.waitUntil(lambda: mock.STATE["actions"][-1] == {"type": "key", "name": "back"}, timeout=8000)

    frame = "document.querySelector('.mirror-frame')"
    sh._eval(qtbot, "(() => { const f = %s; f.focus(); for (const key of ['o', 'k', 'Enter']) f.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true})); return true; })()" % frame)
    qtbot.waitUntil(lambda: mock.STATE["actions"][-1] == {"type": "input", "text": "ok"}, timeout=8000)
