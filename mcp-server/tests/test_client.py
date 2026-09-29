import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from xscript_mcp.client import DeviceClient, DeviceTarget


class _Handler(BaseHTTPRequestHandler):
    store = {"files": {}, "running": False, "seq": 0}

    def _json(self, code, payload):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/status":
            self._json(
                200,
                {
                    "name": "mock",
                    "sdk": 34,
                    "width": 1080,
                    "height": 2400,
                    "port": 9096,
                    "accessibility": True,
                    "capture": True,
                    "running": self.store["running"],
                    "project": "settings_search" if self.store["running"] else None,
                },
            )
            return
        if path == "/ui-tree":
            self._json(
                200,
                {
                    "mode": 0,
                    "width": 1080,
                    "height": 2400,
                    "roots": [
                        {
                            "path": "0/0",
                            "id": "",
                            "text": "Search",
                            "desc": "",
                            "type": "android.widget.TextView",
                            "rect": {"l": 40, "t": 80, "r": 200, "b": 140},
                            "clickable": True,
                            "children": [],
                        }
                    ],
                },
            )
            return
        if path == "/logs":
            self._json(
                200,
                {
                    "entries": [
                        {"seq": 1, "ts": 1, "stream": "stdout", "line": "settings_search: clicking\n"}
                    ],
                    "next": 2,
                },
            )
            return
        if path.startswith("/projects/") and path.endswith("/file"):
            from urllib.parse import parse_qs, urlsplit

            q = parse_qs(urlsplit(self.path).query)
            rel = (q.get("path") or [""])[0]
            if rel in self.store["files"]:
                self._json(200, {"path": rel, "content": self.store["files"][rel]})
            else:
                self._json(404, {"error": "not found"})
            return
        if path == "/screen":
            png = (
                b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
                b"\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00"
                b"\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N"
                b"\x00\x00\x00\x00IEND\xaeB`\x82"
            )
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(png)))
            self.end_headers()
            self.wfile.write(png)
            return
        self._json(404, {"error": "nope"})

    def do_PUT(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        self.store["files"][body.get("path")] = body.get("content")
        self._json(200, {"ok": True})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path.endswith("/run"):
            self.store["running"] = True
            self._json(200, {"ok": True, "running": True})
            return
        if path.endswith("/stop"):
            self.store["running"] = False
            self._json(200, {"ok": True, "running": False})
            return
        if path == "/eval":
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            self._json(200, {"ok": True, "result": body.get("code", "")[:20]})
            return
        self._json(404, {"error": "nope"})

    def log_message(self, fmt, *args):
        return


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = HTTPServer(("127.0.0.1", 0), _Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.httpd.server_address[:2]
        cls.client = DeviceClient(DeviceTarget(host=host, port=port))

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def test_status_and_tree(self):
        status = self.client.status()
        self.assertTrue(status["accessibility"])
        tree = self.client.ui_tree(0)
        self.assertEqual(tree["roots"][0]["text"], "Search")

    def test_upload_run_logs_screen(self):
        self.client.upload_file("settings_search", "__init__.py", "print(1)")
        self.assertTrue(self.client.run_project("settings_search")["ok"])
        logs = self.client.logs(0)
        self.assertTrue(logs["entries"])
        png = self.client.screen_png()
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.client.stop_project("settings_search")

    def test_read_file_passes_path_query(self):
        # Regression: `path` query kwarg used to collide with _get's route parameter.
        self.client.upload_file("demo", "framework/actor.py", "x = 1")
        got = self.client.read_file("demo", "framework/actor.py")
        self.assertEqual(got["path"], "framework/actor.py")
        self.assertEqual(got["content"], "x = 1")


if __name__ == "__main__":
    unittest.main()
