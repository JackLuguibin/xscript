"""URLs for the device's own /tools pages (design §9, §12.1 设备自带工具页签).

The page names a device and a page. Python builds the URL from that device's
loopback forward (or LAN address). A URL supplied by the page is ignored.
"""
from __future__ import annotations

from urllib.parse import urlencode, urlsplit

PAGES = {
    "home": "/tools/",
    "color": "/tools/ui/color.html",
    "label": "/tools/ui/label.html",
    "mirror": "/tools/ui/mirror.html",
}

TITLES = {
    "home": "XScript 开发工具",
    "color": "XScript 图色工具",
    "label": "XScript 标注工具",
    "mirror": "XScript 投屏",
}


def http_origin(host: str, port: int) -> str:
    if not host or any(c in host for c in "/?#@ \t\r\n\\"):
        raise ValueError("bad device host")
    if not isinstance(port, int) or isinstance(port, bool) or not (0 < port <= 65535):
        raise ValueError("bad device port")
    shown = "[%s]" % host if ":" in host else host
    return "http://%s:%d" % (shown, port)


def tool_url(host: str, port: int, page: str) -> str:
    path = PAGES.get(page)
    if path is None:
        raise ValueError("unknown tool page: %s" % page)
    return http_origin(host, port) + path


def paired_url(url: str, code: str) -> str:
    """`url` behind the device's /pair page, which sets the pairing cookie and redirects there. Unchanged without a code."""
    if not code:
        return url
    parts = urlsplit(url)
    target = parts.path + ("?" + parts.query if parts.query else "")
    return "%s://%s/pair?%s" % (parts.scheme, parts.netloc, urlencode({"code": code, "next": target}))


def classify_navigation(scheme: str, host: str, port: int, link_click: bool, device_host: str, device_port: int) -> str:
    """``allow`` stays in the tool window. ``external`` is handed to the system browser. ``block`` is dropped.

    The window may talk to that one device (the tools pages call ``/status``, ``/screen``, ``/tools/*``).
    ``data:`` and ``blob:`` are how those pages draw a canvas. Everything else is refused.
    """
    if scheme in ("data", "blob", "about"):
        return "allow"
    if scheme == "http" and host.lower() == device_host.lower() and port == device_port:
        return "allow"
    if link_click and scheme in ("http", "https"):
        return "external"
    return "block"
