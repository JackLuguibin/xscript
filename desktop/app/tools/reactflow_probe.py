"""Real-window React Flow check (design §14.10 S3–S5, GPU on).

Run from desktop/app, without QT_QPA_PLATFORM=offscreen:

    .venv/bin/python tools/reactflow_probe.py

Prints one JSON object and exits 0. Offscreen numbers live in test_reactflow_spike.py.
"""
from __future__ import annotations

import json
import os
import sys

os.environ.pop("QT_QPA_PLATFORM", None)
os.environ.pop("QTWEBENGINE_CHROMIUM_FLAGS", None)

from PySide6.QtCore import QTimer, QUrl
from PySide6.QtTest import QTest
from PySide6.QtCore import QPoint, Qt
from PySide6.QtWidgets import QApplication

from xscript_desktop.bridge import Bridge
from xscript_desktop.context import AppContext
from xscript_desktop.runtime import AsyncRuntime
from xscript_desktop.scheme import RESOURCES, XsAppHandler, register_scheme
from xscript_desktop.services.adb import AdbService
from xscript_desktop.window import MainWindow

register_scheme()


def main() -> int:
    app = QApplication(sys.argv)
    runtime = AsyncRuntime().start()
    ctx = AppContext(adb=AdbService(), poll_interval=60)
    bridge = Bridge(ctx, runtime)
    handler = XsAppHandler(ctx, runtime, root=RESOURCES)
    win = MainWindow(bridge, handler)
    win.resize(1100, 760)
    win.show()
    win.view.load(QUrl("xsapp://app/spike.html"))
    def fail(msg: str) -> None:
        print(json.dumps({"ok": False, "error": msg}))
        app.quit()

    def read(expr: str):
        box: dict = {}
        win.page.runJavaScript(expr, lambda r: box.setdefault("r", r))
        QTest.qWait(50)
        for _ in range(100):
            if "r" in box:
                return box["r"]
            QTest.qWait(50)
        return None

    def start() -> None:
        if not read("!!(window.__spike && window.__spike.ready)"):
            fail("spike not ready")
            return
        read("window.__spike.measure(200, 300).then((s) => { window.__sample = s; })")
        def grab() -> None:
            raw = read("window.__sample ? JSON.stringify(window.__sample) : ''")
            if not raw:
                fail("no sample")
                return
            sample = json.loads(raw)
            box = json.loads(read("JSON.stringify((() => { const r = document.querySelector('.react-flow__node').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })())"))
            before = box["x"]
            view = win.view
            start_pt = QPoint(int(box["x"] + box["w"] / 2), int(box["y"] + box["h"] / 2))
            end_pt = QPoint(start_pt.x() + 60, start_pt.y())
            QTest.mousePress(view, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, start_pt)
            QTest.mouseMove(view, end_pt, delay=20)
            QTest.mouseRelease(view, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, end_pt)
            QTest.qWait(150)
            after = json.loads(read("JSON.stringify(document.querySelector('.react-flow__node').getBoundingClientRect().x)"))
            print(json.dumps({"ok": True, "gpu": True, "n200": sample, "drag": {"before": before, "after": after, "dx": after - before}}, ensure_ascii=False))
            app.quit()
        QTimer.singleShot(2500, grab)

    QTimer.singleShot(1500, start)
    QTimer.singleShot(20000, lambda: fail("timeout"))
    app.exec()
    runtime.run(ctx.shutdown(), timeout=5)
    runtime.stop()
    win.dispose()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
