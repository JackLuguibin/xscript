#!/usr/bin/env python3
"""In-process HTTP mock of protocol/openapi.yaml for local MCP / client tests."""
from __future__ import annotations

import base64
import io
import json
import os
import re
import struct
import threading
import time
import zipfile
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse


def runtime_version() -> str:
    """The version the real device reports: the on-device runtime's __version__ (kept equal to the App versionName)."""
    src = Path(__file__).resolve().parents[1] / "android" / "python-runtime" / "xscript" / "__init__.py"
    m = re.search(r'^__version__ = "([^"]+)"', src.read_text(encoding="utf-8"), re.M)
    if not m:
        raise RuntimeError("no __version__ in %s" % src)
    return m.group(1)


APP_VERSION = runtime_version()

def _make_png(width=24, height=48):
    """A small valid RGB gradient PNG (browsers can decode it; the old 1x1 stub could not be)."""
    import struct
    import zlib

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    rows = b"".join(b"\x00" + bytes(v for x in range(width) for v in (x * 10 % 256, y * 5 % 256, 128)) for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


PNG = _make_png()


def _mock_login_root(mode):
    """A nested login screen for the Web IDE 节点 dock: id-less button, hint-only input, desc-only image, quotes in text.
    Full mode (1) also lists a layout-only View that the simple tree prunes, like NodeDumper."""
    def n(path, cls, rect, children=(), **kw):
        node = {"path": path, "id": "", "text": "", "desc": "", "type": cls, "package": "com.demo.app",
                "rect": dict(zip("ltrb", rect)), "clickable": False, "editable": False, "enabled": True, "visible": True}
        node.update(kw)
        node["children"] = list(children)
        node["childCount"] = len(node["children"])
        return node
    form = [
        n("1/0/0", "android.widget.ImageView", (440, 300, 640, 500), desc="应用图标"),
        n("1/0/1", "android.widget.EditText", (80, 640, 1000, 760), id="com.demo.app:id/user", hint="请输入账号", clickable=True, editable=True),
        n("1/0/2", "android.widget.TextView", (80, 800, 1000, 860), text='他说"你好"，\'欢迎\''),
        n("1/0/3", "android.widget.Button", (80, 980, 1000, 1110), text="登录", clickable=True),
    ]
    if mode:
        form.append(n("1/0/4", "android.view.View", (0, 1200, 1080, 1210)))
    return n("1", "android.widget.FrameLayout", (0, 0, 1080, 2400), [n("1/0", "android.widget.LinearLayout", (0, 200, 1080, 1300), form)])
# 24x48 JPEG so a real WebEngine <img> can decode a mock /screen/stream frame (sips, quality 60).
JPEG = base64.b64decode(
    "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"
)


def _mjpeg_part(jpeg: bytes, w: int, h: int) -> bytes:
    head = ("--xscriptframe\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\nX-Screen-Size: %dx%d\r\n\r\n" % (len(jpeg), w, h)).encode("ascii")
    return head + jpeg + b"\r\n"

STATE = {
    "projects": {},
    "ascript": {"ascript_demo": {"__init__.py": b"from ascript.android import action\n"}},
    "running": None,
    "logs": [],
    "actions": [],
    "settings": {"run_mode": "auto", "float_on_run": True, "float_always": False, "keep_screen_on": False, "cloud_url": ""},
    "snapshots": {},   # id -> png bytes
    "datasets": {},    # name -> {"classes": [...], "items": {id: {"image": bytes, "label": dict|None}}}
    "schedules": {},   # id -> schedule dict
    "boot_project": "",
    "rerun": set(),
}


def _config(name):
    return {"project": name, "auto_run": STATE["boot_project"] == name, "stop_re_run": name in STATE["rerun"],
            "boot_project": STATE["boot_project"]}


def _schedule_from(body, existing=None):
    """Validate like Schedule.fromRequest (subset); raises ValueError with the device's messages."""
    s = dict(existing or {})
    s.update({k: v for k, v in body.items() if k != "id"})
    if s.get("project") not in STATE["projects"]:
        raise ValueError("missing project %s" % s.get("project"))
    kind = s.get("kind")
    if kind == "daily":
        t = str(s.get("time", ""))
        parts = t.split(":")
        if len(parts) != 2 or not all(p.isdigit() for p in parts) or int(parts[0]) > 23 or int(parts[1]) > 59:
            raise ValueError("time must be HH:mm")
        if any(not 1 <= int(d) <= 7 for d in s.get("weekdays") or []):
            raise ValueError("weekdays are 1 (Mon) .. 7 (Sun)")
    elif kind == "interval":
        if not 1 <= int(s.get("every") or 0) <= 10080:
            raise ValueError("every must be 1..10080 minutes")
    elif kind == "once":
        if not s.get("at"):
            raise ValueError("at is required for kind=once")
    else:
        raise ValueError("kind must be daily, interval or once")
    if s.get("if_running", "skip") not in ("skip", "restart"):
        raise ValueError("if_running must be skip or restart")
    s.setdefault("if_running", "skip")
    s.setdefault("enabled", True)
    s.setdefault("next", 0)
    return s

# 1x1 pixel, color #336699, for snapshot / vision tests.
SNAP_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"
    b"\x00\x00\x00\x0cIDATx\x9cc0f\x9e\x04\x00\x01\xbc\x00\xe2\x1b\xa0\x02k\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _vision(req):
    """Mimic /tools/vision for the 1x1 snapshot without numpy/cv2."""
    op = req.get("op")
    if op == "pixel":
        inside = int(req.get("x", 0)) == 0 and int(req.get("y", 0)) == 0
        return {"op": op, "ms": 1, "color": "#336699" if inside else None}
    if op == "find_colors":
        first = str(req.get("colors", "")).split("|")[0].split(",")
        hit = len(first) >= 3 and first[2].lower() == "#336699"
        return {"op": op, "ms": 1, "points": [[0, 0]] if hit else [], "truncated": False}
    if op in ("compare_colors", "find_image", "ocr"):
        key = {"compare_colors": "details", "find_image": "hits", "ocr": "lines"}[op]
        out = {"op": op, "ms": 1, key: []}
        if op == "compare_colors":
            out["match"] = False
        return out
    raise ValueError("unknown op %r" % op)

TEXT_EXT = {"py", "txt", "md", "json", "yaml", "yml", "html", "htm", "js", "css", "ini", "cfg", "csv", "xml", "toml"}

# The device serves the web tools from the APK assets; the mock reads the same files.
ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "android", "app", "src", "main", "assets", "tools")
WEBSITE_ALIASES = {"/website/src/screen.html": "color.html", "/website/src/label.html": "label.html", "/website/src/editor.html": "editor.html"}
MIME = {"html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
        "svg": "image/svg+xml", "png": "image/png"}


