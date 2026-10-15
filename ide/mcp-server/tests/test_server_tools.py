"""MCP tool layer (xscript_mcp.server): request shaping, guards, error reporting, and an
end-to-end pass over scripts/mock_device.py through the registered tools."""

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))

import httpx  # noqa: E402

import mock_device  # noqa: E402
from xscript_mcp import server  # noqa: E402
from xscript_mcp.client import DeviceClient, DeviceError, DeviceTarget  # noqa: E402


class Recorder:
    """Stands in for DeviceClient and records what each tool asked the device for."""

    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def call(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return {"ok": True}
        return call


class ToolShapingTest(unittest.TestCase):
    def setUp(self):
        self.real = server._client
        self.rec = server._client = Recorder()

    def tearDown(self):
        server._client = self.real

    def last(self):
        return self.rec.calls[-1]

    def test_device_action_payloads(self):
        server.device_action("CLICK", x=5, y=6)
        self.assertEqual(self.last()[1][0], {"type": "click", "x": 5, "y": 6, "dur": 20})
        server.device_action("swipe", 1, 2, 3, 4)
        self.assertEqual(self.last()[1][0], {"type": "swipe", "x1": 1, "y1": 2, "x2": 3, "y2": 4, "dur": 300})
        server.device_action(" input ", text="你好")
        self.assertEqual(self.last()[1][0], {"type": "input", "text": "你好"})
        server.device_action("key", key="back")
        self.assertEqual(self.last()[1][0], {"type": "key", "name": "back"})
        n = len(self.rec.calls)
        self.assertEqual(json.loads(server.device_action("tap")), {"ok": False, "error": "unknown action_type"})
        self.assertEqual(len(self.rec.calls), n, "unknown actions never reach the device")

    def test_eval_guard_and_timeout_cap(self):
        for code in ("while True:\n    pass", "while  True :\n    x=1", "x=1\nwhile True: pass"):
            self.assertFalse(json.loads(server.eval_python(code))["ok"], code)
        self.assertEqual(self.rec.calls, [])
        server.eval_python("_result = 1", timeout_ms=60000)
        self.assertEqual(self.last()[2], {"timeout_ms": 15000})
        server.eval_python("_result = 1")
        self.assertEqual(self.last()[2], {"timeout_ms": server.EVAL_DEADLINE_MS})

    def test_schedule_bodies_only_carry_fields_for_their_kind(self):
        server.add_schedule("p", "daily", time="08:30", weekdays=[1, 5], every=9, at="x")
        self.assertEqual(self.last()[1][0], {"project": "p", "kind": "daily", "if_running": "skip", "time": "08:30", "weekdays": [1, 5]})
        server.add_schedule("p", "interval", every=15, window="22:00-02:00", time="ignored")
        self.assertEqual(self.last()[1][0], {"project": "p", "kind": "interval", "if_running": "skip", "every": 15, "window": "22:00-02:00"})
        server.add_schedule("p", "once", at="2026-10-15 09:00", if_running="restart")
        self.assertEqual(self.last()[1][0], {"project": "p", "kind": "once", "if_running": "restart", "at": "2026-10-15 09:00"})
        server.update_schedule("s1")
        self.assertEqual(self.last()[1], ("s1", {}))
        server.update_schedule("s1", enabled=False, window="")
        self.assertEqual(self.last()[1], ("s1", {"enabled": False, "window": ""}), "empty window clears it")

    def test_run_options_read_vs_write(self):
        server.project_run_options("p")
        self.assertEqual(self.last()[0], "project_config")
        server.project_run_options("p", auto_run=False)
        self.assertEqual(self.last(), ("set_project_config", ("p",), {"auto_run": False}))

    def test_vision_request(self):
        server.vision_test("snap", "pixel", x=3, y=4)
        req = self.last()[1][0]
        self.assertEqual((req["op"], req["x"], req["y"]), ("pixel", 3, 4))
        self.assertNotIn("model", req)
        server.vision_test("snap", "yolo", model="p:res/best.onnx", rect=[0, 0, 10, 10], engine="paddle")
        req = self.last()[1][0]
        self.assertEqual((req["model"], req["conf"], req["rect"], req["engine"]), ("p:res/best.onnx", 0.25, [0, 0, 10, 10], "paddle"))
        self.assertNotIn("x", req)

    def test_catalog_queries(self):
        everything = json.loads(server.get_module_apis(""))
        self.assertGreater(len(everything["modules"]), 5)
        node = json.loads(server.get_module_apis("  NODE "))["modules"]
        self.assertTrue(node and all("node" in (m["name"] + m["description"]).lower() for m in node))
        self.assertEqual(json.loads(server.search_api("no-such-api-zzz"))["modules"], [])
        self.assertTrue(json.loads(server.search_api("Selector"))["modules"])

    def test_every_tool_is_registered_with_a_description(self):
        tools = asyncio.run(server.mcp.list_tools())
        names = {t.name for t in tools}
        for expected in ("connect_device", "run_project", "eval_python", "upload_directory", "vision_test", "pip_install"):
            self.assertIn(expected, names)
        self.assertTrue(all(t.description for t in tools))


class TargetParseTest(unittest.TestCase):
    def test_forms(self):
        cases = {
            "": ("127.0.0.1", 9860), "10.0.0.5": ("10.0.0.5", 9860), "10.0.0.5:19860": ("10.0.0.5", 19860),
            "http://10.0.0.5:9860/": ("10.0.0.5", 9860), "http://10.0.0.5:9860/tools/": ("10.0.0.5", 9860),
            ":19860": ("127.0.0.1", 19860), "[::1]:19860": ("::1", 19860), "fe80::1": ("fe80::1", 9860),
            "[fe80::1]": ("fe80::1", 9860),
        }
        for text, (host, port) in cases.items():
            t = DeviceTarget.parse(text)
            self.assertEqual((t.host, t.port), (host, port), text)
        self.assertEqual(DeviceTarget.parse("[::1]:19860").base_url, "http://[::1]:19860")
        with self.assertRaises(ValueError):
            DeviceTarget.parse("host:notaport")


class EndToEndTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = mock_device.serve("127.0.0.1", 0)
        cls.port = cls.httpd.server_address[1]
        cls.real = server._client
        server._client = DeviceClient(DeviceTarget())

    @classmethod
    def tearDownClass(cls):
        server._client = cls.real
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def test_connect_upload_run_logs_and_errors(self):
        with socket_free_port() as free:
            msg = server.connect_device("127.0.0.1", free)
        self.assertIn("/status failed", msg, "unreachable device is reported, not raised")
        connected = json.loads(server.connect_device("127.0.0.1", self.port))
        self.assertEqual(connected["target"], "http://127.0.0.1:%d" % self.port)
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "__init__.py").write_text("print('mcp e2e')\n")
            (Path(d) / "res").mkdir()
            (Path(d) / "res" / "a.png").write_bytes(b"\x89PNG")
            (Path(d) / "__pycache__").mkdir()
            (Path(d) / "__pycache__" / "x.pyc").write_bytes(b"junk")
            json.loads(server.upload_directory("mcp_e2e", d))
        files = sorted(f["path"] for f in json.loads(server.list_project_files("mcp_e2e"))["files"])
        self.assertEqual(files, ["__init__.py", "res/a.png"], "__pycache__ is never shipped")
        self.assertIn("mcp_e2e", json.loads(server.list_projects())["projects"])
        server.upload_file("mcp_e2e", "lib.py", "X = 1\n")
        self.assertEqual(json.loads(server.read_project_file("mcp_e2e", "lib.py"))["content"], "X = 1\n")
        server.run_project("mcp_e2e")
        logs = json.loads(server.get_run_log(0))
        self.assertTrue(logs["entries"])
        self.assertEqual(json.loads(server.get_run_log(logs["next"]))["entries"], [])
        server.stop_project("mcp_e2e")
        # Device errors surface the device's own message, still as an httpx.HTTPStatusError.
        with self.assertRaises(DeviceError) as e:
            server.read_project_file("mcp_e2e", "../x")
        self.assertIsInstance(e.exception, httpx.HTTPStatusError)
        self.assertEqual(e.exception.status_code, 400)
        self.assertIn("invalid path", str(e.exception))
        with self.assertRaises(DeviceError) as e:
            server.read_project_file("mcp_e2e", "missing.py")
        self.assertEqual(e.exception.status_code, 404)
        self.assertTrue(json.loads(server.delete_project("mcp_e2e"))["ok"])
        self.assertNotIn("mcp_e2e", json.loads(server.list_projects())["projects"])
        with self.assertRaises(ValueError):
            with tempfile.TemporaryDirectory() as empty:
                server.upload_directory("nope", empty)


class socket_free_port:
    def __enter__(self):
        import socket
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        self.port = s.getsockname()[1]
        s.close()
        return self.port

    def __exit__(self, *exc):
        return False


if __name__ == "__main__":
    unittest.main()
