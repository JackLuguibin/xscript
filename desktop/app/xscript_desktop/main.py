"""Entry point: `python -m xscript_desktop` / `xscript-desktop`."""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

from . import __version__

log = logging.getLogger("xscript_desktop")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="xscript-desktop", description="XScript desktop client")
    p.add_argument("--version", action="version", version="xscript-desktop " + __version__)
    p.add_argument("--selftest", action="store_true",
                   help="start the shell headless (offscreen), load the frontend, round-trip one RPC through QWebChannel, exit 0/1")
    p.add_argument("--dev-url", help="load the Vite dev server (e.g. http://localhost:5173) instead of the built frontend")
    p.add_argument("--adb", help="path to adb (default: XSCRIPT_ADB, ANDROID_HOME, PATH, platform defaults)")
    p.add_argument("--connect-adb", metavar="SERIAL", help="connect this adb device right after the UI is ready (verification aid)")
    p.add_argument("--screenshot", metavar="PNG", help="save a screenshot of the window once the UI is ready, then quit (verification aid)")
    p.add_argument("--screenshot-delay", type=float, default=2.5, help="seconds to wait after ready before the screenshot")
    p.add_argument("--click-screenshot", action="store_true", help="with --screenshot: press the page's screenshot button first (verification aid)")
    p.add_argument("--size", metavar="WxH", help="initial window size, e.g. 1180x760 (verification aid; documentation screenshots)")
    p.add_argument("--theme", choices=["system", "light", "dark"], help="with --screenshot: press the sidebar theme button until this theme is active (verification aid)")
    p.add_argument("--timeout", type=float, default=30.0, help="selftest/screenshot timeout in seconds")
    p.add_argument("--report", metavar="JSON",
                   help="with --selftest: also write the result to this file (a windowed build has no stdout, e.g. XScript.exe)")
    p.add_argument("--data-dir", help="where to keep the web profile (default: per-user app data dir)")
    p.add_argument("--update-now", action="store_true",
                   help="check the update feed, download, verify and install a newer version, then quit (verification aid; "
                        "the same steps as the About dialog, used by scripts/desktop_update_e2e.py with a local feed)")
    return p.parse_args(argv)


def default_data_dir() -> Path:
    if sys.platform == "win32":  # ⚠ Windows 未验证
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "XScript"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "XScript"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "xscript"


ICON_PATH = Path(__file__).resolve().parent / "resources" / "icon.svg"
# --theme: true once <html data-theme> (absent = "system") is the wanted theme, else press the sidebar theme button once.
THEME_STEP_JS = """(() => {
  const want = %s, now = document.documentElement.getAttribute('data-theme') || 'system';
  if (now === want) return true;
  document.querySelector('.sidebar-foot button')?.click();
  return false;
})()"""


