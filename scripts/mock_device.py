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
    "snapshots": {},   # id -> png bytes
    "datasets": {},    # name -> {"classes": [...], "items": {id: {"image": bytes, "label": dict|None}}}
}

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
                self._json(200, {"name": unquote(parts[0]), "classes": ds["classes"], "items": [
                    {"id": i, "file": i + ".png", "boxes": len((it["label"] or {}).get("boxes", []))}
                    for i, it in sorted(ds["items"].items())
                ]})
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
                self._json(200, {"name": unquote(parts[0]), "classes": ds["classes"], "items": []})
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
        if path == "/tools/snapshots":
            sid = "%d_%d" % (1790000000000 + len(STATE["snapshots"]), len(STATE["snapshots"]) % 1000)
            STATE["snapshots"][sid] = SNAP_PNG
            self._json(200, {"id": sid, "width": 1, "height": 1, "url": "/tools/snapshots/%s.png" % sid})
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
                snap = STATE["snapshots"].get(self._body().get("snapshot"))
                iid = "%06d" % (len(ds["items"]) + 1)
                ds["items"][iid] = {"image": snap or SNAP_PNG, "label": None}
                self._json(200, {"ok": True, "id": iid})
                return
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
    print("mock device on http://127.0.0.1:%d (local testing only)" % server.server_address[1])
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        server.shutdown()
