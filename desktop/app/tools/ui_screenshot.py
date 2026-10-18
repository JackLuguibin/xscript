#!/usr/bin/env python3
"""Real UI screenshots of the desktop client for PR descriptions (dev tool; not part of the shipped package).

Boots the REAL shell (QWebEngineView + xsapp:// + QWebChannel + Python services, the same `tests/harness.build_shell` the e2e
tests use) against `scripts/mock_device.py` and a FakeAdb, runs scene functions that drive the UI like a user, and saves PNGs.
The mock's 24x48 test frame is replaced by a rendered phone screen (portrait or landscape) so mirror shots look real.

Run it under a virtual display so native Qt dialogs (e.g. the close prompt) are on screen and can be grabbed too:

    xvfb-run -a -s "-screen 0 1600x1000x24" .venv-desktop/bin/python desktop/app/tools/ui_screenshot.py \\
        --scenes desktop/app/tools/screenshot_scenes/pr22.py --out desktop/docs/screenshots/pr-22 [--app <checkout>/desktop/app] [--build]

  --app     the desktop/app of the checkout to photograph (default: this one). Use a `git worktree` of a PR branch to shoot
            that PR without switching your clone; its frontend must be built (`--build` runs `npm run build` there).
  --only    run just these scenes (function names); --list shows them.
  --size    window size, default 1200x760.

A scene file defines `SCENES = [fn, ...]`; each fn(ui) gets a fresh shell. See `UI` below for what scenes can do and
screenshot_scenes/README.md for conventions. Without $DISPLAY the tool falls back to offscreen Qt (window grabs only).

Box prerequisites (Debian): xvfb, fonts-noto-cjk, and the Qt xcb plugin's libs: libxcb-cursor0 libxcb-icccm4 libxcb-keysyms1
libxcb-image0 libxcb-render-util0 libxkbcommon-x11-0. A scene failure prints the traceback and saves FAILED-<scene>.png (exit 1).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Callable

TOOL_APP = Path(__file__).resolve().parents[1]


def _args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--scenes", required=True, type=Path, help="scene file (defines SCENES = [fn, ...])")
    p.add_argument("--out", type=Path, help="output directory for PNGs")
    p.add_argument("--app", type=Path, default=TOOL_APP, help="desktop/app of the checkout to photograph")
    p.add_argument("--build", action="store_true", help="npm run build in <app>/../frontend first")
    p.add_argument("--only", nargs="*", default=None, help="scene function names to run")
    p.add_argument("--list", action="store_true", help="list scenes and exit")
    p.add_argument("--size", default="1200x760", help="window size WxH")
    return p.parse_args(argv)


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


class Bot:
    """The two pytest-qt calls the harness needs, without pytest."""

    def __init__(self, app) -> None:
        self.app = app

    def waitUntil(self, cond: Callable[[], Any], timeout: int = 5000) -> None:  # noqa: N802 (pytest-qt name)
        end = time.monotonic() + timeout / 1000
        while True:
            self.app.processEvents()
            try:
                if cond():
                    return
            except AssertionError:
                pass
            if time.monotonic() > end:
                raise TimeoutError("waitUntil timed out after %d ms" % timeout)
            time.sleep(0.01)

    def wait(self, ms: int) -> None:
        end = time.monotonic() + ms / 1000
        while time.monotonic() < end:
            self.app.processEvents()
            time.sleep(0.01)


def phone_frame(w: int, h: int, landscape: bool = False) -> bytes:
    """A plausible phone screen as JPEG bytes (status bar, app bar, list or a landscape game scene, nav bar)."""
    from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QRect, Qt
    from PySide6.QtGui import QColor, QFont, QImage, QLinearGradient, QPainter

    img = QImage(w, h, QImage.Format.Format_RGB32)
    p = QPainter(img)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    u = min(w, h) / 1080  # 1 unit = 1 px of a 1080-wide portrait screen
    f = QFont("Noto Sans CJK SC")

    def text(x, y, size, s, color="#1f2328", bold=False):
        f.setPixelSize(max(8, int(size * u)))
        f.setBold(bold)
        p.setFont(f)
        p.setPen(QColor(color))
        p.drawText(int(x), int(y), s)

    if landscape:
        g = QLinearGradient(0, 0, 0, h)
        g.setColorAt(0, QColor("#2b5876"))
        g.setColorAt(1, QColor("#4e4376"))
        p.fillRect(0, 0, w, h, g)
        p.fillRect(0, int(h * 0.72), w, h, QColor("#3d7a3a"))
        for i, c in enumerate(["#f4d35e", "#ee964b", "#f95738"]):
            p.setBrush(QColor(c))
            p.setPen(Qt.PenStyle.NoPen)
            p.drawEllipse(int(w * (0.2 + 0.25 * i)), int(h * (0.45 - 0.08 * i)), int(140 * u), int(140 * u))
        p.fillRect(0, 0, w, int(70 * u), QColor(0, 0, 0, 90))
        text(40 * u, 50 * u, 34, "关卡 3 · 金币 1280", "#ffffff", True)
        text(w - 260 * u, 50 * u, 32, "12:30", "#ffffff")
        p.setBrush(QColor(255, 255, 255, 60))
        p.drawEllipse(int(60 * u), int(h - 300 * u), int(240 * u), int(240 * u))
        p.drawEllipse(int(w - 300 * u), int(h - 300 * u), int(240 * u), int(240 * u))
    else:
        p.fillRect(0, 0, w, h, QColor("#f6f8fa"))
        p.fillRect(0, 0, w, int(90 * u), QColor("#e9edf2"))
        text(48 * u, 62 * u, 36, "12:30", "#1f2328", True)
        text(w - 200 * u, 62 * u, 32, "5G  86%", "#1f2328")
        p.fillRect(0, int(90 * u), w, int(170 * u), QColor("#2f6feb"))
        text(48 * u, 205 * u, 56, "XScript 演示", "#ffffff", True)
        y = 300 * u
        rows = ["每日签到", "自动领取奖励", "清理缓存", "批量点赞", "定时任务", "找图找色测试", "OCR 识别", "设置"]
        for i, r in enumerate(rows):
            p.fillRect(QRect(int(32 * u), int(y), int(w - 64 * u), int(190 * u)), QColor("#ffffff"))
            p.setBrush(QColor(["#ffb703", "#219ebc", "#8ecae6", "#fb8500"][i % 4]))
            p.setPen(Qt.PenStyle.NoPen)
            p.drawEllipse(int(64 * u), int(y + 45 * u), int(100 * u), int(100 * u))
            text(200 * u, y + 90 * u, 44, r, "#1f2328", True)
            text(200 * u, y + 150 * u, 32, "点按运行 · 上次 %d 分钟前" % (i * 7 + 3), "#57606a")
            y += 215 * u
        p.fillRect(0, int(h - 130 * u), w, int(130 * u), QColor("#e9edf2"))
        for i, s in enumerate(["◁", "○", "□"]):
            text(w * (0.25 + 0.25 * i) - 20 * u, h - 45 * u, 60, s, "#57606a")
    p.end()
    ba = QByteArray()
    buf = QBuffer(ba)
    buf.open(QIODevice.OpenModeFlag.WriteOnly)
    img.save(buf, "JPEG", 82)
    return bytes(ba)


def is_blank(img) -> bool:
    """True when (almost) every sampled pixel has the same colour (a white / black / unpainted grab)."""
    if img.isNull() or img.width() < 10 or img.height() < 10:
        return True
    seen: dict[int, int] = {}
    n = 0
    for yi in range(0, img.height(), max(1, img.height() // 60)):
        for xi in range(0, img.width(), max(1, img.width() // 60)):
            c = img.pixel(xi, yi)
            seen[c] = seen.get(c, 0) + 1
            n += 1
    return len(seen) < 8 or max(seen.values()) / n > 0.97


class UI:
    """What a scene can do. Element lookups are by visible text / aria-label, like a user (and like the e2e tests)."""

    def __init__(self, sh, bot: Bot, mock, mock_port: int, out: Path, app_mod) -> None:
        self.sh, self.bot, self.mock, self.mock_port, self.out = sh, bot, mock, mock_port, out
        self.ctx = sh.ctx
        self._app = app_mod
        self.saved: list[Path] = []
        self._extra_mocks: list[Any] = []

    # -- page ---------------------------------------------------------------------------------------------------------------------
    def js(self, expr: str, timeout: int = 8000) -> Any:
        return self.sh.js(self.bot, expr, timeout)

    def run_js(self, code: str) -> Any:
        """Run a statement block; wrap in an IIFE yourself if it needs a value."""
        return self.sh._eval(self.bot, code)

    def wait_js(self, expr: str, timeout: int = 10000) -> None:
        self.sh.wait_js(self.bot, expr, timeout)

    def wait_text(self, needle: str, timeout: int = 10000) -> None:
        self.sh.wait_text(self.bot, needle, timeout)

    def click(self, name: str, timeout: int = 8000) -> None:
        """First enabled <button> whose aria-label (or text) equals `name`."""
        self.sh.click(self.bot, name, timeout)

    def click_starting(self, text: str, timeout: int = 8000) -> None:
        """First enabled <button> whose text starts with `text` (list rows, nav items)."""
        sel = "[...document.querySelectorAll('button')].find(b => !b.disabled && b.textContent.trim().startsWith(%s))" % json.dumps(text)
        self.bot.waitUntil(lambda: bool(self.sh._eval(self.bot, "(() => { const b = %s; if (!b) return false; b.click(); return true; })()" % sel)), timeout)

    def goto(self, nav_label: str) -> None:
        sel = "[...document.querySelectorAll('nav .nav-item')].find(b => b.textContent.trim().startsWith(%s))" % json.dumps(nav_label)
        self.bot.waitUntil(lambda: bool(self.sh._eval(self.bot, "(() => { const b = %s; if (!b) return false; b.click(); return true; })()" % sel)), 8000)
        self.wait_js("document.querySelector('h1')?.textContent.trim().startsWith(%s)" % json.dumps(nav_label))

    def type_into(self, label: str, value: str) -> None:
        self.sh.type_into(self.bot, label, value)

    def type_monaco(self, value: str) -> None:
        """Replace the open Monaco editor's text (as typed input, so the page sees an edit)."""
        self.wait_js("document.querySelector('.monaco-host[data-ready=true] .monaco-editor')", 20000)
        self.focus_window()  # on a real (xcb) display Monaco ignores input unless the window has OS focus
        ta = "document.querySelector('.monaco-host textarea')"
        self.run_js("(() => { const t = %s; t.focus(); t.value = %s; t.setSelectionRange(%d, %d); t.dispatchEvent(new InputEvent('input', {bubbles: true, data: %s, inputType: 'insertText'})); return true; })()"
                    % (ta, json.dumps(value), len(value), len(value), json.dumps(value)))

    def focus_window(self) -> None:
        win = self.sh.win
        win.raise_()
        win.activateWindow()
        win.view.setFocus()
        self.bot.waitUntil(lambda: win.isActiveWindow(), 3000)

    def sleep(self, ms: int) -> None:
        self.bot.wait(ms)

    def settle(self, ms: int = 450) -> None:
        """Let transitions/animations and image decodes finish before a grab."""
        self.wait_js("!document.querySelector('[aria-busy=\"true\"]:not(.shot):not(.mirror-frame)') || true")
        self.bot.wait(ms)

    # -- devices --------------------------------------------------------------------------------------------------------------------
    def add_adb(self, serial: str = "emulator-5554", state: str = "device", port: int | None = None) -> int:
        """List an adb device backed by the mock (or another server on `port`); returns the backing port."""
        port = port or self.mock_port
        self.sh.fake.devices.append((serial, state, port))  # FakeAdb maps each forward to this port
        return port

    def extra_mock(self) -> int:
        """Another mock device on its own port (same module state)."""
        httpd = self.mock.serve("127.0.0.1", 0)
        self._extra_mocks.append(httpd)
        return httpd.server_address[1]

    def connect(self, serial: str = "emulator-5554") -> None:
        if not any(s == serial for s, _, _ in self.sh.fake.devices):
            self.add_adb(serial)
        self.click("刷新")
        self.click("连接 %s" % serial, timeout=10000)
        self.wait_js("[...document.querySelectorAll('article')].some(a => a.textContent.includes('在线'))", 15000)

    def seed_project(self, name: str, files: dict[str, str] | None = None) -> None:
        self.mock.STATE["projects"][name] = {k: v.encode("utf-8") for k, v in (files or {"__init__.py": "print('hello')\n"}).items()}

    def run_async(self, coro, timeout: float = 10):
        return self.sh.run_async(coro, timeout)

    def set_frame(self, w: int, h: int, landscape: bool | None = None) -> None:
        """Change the mock stream's picture and the screen size it advertises (rotate the 'phone')."""
        set_mock_frame(self.mock, w, h, w > h if landscape is None else landscape)

    # -- capture --------------------------------------------------------------------------------------------------------------------
    def shot(self, name: str, *, screen: bool = False) -> Path:
        """Save <out>/<name>.png: the window (default) or the whole screen area around it (native dialogs included)."""
        from PySide6.QtGui import QGuiApplication

        self.bot.wait(150)
        win = self.sh.win
        if screen:
            scr = win.screen() or QGuiApplication.primaryScreen()
            geo = win.frameGeometry()
            pm = scr.grabWindow(0, geo.x(), geo.y(), geo.width(), geo.height())
        else:
            pm = win.grab()
        img = pm.toImage()
        if is_blank(img):
            raise RuntimeError("screenshot %s looks blank (single colour); is the page rendered / is this an Xvfb display?" % name)
        path = self.out / ("%s.png" % name)
        path.parent.mkdir(parents=True, exist_ok=True)
        if not pm.save(str(path), "PNG"):
            raise RuntimeError("could not write %s" % path)
        self.saved.append(path)
        print("saved %s (%dx%d)" % (path, img.width(), img.height()))
        return path

    def shot_modal(self, trigger: Callable[[], Any], name: str, *, answer: str = "reject", timeout: int = 8000) -> Path:
        """`trigger` opens a native modal (e.g. win.close() → QMessageBox); grab the screen while it is up, then reject/accept it."""
        from PySide6.QtCore import QTimer
        from PySide6.QtWidgets import QApplication

        result: dict[str, Any] = {}
        start = time.monotonic()

        def poll() -> None:
            box = QApplication.activeModalWidget()
            if box is None or not box.isVisible():
                if time.monotonic() - start > timeout / 1000:
                    result["error"] = "no modal dialog appeared"
                    return
                QTimer.singleShot(50, poll)
                return
            if "t" not in result:
                result["t"] = time.monotonic()
            if time.monotonic() - result["t"] < 0.6:  # let it paint
                QTimer.singleShot(50, poll)
                return
            try:
                result["path"] = self.shot(name, screen=True)
            except Exception as e:  # noqa: BLE001 - reported below, the dialog must still close
                result["error"] = str(e)
            box.accept() if answer == "accept" else box.reject()

        QTimer.singleShot(50, poll)
        trigger()
        self.bot.waitUntil(lambda: "path" in result or "error" in result, timeout + 2000)
        if "error" in result:
            raise RuntimeError(result["error"])
        return result["path"]

    def close_extra(self) -> None:
        for h in self._extra_mocks:
            h.shutdown()
            h.server_close()