def app_icon():
    """The XScript app icon (needs a QApplication)."""
    from PySide6.QtGui import QIcon

    return QIcon(str(ICON_PATH))


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if args.selftest:
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu")  # headless: no GPU process noise at exit

    # Qt imports are deferred so `--version` / tests of the pure-Python layer never need a display.
    from PySide6.QtCore import QTimer
    from PySide6.QtWidgets import QApplication

    from .bridge import Bridge
    from .context import AppContext
    from .runtime import AsyncRuntime
    from .scheme import XsAppHandler, register_scheme
    from .services.adb import AdbService
    from .window import MainWindow

    register_scheme()  # before QApplication
    app = QApplication([sys.argv[0]])
    app.setApplicationName("XScript")
    app.setWindowIcon(app_icon())  # window title bar + macOS Dock / Windows taskbar
    runtime = AsyncRuntime().start()
    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    if not (args.selftest or args.screenshot):
        from .services.diagnostics import add_file_log

        try:
            add_file_log(data_dir)  # for the diagnostics bundle (P5.5)
        except OSError as e:
            log.warning("no log file: %s", e)
    ctx = AppContext(adb=AdbService(args.adb), data_dir=None if args.selftest else data_dir)
    bridge = Bridge(ctx, runtime)
    handler = XsAppHandler(ctx, runtime)
    headless = bool(args.selftest)
    win = MainWindow(bridge, handler, dev_url=args.dev_url, storage=None if (headless or args.screenshot) else data_dir / "web",
                     unsaved=lambda: (ctx.unsaved, ctx.ui_lang))
    if args.size:
        try:
            w, h = (int(x) for x in args.size.lower().split("x", 1))
            win.resize(max(320, w), max(240, h))
        except ValueError:
            print("ignoring bad --size %r (expected WxH)" % args.size, file=sys.stderr)
    from .dialogs import DirectoryPicker, FileSaver, TextClipboard
    from .services.secrets import KeyringBackend
    from .tools_view import ToolHost

    picker = DirectoryPicker(win)
    ctx.pick_directory = picker.pick
    saver = FileSaver(win)
    ctx.save_file = saver.save
    clip = TextClipboard(win)
    ctx.copy_text = clip.write
    tools = ToolHost(win)
    ctx.open_tools = tools.open
    quitter = _Quitter()
    quitter.requested.connect(app.quit)  # queued onto the GUI thread when emitted from the asyncio thread
    ctx.quit_app = quitter.requested.emit
    if not (args.selftest or args.screenshot or args.update_now):
        ctx.secrets.backend = KeyringBackend()
    win.show()
    win.load()

    result = {"code": 1}
    poll = QTimer()
    poll.setInterval(100)
    elapsed = {"t": 0.0, "ready_at": None, "clicked": False, "theme_ok": False}

    def report(payload: dict) -> None:
        print(json.dumps(payload, ensure_ascii=False))
        if args.report:
            try:
                Path(args.report).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            except OSError as e:
                print("cannot write --report %s: %s" % (args.report, e), file=sys.stderr)

    def finish(code: int) -> None:
        result["code"] = code
        poll.stop()
        app.quit()

    def theme_step_done(done) -> None:
        if done and not elapsed["theme_ok"]:
            elapsed["theme_ok"] = True
            elapsed["ready_at"] = elapsed["t"]  # --screenshot-delay counts from the moment the theme is in place

    def tick() -> None:
        elapsed["t"] += 0.1
        if elapsed["t"] > args.timeout and (args.selftest or args.screenshot):
            print("FAIL: timeout waiting for the page (ui_ready=%s)" % ctx.ui_ready.is_set(), file=sys.stderr)
            if args.selftest:
                report({"selftest": "timeout", "version": __version__, "uiReady": ctx.ui_ready.is_set()})
            finish(1)
            return
        if not ctx.ui_ready.is_set():
            return
        if elapsed["ready_at"] is None:
            elapsed["ready_at"] = elapsed["t"]
            if not (args.selftest or args.screenshot or args.update_now):
                runtime.submit(ctx.connect_saved())  # only rows with auto_connect=1; design §14.5
            if args.connect_adb:
                runtime.submit(_connect(ctx, args.connect_adb))
            if args.update_now:
                runtime.submit(_update_now(ctx, result))
        if args.theme and not elapsed["theme_ok"]:
            # Click the theme button (system → light → dark) until <html data-theme> shows the wanted theme, at most one
            # click per tick so React re-renders in between. Counting clicks blindly lost one whenever the button was
            # not rendered yet (the ?.click() did nothing) and the screenshot came out in the wrong theme.
            win.page.runJavaScript(THEME_STEP_JS % json.dumps(args.theme), theme_step_done)
            return
        if args.selftest and not args.connect_adb:
            report({"selftest": "ok", "version": __version__, "page": "loaded", "bridge": "roundtrip"})
            finish(0)
        elif args.screenshot and args.click_screenshot and not elapsed["clicked"] and ctx.devices.list() and \
                elapsed["t"] - elapsed["ready_at"] >= 1.0:
            elapsed["clicked"] = True
            # the compact card keeps the screenshot under 详情: open it, then press the button once React has rendered it
            win.page.runJavaScript("document.querySelector('.details-toggle[aria-expanded=\"false\"]')?.click(); "
                                   "setTimeout(() => document.querySelector('.shot button')?.click(), 150)")
        elif args.screenshot and elapsed["t"] - elapsed["ready_at"] >= args.screenshot_delay + (1.5 if args.click_screenshot else 0):
            ok = win.grab().save(args.screenshot)
            print(("saved " if ok else "FAILED to save ") + args.screenshot)
            finish(0 if ok else 1)
        elif args.selftest and args.connect_adb and ctx.devices.list():
            rec = ctx.devices.list()[0]
            report({"selftest": "ok", "device": rec.to_dict()["info"], "state": rec.state})
            finish(0)

    poll.timeout.connect(tick)
    poll.start()

    def on_quit() -> None:
        tools.dispose()
        win.dispose()
        try:
            runtime.run(ctx.shutdown(), timeout=10)  # removes the adb forwards we created
        except Exception:
            log.exception("shutdown failed")
        runtime.stop()

    app.aboutToQuit.connect(on_quit)
    app.exec()
    return result["code"] if (args.selftest or args.screenshot or args.update_now) else 0


def _Quitter():
    """A QObject whose `requested` signal, emitted from any thread, runs the connected slot on the GUI thread."""
    from PySide6.QtCore import QObject, Signal

    class Quitter(QObject):
        requested = Signal()

    return Quitter()


async def _update_now(ctx, result: dict) -> None:
    """--update-now: check → download → install (the app then quits; exit code 0) or report why not (exit 1, quit)."""
    u = ctx.updates
    try:
        s = await u.check()
        print("update check: %s" % json.dumps(s, ensure_ascii=False))
        if s["state"] == "none":
            result["code"] = 0
        elif s["state"] == "available":
            s = await u.download()
            print("update download: %s" % s["state"])
            if s["state"] == "ready":
                r = await ctx.install_update()  # quits the app
                print("update install: %s (helper log %s)" % (r["state"], r["helperLog"]))
                result["code"] = 0
                return
    except Exception as e:  # noqa: BLE001 - reported, exit code 1
        print("update failed: %s" % e, file=sys.stderr)
    if u.error:
        print("update failed: %s" % json.dumps(u.error, ensure_ascii=False), file=sys.stderr)
    if ctx.quit_app:
        ctx.quit_app()


async def _connect(ctx, serial: str) -> None:
    try:
        rec = await ctx.devices.connect_adb(serial)
        await ctx._remember(rec)  # serial only; the forward port stays in memory
        ctx.devices.start_polling()
    except Exception as e:
        print("connect failed: %s" % e, file=sys.stderr)
