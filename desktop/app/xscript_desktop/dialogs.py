"""Native dialogs the page can ask for through the bridge. RPCs run on the asyncio thread; Qt widgets live on the GUI thread."""
from __future__ import annotations

import asyncio
import concurrent.futures

from PySide6.QtCore import QObject, Qt, Signal
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
