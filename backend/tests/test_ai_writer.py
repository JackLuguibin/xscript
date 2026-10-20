"""后台 AI 写脚本 against a local mock OpenAI-compatible server (no real model, dummy key only)."""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from test_server import CSRF, SKIP, Server  # noqa: E402

if not SKIP:
    import httpx

    from xscript_server import aiwriter
    from xscript_server.__main__ import main as cli
    from xscript_server.config import Config

DUMMY_KEY = "test-key-not-real"
GOOD = ("下面是脚本：\n```python\nfrom xscript.android import action\n\nfor i in range(3):\n"
        "    action.click(100, 200)\n    print('tap', i)\n```\n把坐标换成你的按钮位置。")


GOOD_REPLY = (200, {"choices": [{"message": {"content": GOOD}}],
                    "usage": {"prompt_tokens": 900, "completion_tokens": 60, "total_tokens": 960}}, {}, 0)


class Mock:
    """Records requests; `reply` decides each answer: (status, body dict | bytes, headers, delay)."""

    def __init__(self):
        self.requests: list[dict] = []
        self.reply = GOOD_REPLY
        mock = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                mock.requests.append({"path": self.path, "auth": self.headers.get("Authorization"),
                                      "json": json.loads(body or b"{}")})
                status, data, headers, delay = mock.reply
                time.sleep(delay)
                raw = data if isinstance(data, bytes) else json.dumps(data).encode()
                try:
                    self.send_response(status)
                    for k, v in headers.items():
                        self.send_header(k, v)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                except OSError:
                    pass  # client gave up (timeout test)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.httpd.daemon_threads = True
        self.url = "http://127.0.0.1:%d/v1" % self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def project(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for k, v in files.items():
            zf.writestr(k, v)
    return buf.getvalue()


@unittest.skipIf(SKIP, SKIP)
class AiWriterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for k in ("XSCRIPT_AI_BASE_URL", "XSCRIPT_AI_MODEL", "XSCRIPT_AI_KEY"):
            os.environ.pop(k, None)
        cls.mock = Mock()
        cls.tmp = tempfile.mkdtemp()
        cls.cfg = Config.load(os.path.join(cls.tmp, "data"), web_dir=os.path.join(cls.tmp, "noweb"))
        os.environ["XSCRIPT_ADMIN_PASSWORD"] = "admin-pass-123"
        assert cli(["--data", str(cls.cfg.data_dir), "init"]) == 0
        cls.srv = Server(cls.cfg).__enter__()
        cls.admin = cls.login("admin", "admin-pass-123")
        for name, role in (("op1", "operator"), ("view1", "viewer")):
            r = cls.admin.post("/api/users", json={"username": name, "password": "password-" + name, "role": role})
            assert r.status_code == 200, r.text
        cls.op = cls.login("op1", "password-op1")
        cls.viewer = cls.login("view1", "password-view1")

    @classmethod
    def tearDownClass(cls):
        for c in (cls.admin, cls.op, cls.viewer):
            c.close()
        cls.srv.__exit__(None, None, None)
        cls.mock.close()
        for k in ("XSCRIPT_AI_BASE_URL", "XSCRIPT_AI_MODEL", "XSCRIPT_AI_KEY"):
            os.environ.pop(k, None)

    @classmethod
    def login(cls, user, pw):
        c = httpx.Client(base_url=cls.srv.base, headers=CSRF, timeout=30)
        r = c.post("/api/auth/login", json={"username": user, "password": pw})
        assert r.status_code == 200, r.text
        return c

    def setUp(self):
        os.environ.update(XSCRIPT_AI_BASE_URL=self.mock.url, XSCRIPT_AI_MODEL="mock-coder", XSCRIPT_AI_KEY=DUMMY_KEY)
        self.mock.requests.clear()
        self.mock.reply = GOOD_REPLY
        self.srv.app.state.ctx.ai_limiter.hits.clear()

    def audit(self, action):
        return self.admin.get("/api/audit", params={"action": action}).json()["items"]

    # ---------------------------------------------------------------- config

    def test_catalog_copy_matches_mcp(self):
        mcp = HERE.parents[1] / "ide" / "mcp-server" / "xscript_mcp" / "api_catalog.json"
        self.assertEqual(aiwriter.CATALOG.read_bytes(), mcp.read_bytes(),
                         "backend/xscript_server/api_catalog.json 要和 MCP 的 api_catalog.json 保持一致（复制过去）")
        ref = aiwriter.api_reference()
        self.assertIn("xscript.android.action", ref)
        self.assertIn("click(x, y=None, dur=20)", ref)

    def test_not_configured(self):
        for k in ("XSCRIPT_AI_BASE_URL", "XSCRIPT_AI_MODEL", "XSCRIPT_AI_KEY"):
            os.environ.pop(k)
        st = self.viewer.get("/api/ai/status").json()
        self.assertEqual(st, {"configured": False, "base_url": "", "model": "", "key_set": False, "source": "env"})
        r = self.op.post("/api/ai/script", json={"prompt": "点一下"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("XSCRIPT_AI_BASE_URL", r.json()["error"])
        self.assertEqual(self.mock.requests, [])

    def test_status_never_returns_key(self):
        st = self.viewer.get("/api/ai/status")
        self.assertEqual(st.json(), {"configured": True, "base_url": self.mock.url, "model": "mock-coder",
                                     "key_set": True, "source": "env"})
        self.assertNotIn(DUMMY_KEY, st.text)
        self.assertNotIn(DUMMY_KEY, self.admin.get("/api/settings").text)

    def test_settings_override_env_and_key_is_not_a_setting(self):
        r = self.admin.put("/api/settings", json={"ai_base_url": self.mock.url + "/", "ai_model": "from-settings",
                                                  "ai_key": "should-be-ignored"})
        self.assertEqual(r.status_code, 200, r.text)
        try:
            self.assertEqual(r.json()["ai_base_url"], self.mock.url)
            self.assertNotIn("ai_key", r.json())
            st = self.viewer.get("/api/ai/status").json()
            self.assertEqual((st["model"], st["source"]), ("from-settings", "settings"))
            self.assertEqual(self.op.post("/api/ai/script", json={"prompt": "x"}).status_code, 200)
            self.assertEqual(self.mock.requests[-1]["json"]["model"], "from-settings")
            for bad in ("ftp://x", "http://user:pw@host/v1", "http://h/v1?k=1"):
                self.assertEqual(self.admin.put("/api/settings", json={"ai_base_url": bad}).status_code, 422, bad)
            self.assertEqual(self.op.put("/api/settings", json={"ai_model": "x"}).status_code, 403)
        finally:
            self.admin.put("/api/settings", json={"ai_base_url": "", "ai_model": ""})

    # ---------------------------------------------------------------- generate

    def test_generate_sends_grounded_prompt_and_returns_code(self):
        r = self.op.post("/api/ai/script", json={"prompt": "每隔一秒点击屏幕中间，点三次"})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertTrue(out["code"].startswith("from xscript.android import action"))
        self.assertEqual(out["syntax_error"], "")
        self.assertIn("坐标", out["notes"])
        self.assertEqual(out["model"], "mock-coder")
        self.assertEqual(out["usage"]["total_tokens"], 960)
        req = self.mock.requests[-1]
        self.assertEqual(req["path"], "/v1/chat/completions")
        self.assertEqual(req["auth"], "Bearer " + DUMMY_KEY)
        msgs = req["json"]["messages"]
        self.assertEqual([m["role"] for m in msgs], ["system", "user"])
        self.assertIn("swipe(x1, y1, x2, y2, dur=300)", msgs[0]["content"])
        self.assertIn("__init__.py", msgs[0]["content"])
        self.assertEqual(msgs[1]["content"], "每隔一秒点击屏幕中间，点三次")
        self.assertIs(req["json"]["stream"], False)
        # Audit: size only, never the prompt or the key.
        row = self.audit("ai.script")[0]
        self.assertEqual(row["actor"], "op1")
        self.assertEqual(row["detail"]["prompt_chars"], len("每隔一秒点击屏幕中间，点三次"))
        self.assertTrue(row["detail"]["syntax_ok"])
        self.assertNotIn("每隔一秒", json.dumps(row, ensure_ascii=False))

    def test_revise_includes_current_code(self):
        self.op.post("/api/ai/script", json={"prompt": "改成点五次", "code": "print('old')\n"})
        user = self.mock.requests[-1]["json"]["messages"][1]["content"]
        self.assertIn("print('old')", user)
        self.assertTrue(user.endswith("改成点五次"))

    def test_syntax_error_is_reported_not_run(self):
        self.mock.reply = (200, {"choices": [{"message": {"content": "```python\nif True\n    pass\n```"}}]}, {}, 0)
        out = self.op.post("/api/ai/script", json={"prompt": "x"}).json()
        self.assertTrue(out["syntax_error"].startswith("第 1 行"), out)

    def test_upstream_errors(self):
        cases = [
            ((401, {"error": {"message": "bad key " + DUMMY_KEY}}, {}, 0), 502, "401"),
            ((302, b"", {"Location": "http://127.0.0.1:9/steal"}, 0), 502, "重定向"),
            ((200, b"not json", {}, 0), 502, "不是有效"),
            ((200, {"choices": []}, {}, 0), 502, "不是有效"),
        ]
        for reply, status, text in cases:
            self.mock.reply = reply
            r = self.op.post("/api/ai/script", json={"prompt": "x"})
            self.assertEqual(r.status_code, status, (reply, r.text))
            self.assertIn(text, r.json()["error"])
            self.assertNotIn(DUMMY_KEY, r.text)
        self.assertEqual(len(self.mock.requests), len(cases))  # the redirect was not followed
        row = self.audit("ai.script")[0]
        self.assertFalse(row["detail"]["ok"])
        self.assertNotIn(DUMMY_KEY, json.dumps(row))

    def test_timeout(self):
        old = aiwriter.TIMEOUT
        aiwriter.TIMEOUT = 0.5
        self.mock.reply = (200, {"choices": [{"message": {"content": GOOD}}]}, {}, 2)
        try:
            r = self.op.post("/api/ai/script", json={"prompt": "x"})
        finally:
            aiwriter.TIMEOUT = old
        self.assertEqual(r.status_code, 504, r.text)

    def test_unreachable(self):
        os.environ["XSCRIPT_AI_BASE_URL"] = "http://127.0.0.1:9/v1"
        r = self.op.post("/api/ai/script", json={"prompt": "x"})
        self.assertEqual(r.status_code, 502)
        self.assertIn("连不上", r.json()["error"])

    def test_roles(self):
        self.assertEqual(self.viewer.post("/api/ai/script", json={"prompt": "x"}).status_code, 403)
        self.assertEqual(self.viewer.post("/api/ai/save", json={"script_id": 1, "code": "x=1"}).status_code, 403)
        self.assertEqual(self.op.post("/api/ai/script", json={"prompt": ""}).status_code, 422)
        self.assertEqual(self.op.post("/api/ai/script", json={"prompt": "x" * 4001}).status_code, 422)

    # ---------------------------------------------------------------- save as a version

    def test_save_keeps_base_files_and_round_trips(self):
        sc = self.op.post("/api/scripts", json={"name": "AI 演示", "project_name": "ai_demo"}).json()
        base = project({"ai_demo/__init__.py": b"print('v1')\n", "ai_demo/__init__.pyc": b"\0",
                        "ai_demo/res/a.txt": b"keep me", "ai_demo/requirements.txt": b"pyyaml\n"})
        v1 = self.op.post("/api/scripts/%d/versions" % sc["id"], files={"file": ("p.zip", base)}).json()
        src = self.op.get("/api/ai/source/%d/%d" % (sc["id"], v1["id"])).json()
        self.assertEqual(src, {"code": "print('v1')\n", "version": "1.0.0"})

        code = "print('v2')\n"
        r = self.op.post("/api/ai/save", json={"script_id": sc["id"], "code": code, "base_version_id": v1["id"]})
        self.assertEqual(r.status_code, 200, r.text)
        v2 = r.json()
        self.assertEqual(v2["version"], "1.0.1")
        self.assertEqual(v2["notes"], "AI 写脚本生成")
        z = zipfile.ZipFile(io.BytesIO(self.op.get("/api/scripts/%d/versions/%d/source" % (sc["id"], v2["id"])).content))
        self.assertEqual(sorted(z.namelist()), ["__init__.py", "requirements.txt", "res/a.txt"])
        self.assertEqual(z.read("__init__.py").decode(), code)
        self.assertEqual(self.op.get("/api/ai/source/%d/%d" % (sc["id"], v2["id"])).json()["code"], code)
        row = self.audit("script.version")[0]
        self.assertTrue(row["detail"]["ai"])
        self.assertEqual(row["detail"]["base_version_id"], v1["id"])

        # From scratch, explicit version; operators cannot publish; syntax errors and bad ids refused.
        r = self.op.post("/api/ai/save", json={"script_id": sc["id"], "code": "x = 1\n", "version": "2.0.0"})
        self.assertEqual((r.status_code, r.json()["version"]), (200, "2.0.0"))
        self.assertEqual(self.op.post("/api/ai/save", json={"script_id": sc["id"], "code": "x=1", "publish": True})
                         .status_code, 403)
        r = self.op.post("/api/ai/save", json={"script_id": sc["id"], "code": "def f(:\n"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("语法错误", r.json()["error"])
        self.assertEqual(self.op.post("/api/ai/save", json={"script_id": 9999, "code": "x=1"}).status_code, 404)
        self.assertEqual(self.op.post("/api/ai/save", json={"script_id": sc["id"], "code": "x=1",
                                                             "base_version_id": 9999}).status_code, 404)
        self.assertEqual(self.op.post("/api/ai/save", json={"script_id": sc["id"], "code": "x=1",
                                                             "version": "2.0.0"}).status_code, 409)
        r = self.admin.post("/api/ai/save", json={"script_id": sc["id"], "code": "x=2", "publish": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.admin.get("/api/scripts/%d" % sc["id"]).json()["current"]["id"], r.json()["id"])

    def test_rate_limit(self):
        c = self.login("op1", "password-op1")
        try:
            codes = [c.post("/api/ai/script", json={"prompt": "x"}).status_code for _ in range(21)]
        finally:
            c.close()
        self.assertEqual(codes[:20], [200] * 20)
        self.assertEqual(codes[20], 429)


if __name__ == "__main__":
    unittest.main()
