"""Closing the main window with unsaved edits asks first (the page reports its state with app.setUnsaved over the bridge)."""
from __future__ import annotations

import json
import sys

import pytest

pytest.importorskip("PySide6.QtWebEngineWidgets")

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication, QMessageBox

from xscript_desktop.bridge import Bridge
from xscript_desktop.context import AppContext
from xscript_desktop.runtime import AsyncRuntime
from xscript_desktop.scheme import XsAppHandler, register_scheme
from xscript_desktop.services.adb import AdbService
from xscript_desktop.window import CLOSE_PROMPT, MainWindow

from .conftest import FakeAdb

register_scheme()

PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>
<script src="./qwebchannel.js"></script><script src="./page.js"></script></body></html>"""
PAGE_JS = """
let xs, seq = 0; const pending = {};
window.call = (method, params) => new Promise(res => { const id = ++seq; pending[id] = res; xs.call(JSON.stringify({id, method, params: params || {}})); });
new QWebChannel(qt.webChannelTransport, ch => {
  xs = ch.objects.xs;
  xs.message.connect(j => { const m = JSON.parse(j); if (!m.event && pending[m.id]) { pending[m.id](m); delete pending[m.id]; } });
  window.ready = true;
});
"""


async def rpc(ctx: AppContext, method: str, **params):
    return json.loads(await ctx.dispatcher.handle(json.dumps({"id": 1, "method": method, "params": params})))


async def test_set_unsaved_rpc():
    """app.setUnsaved stores the flag and the page language; a (re)loaded page (app.hello) starts clean."""
    ctx = AppContext(adb=AdbService(runner=FakeAdb([])), poll_interval=60)
    assert (ctx.unsaved, ctx.ui_lang) == (False, "zh")
    r = await rpc(ctx, "app.setUnsaved", unsaved=True, lang="en")
    assert r["ok"] and r["result"] == {"unsaved": True}
    assert (ctx.unsaved, ctx.ui_lang) == (True, "en")
    await rpc(ctx, "app.setUnsaved", unsaved=True, lang="fr")  # unknown language: the Chinese wording
    assert ctx.ui_lang == "zh"
    bad = await rpc(ctx, "app.setUnsaved", unsaved="yes")
    assert not bad["ok"] and bad["error"]["code"] == "rpc.bad_params"
    await rpc(ctx, "app.hello", pingOk=True)
    assert ctx.unsaved is False


class _Win(MainWindow):
    """MainWindow whose confirmation is scripted (records the language it was asked in)."""

    def __init__(self, *a, answer: bool, **kw) -> None:
        super().__init__(*a, **kw)
        self.answer, self.asked = answer, []

    def confirm_discard(self, lang: str) -> bool:
        self.asked.append(lang)
        return self.answer


def _window(cls, ctx, runtime, root=None, **kw):
    bridge, handler = Bridge(ctx, runtime), XsAppHandler(ctx, runtime, root=root)
    win = cls(bridge, handler, unsaved=lambda: (ctx.unsaved, ctx.ui_lang), **kw)
    win.keep = (bridge, handler)  # Qt does not own them: without a reference Python collects the scheme handler and the bridge
    return win


@pytest.fixture()
def env():
    runtime = AsyncRuntime().start()
    ctx = AppContext(adb=AdbService(runner=FakeAdb([])), poll_interval=60)
    yield ctx, runtime
    runtime.run(ctx.shutdown(), timeout=10)
    runtime.stop()


@pytest.mark.qt
def test_close_without_unsaved_edits_does_not_ask(qtbot, env):
    """No unsaved edits: the window closes straight away."""
    ctx, runtime = env
    win = _window(_Win, ctx, runtime, answer=False)
    win.show()
    assert win.close() is True
    assert win.asked == [] and not win.isVisible()
    win.dispose()


@pytest.mark.qt
def test_close_with_unsaved_edits_asks_and_cancel_keeps_the_window(qtbot, env):
    """Unsaved edits: closing asks in the page's language; Cancel keeps the window, Discard closes it."""
    ctx, runtime = env
    ctx.unsaved, ctx.ui_lang = True, "en"
    win = _window(_Win, ctx, runtime, answer=False)
    win.show()
    assert win.close() is False
    assert win.asked == ["en"] and win.isVisible()
    win.answer = True
    assert win.close() is True
    assert win.asked == ["en", "en"] and not win.isVisible()
    win.dispose()


@pytest.mark.qt
@pytest.mark.parametrize("lang,choice,closes", [("zh", "cancel", False), ("zh", "discard", True), ("en", "discard", True), ("en", "escape", False)])
def test_close_prompt_buttons(qtbot, env, lang, choice, closes):
    """The real QMessageBox: wording per language, Cancel is the default and the Escape button, Discard closes."""
    ctx, runtime = env
    ctx.unsaved, ctx.ui_lang = True, lang
    win = _window(MainWindow, ctx, runtime)
    win.show()
    title, text, discard, cancel = CLOSE_PROMPT[lang]
    seen: dict = {}

    def answer() -> None:
        box = QApplication.activeModalWidget()
        if not isinstance(box, QMessageBox):
            QTimer.singleShot(20, answer)
            return
        seen.update(title=box.windowTitle(), text=box.text(), info=box.informativeText(), default=box.defaultButton().text(),
                    escape=box.escapeButton().text(), buttons=sorted(b.text() for b in box.buttons()))
        if choice == "escape":
            box.escapeButton().click()
        else:
            next(b for b in box.buttons() if b.text() == (discard if choice == "discard" else cancel)).click()

    QTimer.singleShot(0, answer)
    assert win.close() is closes
    # macOS shows no window title, so the title becomes the bold message and the text the informative line.
    words = {"title": "", "text": title, "info": text} if sys.platform == "darwin" else {"title": title, "text": text, "info": ""}
    assert seen == {**words, "default": cancel, "escape": cancel, "buttons": sorted([discard, cancel])}
    assert win.isVisible() is (not closes)
    if not closes:
        ctx.unsaved = False
        win.close()
    win.dispose()


