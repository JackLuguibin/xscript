"""Main window: one QWebEngineView on the xsapp:// origin, locked down (design §5.3)."""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Callable

from PySide6.QtCore import QCoreApplication, QEvent, QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile, QWebEngineScript, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QMainWindow, QMessageBox

from .bridge import Bridge
from .scheme import APP_ORIGIN, SCHEME, XsAppHandler, read_qwebchannel_js

log = logging.getLogger("xscript_desktop.window")


def is_allowed_url(url: QUrl, dev_url: str | None = None) -> bool:
    """Navigation allow-list: our own origin, about:blank, and (dev only) the Vite dev server origin."""
    if url.scheme() == SCHEME and url.host() == "app":
        return True
    if url.toString() == "about:blank":
        return True
    if dev_url:
        d = QUrl(dev_url)
        return url.scheme() == d.scheme() and url.host() == d.host() and url.port() == d.port()
    return False


class GuardedPage(QWebEnginePage):
    def __init__(self, profile: QWebEngineProfile, dev_url: str | None, parent=None) -> None:
        super().__init__(profile, parent)
        self._dev_url = dev_url

    def acceptNavigationRequest(self, url: QUrl, nav_type, is_main_frame: bool) -> bool:
        if is_allowed_url(url, self._dev_url):
            return True
        if url.scheme() in ("http", "https") and nav_type == QWebEnginePage.NavigationType.NavigationTypeLinkClicked:
            QDesktopServices.openUrl(url)  # external links go to the system browser
        else:
            log.warning("blocked navigation to %s", url.toString())
        return False

    def createWindow(self, window_type):  # window.open / target=_blank: never create a second web view
        return None

    def javaScriptConsoleMessage(self, level, message: str, line: int, source: str) -> None:
        log.info("[js %s] %s (%s:%d)", level.name if hasattr(level, "name") else level, message, source, line)


# Wording of the close prompt, in the page's language (the page reports it with app.setUnsaved).
CLOSE_PROMPT = {
    "zh": ("未保存的修改", "编辑器里有未保存的修改，关闭窗口会丢失这些修改。", "放弃修改并关闭", "取消"),
    "en": ("Unsaved changes", "The editor has unsaved changes. Closing the window discards them.", "Discard and close", "Cancel"),
}


class MainWindow(QMainWindow):
    def __init__(self, bridge: Bridge, handler: XsAppHandler, dev_url: str | None = None, storage: Path | None = None,
                 unsaved: Callable[[], tuple[bool, str]] | None = None) -> None:
        """`unsaved()` -> (page has unsaved edits, page language); closing the window asks first while it is True."""
        super().__init__()
        self._unsaved = unsaved
        self.setWindowTitle("XScript")
        self.resize(1180, 760)
        # a named profile persists localStorage/IndexedDB under `storage`; None => off-the-record (selftest)
        # No Qt parent: the profile must outlive the page and be released after it (see dispose()).
        self.profile = QWebEngineProfile("xscript-main") if storage else QWebEngineProfile()
        if storage:
            storage.mkdir(parents=True, exist_ok=True)
            self.profile.setPersistentStoragePath(str(storage))
            self.profile.setCachePath(str(storage / "cache"))
        self.profile.installUrlSchemeHandler(SCHEME.encode(), handler)
        s = self.profile.settings()
        s.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, False)
        s.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, False)
        s.setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanAccessClipboard, False)
        s.setAttribute(QWebEngineSettings.WebAttribute.PluginsEnabled, False)
        s.setAttribute(QWebEngineSettings.WebAttribute.AllowRunningInsecureContent, False)
        self.view = QWebEngineView(self)
        self.page = GuardedPage(self.profile, dev_url, self.view)
        self.channel = QWebChannel(self.page)
        self.channel.registerObject("xs", bridge)
        self.page.setWebChannel(self.channel)
        if dev_url:
            # The Vite dev server cannot serve qwebchannel.js (prod gets it from xsapp://app/qwebchannel.js): inject it.
            script = QWebEngineScript()
            script.setName("qwebchannel")
            script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
            script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
            script.setRunsOnSubFrames(False)
            script.setSourceCode(read_qwebchannel_js().decode("utf-8"))
            self.page.scripts().insert(script)
        self.view.setPage(self.page)
        self.setCentralWidget(self.view)
        self._dev_url = dev_url

    def closeEvent(self, event) -> None:
        dirty, lang = self._unsaved() if self._unsaved is not None else (False, "zh")
        if dirty and not self.confirm_discard(lang):
            event.ignore()
            return
        super().closeEvent(event)

    def confirm_discard(self, lang: str) -> bool:
        """Ask whether to close anyway. Cancel is the default (Enter / Esc keep the window open)."""
        title, text, discard, cancel = CLOSE_PROMPT.get(lang, CLOSE_PROMPT["zh"])
        box = QMessageBox(QMessageBox.Icon.Warning, title, text, QMessageBox.StandardButton.NoButton, self)
        if sys.platform == "darwin":
            # macOS dialogs have no title bar text (Qt drops it), so follow the platform style:
            # the title is the bold message and the explanation goes underneath.
            box.setText(title)
            box.setInformativeText(text)
        discard_btn = box.addButton(discard, QMessageBox.ButtonRole.DestructiveRole)
        cancel_btn = box.addButton(cancel, QMessageBox.ButtonRole.RejectRole)
        box.setDefaultButton(cancel_btn)
        box.setEscapeButton(cancel_btn)
        box.exec()
        return box.clickedButton() is discard_btn

    def load(self) -> None:
        self.view.load(QUrl(self._dev_url or APP_ORIGIN + "/"))

    def dispose(self) -> None:
        """Release the page before the profile (Qt warns and may crash otherwise); call from aboutToQuit."""
        self.view.setPage(None)
        self.page.deleteLater()
        self.channel.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.profile.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
