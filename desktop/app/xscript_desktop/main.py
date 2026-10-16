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
    p.add_argument("--data-dir", help="where to keep the web profile (default: per-user app data dir)")
    return p.parse_args(argv)


def default_data_dir() -> Path:
    if sys.platform == "win32":  # ⚠ Windows 未验证
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "XScript"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "XScript"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "xscript"


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
    runtime = AsyncRuntime().start()
    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    ctx = AppContext(adb=AdbService(args.adb), data_dir=None if args.selftest else data_dir)
    bridge = Bridge(ctx, runtime)
    handler = XsAppHandler(ctx, runtime)
    headless = bool(args.selftest)
    win = MainWindow(bridge, handler, dev_url=args.dev_url, storage=None if (headless or args.screenshot) else data_dir / "web")
    if args.size:
        try:
            w, h = (int(x) for x in args.size.lower().split("x", 1))
            win.resize(max(320, w), max(240, h))
        except ValueError:
            print("ignoring bad --size %r (expected WxH)" % args.size, file=sys.stderr)
    from .dialogs import DirectoryPicker
    picker = DirectoryPicker(win)
    ctx.pick_directory = picker.pick
    win.show()
    win.load()

    result = {"code": 1}
    poll = QTimer()
    poll.setInterval(100)
    elapsed = {"t": 0.0, "ready_at": None, "clicked": False, "theme_clicks": 0}
    theme_order = ["system", "light", "dark"]

    def finish(code: int) -> None:
        result["code"] = code
        poll.stop()
        app.quit()

    def tick() -> None:
        elapsed["t"] += 0.1
        if elapsed["t"] > args.timeout and (args.selftest or args.screenshot):
            print("FAIL: timeout waiting for the page (ui_ready=%s)" % ctx.ui_ready.is_set(), file=sys.stderr)
            finish(1)
            return
        if not ctx.ui_ready.is_set():
            return
        if elapsed["ready_at"] is None:
            elapsed["ready_at"] = elapsed["t"]
            if args.connect_adb:
                runtime.submit(_connect(ctx, args.connect_adb))
        if args.theme and elapsed["theme_clicks"] < theme_order.index(args.theme):
            elapsed["theme_clicks"] += 1  # one click per tick (React re-renders between clicks): system → light → dark
            win.page.runJavaScript("document.querySelector('.sidebar-foot button')?.click()")
            return
        if args.selftest and not args.connect_adb:
            print(json.dumps({"selftest": "ok", "version": __version__, "page": "loaded", "bridge": "roundtrip"}))
            finish(0)
        elif args.screenshot and args.click_screenshot and not elapsed["clicked"] and ctx.devices.list() and \
                elapsed["t"] - elapsed["ready_at"] >= 1.0:
            elapsed["clicked"] = True
            win.page.runJavaScript("document.querySelector('.shot button')?.click()")
        elif args.screenshot and elapsed["t"] - elapsed["ready_at"] >= args.screenshot_delay + (1.5 if args.click_screenshot else 0):
            ok = win.grab().save(args.screenshot)
            print(("saved " if ok else "FAILED to save ") + args.screenshot)
            finish(0 if ok else 1)
        elif args.selftest and args.connect_adb and ctx.devices.list():
            rec = ctx.devices.list()[0]
            print(json.dumps({"selftest": "ok", "device": rec.to_dict()["info"], "state": rec.state}, ensure_ascii=False))
            finish(0)

    poll.timeout.connect(tick)
    poll.start()

    def on_quit() -> None:
        win.dispose()
        try:
            runtime.run(ctx.shutdown(), timeout=10)  # removes the adb forwards we created
        except Exception:
            log.exception("shutdown failed")
        runtime.stop()

    app.aboutToQuit.connect(on_quit)
    app.exec()
    return result["code"] if (args.selftest or args.screenshot) else 0


async def _connect(ctx, serial: str) -> None:
    try:
        await ctx.devices.connect_adb(serial)
        ctx.devices.start_polling()
    except Exception as e:
        print("connect failed: %s" % e, file=sys.stderr)
