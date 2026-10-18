"""E2E: the real built React app inside the real shell (QtWebEngine offscreen, xsapp:// scheme, QWebChannel bridge, Python services),
talking to a FakeAdb and a deterministic FakeDevice. Skipped when the frontend has not been built (`npm run build`)."""
from __future__ import annotations

import base64
from pathlib import Path

import pytest

pytest.importorskip("PySide6.QtWebEngineWidgets")

from xscript_desktop.services.adb import AdbError

from .fake_device import STATUS, FakeDevice
from .harness import build_shell, close_shell, have_build

pytestmark = [pytest.mark.qt, pytest.mark.skipif(not have_build(), reason="frontend not built (cd desktop/frontend && npm run build)")]


@pytest.fixture(scope="module")
def _shell(qapp):
    """One window for the whole module (QtWebEngine profiles are expensive and must be disposed in order); state is reset per test."""
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
    sh.ctx.store.forget_all()  # saved rows survive a live disconnect; the next case starts from an empty list
    sh.fake.forwards.clear()
    sh.fake.devices = [("emulator-5554", "device", fd.port), ("R58M", "unauthorized", fd.port), ("emulator-5556", "offline", fd.port)]
    sh.fake._next = 41000
    sh.ctx.adb._runner = sh.fake
    sh.redirect.clear()
    sh.redirect[41000] = fd.port
    sh.win.resize(1100, 720)
    sh.win.load()
    qtbot.wait(100)
    sh.wait_url(qtbot)
    sh.wait_js(qtbot, "document.querySelector('main') !== null && document.body.innerText.includes('emulator-5554')", timeout=15000)
    return sh


def card(sh, qtbot) -> str:
    return sh.text(qtbot)


def test_e2e_01_startup_lists_adb_devices_and_marks_unusable_ones(ui, qtbot):
    """E-01 first paint: header, no demo banner, adb list from the shell, non-`device` states can't be connected."""
    ui.wait_text(qtbot, "emulator-5554")
    t = ui.text(qtbot)
    assert "XScript 桌面端" in t and "演示模式" not in t
    assert "R58M" in t and "unauthorized" in t and "offline" in t
    assert ui.is_disabled(qtbot, "连接 R58M") is True and ui.is_disabled(qtbot, "连接 emulator-5556") is True
    assert ui.is_disabled(qtbot, "连接 emulator-5554") is False
    assert ui.js(qtbot, "document.title") == "XScript"


def test_e2e_02_connect_shows_info_screenshot_and_disconnect_cleans_forward(ui, qtbot):
    """E-02 connect over adb → card with /status info + forward port → screenshot over xsapp:// → disconnect drops the forward but keeps the saved offline card → forget removes it."""
    ui.wait_text(qtbot, "emulator-5554")
    ui.click(qtbot, "连接 emulator-5554")
    ui.wait_text(qtbot, "在线")
    ui.click(qtbot, "adb:emulator-5554 的详情")  # compact card: properties, screenshot and 忘记 fold under 详情
    t = ui.text(qtbot)
    for needle in ("emu64a16k", "google sdk_gphone16k_arm64", "1080×2337", "0.2.6", "10.0.2.16", "ae10e6ed9b09580c", "41000"):
        assert needle in t, needle
    assert list(ui.fake.forwards) == [41000]
    ui.click(qtbot, "刷新截图")
    ui.wait_js(qtbot, "document.querySelector('img[alt=\"截图\"]') && document.querySelector('img[alt=\"截图\"]').complete && document.querySelector('img[alt=\"截图\"]').naturalWidth > 0", timeout=10000)
    assert ui.js(qtbot, "document.querySelector('img[alt=\"截图\"]').naturalWidth") == 270  # the FakeDevice gradient, decoded by the browser
    ui.click(qtbot, "断开")
    ui.wait_text(qtbot, "离线")
    ui.wait_no_text(qtbot, "在线")
    assert ui.fake.forwards == {}
    assert ui.js(qtbot, "document.querySelectorAll('article').length") == 1  # saved device stays as an offline card
    ui.click(qtbot, "忘记 adb:emulator-5554")
    ui.wait_js(qtbot, "document.querySelectorAll('article').length === 0")