def set_mock_frame(mock, w: int, h: int, landscape: bool) -> None:
    jpeg = phone_frame(w, h, landscape)  # full device resolution, so the 1:1 view is sharp
    orig = getattr(mock, "_orig_mjpeg_part", None) or mock._mjpeg_part
    mock._orig_mjpeg_part = orig
    mock._mjpeg_part = lambda _jpeg, _w, _h: orig(jpeg, w, h)


def main(argv: list[str] | None = None) -> int:
    a = _args(argv)
    app_dir = a.app.resolve()
    repo = app_dir.parents[1]
    scenes_mod = _load(a.scenes.resolve(), "screenshot_scenes_%s" % a.scenes.stem)
    scenes = [s for s in scenes_mod.SCENES if a.only is None or s.__name__ in a.only]
    if a.list:
        for s in scenes_mod.SCENES:
            print("%-32s %s" % (s.__name__, (s.__doc__ or "").strip().split("\n")[0]))
        return 0
    if a.out is None:
        raise SystemExit("--out is required (except with --list)")
    a.out.mkdir(parents=True, exist_ok=True)
    if not a.out:
        print("--out is required", file=sys.stderr)
        return 2
    if a.build:
        subprocess.run(["npm", "run", "build"], cwd=app_dir.parent / "frontend", check=True)

    os.environ["QT_QPA_PLATFORM"] = "xcb" if os.environ.get("DISPLAY") else "offscreen"
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu")
    if not os.environ.get("DISPLAY"):
        print("note: no $DISPLAY, using offscreen Qt (window grabs only; run under xvfb-run for native dialogs)", file=sys.stderr)
    sys.path.insert(0, str(app_dir))  # the checkout under test wins over an installed xscript_desktop
    from tests import harness  # noqa: E402  (registers the xsapp scheme before the QApplication)
    import xscript_desktop

    if Path(xscript_desktop.__file__).resolve().parents[1] != app_dir:
        print("error: imported %s, not the checkout at %s" % (xscript_desktop.__file__, app_dir), file=sys.stderr)
        return 2
    if not harness.have_build():
        print("error: %s is not built; pass --build" % harness.BUILT, file=sys.stderr)
        return 2

    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication(["xscript-screenshot"])
    bot = Bot(app)
    mock = _load(repo / "scripts" / "mock_device.py", "mock_device")
    httpd = mock.serve("127.0.0.1", 0)
    port = httpd.server_address[1]
    w, h = (int(v) for v in a.size.lower().split("x"))
    pristine = json.loads(json.dumps({k: v for k, v in mock.STATE.items() if isinstance(v, (dict, list, str, type(None)))}, default=str))
    failed = 0
    try:
        for scene in scenes:
            for k, v in pristine.items():  # every scene starts from the same mock state
                mock.STATE[k] = json.loads(json.dumps(v)) if isinstance(v, (dict, list)) else v
            mock.STATE["projects"] = {}
            set_mock_frame(mock, 1080, 2400, False)
            sh = harness.build_shell(size=(w, h))
            sh.fake._next = 41000
            ui = UI(sh, bot, mock, port, a.out, xscript_desktop)
            try:
                sh.wait_url(bot)
                ui.wait_js("document.querySelector('main')", 20000)
                print("scene %s" % scene.__name__)
                scene(ui)
            except Exception as e:  # noqa: BLE001 - report and continue with the next scene
                failed += 1
                print("scene %s FAILED: %s" % (scene.__name__, e), file=sys.stderr)
                traceback.print_exc()
                try:  # what the window showed when it gave up; not blank-checked, never meant for a PR
                    sh.win.grab().save(str(a.out / ("FAILED-%s.png" % scene.__name__)), "PNG")
                except Exception:  # noqa: BLE001
                    pass
            finally:
                sh.ctx.unsaved = False  # a dirty scene must not prompt on teardown
                ui.close_extra()
                harness.close_shell(sh)
    finally:
        httpd.shutdown()
        httpd.server_close()
    return 1 if failed else 0


if __name__ == "__main__":
    rc = main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(rc)  # skip interpreter teardown: PySide/QtWebEngine objects can crash while being garbage-collected