@pytest.mark.qt
def test_page_reports_unsaved_over_the_bridge(qtbot, env, tmp_path):
    """The page's app.setUnsaved call (over QWebChannel) is what closeEvent consults."""
    ctx, runtime = env
    (tmp_path / "index.html").write_text(PAGE)
    (tmp_path / "page.js").write_text(PAGE_JS)
    win = _window(_Win, ctx, runtime, root=tmp_path, answer=False)
    win.show()
    win.load()

    def page_eval(code: str):
        box: dict = {}
        win.page.runJavaScript(code, lambda r: box.setdefault("r", r))
        qtbot.waitUntil(lambda: "r" in box, timeout=8000)
        return box["r"]

    qtbot.waitUntil(lambda: page_eval("window.ready === true") is True, timeout=15000)
    page_eval("call('app.setUnsaved', {unsaved: true, lang: 'en'}); 0")
    qtbot.waitUntil(lambda: ctx.unsaved is True, timeout=5000)
    assert win.close() is False and win.asked == ["en"]
    page_eval("call('app.setUnsaved', {unsaved: false, lang: 'en'}); 0")
    qtbot.waitUntil(lambda: ctx.unsaved is False, timeout=5000)
    assert win.close() is True and win.asked == ["en"]
    win.dispose()


@pytest.mark.qt
def test_e2e_real_frontend_edit_switch_pages_then_close(qapp, qtbot, mock_device):
    """Real React build: an edit survives a page switch and back; closing asks while unsaved; after Ctrl+S it closes."""
    from .harness import build_shell, close_shell, have_build

    if not have_build():
        pytest.skip("frontend not built (cd desktop/frontend && npm run build)")
    sh = build_shell()
    asked: list[str] = []
    answer = {"v": False}
    sh.win._unsaved = lambda: (sh.ctx.unsaved, sh.ctx.ui_lang)
    sh.win.confirm_discard = lambda lang: asked.append(lang) or answer["v"]
    try:
        sh.fake.devices = [("emulator-5554", "device", mock_device)]
        sh.fake._next = 41000
        sh.redirect[41000] = mock_device
        sh.wait_url(qtbot)
        sh.wait_js(qtbot, "document.body.innerText.includes('emulator-5554')", timeout=15000)
        from xscript_desktop.services.device_client import DeviceClient, DeviceTarget

        async def seed():
            c = DeviceClient(DeviceTarget("127.0.0.1", mock_device))
            try:
                await c.create_project("e2e_unsaved")
            finally:
                await c.aclose()

        sh.run_async(seed())
        sh.click(qtbot, "连接 emulator-5554")
        sh.wait_text(qtbot, "在线")

        def click_js(selector_js: str) -> None:
            qtbot.waitUntil(lambda: bool(sh._eval(qtbot, "(() => { const b = %s; if (!b) return false; b.click(); return true; })()" % selector_js)), timeout=8000)

        nav = lambda label: "[...document.querySelectorAll('nav .nav-item')].find(b => b.textContent.trim().startsWith(%s))" % json.dumps(label)
        btn = lambda text: "[...document.querySelectorAll('button')].find(b => !b.disabled && b.textContent.trim().startsWith(%s))" % json.dumps(text)
        click_js(nav("工程"))
        click_js(btn("e2e_unsaved"))
        click_js(btn("__init__.py"))
        sh.wait_js(qtbot, "document.querySelector('.monaco-host[data-ready=true] .monaco-editor')", timeout=20000)
        ta = "document.querySelector('.monaco-host textarea')"
        sh._eval(qtbot, "(() => { const t = %s; t.focus(); t.value = 'kept = 1'; t.setSelectionRange(8, 8); t.dispatchEvent(new InputEvent('input', {bubbles: true, data: 'kept = 1', inputType: 'insertText'})); return true; })()" % ta)
        sh.wait_text(qtbot, "未保存")
        qtbot.waitUntil(lambda: sh.ctx.unsaved is True, timeout=5000)
        assert sh.ctx.ui_lang == "zh"

        click_js(nav("设备"))
        sh.wait_js(qtbot, "document.querySelector('h1')?.textContent === '设备'")
        click_js(nav("工程"))
        sh.wait_js(qtbot, "document.querySelector('.monaco-host .view-lines')?.innerText.replace(/\\u00a0/g, ' ').includes('kept = 1') === true")
        assert sh.js(qtbot, "document.body.innerText.includes('未保存')") is True

        assert sh.win.close() is False and asked == ["zh"] and sh.win.isVisible()

        sh._eval(qtbot, "(() => { %s.dispatchEvent(new KeyboardEvent('keydown', {key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true, bubbles: true})); return true; })()" % ta)
        sh.wait_text(qtbot, "已保存")
        qtbot.waitUntil(lambda: sh.ctx.unsaved is False, timeout=5000)
        assert sh.win.close() is True and asked == ["zh"]
    finally:
        answer["v"] = True
        close_shell(sh)
