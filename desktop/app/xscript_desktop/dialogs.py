"""Native dialogs the page can ask for through the bridge. RPCs run on the asyncio thread; Qt widgets live on the GUI thread."""
from __future__ import annotations

import asyncio
import concurrent.futures

from PySide6.QtCore import QObject, Qt, Signal
from PySide6.QtGui import QGuiApplication
from PySide6.QtWidgets import QFileDialog, QWidget


class DirectoryPicker(QObject):
    _ask = Signal(str, object)  # title, concurrent future; queued onto the GUI thread

    def __init__(self, parent: QWidget) -> None:
        super().__init__(parent)
        self._parent = parent
        self._ask.connect(self._show, Qt.ConnectionType.QueuedConnection)

    def _show(self, title: str, fut: concurrent.futures.Future) -> None:
        try:
            path = QFileDialog.getExistingDirectory(self._parent, title or "选择文件夹")
            fut.set_result(path or None)
        except Exception as e:  # pragma: no cover - Qt failure
            fut.set_exception(e)

    async def pick(self, title: str = "") -> str | None:
        fut: concurrent.futures.Future = concurrent.futures.Future()
        self._ask.emit(title, fut)
        return await asyncio.wrap_future(fut)


class FileSaver(QObject):
    """Save dialog for a screenshot. The page never chooses the path (design §5.3: the shell owns the filesystem)."""

    _ask = Signal(object, str, str, str)

    def __init__(self, parent: QWidget) -> None:
        super().__init__(parent)
        self._parent = parent
        self._ask.connect(self._show, Qt.ConnectionType.QueuedConnection)

    def _show(self, fut: concurrent.futures.Future, title: str, name: str, filt: str) -> None:
        try:
            path, _selected = QFileDialog.getSaveFileName(self._parent, title, name, filt)
            fut.set_result(path or None)
        except Exception as e:  # pragma: no cover - Qt failure
            fut.set_exception(e)

    async def save(self, title: str = "保存截图", name: str = "xscript-screen.png", filt: str = "PNG (*.png)") -> str | None:
        fut: concurrent.futures.Future = concurrent.futures.Future()
        self._ask.emit(fut, title, name, filt)
        return await asyncio.wrap_future(fut)


class TextClipboard(QObject):
    """Puts text on the system clipboard. The RPC result does not echo it back."""

    _ask = Signal(str, object)

    def __init__(self, parent: QWidget) -> None:
        super().__init__(parent)
        self._ask.connect(self._write, Qt.ConnectionType.QueuedConnection)

    def _write(self, text: str, fut: concurrent.futures.Future) -> None:
        try:
            QGuiApplication.clipboard().setText(text)
            fut.set_result(None)
        except Exception as e:  # pragma: no cover - Qt failure
            fut.set_exception(e)

    async def write(self, text: str) -> None:
        fut: concurrent.futures.Future = concurrent.futures.Future()
        self._ask.emit(text, fut)
        await asyncio.wrap_future(fut)
