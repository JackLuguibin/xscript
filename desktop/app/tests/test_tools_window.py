"""The device tool window stays on that device's origin."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6.QtWebEngineWidgets")

from PySide6.QtCore import QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWebEngineCore import QWebEnginePage

from xscript_desktop.runtime import AsyncRuntime
from xscript_desktop.services.tool_pages import tool_url
from xscript_desktop.tools_view import ToolHost, ToolWindow

pytestmark = pytest.mark.qt


def test_navigation_allow_list(qtbot, monkeypatch):
    win = ToolWindow("127.0.0.1", 9860)
    qtbot.addWidget(win)
    page = win.page
    typed = QWebEnginePage.NavigationType.NavigationTypeTyped
    link = QWebEnginePage.NavigationType.NavigationTypeLinkClicked
    assert page.acceptNavigationRequest(QUrl("http://127.0.0.1:9860/tools/ui/color.html"), typed, True)
    assert page.acceptNavigationRequest(QUrl("http://127.0.0.1:9860/status"), typed, True)
    assert page.acceptNavigationRequest(QUrl("blob:http://127.0.0.1:9860/uuid"), typed, True)
    assert not page.acceptNavigationRequest(QUrl("http://127.0.0.1:9/tools/"), typed, True)
    assert not page.acceptNavigationRequest(QUrl("file:///etc/passwd"), typed, True)
    opened = {}
    monkeypatch.setattr(QDesktopServices, "openUrl", lambda url: opened.setdefault("url", url.toString()) or True)
    assert not page.acceptNavigationRequest(QUrl("https://example.com/docs"), link, True)
    assert opened["url"] == "https://example.com/docs"
    assert page.profile() is not None
    assert page.profile() is win.profile
    win.dispose()


def test_host_loads_the_device_tools_page(qtbot, mock_device):
    from PySide6.QtWidgets import QWidget

    parent = QWidget()
    qtbot.addWidget(parent)
    host = ToolHost(parent)
    rt = AsyncRuntime().start()
    url = tool_url("127.0.0.1", mock_device, "home")
    try:
        fut = rt.submit(host.open("127.0.0.1", mock_device, url, "XScript 开发工具"))
        qtbot.waitUntil(fut.done, timeout=5000)
        assert fut.result() is None
        win = host._windows[("127.0.0.1", mock_device)]
        qtbot.waitUntil(lambda: "/tools/" in win.view.url().toString(), timeout=15000)
        assert win.windowTitle() == "XScript 开发工具"
        # a second open reuses the window and navigates
        fut = rt.submit(host.open("127.0.0.1", mock_device, tool_url("127.0.0.1", mock_device, "color"), "XScript 图色工具"))
        qtbot.waitUntil(fut.done, timeout=5000)
        assert host._windows[("127.0.0.1", mock_device)] is win
        qtbot.waitUntil(lambda: win.view.url().toString().endswith("/tools/ui/color.html"), timeout=15000)
    finally:
        host.dispose()
        rt.stop()