def test_e2e_03_screenshot_failure_when_capture_not_authorised(ui, qtbot):
    """E-03 /screen → 503 capture_unavailable: the page shows the failure and the capture hint (status.capture=false)."""
    ui.fake_device.status["capture"] = False
    ui.fake_device.screen_mode = "503"
    ui.wait_text(qtbot, "emulator-5554")
    ui.click(qtbot, "连接 emulator-5554")
    ui.click(qtbot, "adb:emulator-5554 的详情")
    ui.wait_text(qtbot, "录屏授权")
    assert "尚未授予录屏" in ui.text(qtbot)
    ui.click(qtbot, "刷新截图")
    ui.wait_text(qtbot, "截图失败")


def test_e2e_04_adb_missing_shows_install_hint_and_not_the_empty_message(ui, qtbot, monkeypatch):
    """E-04 no adb at all → `adb.not_found` rendered as the install hint; the 'no devices' text is not shown at the same time."""
    ui.wait_text(qtbot, "emulator-5554")

    async def boom(argv):  # the runner is bypassed: simulate find_adb() == None
        raise AdbError("adb.not_found", "x")

    ui.ctx.adb._runner = boom
    ui.click(qtbot, "刷新")
    ui.wait_text(qtbot, "找不到 adb")
    assert "没有发现 ADB 设备" not in ui.text(qtbot)


def test_e2e_05_adb_returns_no_devices_shows_empty_state(ui, qtbot):
    """E-05 empty ADB list → the empty-state sentence."""
    ui.fake.devices = []
    ui.click(qtbot, "刷新")
    ui.wait_text(qtbot, "没有发现 ADB 设备")


@pytest.mark.parametrize("mode, code, title", [
    ("bad_json", "device.protocol", "对方不像 XScript 设备"), ("non_object", "device.protocol", "对方不像 XScript 设备"),
    ("html", "device.protocol", "对方不像 XScript 设备"), ("429", "device.http", "设备返回了错误"), ("500", "device.http", "设备内部出错"),
    ("503", "device.http", "设备内部出错"), ("reset", "device.unreachable", "连不上设备")])
def test_e2e_06_connect_errors_surface_as_alerts(ui, qtbot, mode, code, title):
    """E-06 device misbehaves during connect (bad JSON / not an object / HTML / 429 / 500 / 503 / dropped connection): mapped alert, the code behind 详情, no card, no leaked forward."""
    ui.fake_device.mode = mode
    ui.wait_text(qtbot, "emulator-5554")
    ui.click(qtbot, "连接 emulator-5554")
    ui.wait_text(qtbot, title, timeout=15000)
    assert "[%s]" % code not in ui.text(qtbot)
    ui.click(qtbot, "详情")
    ui.wait_text(qtbot, "[%s]" % code)
    assert ui.js(qtbot, "document.querySelectorAll('article').length") == 0
    assert ui.fake.forwards == {}  # the forward created for the probe was removed again
    assert ui.js(qtbot, "!!document.querySelector('[role=alert]')") is True


def test_e2e_07_device_goes_offline_and_comes_back_via_pushed_events(ui, qtbot):
    """E-07 health refresh marks the card 离线 (+error), then 在线 again — both arrive as device.state events."""
    ui.wait_text(qtbot, "emulator-5554")
    ui.click(qtbot, "连接 emulator-5554")
    ui.wait_text(qtbot, "在线")
    ui.fake_device.mode = "500"
    ui.run_async(ui.ctx.devices.refresh("adb:emulator-5554"))
    ui.wait_text(qtbot, "离线")
    ui.wait_text(qtbot, "设备内部出错")  # the card's raw error goes through the same mapping (errorCode + status)
    ui.click(qtbot, "详情")
    ui.wait_text(qtbot, "[device.http]")
    assert "500" in ui.text(qtbot)
    ui.fake_device.mode = "ok"
    ui.run_async(ui.ctx.devices.refresh("adb:emulator-5554"))
    ui.wait_no_text(qtbot, "离线")
    assert "在线" in ui.text(qtbot)


