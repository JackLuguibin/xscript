#!/usr/bin/env python3
"""In-process HTTP mock of protocol/openapi.yaml for local MCP / client tests."""
from __future__ import annotations

import base64
import io
import json
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, unquote, urlparse

PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
    b"\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00"
    b"\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)

STATE = {
    "projects": {},
    "running": None,
    "logs": [],
    "actions": [],
    "settings": {"run_mode": "auto", "float_on_run": True, "keep_screen_on": False, "cloud_url": ""},
}

TEXT_EXT = {"py", "txt", "md", "json", "yaml", "yml", "html", "htm", "js", "css", "ini", "cfg", "csv", "xml", "toml"}


def _safe_rel(rel):
    return bool(rel) and not rel.startswith("/") and ".." not in rel.split("/")


def _log(line):
    seq = len(STATE["logs"]) + 1
    STATE["logs"].append({"seq": seq, "ts": seq, "stream": "stdout", "line": line})


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _send(self, code, mime, raw):
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _json(self, code, payload):
        self._send(code, "application/json; charset=utf-8", json.dumps(payload).encode("utf-8"))

    def _raw_body(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        return self.rfile.read(length) if length > 0 else b""

    def _body(self):
        raw = self._raw_body()
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

    def do_GET(self):
        parsed = urlparse(self.path)
        q = self._query()
        if parsed.path == "/status":
            self._json(200, {
                "name": "mock-device",
                "model": "XScript Mock",
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
                "running": STATE["running"] is not None,
                "project": STATE["running"],
                "version": "0.2.0",
            })
            return
        if parsed.path == "/screen":
            self._send(200, "image/jpeg" if q.get("format") in ("jpg", "jpeg") else "image/png", PNG)
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
                }],
            })
            return
        if parsed.path == "/projects":
            self._json(200, {"projects": sorted(STATE["projects"])})
            return
        if parsed.path == "/ascript/projects":
            self._json(200, {"projects": []})
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
        name, sub = self._project_route()
        if name is not None:
            files = STATE["projects"].get(name)
            if files is None:
                self._json(404, {"error": "missing project"})
                return
            if sub == "/files":
                self._json(200, {"project": name, "files": [
                    {"path": p, "size": len(c)} for p, c in sorted(files.items())
                ]})
                return
            if sub == "/file":
                rel = q.get("path", "")
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
            if sub == "/zip":
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w") as zf:
                    for p, c in files.items():
                        zf.writestr(p, c)
                self._send(200, "application/zip", buf.getvalue())
                return
        self._json(404, {"error": "not found"})

    # ------------------------------------------------------------------ PUT

    def do_PUT(self):
        if urlparse(self.path).path == "/settings":
            body = self._body()
            if "run_mode" in body and body["run_mode"] not in ("auto", "accessibility", "root"):
                self._json(400, {"error": "bad run_mode"})
                return
            for k in ("run_mode", "float_on_run", "keep_screen_on"):
                if k in body:
                    STATE["settings"][k] = body[k]
            self._json(200, STATE["settings"])
            return
        name, sub = self._project_route()
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

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/eval":
            body = self._body()
            self._json(200, {"ok": True, "result": "mock:" + (body.get("code") or "")[:20], "error": ""})
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
            STATE["projects"].setdefault(name, {"__init__.py": b"print('hello')\n"})
            self._json(200, {"ok": True, "project": name})
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

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path == "/logs":
            STATE["logs"].clear()
            self._json(200, {"ok": True})
            return
        name, sub = self._project_route()
        if name is not None and sub == "":
            if STATE["running"] == name:
                STATE["running"] = None
            self._json(200, {"ok": STATE["projects"].pop(name, None) is not None})
            return
        if name is not None and sub == "/file":
            files = STATE["projects"].get(name, {})
            self._json(200, {"ok": files.pop(self._query().get("path", ""), None) is not None})
            return
        self._json(404, {"error": "not found"})


def serve(host="127.0.0.1", port=0):
    httpd = HTTPServer((host, port), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


if __name__ == "__main__":
    server = serve("127.0.0.1", 9096)
    print("mock device on http://127.0.0.1:%d (no auth; local testing only)" % server.server_address[1])
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        server.shutdown()
