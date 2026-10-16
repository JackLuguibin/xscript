"""Visual regression of the real UI (light + dark): window.grab() against per-platform baselines (tests/baselines/<platform>/).
Deterministic by construction: FakeDevice data, FakeAdb ports from 41000, fixed window sizes, animations waited out.
No baseline for this platform => skipped (see visual_util.py). Regenerate: XSCRIPT_UPDATE_BASELINES=1 pytest -m visual."""
from __future__ import annotations

import pytest

pytest.importorskip("PySide6.QtWebEngineWidgets")

from .fake_device import STATUS, FakeDevice
from .harness import build_shell, close_shell, have_build
from .visual_util import check

pytestmark = [pytest.mark.qt, pytest.mark.visual, pytest.mark.skipif(not have_build(), reason="frontend not built")]

DEVICES = [("emulator-5554", "device"), ("R58M", "unauthorized"), ("emulator-5556", "offline")]


@pytest.fixture(scope="module")
def vis(qapp):
    fd = FakeDevice()
    sh = build_shell(size=(1100, 720))
    sh.fake_device = fd
    yield sh
    close_shell(sh)
    fd.close()


def prepare(sh, qtbot, theme: str, size=(1100, 720), devices=DEVICES, adb_missing=False):
    fd = sh.fake_device
    fd.mode = fd.screen_mode = "ok"
    fd.status.clear()
    fd.status.update(STATUS)
    sh.run_async(sh.ctx.devices.shutdown())
    sh.fake.forwards.clear()
    sh.fake._next = 41000
    sh.fake.devices = [(s, st, fd.port) for s, st in devices]
    sh.redirect.clear()
    sh.redirect[41000] = fd.port
    if adb_missing:
        async def boom(argv):
            raise FileNotFoundError("adb")

        sh.ctx.adb._runner = None
        sh.ctx.adb.path = lambda: None  # type: ignore[method-assign]
    else:
        sh.ctx.adb._runner = sh.fake
        sh.ctx.adb.path = lambda: "/fake/adb"  # type: ignore[method-assign]
    sh.win.resize(*size)
    sh.wait_url(qtbot)
    qtbot.wait(300)
    sh._eval(qtbot, "localStorage.setItem('xscript.theme', %r); 0" % theme)
    sh.win.load()
    qtbot.wait(100)
    sh.wait_url(qtbot)
    sh.wait_js(qtbot, "document.documentElement.getAttribute('data-theme') === %r && document.querySelector('main')" % theme, timeout=15000)
    sh.wait_js(qtbot, "!document.querySelector('[aria-busy=\"true\"]')", timeout=10000)


def connect_and_shoot(sh, qtbot):
    sh.click(qtbot, "连接 emulator-5554")
    sh.wait_text(qtbot, "在线")
    sh.click(qtbot, "刷新截图")
    sh.wait_js(qtbot, "(() => { const i = document.querySelector('img[alt=\"截图\"]'); return i && i.complete && i.naturalWidth > 0; })()", timeout=10000)


def settle(sh, qtbot):
    sh._eval(qtbot, "document.activeElement && document.activeElement.blur(); 0")
    qtbot.wait(600)  # card-in / fade transitions


def verify(name, sh, qtbot):
    settle(sh, qtbot)
    r = check(name, sh.win.grab().toImage())
    if r and r.startswith("skip"):
        pytest.skip(r)
    assert r is None, r


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_v_adb_list_not_connected(vis, qtbot, theme):
    """adb devices of all three kinds (ready / unauthorized / offline), nothing connected: empty-state card + list."""
    prepare(vis, qtbot, theme)
    vis.wait_text(qtbot, "emulator-5556")
    verify("devices-list-" + theme, vis, qtbot)


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_v_connected_card_with_screenshot(vis, qtbot, theme):
    """connected card: badge, tiles, phone-frame screenshot preview."""
    prepare(vis, qtbot, theme)
    vis.wait_text(qtbot, "emulator-5554")
    connect_and_shoot(vis, qtbot)
    verify("device-card-" + theme, vis, qtbot)


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_v_empty_adb(vis, qtbot, theme):
    """both empty states at once: no connected device, no adb device."""
    prepare(vis, qtbot, theme, devices=[])
    vis.wait_text(qtbot, "未发现 USB 设备")
    verify("empty-" + theme, vis, qtbot)


def test_v_adb_missing_error_state(vis, qtbot):
    prepare(vis, qtbot, "light", adb_missing=True)
    vis.wait_text(qtbot, "未检测到 adb")
    verify("adb-missing-light", vis, qtbot)


def test_v_screenshot_failure_state(vis, qtbot):
    prepare(vis, qtbot, "dark")
    vis.wait_text(qtbot, "emulator-5554")
    vis.fake_device.screen_mode = "503"
    vis.click(qtbot, "连接 emulator-5554")
    vis.wait_text(qtbot, "在线")
    vis.click(qtbot, "刷新截图")
    vis.wait_text(qtbot, "截图失败")
    verify("shot-failed-dark", vis, qtbot)


@pytest.mark.parametrize("theme,size", [("light", (640, 800)), ("dark", (480, 800))])
def test_v_narrow_windows_use_the_icon_rail(vis, qtbot, theme, size):
    """≤760 px: the sidebar collapses to an icon rail and the card stacks (reflow)."""
    prepare(vis, qtbot, theme, size=size)
    vis.wait_text(qtbot, "emulator-5554")
    connect_and_shoot(vis, qtbot)
    assert vis.js(qtbot, "document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1") is True
    verify("narrow-%d-%s" % (size[0], theme), vis, qtbot)
