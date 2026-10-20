"""A configurable fake of the device HTTP API (`protocol/openapi.yaml`) for error-path, e2e and visual tests.

Unlike `scripts/mock_device.py` (a broad functional mock with random ports and fixed content) this one is small, fully
deterministic (fixed /status, generated gradient screenshot) and can misbehave on demand: bad JSON, HTML pages, 429/500/503,
dropped connections, slow responses, 503 capture_unavailable on /screen.
"""
from __future__ import annotations

import json
import socket
import struct
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATUS = {
    "name": "emu64a16k", "model": "sdk_gphone16k_arm64", "brand": "google", "sdk": 37, "release": "17", "width": 1080, "height": 2337,
    "density": 420, "ip": "10.0.2.16", "port": 9860, "accessibility": False, "root": False, "run_mode": "auto", "channel": "none",
    "capture": True, "running": False, "project": None, "version": "0.2.6", "device_id": "ae10e6ed9b09580c", "app_id": "com.xscript.app",
    "cloud": "未连接",
}


class _Server(ThreadingHTTPServer):
    # socketserver listens with a backlog of 5; Windows refuses connections beyond it at once (macOS/Linux queue
    # them), which failed test_perf's 50 concurrent status calls on the Windows runner with "connection refused".
    request_queue_size = 128


def make_png(w: int = 270, h: int = 585) -> bytes:
    """Deterministic vertical gradient with a lighter top bar, so a screenshot is recognisable in a visual diff."""
    rows = bytearray()
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            if y < 40:
                row += bytes((236, 240, 248))
            else:
                row += bytes((40 + (x * 90) // w, 90 + (y * 120) // h, 200 - (y * 100) // h))
        rows += row

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(rows))) + chunk(b"IEND", b"")


class FakeDevice:
    def __init__(self, status: dict | None = None) -> None:
        self.status = dict(STATUS, **(status or {}))
        self.mode = "ok"  # ok | bad_json | non_object | html | 429 | 500 | 503 | reset | slow | empty
        self.screen_mode = "ok"  # ok | 503 | bad | slow | 404
        self.delay = 0.0
        self.requests: list[tuple[str, str]] = []
        self.png = make_png()
        outer = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a) -> None:  # noqa: D401 - silence
                pass

            def _send(self, code: int, ctype: str, body: bytes) -> None:
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802
                outer.requests.append(("GET", self.path))
                path = self.path.split("?", 1)[0]
                if path == "/status":
                    self._status()
                elif path == "/screen":
                    self._screen()
                elif path == "/projects":
                    self._send(200, "application/json", json.dumps({"projects": ["demo"], "details": [{"name": "demo", "files": 3}]}).encode())
                else:
                    self._send(404, "application/json", b'{"error":"not found"}')

            def _status(self) -> None:
                m = outer.mode
                if m == "slow" or outer.delay:
                    time.sleep(outer.delay or 3.0)
                if m == "reset":
                    self.close_connection = True
                    try:
                        self.connection.shutdown(socket.SHUT_RDWR)  # a real abrupt drop (close() alone leaves the makefile() wrappers open)
                    except OSError:
                        pass
                    return
                if m == "bad_json":
                    self._send(200, "application/json", b'{"name": "x", ')
                elif m == "non_object":
                    self._send(200, "application/json", b"[1, 2, 3]")
                elif m == "html":
                    self._send(200, "text/html", b"<html><body>captive portal</body></html>")
                elif m == "empty":
                    self._send(200, "application/json", b"")
                elif m in ("429", "500", "503"):
                    self._send(int(m), "application/json", json.dumps({"error": "mode " + m}).encode())
                else:
                    self._send(200, "application/json", json.dumps(outer.status).encode())

            def _screen(self) -> None:
                m = outer.screen_mode
                if m == "slow":
                    time.sleep(outer.delay or 3.0)
                if m == "503":
                    self._send(503, "application/json", b'{"error":"capture_unavailable"}')
                elif m == "404":
                    self._send(404, "application/json", b'{"error":"nope"}')
                elif m == "bad":
                    self._send(200, "image/jpeg", b"this is not an image")
                else:
                    self._send(200, "image/png", outer.png)

        self._httpd = _Server(("127.0.0.1", 0), H)
        self._httpd.daemon_threads = True
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    @property
    def port(self) -> int:
        return self._httpd.server_address[1]

    def close(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
