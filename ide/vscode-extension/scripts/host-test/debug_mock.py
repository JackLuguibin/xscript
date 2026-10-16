#!/usr/bin/env python3
"""scripts/mock_device.py plus the device's debug bridge (docs/DEBUGGING.md), backed by a real local debugpy.

    python debug_mock.py <repo>/scripts <port>      (prints the bound port, then serves until killed)

POST /projects/{name}/debug writes the uploaded files to a temp "remote root" and starts
`python -m debugpy --listen 127.0.0.1:<free> --wait-for-client __init__.py` there (needs debugpy in this
interpreter). /debug/connect, /debug/request, /debug/messages and DELETE /debug forward DAP over that TCP
socket with Content-Length framing, like the app's bridge. Script output goes to /logs. Local testing only.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
from urllib.parse import urlparse

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "../../../../scripts"))
import mock_device  # noqa: E402
from mock_device import STATE, _log  # noqa: E402

DBG = {"proc": None, "port": None, "sock": None, "messages": [], "next": 0, "lock": threading.Lock(), "error": None}


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _kill():
    proc = DBG["proc"]
    if proc and proc.poll() is None:
        proc.kill()
        proc.wait(5)
    _close()


def _close():
    sock = DBG["sock"]
    DBG["sock"] = None
    if sock:
        try:
            sock.close()
        except OSError:
            pass


def _pump(proc, name):
    for raw in proc.stdout:
        _log(raw.decode("utf-8", "replace").rstrip("\n"))
    proc.wait()
    if STATE["running"] == name and DBG["proc"] is proc:
        STATE["running"] = None


def _reader(sock):
    buf = b""
    try:
        while True:
            while b"\r\n\r\n" not in buf:
                chunk = sock.recv(65536)
                if not chunk:
                    return
                buf += chunk
            head, buf = buf.split(b"\r\n\r\n", 1)
            length = int([l.split(b":")[1] for l in head.split(b"\r\n") if l.lower().startswith(b"content-length")][0])
            while len(buf) < length:
                chunk = sock.recv(65536)
                if not chunk:
                    return
                buf += chunk
            body, buf = buf[:length], buf[length:]
            with DBG["lock"]:
                DBG["next"] += 1
                DBG["messages"].append({"id": DBG["next"], "message": json.loads(body.decode("utf-8"))})
    except OSError as e:
        DBG["error"] = str(e)
    finally:
        if DBG["sock"] is sock:
            DBG["sock"] = None


class Handler(mock_device.Handler):
    def do_GET(self):
        if urlparse(self.path).path == "/debug/messages":
            since = int(self._query().get("since", "0") or 0)
            with DBG["lock"]:
                msgs = [m for m in DBG["messages"] if m["id"] > since]
                nxt = DBG["next"]
            self._json(200, {"messages": msgs, "next": nxt, "connected": DBG["sock"] is not None, "error": DBG["error"]})
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        name, sub = self._project_route()
        if name is not None and sub == "/debug":
            if name not in STATE["projects"]:
                self._json(404, {"error": "工程不存在: " + name})
                return
            if STATE["running"]:
                self._json(409, {"error": "already running", "project": STATE["running"]})
                return
            _kill()
            root = os.path.realpath(tempfile.mkdtemp(prefix="xs-remote-")) + "/" + name
            for rel, raw in STATE["projects"][name].items():
                full = os.path.join(root, *rel.split("/"))
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "wb") as f:
                    f.write(raw if isinstance(raw, bytes) else raw.encode("utf-8"))
            port = _free_port()
            proc = subprocess.Popen([sys.executable, "-u", "-m", "debugpy", "--listen", "127.0.0.1:%d" % port, "--wait-for-client",
                                     os.path.join(root, "__init__.py")], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            with DBG["lock"]:
                DBG.update(proc=proc, port=port, messages=[], next=0, error=None)
            STATE["running"] = name
            threading.Thread(target=_pump, args=(proc, name), daemon=True).start()
            self._json(200, {"ok": True, "debug": {"port": 5678, "remote_root": root}})
            return
        if name is not None and sub == "/stop":
            _kill()
        if path == "/debug/connect":
            if DBG["sock"] is not None:
                self._json(409, {"error": "already connected"})
                return
            if not DBG["port"]:
                self._json(409, {"error": "no debug session"})
                return
            try:
                sock = socket.create_connection(("127.0.0.1", DBG["port"]), timeout=1)
            except OSError as e:
                self._json(503, {"error": "debugpy not listening: " + str(e)})
                return
            sock.settimeout(None)
            DBG["sock"] = sock
            threading.Thread(target=_reader, args=(sock,), daemon=True).start()
            self._json(200, {"ok": True, "connected": True})
            return
        if path == "/debug/request":
            sock = DBG["sock"]
            if sock is None:
                self._json(409, {"error": "not connected"})
                return
            body = json.dumps(self._body()).encode("utf-8")
            sock.sendall(b"Content-Length: %d\r\n\r\n" % len(body) + body)
            self._json(200, {"ok": True})
            return
        super().do_POST()

    def do_DELETE(self):
        if urlparse(self.path).path == "/debug":
            _close()
            self._json(200, {"ok": True})
            return
        super().do_DELETE()


def serve(host="127.0.0.1", port=0):
    from http.server import ThreadingHTTPServer
    httpd = ThreadingHTTPServer((host, port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


if __name__ == "__main__":
    server = serve("127.0.0.1", int(sys.argv[2]) if len(sys.argv) > 2 else 0)
    print(server.server_address[1], flush=True)
    try:
        threading.Event().wait()
    finally:
        _kill()
