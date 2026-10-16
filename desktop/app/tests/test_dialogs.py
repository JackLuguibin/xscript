from __future__ import annotations

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6.QtWidgets")

from xscript_desktop import dialogs
from xscript_desktop.runtime import AsyncRuntime

pytestmark = pytest.mark.qt


def test_directory_picker_runs_the_dialog_on_the_gui_thread(qtbot, monkeypatch):
    import threading

    from PySide6.QtWidgets import QWidget

    seen = {}

    def fake(parent, title):
        seen["thread"] = threading.current_thread() is threading.main_thread()
        seen["title"] = title
        return "/picked" if title == "ok" else ""

    monkeypatch.setattr(dialogs.QFileDialog, "getExistingDirectory", staticmethod(fake))
    w = QWidget()
    qtbot.addWidget(w)
    picker = dialogs.DirectoryPicker(w)
    rt = AsyncRuntime().start()
    try:
        fut = rt.submit(picker.pick("ok"))
        qtbot.waitUntil(fut.done, timeout=5000)
        assert fut.result() == "/picked" and seen["thread"] is True
        fut = rt.submit(picker.pick("cancel"))
        qtbot.waitUntil(fut.done, timeout=5000)
        assert fut.result() is None
        fut = rt.submit(picker.pick(""))
        qtbot.waitUntil(fut.done, timeout=5000)
        assert seen["title"] == "选择文件夹"
    finally:
        rt.stop()