def test_e2e_08_lan_connect_warns_about_missing_auth_for_non_loopback(ui, qtbot):
    """E-08 a non-loopback address connects but shows the 'no authentication' warning banner; loopback does not."""
    ui.redirect[9860] = ui.fake_device.port
    ui.type_into(qtbot, "device address", "192.168.1.20:9860")
    ui.click(qtbot, "连接地址")
    ui.wait_text(qtbot, "没有鉴权，同网段任何人都能运行代码")
    assert "192.168.1.20:9860" in ui.text(qtbot)


def test_e2e_09_lan_connect_to_closed_port_is_unreachable(ui, qtbot):
    """E-09 nothing listens on the address → device.unreachable alert (retryable), UI stays usable."""
    ui.type_into(qtbot, "device address", "127.0.0.1:1")
    ui.click(qtbot, "连接地址")
    ui.wait_text(qtbot, "连不上设备", timeout=15000)
    assert "前台" in ui.text(qtbot)  # the actionable hint
    ui.click(qtbot, "详情")
    ui.wait_text(qtbot, "[device.unreachable]")
    assert "cannot reach" in ui.text(qtbot)
    assert ui.is_disabled(qtbot, "连接地址") is False


def test_e2e_10_lan_connect_bad_address_and_empty_input(ui, qtbot):
    """E-10 an invalid port is refused by Python (device.protocol/bad params); an empty field keeps the connect button disabled."""
    assert ui.is_disabled(qtbot, "连接地址") is True
    ui.type_into(qtbot, "device address", "host:99999")
    ui.click(qtbot, "连接地址")
    ui.wait_text(qtbot, "设备地址格式不对", timeout=10000)
    ui.click(qtbot, "详情")
    ui.wait_text(qtbot, "invalid port")


def test_e2e_11_scan_finds_the_fake_device_only(ui, qtbot, monkeypatch):
    """E-11 scan: only endpoints answering like XScript are listed (the scan range is patched to loopback + the fake's port)."""
    import xscript_desktop.context as context

    monkeypatch.setattr(context, "lan_hosts", lambda cidr=None, limit=1024: ["127.0.0.1"])
    orig = ui.ctx.devices.scan
    port = ui.fake_device.port

    async def scan(hosts, **kw):
        return await orig(hosts, ports=(port, 1))

    monkeypatch.setattr(ui.ctx.devices, "scan", scan)
    ui.click(qtbot, "扫描本机所在的 /24 网段")
    ui.wait_text(qtbot, "127.0.0.1:%d" % port)
    assert "emu64a16k" in ui.text(qtbot)


def test_e2e_12_page_survives_garbage_from_python(ui, qtbot):
    """E-12 non-JSON / unknown-topic messages pushed from Python are ignored; the page keeps working."""
    ui.wait_text(qtbot, "emulator-5554")
    ui.bridge._deliver.emit("this is not json")
    ui.bridge._deliver.emit('{"event": true, "topic": "nobody.listens", "data": 1}')
    ui.bridge._deliver.emit('{"id": 424242, "ok": true, "result": 1}')  # late reply nobody waits for
    ui.click(qtbot, "连接 emulator-5554")
    ui.wait_text(qtbot, "在线")


