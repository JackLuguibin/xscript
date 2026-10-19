"""A separate QWebEngineView for one device's /tools pages (design §5.3).

Own profile, so it does not share cookies or localStorage with the main shell.
No QWebChannel: the page cannot call the desktop bridge. Requests to any host
other than that device are blocked; a clicked external link opens in the system browser.
"""
from __future__ import annotations

import asyncio
import concurrent.futures

from PySide6.QtCore import QCoreApplication, QEvent, QObject, Qt, QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile, QWebEngineSettings, QWebEngineUrlRequestInfo, QWebEngineUrlRequestInterceptor
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QMainWindow, QWidget

from .services.tool_pages import classify_navigation


class OriginGate(QWebEngineUrlRequestInterceptor):
    def __init__(self, host: str, port: int, parent: QObject) -> None:
        super().__init__(parent)
        self.host = host
        self.port = port

    def interceptRequest(self, info: QWebEngineUrlRequestInfo) -> None:
        url = info.requestUrl()
        if classify_navigation(url.scheme(), url.host(), url.port(), False, self.host, self.port) != "allow":
            info.block(True)


class DeviceToolPage(QWebEnginePage):
    def __init__(self, profile: QWebEngineProfile, host: str, port: int, parent=None) -> None:
        super().__init__(profile, parent)
        self._host = host
        self._port = port

    def acceptNavigationRequest(self, url: QUrl, nav_type, is_main_frame: bool) -> bool:
        link = nav_type == QWebEnginePage.NavigationType.NavigationTypeLinkClicked
        decision = classify_navigation(url.scheme(), url.host(), url.port(), link, self._host, self._port)
        if decision == "allow":
            return True
        if decision == "external":
            QDesktopServices.openUrl(url)
        return False

    def createWindow(self, window_type):
        return None


class ToolWindow(QMainWindow):
    def __init__(self, host: str, port: int) -> None:
        super().__init__()
        self.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, True)
        self.resize(1100, 760)
        self._dead = False
        self.profile = QWebEngineProfile()  # off the record; not the main shell's profile
        self.gate = OriginGate(host, port, self)
        self.profile.setUrlRequestInterceptor(self.gate)
        s = self.profile.settings()
        s.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, False)
        s.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, False)
        s.setAttribute(QWebEngineSettings.WebAttribute.PluginsEnabled, False)
        # The device pages copy generated color/selector snippets. The main shell stays clipboard-off.
        s.setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanAccessClipboard, True)
        self.view = QWebEngineView(self)
        self.page = DeviceToolPage(self.profile, host, port, self.view)
        self.view.setPage(self.page)
        self.setCentralWidget(self.view)

    def show_page(self, url: str, title: str) -> None:
        self.setWindowTitle(title)
        self.view.load(QUrl(url))
        self.show()
        self.raise_()
        self.activateWindow()

    def dispose(self) -> None:
        if self._dead:
            return
        self._dead = True
        # QtWebEngine wants a profile's pages gone before the profile ("Release of profile requested but WebEnginePage
        # still not deleted"). Leaving both to deferred deletion, whenever the event loop got to them, let Chromium's
        # threads segfault the process (pytest-xdist workers). Delete synchronously, page first, like MainWindow.dispose.
        self.view.setPage(None)
        self.page.deleteLater()
        QCoreApplication.sendPostedEvents(self.page, QEvent.Type.DeferredDelete)
        self.profile.deleteLater()
        QCoreApplication.sendPostedEvents(self.profile, QEvent.Type.DeferredDelete)

    def closeEvent(self, event) -> None:
        self.dispose()
        super().closeEvent(event)


class ToolHost(QObject):
    """Opens (or focuses) one tool window per device origin. RPC runs on the asyncio thread."""

    _open = Signal(str, int, str, str, object)

    def __init__(self, parent: QWidget) -> None:
        super().__init__(parent)
        self._windows: dict[tuple[str, int], ToolWindow] = {}
        self._open.connect(self._show, Qt.ConnectionType.QueuedConnection)

    def _show(self, host: str, port: int, url: str, title: str, fut: concurrent.futures.Future) -> None:
        try:
            key = (host, int(port))
            win = self._windows.get(key)
            if win is None:
                win = ToolWindow(host, int(port))
                self._windows[key] = win
                win.destroyed.connect(lambda *_args, k=key: self._windows.pop(k, None))
            win.show_page(url, title)
            fut.set_result(None)
        except Exception as e:  # pragma: no cover - Qt failure
            fut.set_exception(e)

    async def open(self, host: str, port: int, url: str, title: str) -> None:
        fut: concurrent.futures.Future = concurrent.futures.Future()
        self._open.emit(host, port, url, title, fut)
        await asyncio.wrap_future(fut)

    def dispose(self) -> None:
        for win in list(self._windows.values()):
            win.dispose()
            win.close()
        self._windows.clear()
