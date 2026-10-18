"""Security checks (design §6): CSP, navigation allow-list, scheme path traversal, no direct network from the page, adb command
whitelist, secrets never in the tree. Pure-Python parts run everywhere; the in-page parts drive the real shell (offscreen)."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from xscript_desktop.scheme import CSP, mime_for, resolve_static, with_csp

REPO = Path(__file__).resolve().parents[3]
FRONTEND_SRC = REPO / "desktop" / "frontend" / "src"


def directives() -> dict[str, list[str]]:
    out = {}
    for part in CSP.split(";"):
        bits = part.split()
        if bits:
            out[bits[0]] = bits[1:]
    return out


def test_csp_has_no_network_and_no_script_escape_hatches():
    d = directives()
    assert d["connect-src"] == ["'none'"]  # fetch/XHR/WebSocket/EventSource are all governed by connect-src
    assert d["script-src"] == ["'self'"]  # no inline, no eval, no remote
    for bad in ("'unsafe-eval'", "'unsafe-inline'", "http:", "https:", "ws:", "wss:", "*", "data:", "blob:"):
        assert bad not in d["script-src"] and bad not in d["connect-src"]
    assert d["object-src"] == ["'none'"] and d["base-uri"] == ["'none'"] and d["form-action"] == ["'none'"]
    assert d["default-src"] == ["'self'"]
    assert "frame-src" not in d and "worker-src" not in d  # falls back to default-src 'self' (design §14.3: Monaco workers need a deliberate change)


@pytest.mark.parametrize("html", [b"<html><head><title>x</title></head></html>", b"<head>", b"<html>no head</html>"])
def test_csp_is_injected_before_anything_else(html):
    out = with_csp(html)
    assert out.count(b"Content-Security-Policy") == 1
    assert out.index(b"Content-Security-Policy") < (out.index(b"<title>") if b"<title>" in out else len(out))


@pytest.mark.parametrize("path", [
    "/../secret", "/..%2fsecret", "/%2e%2e/secret", "/assets/../../secret", "//etc/passwd", "/\\..\\secret", "/a\x00b", "/..%5csecret",
    "/%00", "/assets/%2e%2e%2f%2e%2e%2fsecret",
])
def test_resolve_static_blocks_every_traversal_spelling(tmp_path, path):
    root = tmp_path / "root"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("ok")
    (tmp_path / "secret").write_text("TOP SECRET")
    r = resolve_static(root, path)
    assert r is None or r.read_text() != "TOP SECRET"
    assert r is None or root.resolve() in r.resolve().parents


def test_resolve_static_serves_index_for_root_and_not_directories(tmp_path):
    (tmp_path / "index.html").write_text("i")
    (tmp_path / "d").mkdir()
    assert resolve_static(tmp_path, "/").name == "index.html"
    assert resolve_static(tmp_path, "/d") is None and resolve_static(tmp_path, "/nope.js") is None


def test_mime_types_are_explicit_so_scripts_are_never_sniffed_as_text_plain():
    assert mime_for("a.js") == "text/javascript" and mime_for("a.css") == "text/css" and mime_for("x.unknown") == "application/octet-stream"


def test_frontend_source_has_no_network_primitives():
    """Static twin of the vitest test: no fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon / dynamic import of URLs."""
    pat = re.compile(r"\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|navigator\.serviceWorker)")
    hits = []
    for f in FRONTEND_SRC.rglob("*.ts*"):
        for i, line in enumerate(f.read_text().splitlines(), 1):
            code = line.split("//")[0]
            if pat.search(code):
                hits.append("%s:%d: %s" % (f.relative_to(REPO), i, line.strip()))
    assert hits == []


def test_frontend_never_uses_dangerous_html_or_eval():
    pat = re.compile(r"dangerouslySetInnerHTML|\beval\s*\(|new Function\s*\(|innerHTML\s*=|document\.write")
    hits = [str(f.relative_to(REPO)) for f in FRONTEND_SRC.rglob("*.ts*") if pat.search(f.read_text())]
    assert hits == []


def test_built_bundle_contains_no_remote_origins():
    from .harness import BUILT

    if not BUILT.exists():
        pytest.skip("frontend not built")
    text = "".join(p.read_text(errors="ignore") for p in BUILT.parent.rglob("*") if p.is_file() and p.suffix in (".js", ".css", ".html"))
    urls = set(re.findall(r"https?://[^\s\"'`)<>]+", text))
    allowed = ("http://www.w3.org/", "https://react.dev", "http://localhost", "https://reactjs.org", "https://github.com/facebook/react")
    # Monaco's bundle carries help/license/issue links as text (shown as links, never fetched: CSP connect-src 'none').
    # Listed one by one so a real remote origin (CDN script, font, telemetry) still fails this test.
    monaco_text_links = {
        "https://code.visualstudio.com/docs/editor/codebasics#_find-and-replace",
        "https://code.visualstudio.com/docs/editor/codebasics#_multicursor-modifier",
        "https://github.com/markedjs/marked.", "https://github.com/microsoft/monaco-editor#faq",
        "https://github.com/microsoft/vscode/blob/main/LICENSE.txt", "https://github.com/microsoft/vscode/issues/103170",
        "https://github.com/microsoft/vscode/issues/new", "https://microsoft.com",
        # Tailwind's MIT license banner kept at the top of the built CSS (a comment, never fetched).
        "https://tailwindcss.com",
    }
    assert [u for u in urls if not u.startswith(allowed) and u not in monaco_text_links and not _never_remote(u)] == [], urls


def _never_remote(url: str) -> bool:
    """URLs that cannot name a real remote origin, matched on the parsed host (not a prefix, so
    "http://127.0.0.1.evil.com" or "https://example.com.evil.net" still fail):
    loopback (the demo data mirrors the real adb-forwarded device address, http://127.0.0.1:<port>) and the
    RFC 2606 example domains (placeholder text such as 设置 help "例如 https://cloud.example.com")."""
    host = (urlsplit(url).hostname or "").lower()
    if host in ("127.0.0.1", "::1"):
        return True
    return any(host == d or host.endswith("." + d) for d in ("example.com", "example.org", "example.net"))


def test_no_secret_material_is_tracked_under_desktop():
    """Hard constraint: nothing under keys/ (or key/cert files) in the desktop tree or in git."""
    files = subprocess.run(["git", "ls-files", "desktop", "docs"], cwd=REPO, capture_output=True, text=True).stdout.split()
    assert not [f for f in files if f.startswith("keys/") or f.endswith((".jks", ".keystore", ".pem", ".p12", ".key"))]


def test_device_client_ignores_proxy_environment(monkeypatch):
    from xscript_desktop.services.device_client import DeviceClient, DeviceTarget

    monkeypatch.setenv("HTTP_PROXY", "http://proxy.invalid:3128")
    monkeypatch.setenv("ALL_PROXY", "http://proxy.invalid:3128")
    assert DeviceClient(DeviceTarget())._http._trust_env is False


@pytest.mark.parametrize("url,ok", [
    ("xsapp://app/", True), ("xsapp://app/index.html?x=1", True), ("about:blank", True),
    ("xsapp://evil/", False), ("xsapp://app.evil.com/", False), ("http://127.0.0.1:9860/", False), ("https://example.com", False),
    ("file:///etc/passwd", False), ("javascript:alert(1)", False), ("data:text/html,<script>1</script>", False), ("ftp://x/", False),
    ("chrome://gpu", False), ("view-source:xsapp://app/", False),
])
def test_navigation_allow_list_table(url, ok):
    from PySide6.QtCore import QUrl

    from xscript_desktop.window import is_allowed_url

    assert is_allowed_url(QUrl(url)) is ok


def test_dev_url_allows_only_its_own_origin():
    from PySide6.QtCore import QUrl

    from xscript_desktop.window import is_allowed_url

    dev = "http://localhost:5173"
    assert is_allowed_url(QUrl("http://localhost:5173/src/main.tsx"), dev)
    assert not is_allowed_url(QUrl("http://localhost:5174/"), dev) and not is_allowed_url(QUrl("http://evil.com:5173/"), dev)
    assert not is_allowed_url(QUrl("http://localhost:5173/"))  # not allowed without the dev flag
