"""`xsapp://app/...` custom scheme (design §3.1 point 3): serves the built frontend, qwebchannel.js and device
screenshots. Only the frontend's own origin is ever loaded by the main view."""
from __future__ import annotations

import logging
import mimetypes
from pathlib import Path
from urllib.parse import unquote, urlsplit, parse_qs

from PySide6.QtCore import QBuffer, QByteArray, QFile, QIODevice, QObject, Signal, Qt
from PySide6.QtWebEngineCore import QWebEngineUrlRequestJob, QWebEngineUrlScheme, QWebEngineUrlSchemeHandler

from .context import AppContext
from .runtime import AsyncRuntime

log = logging.getLogger("xscript_desktop.scheme")

SCHEME = "xsapp"
APP_ORIGIN = "xsapp://app"
RESOURCES = Path(__file__).resolve().parent / "resources" / "app"

# connect-src 'none': the page must not make network requests of its own; everything goes through the bridge (design D4).
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
    "font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
)

_MIME_FIX = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
             ".json": "application/json", ".map": "application/json", ".woff2": "font/woff2", ".html": "text/html"}


def register_scheme() -> None:
    """Must run before QApplication is created (Qt requirement)."""
    s = QWebEngineUrlScheme(SCHEME.encode())
    s.setSyntax(QWebEngineUrlScheme.Syntax.Host)
    s.setFlags(QWebEngineUrlScheme.Flag.SecureScheme | QWebEngineUrlScheme.Flag.CorsEnabled | QWebEngineUrlScheme.Flag.FetchApiAllowed)
    QWebEngineUrlScheme.registerScheme(s)


def resolve_static(root: Path, url_path: str) -> Path | None:
    """Map a URL path to a file under `root`; refuse anything that escapes it (../, absolute, encoded, symlinks)."""
    rel = unquote(url_path).lstrip("/")
    if rel == "":
        rel = "index.html"
    if "\x00" in rel or "\\" in rel:
        return None
    root_r = root.resolve()
    try:
        p = (root_r / rel).resolve()
        p.relative_to(root_r)
    except (ValueError, OSError):
        return None
    return p if p.is_file() else None


def mime_for(path: Path | str) -> str:
    ext = Path(path).suffix.lower()
    return _MIME_FIX.get(ext) or mimetypes.guess_type(str(path))[0] or "application/octet-stream"


def frame_device_id(url_path: str) -> str | None:
    """`/_frame/<id>` or `/_frame/<id>.jpg` -> device id. Reject anything that is not a single path segment."""
    if not url_path.startswith("/_frame/"):
        return None
    device_id = unquote(url_path[len("/_frame/"):])
    if device_id.endswith(".jpg"):
        device_id = device_id[:-4]
    if not device_id or "/" in device_id or "\\" in device_id or "\0" in device_id or device_id in (".", ".."):
        return None
    return device_id


def with_csp(html: bytes) -> bytes:
    """Inject the CSP as a <meta> tag (QWebEngineUrlRequestJob's response-header API does not marshal reliably in PySide6).
    It must come first in <head> so it applies to everything after it."""
    meta = ('<meta http-equiv="Content-Security-Policy" content="%s">' % CSP).encode()
    return html.replace(b"<head>", b"<head>" + meta, 1) if b"<head>" in html else meta + html


def read_qwebchannel_js() -> bytes:
    f = QFile(":/qtwebchannel/qwebchannel.js")
    if not f.open(QIODevice.OpenModeFlag.ReadOnly):
        return b""
    try:
        return bytes(f.readAll().data())
    finally:
        f.close()


class XsAppHandler(QWebEngineUrlSchemeHandler):
    _shot_done = Signal(object, bytes, str, str)  # job, body, mime, error

    def __init__(self, ctx: AppContext, runtime: AsyncRuntime, root: Path = RESOURCES, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._ctx = ctx
        self._runtime = runtime
        self._root = root
        self._shot_done.connect(self._finish_shot, Qt.ConnectionType.QueuedConnection)

    def requestStarted(self, job: QWebEngineUrlRequestJob) -> None:
        url = job.requestUrl()
        if url.host() != "app" or bytes(job.requestMethod()) != b"GET":
            job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
            return
        path = url.path()
        if path == "/qwebchannel.js":
            body = read_qwebchannel_js()
            self._reply(job, body, "text/javascript") if body else job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
            return
        if path.startswith("/_shot/"):
            self._start_shot(job, path[len("/_shot/"):], parse_qs(url.query()))
            return
        if path.startswith("/_cloudshot/"):
            self._start_shot(job, path[len("/_cloudshot/"):], parse_qs(url.query()), cloud=True)
            return
        if path.startswith("/_frame/"):
            # Latest JPEG only (design §14.4 scheme B). `seq` is a cache-buster; a stale seq still gets the newest frame.
            device_id = frame_device_id(path)
            body = self._ctx.mirror.latest(device_id) if device_id else None
            if device_id is None:
                job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
            elif not body:
                job.fail(QWebEngineUrlRequestJob.Error.RequestFailed)
            else:
                self._reply(job, body, "image/jpeg")
            return
        f = resolve_static(self._root, path)
        if f is None:
            job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
            return
        body = f.read_bytes()
        if f.suffix.lower() == ".html":
            body = with_csp(body)
        self._reply(job, body, mime_for(f))

    # ---- helpers ------------------------------------------------------------------------------------------------------------

    def _reply(self, job: QWebEngineUrlRequestJob, body: bytes, mime: str) -> None:
        buf = QBuffer(job)
        buf.setData(QByteArray(body))
        buf.open(QIODevice.OpenModeFlag.ReadOnly)
        job.reply(QByteArray(mime.encode()), buf)

    def _start_shot(self, job: QWebEngineUrlRequestJob, name: str, query: dict[str, list[str]], cloud: bool = False) -> None:
        device_id = unquote(name)
        if device_id.endswith(".jpg"):
            device_id = device_id[:-4]
        try:
            max_side = int((query.get("max") or ["480"])[0])
        except ValueError:
            max_side = 480
        max_side = max(64, min(max_side, 2400))

        if not device_id or "/" in device_id or "\\" in device_id:
            job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
            return

        async def fetch() -> tuple[bytes, str]:
            if cloud:
                return await self._ctx.cloud_thumb(device_id, max_side)
            return await self._ctx.screen(device_id, max_side)

        fut = self._runtime.submit(fetch())

        def done(f) -> None:  # asyncio thread
            try:
                body, mime = f.result()
                self._shot_done.emit(job, body, mime, "")
            except Exception as e:
                self._shot_done.emit(job, b"", "", "%s" % e)

        fut.add_done_callback(done)

    def _finish_shot(self, job: QWebEngineUrlRequestJob, body: bytes, mime: str, err: str) -> None:
        try:
            import shiboken6

            if not shiboken6.isValid(job):  # the page cancelled the request meanwhile
                return
        except ImportError:  # pragma: no cover
            pass
        if err:
            log.info("screenshot failed: %s", err)
            job.fail(QWebEngineUrlRequestJob.Error.RequestFailed)
        else:
            self._reply(job, body, mime or "image/jpeg")