# Canned answers for read-only calls a snippet commonly asks about, matching this mock's /status (1080x2400).
_EVAL_CANNED = {
    "size": [1080, 2400],
    "screen_size": [1080, 2400],
    "current_app": {"packageName": "com.android.launcher3", "activity": ".Launcher"},
}


def _eval_format(value):
    """Like xscript/runtime/eval_runner.py: None -> "", str as is, everything else JSON."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)


def _eval_literal(node):
    """ast.literal_eval plus + - * / // % on small numbers (`_result = 1 + 1`); anything else raises ValueError."""
    import ast
    import operator
    ops = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
           ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod}
    if isinstance(node, ast.BinOp) and type(node.op) in ops:
        a, b = _eval_literal(node.left), _eval_literal(node.right)
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and abs(v) < 1e12 for v in (a, b)):
            raise ValueError("not a small number")
        return ops[type(node.op)](a, b)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return -_eval_literal(node.operand)
    return ast.literal_eval(node)


def mock_eval(code):
    """POST /eval for the mock. Never executes the snippet: it is parsed, and the last `_result = …` is answered when its
    value is a literal or a known read-only call (`_EVAL_CANNED`, by the called function's name); other calls say they are
    not simulated. A syntax error comes back as ok=false with the device's traceback-style text."""
    import ast
    try:
        tree = ast.parse(code, "<eval>", "exec")
    except SyntaxError as e:
        return {"ok": False, "result": "", "error": "SyntaxError: %s (line %s)" % (e.msg, e.lineno)}
    value = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "_result" for t in node.targets):
            value = node.value
    if value is None:
        return {"ok": True, "result": "", "error": ""}
    try:
        return {"ok": True, "result": _eval_format(_eval_literal(value)), "error": ""}
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError, ArithmeticError):
        pass
    if isinstance(value, ast.Call):
        fn = value.func
        name = fn.attr if isinstance(fn, ast.Attribute) else fn.id if isinstance(fn, ast.Name) else ""
        if name in _EVAL_CANNED:
            return {"ok": True, "result": _eval_format(_EVAL_CANNED[name]), "error": ""}
        return {"ok": True, "result": "<mock device: %s() is not simulated>" % (ast.unparse(fn) if name else "call"), "error": ""}
    return {"ok": True, "result": "<mock device: expression is not simulated>", "error": ""}

def _png_size(raw):
    """(width, height) from the IHDR chunk, or None when `raw` is not a PNG."""
    if len(raw) < 24 or raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
        return None
    w, h = struct.unpack(">II", raw[16:24])
    return (w, h) if w > 0 and h > 0 else None


def _snap_info(sid):
    w, h = _png_size(STATE["snapshots"][sid]) or (1, 1)
    return {"id": sid, "width": w, "height": h, "url": "/tools/snapshots/%s.png" % sid}


def _describe(name):
    ds = STATE["datasets"][name]
    counts = [0] * len(ds["classes"])
    items = []
    for i, it in sorted(ds["items"].items()):
        boxes = (it["label"] or {}).get("boxes", [])
        for b in boxes:
            if 0 <= b["cls"] < len(counts):
                counts[b["cls"]] += 1
        items.append({"id": i, "file": i + ".png", "labeled": it["label"] is not None, "boxes": len(boxes)})
    return {"name": name, "classes": ds["classes"], "counts": counts, "items": items}


def _safe_rel(rel):
    return (bool(rel) and not rel.startswith("/") and "\\" not in rel and "\0" not in rel
            and not any(p in ("", ".", "..") for p in rel.split("/")))


def _valid_project(name):
    """Same rule as ProjectStore.isValidName: identifier, Unicode letters allowed."""
    return bool(name) and (name[0].isalpha() or name[0] == "_") and all(c.isalnum() or c == "_" for c in name)


