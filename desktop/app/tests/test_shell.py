"""Qt integration: a real QWebEngineView (offscreen) + xsapp:// scheme + QWebChannel bridge + services.

Uses a tiny test page, not the built React app, so it does not depend on `npm run build`.
(The built app is covered by `python -m xscript_desktop --selftest`.)
"""
from __future__ import annotations

import json
import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu")
pytest.importorskip("PySide6.QtWebEngineWidgets")

from PySide6.QtCore import QUrl
from PySide6.QtWebEngineCore import QWebEnginePage

from xscript_desktop.bridge import Bridge
from xscript_desktop.context import AppContext
from xscript_desktop.runtime import AsyncRuntime
from xscript_desktop.scheme import XsAppHandler, register_scheme
from xscript_desktop.services.adb import AdbService
from xscript_desktop.services.device_client import DeviceClient, DeviceTarget
from xscript_desktop.window import MainWindow

from .conftest import FakeAdb

register_scheme()  # before the QApplication that pytest-qt creates

# CSP script-src 'self' forbids inline scripts, so the page logic lives in a separate file (as the real app's does)
PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>
<script src="./qwebchannel.js"></script><script src="./page.js"></script></body></html>"""
PAGE_JS = """
const events = [];
let xs, seq = 0; const pending = {};
function call(method, params) { return new Promise(res => { const id = ++seq; pending[id] = res; xs.call(JSON.stringify({id, method, params: params || {}})); }); }
new QWebChannel(qt.webChannelTransport, ch => {
  xs = ch.objects.xs;
  xs.message.connect(j => { const m = JSON.parse(j); if (m.event) events.push(m); else if (pending[m.id]) { pending[m.id](m); delete pending[m.id]; } });
  window.ready = true;
});
"""


@pytest.fixture(scope="module")
def shell(tmp_path_factory, qapp):
    root = tmp_path_factory.mktemp("web")
    (root / "index.html").write_text(PAGE)
    (root / "page.js").write_text(PAGE_JS)
    runtime = AsyncRuntime().start()
    fake = FakeAdb([])
    ctx = AppContext(adb=AdbService(runner=fake), poll_interval=60)
    ctx.devices._factory = lambda t: DeviceClient(DeviceTarget(t.host, getattr(fake, "target_for", {}).get(t.port, t.port)))
    bridge = Bridge(ctx, runtime)
    handler = XsAppHandler(ctx, runtime, root=root)
    win = MainWindow(bridge, handler)
    win.show()
    win.load()
    s = type("Shell", (), {})()
    s.win, s.ctx, s.fake, s.runtime, s.root = win, ctx, fake, runtime, root
    yield s
    win.close()
    win.dispose()
    runtime.run(ctx.shutdown(), timeout=10)
    runtime.stop()


def _eval(shell, qtbot, code: str, timeout: int):
    box: dict = {}
    shell.win.page.runJavaScript(code, lambda r: box.setdefault("r", r))
    qtbot.waitUntil(lambda: "r" in box, timeout=timeout)
    return box["r"]


def js(shell, qtbot, expr: str, timeout=8000):
    """Evaluate `expr` in the page (it may be a Promise; runJavaScript itself does not await) and JSON-decode the result."""
    _eval(shell, qtbot, "window.__r = undefined; (async () => { try { window.__r = JSON.stringify(await (%s)); } catch (e) { window.__r = JSON.stringify({jsError: String(e)}); } })(); 0" % expr, timeout)
    out: dict = {}

    def ready() -> bool:
        out["v"] = _eval(shell, qtbot, "window.__r === undefined ? null : window.__r", timeout)
        return bool(out["v"])  # JS null arrives as None or ''

    qtbot.waitUntil(ready, timeout=timeout)
    try:
        return json.loads(out["v"])
    except ValueError:
        raise AssertionError("page returned a non-JSON value for %r: %r" % (expr, out["v"]))


def wait_ready(shell, qtbot):
    qtbot.waitUntil(lambda: shell.win.page.url().toString().startswith("xsapp://app"), timeout=15000)
    qtbot.waitUntil(lambda: _eval(shell, qtbot, "window.ready === true", 5000) is True, timeout=15000)


@pytest.mark.qt
def test_bridge_roundtrip_through_qwebchannel(shell, qtbot):
    wait_ready(shell, qtbot)
    r = js(shell, qtbot, "call('app.ping', {echo: '签到-\\u2603'})")
    assert r["ok"] is True and r["result"]["pong"] == "签到-☃"
    bad = js(shell, qtbot, "call('nope.nope')")
    assert bad["ok"] is False and bad["error"]["code"] == "rpc.method_not_found"


@pytest.mark.qt
def test_page_cannot_make_network_requests_csp(shell, qtbot, mock_device):
    wait_ready(shell, qtbot)
    r = js(shell, qtbot, "fetch('http://127.0.0.1:%d/status').then(() => 'LEAKED', e => 'blocked:' + e.name)" % mock_device)
    assert r.startswith("blocked:")
    r = js(shell, qtbot, "new Promise(res => { const x = new XMLHttpRequest(); x.onerror = () => res('blocked'); x.onload = () => res('LEAKED'); x.open('GET', 'http://127.0.0.1:%d/status'); x.send(); })" % mock_device)
    assert r == "blocked"


@pytest.mark.qt
def test_navigation_guard_blocks_external_and_unknown(shell, qtbot, monkeypatch):
    opened = []
    monkeypatch.setattr("xscript_desktop.window.QDesktopServices.openUrl", lambda u: opened.append(u.toString()) or True)
    page = shell.win.page
    NT = QWebEnginePage.NavigationType
    assert page.acceptNavigationRequest(QUrl("xsapp://app/x"), NT.NavigationTypeTyped, True) is True
    assert page.acceptNavigationRequest(QUrl("https://example.com/"), NT.NavigationTypeLinkClicked, True) is False
    assert opened == ["https://example.com/"]  # handed to the system browser, not loaded in the view
    assert page.acceptNavigationRequest(QUrl("http://127.0.0.1:9860/"), NT.NavigationTypeTyped, True) is False
    assert page.acceptNavigationRequest(QUrl("file:///etc/passwd"), NT.NavigationTypeLinkClicked, True) is False
    assert opened == ["https://example.com/"]
    assert page.createWindow(QWebEnginePage.WebWindowType.WebBrowserTab) is None


@pytest.mark.qt
def test_scheme_rejects_unknown_paths(shell, qtbot):
    wait_ready(shell, qtbot)
    r = js(shell, qtbot, "new Promise(res => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('error'); i.src = '/../../etc/passwd.png'; })")
    assert r == "error"


@pytest.mark.qt
def test_device_events_and_screenshot_over_scheme(shell, qtbot, mock_device):
    wait_ready(shell, qtbot)
    shell.fake.devices = [("emulator-5554", "device", mock_device)]
    r = js(shell, qtbot, "call('device.connect', {transport: 'adb', serial: 'emulator-5554'})")
    assert r["ok"], r
    assert r["result"]["info"]["model"] == "XScript Mock"
    # the Python side pushed device.state to the page
    qtbot.waitUntil(lambda: js(shell, qtbot, "events.filter(e => e.topic === 'device.state').length") >= 1, timeout=5000)
    # the screenshot comes through xsapp://app/_shot/<id>.jpg and is decoded by the browser
    w = js(shell, qtbot, "new Promise(res => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(-1); i.src = '/_shot/adb%3Aemulator-5554.jpg?max=480'; })")
    assert w > 0
    gone = js(shell, qtbot, "new Promise(res => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('error'); i.src = '/_shot/adb%3Anope.jpg'; })")
    assert gone == "error"
    assert js(shell, qtbot, "call('device.disconnect', {id: 'adb:emulator-5554'})")["result"]["removed"] is True
    assert shell.fake.forwards == {}


@pytest.mark.qt
def test_cloud_thumbnail_over_scheme(shell, qtbot):
    """The cloud wall's thumbnails come through xsapp://app/_cloudshot/<id>.jpg, fetched over the backend relay."""
    from PySide6.QtCore import QBuffer, QByteArray, QIODevice
    from PySide6.QtGui import QColor, QImage

    from .fake_backend import ORIGIN, FakeBackend

    img = QImage(8, 6, QImage.Format.Format_RGB32)
    img.fill(QColor("teal"))
    raw = QByteArray()
    buf = QBuffer(raw)
    buf.open(QIODevice.OpenModeFlag.WriteOnly)
    img.save(buf, "JPG")
    fb = FakeBackend()
    fb.jpeg = bytes(raw.data())
    shell.ctx.cloud.transport = fb.transport()
    wait_ready(shell, qtbot)
    r = js(shell, qtbot, "call('cloud.connect', {origin: '%s', token: 'xsk_op'})" % ORIGIN)
    assert r["ok"], r
    w = js(shell, qtbot, "new Promise(res => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(-1); i.src = '/_cloudshot/dev-a1.jpg?max=320'; })")
    assert w == 8
    assert fb.relayed[-1]["query"]["max"] == 320
    off = js(shell, qtbot, "new Promise(res => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('error'); i.src = '/_cloudshot/dev-c3.jpg'; })")
    assert off == "error"
    assert js(shell, qtbot, "call('cloud.disconnect', {})")["ok"]
