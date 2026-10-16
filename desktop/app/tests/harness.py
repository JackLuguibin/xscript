"""Shared helpers for tests that drive the REAL shell: QWebEngineView (offscreen) + xsapp:// scheme + QWebChannel + services.

`build_shell()` serves either a tiny test page or the real built React app (needs `npm run build`), against a FakeAdb and a
`FakeDevice`; `Shell.js()` evaluates an expression in the page and returns the JSON-decoded result.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu")

from xscript_desktop.bridge import Bridge
from xscript_desktop.context import AppContext
from xscript_desktop.runtime import AsyncRuntime
from xscript_desktop.scheme import RESOURCES, XsAppHandler, register_scheme
from xscript_desktop.services.adb import AdbService
from xscript_desktop.services.device_client import DeviceClient, DeviceTarget
from xscript_desktop.window import MainWindow

from .conftest import FakeAdb

register_scheme()  # before the QApplication that pytest-qt creates

BUILT = RESOURCES / "index.html"


def have_build() -> bool:
    return BUILT.is_file()


class Shell:
    """One running shell. `qtbot` is passed per call because pytest-qt's fixture is function scoped."""

    def __init__(self, win: MainWindow, ctx: AppContext, fake: FakeAdb, runtime: AsyncRuntime, bridge: Bridge, root: Path) -> None:
        self.win, self.ctx, self.fake, self.runtime, self.bridge, self.root = win, ctx, fake, runtime, bridge, root
        self.redirect: dict[int, int] = {}  # port the app dials -> port of the fake/mock device actually listening

    # ---- JS -------------------------------------------------------------------------------------------------------------------------

    def _eval(self, qtbot, code: str, timeout: int = 8000) -> Any:
        box: dict = {}
        self.win.page.runJavaScript(code, lambda r: box.setdefault("r", r))
        qtbot.waitUntil(lambda: "r" in box, timeout=timeout)
        return box["r"]

    def js(self, qtbot, expr: str, timeout: int = 8000) -> Any:
        """Evaluate `expr` (may be a Promise) in the page and JSON-decode the result."""
        self._eval(qtbot, "window.__r = undefined; (async () => { try { window.__r = JSON.stringify(await (%s)); } catch (e) { window.__r = JSON.stringify({jsError: String(e)}); } })(); 0" % expr, timeout)
        out: dict = {}

        def ready() -> bool:
            out["v"] = self._eval(qtbot, "window.__r === undefined ? null : window.__r", timeout)
            return bool(out["v"])

        qtbot.waitUntil(ready, timeout=timeout)
        return json.loads(out["v"])

    def wait_url(self, qtbot, timeout: int = 15000) -> None:
        qtbot.waitUntil(lambda: self.win.page.url().toString().startswith("xsapp://app"), timeout=timeout)

    def wait_js(self, qtbot, expr: str, timeout: int = 8000, interval: int = 50) -> None:
        """Wait until the (synchronous) JS expression is truthy."""
        qtbot.waitUntil(lambda: bool(self._eval(qtbot, "!!(%s)" % expr, timeout)), timeout=timeout)

    # ---- DOM helpers (the app is a React page: drive it like a user) -------------------------------------------------------------------

    def click(self, qtbot, name: str, timeout: int = 8000) -> None:
        """Click the first enabled <button> whose aria-label (or text) equals `name`."""
        code = ("(() => { const b = [...document.querySelectorAll('button')].find(b => !b.disabled && ((b.getAttribute('aria-label') || b.textContent).trim() === %s)); "
                "if (!b) return false; b.click(); return true; })()" % json.dumps(name))
        qtbot.waitUntil(lambda: bool(self._eval(qtbot, code, timeout)), timeout=timeout)

    def is_disabled(self, qtbot, name: str) -> bool:
        return bool(self._eval(qtbot, "(() => { const b = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.textContent).trim() === %s); return b ? b.disabled : null; })()" % json.dumps(name)))

    def type_into(self, qtbot, label: str, value: str) -> None:
        self._eval(qtbot, ("(() => { const el = document.querySelector('[aria-label=%s]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; "
                           "set.call(el, %s); el.dispatchEvent(new Event('input', {bubbles: true})); return true; })()") % (json.dumps(label), json.dumps(value)))

    def text(self, qtbot) -> str:
        return self._eval(qtbot, "document.body.innerText") or ""

    def wait_text(self, qtbot, needle: str, timeout: int = 8000) -> None:
        qtbot.waitUntil(lambda: needle in self.text(qtbot), timeout=timeout)

    def wait_no_text(self, qtbot, needle: str, timeout: int = 8000) -> None:
        qtbot.waitUntil(lambda: needle not in self.text(qtbot), timeout=timeout)

    # ---- Python side ----------------------------------------------------------------------------------------------------------------

    def run_async(self, coro, timeout: float = 10):
        return self.runtime.run(coro, timeout=timeout)

    def grab_png(self, path: Path) -> bool:
        return self.win.grab().save(str(path))


def build_shell(root: Path | None = None, *, size: tuple[int, int] = (1100, 720), poll_interval: float = 60) -> Shell:
    runtime = AsyncRuntime().start()
    fake = FakeAdb([])
    ctx = AppContext(adb=AdbService(runner=fake), poll_interval=poll_interval)
    sh_redirect: dict[int, int] = {}

    def factory(t: DeviceTarget) -> DeviceClient:
        port = getattr(fake, "target_for", {}).get(t.port, sh_redirect.get(t.port, t.port))
        return DeviceClient(DeviceTarget("127.0.0.1" if t.host not in ("127.0.0.1", "localhost") and sh_redirect.get(t.port) else t.host, port))

    ctx.devices._factory = factory
    bridge = Bridge(ctx, runtime)
    handler = XsAppHandler(ctx, runtime, root=root or RESOURCES)
    win = MainWindow(bridge, handler)
    win.resize(*size)
    win.show()
    win.load()
    sh = Shell(win, ctx, fake, runtime, bridge, root or RESOURCES)
    sh.redirect = sh_redirect
    sh.handler = handler  # keep alive: a QWebEngineUrlSchemeHandler without a Python owner is garbage-collected and the scheme dies
    return sh


def close_shell(sh: Shell) -> None:
    sh.win.close()
    sh.win.dispose()
    sh.runtime.run(sh.ctx.shutdown(), timeout=10)
    sh.runtime.stop()