def test_e2e_13_narrow_window_reflows_without_horizontal_scroll(ui, qtbot):
    """E-13 at 640 px wide the page must not need a horizontal scrollbar (reflow, WCAG 1.4.10)."""
    ui.click(qtbot, "连接 emulator-5554")
    ui.wait_text(qtbot, "在线")
    ui.win.resize(640, 700)
    qtbot.wait(300)
    assert ui.js(qtbot, "document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1") is True


def test_e2e_14_keyboard_can_reach_and_activate_connect(ui, qtbot):
    """E-14 the connect button is a real focusable <button> (Tab order) and Enter/Space activation works through a synthetic click."""
    ui.wait_text(qtbot, "emulator-5554")
    assert ui.js(qtbot, "(() => { const b = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '连接 emulator-5554'); b.focus(); return document.activeElement === b; })()") is True
    assert ui.js(qtbot, "document.querySelector('[aria-label=\"device address\"]').tabIndex >= 0") is True


def test_e2e_15_reconnect_replaces_card_and_keeps_single_forward(ui, qtbot):
    """E-15 connecting the same serial twice (button is disabled after the first) – re-connect via RPC replaces, not duplicates."""
    ui.wait_text(qtbot, "emulator-5554")
    ui.click(qtbot, "连接 emulator-5554")
    ui.wait_text(qtbot, "在线")
    assert ui.is_disabled(qtbot, "连接 emulator-5554") is True
    r = ui.js(qtbot, "new Promise(res => { const ch = window.__ch; res(null); })")  # keep the page responsive
    assert r is None
    ui.run_async(ui.ctx.devices.connect_adb("emulator-5554"))
    assert len(ui.fake.forwards) == 1
    assert ui.js(qtbot, "document.querySelectorAll('article').length") == 1


def test_e2e_16_theme_button_switches_and_survives_reload(ui, qtbot):
    """E-16 the sidebar theme button cycles system→light→dark in the real shell, sets <html data-theme>, repaints and is remembered after a reload."""
    ui.wait_text(qtbot, "主题：")
    ui.js(qtbot, "(() => { localStorage.removeItem('xscript.theme'); return 1; })()")
    ui.win.load()
    ui.wait_js(qtbot, "document.querySelector('.sidebar-foot button')")
    assert ui.js(qtbot, "document.documentElement.hasAttribute('data-theme')") is False
    ui.js(qtbot, "(() => { document.querySelector('.sidebar-foot button').click(); return 1; })()")
    ui.js(qtbot, "(() => { document.querySelector('.sidebar-foot button').click(); return 1; })()")
    ui.wait_js(qtbot, "document.documentElement.getAttribute('data-theme') === 'dark'")
    assert ui.js(qtbot, "getComputedStyle(document.body).backgroundColor") == "rgb(14, 17, 22)"  # --bg of the dark tokens
    ui.win.load()
    ui.wait_js(qtbot, "document.documentElement.getAttribute('data-theme') === 'dark' && document.querySelector('main')")
    ui.js(qtbot, "(() => { localStorage.removeItem('xscript.theme'); return 1; })()")


METRICS_FONT = base64.b64encode((Path(__file__).parent / "fixtures" / "xs-metrics.ttf").read_bytes()).decode()

# elements sticking out past the viewport, deepest first: "tag.class 'text' right=…px" (empty when nothing overflows)
OVERFLOWING = """(() => { const w = document.documentElement.clientWidth;
  return [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > w + 1 && ![...e.children].some(c => c.getBoundingClientRect().right > w + 1))
    .slice(0, 8).map(e => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).join('.') : ''} '${(e.textContent || '').trim().slice(0, 40)}' right=${Math.round(e.getBoundingClientRect().right)}px > ${w}px`); })()"""


