"""Pure-Python parts of the scheme/navigation layer (no web engine needed beyond QUrl)."""
from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("PySide6")
from PySide6.QtCore import QUrl

from xscript_desktop.scheme import CSP, mime_for, resolve_static, with_csp
from xscript_desktop.window import is_allowed_url


def test_resolve_static_serves_files_and_index(tmp_path: Path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html>")
    (tmp_path / "assets" / "a.js").write_text("1")
    assert resolve_static(tmp_path, "/") == (tmp_path / "index.html").resolve()
    assert resolve_static(tmp_path, "/assets/a.js") == (tmp_path / "assets" / "a.js").resolve()
    assert resolve_static(tmp_path, "/missing.js") is None
    assert resolve_static(tmp_path, "/assets") is None  # directories are not served


@pytest.mark.parametrize("evil", ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "//etc/passwd", "/..%2fsecret.txt",
                                  "/a\\..\\..\\secret.txt", "/index.html%00.js"])
def test_resolve_static_blocks_traversal(tmp_path: Path, evil: str):
    root = tmp_path / "root"
    root.mkdir()
    (root / "index.html").write_text("x")
    (tmp_path / "secret.txt").write_text("secret")
    assert resolve_static(root, evil) is None


def test_resolve_static_blocks_symlink_escape(tmp_path: Path):
    root = tmp_path / "root"
    root.mkdir()
    (tmp_path / "secret.txt").write_text("secret")
    try:
        (root / "link.txt").symlink_to(tmp_path / "secret.txt")
    except OSError:
        pytest.skip("symlinks not available")
    assert resolve_static(root, "/link.txt") is None


def test_mime_types():
    assert mime_for("a.js") == "text/javascript" and mime_for("a.css") == "text/css" and mime_for("a.html") == "text/html"
    assert mime_for("a.svg") == "image/svg+xml" and mime_for("a.weird") == "application/octet-stream"


def test_csp_forbids_network_and_is_injected_first_in_head():
    assert "connect-src 'none'" in CSP and "script-src 'self'" in CSP and "unsafe-eval" not in CSP
    out = with_csp(b"<html><head><title>x</title></head></html>")
    assert out.index(b"Content-Security-Policy") < out.index(b"<title>")
    assert b"Content-Security-Policy" in with_csp(b"no head here")


def test_navigation_allow_list():
    ok = [QUrl("xsapp://app/"), QUrl("xsapp://app/index.html#x"), QUrl("about:blank")]
    bad = [QUrl("https://example.com/"), QUrl("http://127.0.0.1:9860/"), QUrl("xsapp://other/"), QUrl("file:///etc/passwd"), QUrl("javascript:alert(1)")]
    assert all(is_allowed_url(u) for u in ok)
    assert not any(is_allowed_url(u) for u in bad)
    assert is_allowed_url(QUrl("http://localhost:5173/x"), "http://localhost:5173")
    assert not is_allowed_url(QUrl("http://localhost:5174/x"), "http://localhost:5173")
    assert not is_allowed_url(QUrl("http://evil.com:5173/x"), "http://localhost:5173")