def _dirs(name):
    """Folders of a project: parents of every file plus explicitly created (possibly empty) ones."""
    out = set(STATE.setdefault("dirs", {}).get(name, set()))
    for rel in STATE["projects"].get(name, {}):
        parts = rel.split("/")[:-1]
        out.update("/".join(parts[:i + 1]) for i in range(len(parts)))
    return sorted(out)


def _log(line):
    seq = len(STATE["logs"]) + 1
    STATE["logs"].append({"seq": seq, "ts": seq, "stream": "stdout", "line": line})


_TEMPLATES_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "android", "app", "src", "main",
                               "assets", "templates", "projects.json")


def _templates():
    """The device's new-project templates (same asset the app ships)."""
    with open(_TEMPLATES_JSON, encoding="utf-8") as f:
        return json.load(f)["templates"]


class UnsupportedMediaType(Exception):
    """A JSON body sent without Content-Type: application/json (the device answers 415)."""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def end_headers(self):
        # This is an HTTP/1.0 server: it closes the socket after every reply. Say so, or an HTTP/1.1 client (the JDK
        # HttpClient in the PyCharm plugin) may put the socket back in its pool and send the next request into a
        # connection that is already closing ("header parser received no bytes"), which only GETs survive by retrying.
        self.send_header("Connection", "close")
        super().end_headers()

    def _dispatch(self, handler):
        try:
            handler()
        except UnsupportedMediaType:
            self._json(415, {"error": "expected Content-Type: application/json"})

    def do_GET(self):
        self._dispatch(self._do_GET)

    def do_PUT(self):
        self._dispatch(self._do_PUT)

    def do_POST(self):
        self._dispatch(self._do_POST)

    def do_DELETE(self):
        self._dispatch(self._do_DELETE)

    def _send(self, code, mime, raw):
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _asset(self, rel):
        if not _safe_rel(rel):
            self._json(400, {"error": "invalid path"})
            return
        path = os.path.join(ASSETS, rel)
        if not os.path.isfile(path):
            self._json(404, {"error": "missing asset %s" % rel})
            return
        with open(path, "rb") as f:
            self._send(200, MIME.get(rel.rsplit(".", 1)[-1], "application/octet-stream"), f.read())

    # ---- pairing (same rules as the device's HttpGuard; on only when serve(..., token=...) is given)

    PUBLIC_STATUS = ("name", "model", "brand", "version", "device_id", "app_id", "port")

    def _token(self):
        return getattr(self.server, "pair_token", None)

    @staticmethod
    def _norm(code):
        return "".join(c for c in (code or "") if c.isalnum()).upper()

    def _presented(self):
        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        if self.headers.get("X-XScript-Token"):
            return self.headers["X-XScript-Token"].strip()
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "xs_pair":
                return v.strip()
        return ""

    def _authed(self):
        token = self._token()
        return token is None or (self._norm(self._presented()) != "" and self._norm(self._presented()) == self._norm(token))

    def _status_view(self, full):
        required = self._token() is not None
        if self._authed():
            return dict(full, pairing=required, paired=True)
        return dict({k: full[k] for k in self.PUBLIC_STATUS if k in full}, pairing=required, paired=False)

    def _gate(self, method):
        """False (and the reply already sent) when the request may not go on."""
        path = urlparse(self.path).path.rstrip("/") or "/"
        origin = self.headers.get("Origin")
        host = self.headers.get("Host") or ""
        if origin and origin.split("://", 1)[-1].rstrip("/").lower() != host.lower():
            self._json(403, {"error": "cross-origin request refused"})
            return False
        if path == "/pair" and method == "POST":
            if "json" not in (self.headers.get("Content-Type") or ""):
                self._json(415, {"error": "expected application/json"})
                return False
            given = self._body().get("code", "")
            token = self._token()
            if token is None:
                self._json(200, {"ok": True, "pairing": False})
            elif self._norm(given) and self._norm(given) == self._norm(token):
                self.send_response(200)
                raw = json.dumps({"ok": True, "pairing": True}).encode()
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Set-Cookie", "xs_pair=%s; Path=/; HttpOnly; SameSite=Strict" % self._norm(token))
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            else:
                self._json(401, {"error": "invalid code"})
            return False
        public = (method == "GET" and (path in ("/status", "/pair") or (path.startswith("/tools/ui/") and path.endswith((".js", ".css")))))
        if public or self._authed():
            return True
        self.send_response(401)
        raw = json.dumps({"error": "pairing required", "pairing": True}).encode()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("WWW-Authenticate", 'Bearer realm="xscript"')
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
        return False

    def _json(self, code, payload):
        self._send(code, "application/json; charset=utf-8", json.dumps(payload).encode("utf-8"))

    def _screen_stream(self):
        """One MJPEG viewer. At most two, matching the device; a third gets 429 and does not take a slot."""
        srv = self.server
        if not hasattr(srv, "stream_lock"):
            srv.stream_lock = threading.Lock()
            srv.stream_viewers = 0
        with srv.stream_lock:
            if srv.stream_viewers >= 2:
                self._json(429, {"error": "too many screen streams (max 2)"})
                return
            srv.stream_viewers += 1
        try:
            self.close_connection = True
            self.wfile.write(b"HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=xscriptframe\r\n"
                             b"Cache-Control: no-cache, no-store\r\nTransfer-Encoding: chunked\r\n\r\n")
            self.wfile.flush()
            while True:
                part = _mjpeg_part(JPEG, 1080, 2400)
                self.wfile.write(b"%x\r\n" % len(part) + part + b"\r\n")
                self.wfile.flush()
                time.sleep(0.05)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            return
        finally:
            with srv.stream_lock:
                srv.stream_viewers = max(0, srv.stream_viewers - 1)

    def _raw_body(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        return self.rfile.read(length) if length > 0 else b""

    def _body(self):
        raw = self._raw_body()
        if raw.strip() and "json" not in (self.headers.get("Content-Type") or "").lower():
            raise UnsupportedMediaType()
        return json.loads(raw.decode("utf-8")) if raw.strip() else {}

    def _project_route(self):
        """('name', '/sub') for /projects/<name>[/sub], else (None, None)."""
        parts = urlparse(self.path).path.strip("/").split("/")
        if len(parts) >= 2 and parts[0] == "projects":
            return unquote(parts[1]), ("/" + "/".join(parts[2:])) if len(parts) > 2 else ""
        return None, None

    def _query(self):
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    # ------------------------------------------------------------------ GET

    def _do_GET(self):
        if not self._gate("GET"):
            return
        parsed = urlparse(self.path)
        q = self._query()
        if parsed.path == "/status":
            self._json(200, self._status_view({
                "name": "mock-device",
                "model": "XScript Mock",
                "device_id": "mock0000device01",
                "app_id": "com.xscript.app.mock",
                "sdk": 34,
                "release": "14",
                "width": 1080,
                "height": 2400,
                "ip": "127.0.0.1",
                "port": self.server.server_address[1],
                "accessibility": True,
                "root": False,
                "run_mode": STATE["settings"]["run_mode"],
                "channel": "accessibility",
                "capture": True,
                "capture_source": "mock",
                "capture_via": "projection",
                "capture_lost": False,
                "running": STATE["running"] is not None,
                "project": STATE["running"],
                "version": APP_VERSION,
                "overlay": {
                    "enabled": STATE["settings"]["float_on_run"],
                    "always": STATE["settings"]["float_always"],
                    "mode": "off" if not STATE["settings"]["float_on_run"] else ("always" if STATE["settings"]["float_always"] else "run"),
                    "permitted": True,
                    "visible": False,
                    "state": None,
                    "expanded": False,
                    "app_foreground": True,
                    "side": "right",
                    "reason": "foreground",
                    "error": False,
                    "menus": 0,
                    "insets": {"left": 0, "top": 0, "right": 0, "bottom": 0},
                },
            }))
            return
        if parsed.path == "/screen":
            self._send(200, "image/jpeg" if q.get("format") in ("jpg", "jpeg") else "image/png", PNG)
            return
        if parsed.path == "/screen/stream":
            self._screen_stream()
            return
        if parsed.path == "/ui-tree":
            self._json(200, {
                "mode": int(q.get("mode", 0)),
                "width": 1080,
                "height": 2400,
                "roots": [{
                    "path": "0/0",
                    "id": "com.android.settings:id/search",
                    "text": "Search",
                    "desc": "Search settings",
                    "type": "android.widget.TextView",
                    "rect": {"l": 40, "t": 80, "r": 280, "b": 160},
                    "clickable": True,
                    "editable": False,
                    "enabled": True,
                    "children": [],
                }, _mock_login_root(int(q.get("mode", 0)))],
            })
            return
        if parsed.path == "/projects":
            self._json(200, {"projects": sorted(STATE["projects"])})
            return
        if parsed.path == "/project-templates":
            self._json(200, {"default": "empty", "templates": [
                {"id": t["id"], "label": t["label"], "detail": t.get("detail", "")} for t in _templates()]})
            return
        if parsed.path == "/ascript/projects":
            self._json(200, {"projects": sorted(STATE["ascript"])})
            return
        if parsed.path == "/settings":
            self._json(200, STATE["settings"])
            return
        if parsed.path == "/logs":
            since = int(q.get("since", 0))
            entries = [e for e in STATE["logs"] if e["seq"] > since]
            nxt = STATE["logs"][-1]["seq"] if STATE["logs"] else since
            self._json(200, {"entries": entries, "next": nxt})
            return
        if parsed.path == "/":
            self._send(200, "text/plain", b"XScript mock device")
            return
        if parsed.path == "/schedules":
            project = q.get("project")
            items = [s for _, s in sorted(STATE["schedules"].items()) if not project or s["project"] == project]
            self._json(200, {"schedules": items, "exact_alarms": True})
            return
        if parsed.path.startswith("/schedules/"):
            s = STATE["schedules"].get(unquote(parsed.path[len("/schedules/"):]))
            self._json(200 if s else 404, s or {"error": "missing schedule"})
            return
        asset = WEBSITE_ALIASES.get(parsed.path)
        if asset or parsed.path in ("/tools", "/tools/") or parsed.path.startswith("/tools/ui/"):
            self._asset(asset or ("index.html" if parsed.path in ("/tools", "/tools/") else parsed.path[len("/tools/ui/"):]))
            return
        if parsed.path == "/tools/snapshots":
            self._json(200, {"snapshots": [_snap_info(s) for s in reversed(list(STATE["snapshots"]))]})
            return
        if parsed.path.startswith("/tools/snapshots/") and parsed.path.endswith(".png"):
            snap = STATE["snapshots"].get(parsed.path[len("/tools/snapshots/"):-4])
            if snap is None:
                self._json(404, {"error": "missing snapshot"})
            else:
                self._send(200, "image/png", snap)
            return
        if parsed.path == "/tools/datasets":
            self._json(200, {"datasets": [
                {"name": n, "classes": d["classes"], "images": len(d["items"]),
                 "labeled": sum(1 for it in d["items"].values() if it["label"] is not None)}
                for n, d in sorted(STATE["datasets"].items())
            ]})
            return
        if parsed.path.startswith("/tools/datasets/"):
            parts = parsed.path.split("/")[3:]
            ds = STATE["datasets"].get(unquote(parts[0]))
            if ds is None:
                self._json(404, {"error": "missing dataset"})
                return
            if len(parts) == 1:
                self._json(200, _describe(unquote(parts[0])))
                return
            if len(parts) == 3 and parts[1] == "images" and parts[2] in ds["items"]:
                self._send(200, "image/png", ds["items"][parts[2]]["image"])
                return
            if len(parts) == 3 and parts[1] == "labels" and parts[2] in ds["items"]:
                self._json(200, ds["items"][parts[2]]["label"] or {"width": 0, "height": 0, "boxes": []})
                return
            if parts[1] == "export":
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w") as zf:
                    for i, it in ds["items"].items():
                        if it["label"] is not None:
                            zf.writestr("images/train/%s.png" % i, it["image"])
                            zf.writestr("labels/train/%s.txt" % i, "")
                    zf.writestr("data.yaml", "nc: %d\n" % len(ds["classes"]))
                self._send(200, "application/zip", buf.getvalue())
                return
        name, sub = self._project_route()
        if name is not None:
            files = STATE["projects"].get(name)
            if files is None:
                self._json(404, {"error": "missing project"})
                return
            if sub == "/files":
                self._json(200, {"project": name, "files": [
                    {"path": p, "size": len(c)} for p, c in sorted(files.items())
                ], "dirs": _dirs(name)})
                return
            if sub == "/file":
                rel = q.get("path", "")
                if not _safe_rel(rel):  # same as the device (ProjectStore.resolve): 400, not 404
                    self._json(400, {"error": "invalid path"})
                    return
                if rel not in files:
                    self._json(404, {"error": "missing file"})
                    return
                data = files[rel]
                if q.get("raw") == "1":
                    self._send(200, "application/octet-stream", data)
                elif rel.rsplit(".", 1)[-1].lower() in TEXT_EXT:
                    self._json(200, {"path": rel, "encoding": "utf-8", "content": data.decode("utf-8")})
                else:
                    self._json(200, {"path": rel, "encoding": "base64", "content": base64.b64encode(data).decode()})
                return
            if sub == "/config":
                self._json(200, _config(name))
                return
            if sub == "/runs":
                # Two canned runs so clients have something to list: one clean, one crash.
                now = int(time.time() * 1000)
                runs = [
                    {"project": name, "start": now - 120_000, "duration_ms": 4_200, "exit": "1", "user_stop": False,
                     "log_from": 10, "log_to": 30, "outcome": "出错退出（退出码 1）", "failed": True,
                     "stats": {"captures": 12, "capture_avg_ms": 41, "peak_mb": 180}},
                    {"project": name, "start": now - 600_000, "duration_ms": 61_000, "exit": "0", "user_stop": False,
                     "log_from": 0, "log_to": 10, "outcome": "正常结束", "failed": False},
                ]
                if self._query().get("failed") in ("1", "true"):
                    runs = [r for r in runs if r["failed"]]
                self._json(200, {"runs": runs})
                return
            if sub == "/zip":
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w") as zf:
                    for p, c in files.items():
                        zf.writestr(p, c)
                self._send(200, "application/zip", buf.getvalue())
                return
        self._json(404, {"error": "not found"})

    # ------------------------------------------------------------------ PUT

    def _do_PUT(self):
        if not self._gate("PUT"):
            return
        path = urlparse(self.path).path
        if path.startswith("/tools/datasets/"):
            parts = path.split("/")[3:]
            ds = STATE["datasets"].get(unquote(parts[0]))
            if ds is None:
                self._json(404, {"error": "missing dataset"})
                return
            body = self._body()
            if parts[1:] == ["classes"]:
                ds["classes"] = list(body.get("classes") or [])
                self._json(200, _describe(unquote(parts[0])))
                return
            if len(parts) == 3 and parts[1] == "labels" and parts[2] in ds["items"]:
                ds["items"][parts[2]]["label"] = body
                self._json(200, body)
                return
            self._json(404, {"error": "not found"})
            return
        if path == "/settings":
            body = self._body()
            if "run_mode" in body and body["run_mode"] not in ("auto", "accessibility", "root"):
                self._json(400, {"error": "bad run_mode"})
                return
            for k in ("run_mode", "float_on_run", "float_always", "keep_screen_on"):
                if k in body:
                    STATE["settings"][k] = body[k]
            self._json(200, STATE["settings"])
            return
        if path.startswith("/schedules/"):
            sid = unquote(path[len("/schedules/"):])
            if sid not in STATE["schedules"]:
                self._json(404, {"error": "missing schedule"})
                return
            try:
                STATE["schedules"][sid] = _schedule_from(self._body(), STATE["schedules"][sid])
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return
            self._json(200, STATE["schedules"][sid])
            return
        name, sub = self._project_route()
        if name is not None and sub == "/config":
            if name not in STATE["projects"]:
                self._json(404, {"error": "missing project"})
                return
            body = self._body()
            if "auto_run" in body:
                if body["auto_run"]:
                    STATE["boot_project"] = name
                elif STATE["boot_project"] == name:
                    STATE["boot_project"] = ""
            if "stop_re_run" in body:
                (STATE["rerun"].add if body["stop_re_run"] else STATE["rerun"].discard)(name)
            self._json(200, _config(name))
            return
        if name is not None and sub == "/files":
            body = self._body()
            items = body.get("files") if isinstance(body.get("files"), list) else [body]
            decoded = []
            for f in items:
                rel = f.get("path") or ""
                if not _safe_rel(rel):
                    self._json(400, {"error": "invalid path"})
                    return
                content = f.get("content") or ""
                raw = base64.b64decode(content) if f.get("encoding") == "base64" else content.encode("utf-8")
                decoded.append((rel, raw))
            if body.get("create"):
                if name not in STATE["projects"]:
                    self._json(404, {"error": "工程不存在: " + name})
                    return
                rel = decoded[0][0]
                if rel in STATE["projects"][name] or rel in _dirs(name):
                    self._json(409, {"error": "文件已存在: " + rel})
                    return
            proj = STATE["projects"].setdefault(name, {})
            for rel, raw in decoded:
                proj[rel] = raw
            self._json(200, {"ok": True, "count": len(decoded)})
            return
        if name is not None and sub == "/zip":
            replace = self._query().get("replace", "true") != "false"
            with zipfile.ZipFile(io.BytesIO(self._raw_body())) as zf:
                entries = [(i.filename, zf.read(i)) for i in zf.infolist() if not i.is_dir()]
            # Strip a single shared top-level folder (AScript exports wrap the project in one).
            tops = {p.split("/", 1)[0] for p, _ in entries}
            if len(tops) == 1 and all("/" in p for p, _ in entries):
                entries = [(p.split("/", 1)[1], c) for p, c in entries]
            entries = [(p, c) for p, c in entries if _safe_rel(p)]
            proj = {} if replace else dict(STATE["projects"].get(name, {}))
            proj.update(entries)
            STATE["projects"][name] = proj
            self._json(200, {"ok": True, "project": name, "files": len(proj)})
            return
        self._json(404, {"error": "not found"})

    # ------------------------------------------------------------------ POST

    def _do_POST(self):
        if not self._gate("POST"):
            return
        path = urlparse(self.path).path
        if path == "/capture/request":
            # The real app brings up the system screen-recording dialog; here only count the asks.
            STATE["capture_requests"] = STATE.get("capture_requests", 0) + 1
            self._json(200, {"ok": True, "opened": True, "notified": True})
            return
        if path == "/tools/snapshots":
            # Empty body: "capture" the 1x1 screen; a PNG body is an upload.
            raw = self._raw_body()
            if raw and _png_size(raw) is None:
                self._json(400, {"error": "snapshot upload must be a PNG image"})
                return
            STATE["seq"] = STATE.get("seq", 0) + 1
            sid = "%d_%d" % (1790000000000 + STATE["seq"], STATE["seq"] % 1000)
            STATE["snapshots"][sid] = raw or SNAP_PNG
            self._json(200, _snap_info(sid))
            return
        if path == "/ascript/import":
            name = str(self._body().get("name") or "")
            if name not in STATE["ascript"]:
                self._json(404, {"ok": False, "error": "AScript 工程不存在: " + name})
                return
            if name in STATE["projects"]:
                self._json(409, {"ok": False, "error": "工程已存在: " + name})
                return
            STATE["projects"][name] = dict(STATE["ascript"][name])
            self._json(200, {"ok": True, "name": name})
            return
        if path == "/tools/vision":
            body = self._body()
            if body.get("snapshot") not in STATE["snapshots"]:
                self._json(404, {"ok": False, "error": "missing snapshot"})
                return
            try:
                out = _vision(body)
            except ValueError as e:
                self._json(400, {"ok": False, "error": "ValueError: %s" % e})
                return
            out["ok"] = True
            self._json(200, out)
            return
        if path.startswith("/tools/snapshots/") and path.endswith("/crop"):
            sid = path[len("/tools/snapshots/"):-len("/crop")]
            body = self._body()
            if sid not in STATE["snapshots"] or body.get("project") not in STATE["projects"]:
                self._json(404, {"error": "missing snapshot or project"})
                return
            STATE["projects"][body["project"]][body["path"]] = STATE["snapshots"][sid]
            self._json(200, {"ok": True, "project": body["project"], "path": body["path"], "rect": body["rect"]})
            return
        if path.startswith("/tools/datasets/"):
            parts = path.split("/")[3:]
            name = unquote(parts[0])
            if len(parts) == 1:
                STATE["datasets"].setdefault(name, {"classes": [], "items": {}})
                self._json(200, {"name": name, "classes": [], "items": []})
                return
            ds = STATE["datasets"].get(name)
            if ds is not None and parts[1:] == ["images"]:
                raw = self._raw_body()
                if raw[:4] == b"\x89PNG" or raw[:3] == b"\xff\xd8\xff":
                    image = raw
                else:
                    snap_id = (json.loads(raw.decode("utf-8")) if raw.strip() else {}).get("snapshot")
                    image = STATE["snapshots"].get(snap_id) or SNAP_PNG
                iid = "%06d" % (max([int(i) for i in ds["items"]] or [0]) + 1)
                ds["items"][iid] = {"image": image, "label": None}
                self._json(200, {"ok": True, "id": iid})
                return
            if ds is not None and parts[1:] == ["rename"]:
                to = (self._body().get("to") or "").strip()
                if not to or to in STATE["datasets"]:
                    self._json(400, {"error": "bad or existing name"})
                    return
                STATE["datasets"][to] = STATE["datasets"].pop(name)
                self._json(200, _describe(to))
                return
        if path == "/schedules":
            try:
                s = _schedule_from(self._body())
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return
            STATE["seq"] = STATE.get("seq", 0) + 1
            s["id"] = "s%04d" % STATE["seq"]
            STATE["schedules"][s["id"]] = s
            self._json(200, s)
            return
        if path.startswith("/schedules/") and path.endswith("/run"):
            s = STATE["schedules"].get(unquote(path[len("/schedules/"):-len("/run")]))
            if s is None:
                self._json(404, {"error": "missing schedule"})
                return
            if STATE["running"]:
                result = "skipped" if s["if_running"] == "skip" else "queued"
            else:
                STATE["running"] = s["project"]
                result = "started"
            self._json(200, {"result": result})
            return
        if path == "/eval":
            body = self._body()
            self._json(200, mock_eval(body.get("code") or ""))
            return
        if path == "/action":
            body = self._body()
            if body.get("type") not in ("click", "swipe", "input", "key", "node"):
                self._json(400, {"error": "unknown action type"})
                return
            STATE["actions"].append(body)
            self._json(200, {"ok": True})
            return
        name, sub = self._project_route()
        if name is not None and sub == "":
            if not _valid_project(name):
                self._json(400, {"error": "工程名须以字母或下划线开头，仅包含字母、数字、下划线: " + name})
                return
            if name in STATE["projects"]:
                self._json(409, {"error": "工程已存在: " + name})
                return
            template = str(self._body().get("template") or "")
            if template:
                found = next((t for t in _templates() if t["id"] == template), None)
                if found is None:
                    self._json(400, {"error": "未知模板: " + template})
                    return
                STATE["projects"][name] = {
                    rel: text.replace("{{name}}", name).encode("utf-8") for rel, text in found["files"].items()}
                self._json(200, {"ok": True, "project": name, "template": template})
                return
            STATE["projects"][name] = {"__init__.py": b"print('hello')\n"}
            self._json(200, {"ok": True, "project": name})
            return
        if name is not None and sub == "/dir":
            rel = (self._body().get("path") or "").strip().strip("/")
            if name not in STATE["projects"]:
                self._json(404, {"error": "工程不存在: " + name})
                return
            if not _safe_rel(rel):
                self._json(400, {"error": "invalid path"})
                return
            if rel in STATE["projects"][name] or rel in _dirs(name):
                self._json(409, {"error": "路径已存在: " + rel})
                return
            STATE.setdefault("dirs", {}).setdefault(name, set()).add(rel)
            self._json(200, {"ok": True, "path": rel})
            return
        if name is not None and sub == "/move":
            # Same contract as the device's ProjectStore.move.
            body = self._body()
            src = (body.get("from") or "").strip().strip("/")
            dst = (body.get("to") or "").strip().strip("/")
            files = STATE["projects"].get(name)
            if files is None:
                self._json(404, {"error": "工程不存在: " + name})
                return
            if not _safe_rel(src) or not _safe_rel(dst):
                self._json(400, {"error": "invalid path"})
                return
            if src in ("__init__.py", "__init__.pyc"):
                self._json(400, {"error": "不能移动工程入口 " + src})
                return
            if src == dst or dst.startswith(src + "/"):
                self._json(400, {"error": "不能移动到原位置或它自己里面: " + dst})
                return
            dirs = _dirs(name)
            if src not in files and src not in dirs:
                self._json(404, {"error": "文件不存在: " + src})
                return
            if dst in files or dst in dirs:
                self._json(409, {"error": "目标已存在: " + dst})
                return
            parent = dst.rsplit("/", 1)[0] if "/" in dst else ""
            if parent and any(parent == f or parent.startswith(f + "/") for f in files):
                self._json(400, {"error": "目标上级不是文件夹: " + parent})
                return
            moved = lambda p: dst + p[len(src):] if p == src or p.startswith(src + "/") else p
            STATE["projects"][name] = {moved(p): v for p, v in files.items()}
            explicit = STATE.setdefault("dirs", {}).setdefault(name, set())
            STATE["dirs"][name] = {moved(d) for d in explicit} | ({dst} if src in dirs else set())
            self._json(200, {"ok": True, "from": src, "to": dst})
            return
        if name is not None and sub == "/run":
            if name not in STATE["projects"] or "__init__.py" not in STATE["projects"][name]:
                self._json(404, {"error": "missing project"})
                return
            if STATE["running"]:
                self._json(409, {"error": "already running", "project": STATE["running"]})
                return
            STATE["running"] = name
            _log("settings_search: clicking 'Search' path=0/0\n")
            self._json(200, {"ok": True, "running": True, "project": name})
            return
        if name is not None and sub == "/stop":
            STATE["running"] = None
            self._json(200, {"ok": True, "running": False})
            return
        self._json(404, {"error": "not found"})

    # ------------------------------------------------------------------ DELETE

    def _do_DELETE(self):
        if not self._gate("DELETE"):
            return
        path = urlparse(self.path).path
        if path == "/logs":
            STATE["logs"].clear()
            self._json(200, {"ok": True})
            return
        if path == "/tools/snapshots":
            n = len(STATE["snapshots"])
            STATE["snapshots"].clear()
            self._json(200, {"ok": True, "deleted": n})
            return
        if path.startswith("/tools/snapshots/"):
            sid = path[len("/tools/snapshots/"):].replace(".png", "")
            self._json(200, {"ok": STATE["snapshots"].pop(sid, None) is not None})
            return
        if path.startswith("/tools/datasets/"):
            parts = path.split("/")[3:]
            name = unquote(parts[0])
            ds = STATE["datasets"].get(name)
            if ds is None:
                self._json(404, {"error": "missing dataset"})
                return
            if len(parts) == 1:
                del STATE["datasets"][name]
                self._json(200, {"ok": True})
                return
            if len(parts) == 3 and parts[1] == "images":
                self._json(200, {"ok": ds["items"].pop(parts[2], None) is not None})
                return
            if len(parts) == 3 and parts[1] == "labels" and parts[2] in ds["items"]:
                had = ds["items"][parts[2]]["label"] is not None
                ds["items"][parts[2]]["label"] = None
                self._json(200, {"ok": had})
                return
            if len(parts) == 3 and parts[1] == "classes" and parts[2].isdigit():
                idx = int(parts[2])
                if idx >= len(ds["classes"]):
                    self._json(400, {"error": "class index out of range"})
                    return
                ds["classes"].pop(idx)
                for it in ds["items"].values():
                    label = it["label"]
                    if label:
                        label["boxes"] = [dict(b, cls=b["cls"] - (b["cls"] > idx)) for b in label.get("boxes", []) if b["cls"] != idx]
                self._json(200, _describe(name))
                return
            self._json(404, {"error": "not found"})
            return
        if path.startswith("/schedules/"):
            self._json(200, {"ok": STATE["schedules"].pop(unquote(path[len("/schedules/"):]), None) is not None})
            return
        name, sub = self._project_route()
        if name is not None and sub == "":
            if STATE["running"] == name:
                STATE["running"] = None
            for sid in [i for i, s in STATE["schedules"].items() if s["project"] == name]:
                del STATE["schedules"][sid]
            if STATE["boot_project"] == name:
                STATE["boot_project"] = ""
            STATE["rerun"].discard(name)
            self._json(200, {"ok": STATE["projects"].pop(name, None) is not None})
            return
        if name is not None and sub == "/file":
            files = STATE["projects"].get(name)
            rel = self._query().get("path", "")
            if files is None:
                self._json(404, {"error": "工程不存在: " + name})
            elif not _safe_rel(rel):
                self._json(400, {"error": "invalid path"})
            elif rel in ("__init__.py", "__init__.pyc"):
                self._json(400, {"error": "不能删除工程入口 " + rel})
            elif rel in files:
                del files[rel]
                self._json(200, {"ok": True})
            elif self._query().get("recursive") == "1" and rel in _dirs(name):
                gone = [p for p in files if p.startswith(rel + "/")]
                for p in gone:
                    del files[p]
                # Folders that only exist through uploaded files have no explicit entry.
                STATE["dirs"][name] = {d for d in STATE["dirs"].get(name, set()) if d != rel and not d.startswith(rel + "/")}
                self._json(200, {"ok": True, "deleted": len(gone)})
            elif rel in _dirs(name):
                if any(p.startswith(rel + "/") for p in files) or any(d.startswith(rel + "/") for d in _dirs(name)):
                    self._json(409, {"error": "文件夹非空: " + rel})
                else:
                    STATE["dirs"][name].discard(rel)
                    self._json(200, {"ok": True})
            else:
                self._json(404, {"error": "文件不存在: " + rel})
            return
        self._json(404, {"error": "not found"})


def serve(host="127.0.0.1", port=0, token=None):
    """`token` turns pairing on (like the phone's default); None is the AScript-compatible open mode."""
    # Threaded so a held /screen/stream does not block /action and /status on the same device.
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    httpd.stream_lock = threading.Lock()
    httpd.stream_viewers = 0
    httpd.pair_token = token
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


if __name__ == "__main__":
    server = serve("127.0.0.1", 9860, token=os.environ.get("XSCRIPT_MOCK_TOKEN") or None)
    print("mock device on http://127.0.0.1:%d (local testing only)" % server.server_address[1])
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        server.shutdown()