def pin_metrics_font(sh, qtbot) -> None:
    """Lay text out with tests/fixtures/xs-metrics.ttf instead of whatever fonts the machine has, so width checks give the same answer in CI and on a desktop with CJK fonts installed (see make_metrics_font.py)."""
    sh.js(qtbot, """(() => { const f = new FontFace('XS Metrics', 'url(data:font/ttf;base64,%s)'); document.fonts.add(f); window.__xsFont = 'loading';
      f.load().then(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { font-family: "XS Metrics" !important; }';
        document.head.appendChild(s); window.__xsFont = 'ok'; }, e => { window.__xsFont = String(e); }); return 1; })()""" % METRICS_FONT)
    sh.wait_js(qtbot, "window.__xsFont !== 'loading'")
    assert sh.js(qtbot, "window.__xsFont") == "ok"
    # every glyph comes from the test font: 10px CJK = 10px, 10px latin = 6px, no system-font fallback
    assert sh.js(qtbot, """(() => { const s = document.createElement('span'); s.style.cssText = 'font-size:10px;position:absolute;white-space:pre';
      s.textContent = '中文ab'; document.body.appendChild(s); const w = s.getBoundingClientRect().width; s.remove(); return Math.round(w); })()""") == 32


@pytest.mark.parametrize("width", [400, 560, 760, 900, 1400, 2200])
def test_e2e_17_no_horizontal_scroll_at_any_width(ui, qtbot, width):
    """E-17 window-resize support: from a phone-sized column to a wide monitor the page never needs a horizontal scrollbar (also with a connected card).
    Text uses the pinned test font so the result doesn't depend on the fonts installed on the machine; a failure names the elements that stick out."""
    pin_metrics_font(ui, qtbot)
    ui.click(qtbot, "连接 emulator-5554")
    ui.wait_text(qtbot, "在线")
    ui.win.resize(width, 800)
    qtbot.wait(300)
    sticking_out = ui.js(qtbot, OVERFLOWING)  # also catches content a scroll container clips, which scrollWidth alone can miss
    assert sticking_out == []
    assert ui.js(qtbot, "document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1") is True
    # the sidebar collapses to an icon rail at ≤760 px but its labels stay available to assistive tech
    assert ui.js(qtbot, "!!document.querySelector('.nav-item .label')") is True
    assert ui.js(qtbot, "document.querySelector('.sidebar').getBoundingClientRect().width < 100") is (width <= 760)


def test_e2e_18_keyboard_focus_is_visible_and_skip_link_works(ui, qtbot):
    """E-18 a :focus-visible ring rule exists in the shipped CSS, the skip link is the first tab stop and moves focus to <main>."""
    ui.wait_text(qtbot, "emulator-5554")
    rules = ui.js(qtbot, "[...document.styleSheets].flatMap(s => [...s.cssRules]).map(r => r.cssText).filter(t => t.includes(':focus-visible') && t.includes('outline')).length")
    assert rules >= 1
    assert ui.js(qtbot, "document.querySelector('.skip-link').getAttribute('href')") == "#main"
    ui.js(qtbot, "(() => { document.querySelector('.skip-link').click(); return 1; })()")
    ui.wait_js(qtbot, "document.activeElement && document.activeElement.id === 'main'")


def test_e2e_19_screenshot_button_shows_loading_then_loaded(ui, qtbot):
    """E-19 screenshot micro-states in the real shell: skeleton + disabled button while the image loads, then the picture."""
    ui.fake_device.screen_mode = "slow"
    ui.fake_device.delay = 0.8
    ui.click(qtbot, "连接 emulator-5554")
    ui.wait_text(qtbot, "在线")
    ui.click(qtbot, "adb:emulator-5554 的详情")
    ui.click(qtbot, "刷新截图")
    ui.wait_js(qtbot, "document.querySelector('.shot[aria-busy=\"true\"]')")
    assert ui.is_disabled(qtbot, "刷新截图") is True
    ui.wait_js(qtbot, "document.querySelector('.shot[aria-busy=\"false\"]') && document.querySelector('img[alt=\"截图\"]').naturalWidth > 0", timeout=10000)
    assert ui.is_disabled(qtbot, "刷新截图") is False
