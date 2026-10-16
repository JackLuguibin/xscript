"""MCP breakpoint debugging against a scripted fake debugpy behind the /debug/* HTTP bridge."""

import json
import sys
import unittest
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from xscript_mcp.client import DeviceClient, DeviceTarget  # noqa: E402
from xscript_mcp.debug import DebugError, DebugSession  # noqa: E402

ROOT = "/data/user/0/com.xscript/files/projects/demo"


class FakeDebugDevice:
    """Two-line program: breakpoint at line 2 stops once, then the program ends on continue."""

    def __init__(self):
        self.msgs: list[dict] = []
        self.requests: list[dict] = []
        self.connected = False
        self.connect_fails = 2
        self.bp_lines: list[int] = []
        self.line = 0
        self.stopped_project = False

    def emit(self, m):
        self.msgs.append(m)

    def respond(self, req, body=None, success=True, message=""):
        self.emit({"type": "response", "request_seq": req["seq"], "command": req["command"], "success": success,
                   "message": message, "body": body or {}})

    def stop_at(self, line, reason):
        self.line = line
        self.emit({"type": "event", "event": "stopped", "body": {"reason": reason, "threadId": 1}})

    def end(self):
        self.emit({"type": "event", "event": "output", "body": {"category": "stdout", "output": "done\n"}})
        self.emit({"type": "event", "event": "terminated", "body": {}})

    def dap(self, req):
        self.requests.append(req)
        cmd, args = req["command"], req.get("arguments") or {}
        if cmd == "initialize":
            self.respond(req, {"supportsConfigurationDoneRequest": True})
        elif cmd == "attach":
            self.attach = req
            self.emit({"type": "event", "event": "initialized", "body": {}})
        elif cmd == "setBreakpoints":
            assert args["source"]["path"] == ROOT + "/__init__.py", args
            self.bp_lines = [b["line"] for b in args["breakpoints"]]
            self.respond(req, {"breakpoints": [{"line": n, "verified": True} for n in self.bp_lines]})
        elif cmd == "configurationDone":
            self.respond(req)
            self.respond(self.attach)
            if 2 in self.bp_lines:
                self.stop_at(2, "breakpoint")
            else:
                self.end()
        elif cmd == "stackTrace":
            self.respond(req, {"stackFrames": [{"id": 7, "name": "<module>", "line": self.line,
                                                "source": {"path": ROOT + "/__init__.py"}}]})
        elif cmd == "scopes":
            self.respond(req, {"scopes": [{"name": "Locals", "variablesReference": 9}]})
        elif cmd == "variables":
            self.respond(req, {"variables": [{"name": "x", "value": "41", "type": "int"},
                                             {"name": "__name__", "value": "'__main__'", "type": "str"}]})
        elif cmd == "evaluate":
            self.respond(req, {"result": "42" if args["expression"] == "x + 1" else "?", "type": "int"})
        elif cmd == "next":
            self.respond(req)
            self.emit({"type": "event", "event": "continued", "body": {"threadId": 1}})
            self.stop_at(3, "step")
        elif cmd == "continue":
            self.respond(req, {"allThreadsContinued": True})
            self.end()
        elif cmd == "disconnect":
            self.respond(req)
        else:
            self.respond(req, success=False, message="unsupported " + cmd)

    def handler(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        if path == "/projects/demo/debug" and method == "POST":
            return httpx.Response(200, json={"ok": True, "debug": {"port": 5678, "remote_root": ROOT}})
        if path == "/projects/busy/debug":
            return httpx.Response(409, json={"error": "已有脚本在运行"})
        if path == "/debug/connect":
            if self.connect_fails:
                self.connect_fails -= 1
                return httpx.Response(409, json={"error": "not ready"})
            self.connected = True
            return httpx.Response(200, json={"ok": True, "next": 0})
        if path == "/debug/request":
            self.dap(json.loads(request.content))
            return httpx.Response(200, json={"ok": True})
        if path == "/debug/messages":
            since = int(request.url.params.get("since", 0))
            items = [{"id": i + 1, "message": m} for i, m in enumerate(self.msgs) if i + 1 > since]
            return httpx.Response(200, json={"messages": items, "next": len(self.msgs), "connected": self.connected})
        if path == "/debug" and method == "DELETE":
            self.connected = False
            return httpx.Response(200, json={"ok": True})
        if path == "/projects/demo/stop":
            self.stopped_project = True
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404, json={"error": "no route " + path})


class FakeClient(DeviceClient):
    def __init__(self, dev):
        super().__init__(DeviceTarget())
        self.dev = dev

    def _client(self, timeout=None):
        return httpx.Client(transport=httpx.MockTransport(self.dev.handler), timeout=5)


class DebugSessionTest(unittest.TestCase):
    def setUp(self):
        self.dev = FakeDebugDevice()
        self.s = DebugSession(FakeClient(self.dev), sleep=lambda _: None, poll_interval=0, request_timeout=2)

    def test_breakpoint_step_evaluate_continue_stop(self):
        snap = self.s.start("demo", {"__init__.py": [2]}, wait_seconds=2)
        self.assertEqual((snap["state"], snap["reason"], snap["file"], snap["line"]),
                         ("stopped", "breakpoint", "__init__.py", 2))
        self.assertEqual(snap["locals"], [{"name": "x", "value": "41", "type": "int"}])
        self.assertEqual(self.s.evaluate("x + 1")["result"], "42")
        snap = self.s.step("next", wait_seconds=2)
        self.assertEqual((snap["state"], snap["line"]), ("stopped", 3))
        snap = self.s.step("continue", wait_seconds=2)
        self.assertEqual(snap["state"], "terminated")
        self.assertIn("done", snap["output"])
        self.assertTrue(self.s.stop()["ok"])
        self.assertTrue(self.dev.stopped_project)
        self.assertFalse(self.dev.connected)
        order = [r["command"] for r in self.dev.requests[:4]]
        self.assertEqual(order, ["initialize", "attach", "setBreakpoints", "configurationDone"])

    def test_without_breakpoints_runs_to_the_end(self):
        snap = self.s.start("demo", {}, wait_seconds=2)
        self.assertEqual(snap["state"], "terminated")

    def test_busy_device_and_misuse_are_reported(self):
        with self.assertRaises(DebugError):
            self.s.start("busy")
        with self.assertRaises(DebugError):
            self.s.step("next")
        self.s.start("demo", {"__init__.py": [2]}, wait_seconds=2)
        with self.assertRaises(DebugError):
            self.s.start("demo")
        with self.assertRaises(DebugError):
            self.s.step("jump")


class ToolTest(unittest.TestCase):
    def test_tools_are_registered_and_errors_are_json(self):
        from xscript_mcp import server

        out = json.loads(server.debug_step("next"))
        self.assertFalse(out["ok"])
        self.assertIn("not stopped", out["error"])


if __name__ == "__main__":
    unittest.main()
