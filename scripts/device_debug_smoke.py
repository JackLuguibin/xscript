#!/usr/bin/env python3
"""Real-device DAP check through XScript HTTP API; creates/deletes its own fixture only."""
import argparse
import json
import time
import urllib.error
import urllib.request
import uuid


class Device:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.seq = 0
        self.cursor = 0
        self.messages = []

    def api(self, method, path, body=None):
        request = urllib.request.Request(self.base + path, method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Content-Type": "application/json"})
        with self.opener.open(request, timeout=8) as response:
            return json.load(response)

    def send(self, command, arguments=None):
        self.seq += 1
        self.api("POST", "/debug/request", {"seq": self.seq, "type": "request",
            "command": command, "arguments": arguments or {}})
        return self.seq

    def wait(self, predicate, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for i, msg in enumerate(self.messages):
                if predicate(msg):
                    return self.messages.pop(i)
            result = self.api("GET", "/debug/messages?since=" + str(self.cursor))
            self.cursor = result["next"]
            self.messages.extend(row["message"] for row in result["messages"])
            time.sleep(0.08)
        logs = self.api("GET", "/logs?since=0").get("entries", [])[-12:]
        raise TimeoutError("DAP timeout; recent logs: " + json.dumps(logs, ensure_ascii=False))

    def response(self, seq):
        msg = self.wait(lambda m: m.get("type") == "response" and m.get("request_seq") == seq)
        assert msg.get("success"), msg
        return msg.get("body", {})

    def event(self, name):
        return self.wait(lambda m: m.get("type") == "event" and m.get("event") == name).get("body", {})


def smoke(base):
    d = Device(base)
    assert not d.api("GET", "/status").get("running"), "a user project is running"
    project = "_codex_dap_" + uuid.uuid4().hex[:10]
    url = "/projects/" + project
    d.api("POST", url, {})
    try:
        d.api("PUT", url + "/files", {"path": "__init__.py", "encoding": "utf-8",
            "content": "total = 1\ntotal += 41\nprint('XSCRIPT_DAP_OK', total)\n"})
        started = d.api("POST", url + "/debug", {})
        deadline = time.monotonic() + 35
        while True:
            try:
                d.api("POST", "/debug/connect", {})
                break
            except urllib.error.HTTPError:
                if time.monotonic() > deadline:
                    raise RuntimeError("debugger did not start: " + str(d.api("GET", "/logs?since=0")))
                time.sleep(0.3)
        d.response(d.send("initialize", {"adapterID": "python", "clientID": "xscript-smoke",
            "pathFormat": "path", "linesStartAt1": True, "columnsStartAt1": True}))
        attach = d.send("attach", {"justMyCode": True})
        d.event("initialized")
        source = started["debug"]["remote_root"] + "/__init__.py"
        result = d.response(d.send("setBreakpoints", {"source": {"path": source}, "breakpoints": [{"line": 2}]}))
        assert result["breakpoints"][0]["verified"], result
        d.response(d.send("configurationDone"))
        d.response(attach)
        stopped = d.event("stopped")
        assert stopped["reason"] == "breakpoint", stopped
        thread = stopped["threadId"]
        stack = d.response(d.send("stackTrace", {"threadId": thread}))["stackFrames"]
        frame = stack[0]
        assert frame["line"] == 2 and frame["source"]["path"] == source, frame
        scopes = d.response(d.send("scopes", {"frameId": frame["id"]}))["scopes"]
        local = next(s for s in scopes if s["name"] == "Locals")
        variables = d.response(d.send("variables", {"variablesReference": local["variablesReference"]}))["variables"]
        assert next(v for v in variables if v["name"] == "total")["value"] == "1", variables
        d.response(d.send("next", {"threadId": thread}))
        step = d.event("stopped")
        frame2 = d.response(d.send("stackTrace", {"threadId": step["threadId"]}))["stackFrames"][0]
        assert frame2["line"] == 3, frame2
        value = d.response(d.send("evaluate", {"expression": "total", "frameId": frame2["id"], "context": "watch"}))
        assert value["result"] == "42", value
        d.response(d.send("continue", {"threadId": thread}))
        deadline = time.monotonic() + 15
        while d.api("GET", "/status").get("running"):
            assert time.monotonic() < deadline, "script did not finish"
            time.sleep(0.2)
        logs = d.api("GET", "/logs?since=0")
        assert "XSCRIPT_DAP_OK 42" in json.dumps(logs), logs
        # Stop must work even before a client attaches, then a normal run must be unaffected.
        time.sleep(0.3)
        d.api("POST", url + "/debug", {})
        deadline = time.monotonic() + 15
        while True:
            try:
                d.api("POST", "/debug/connect", {})
                break
            except urllib.error.HTTPError:
                assert time.monotonic() < deadline, "second debugger did not start"
                time.sleep(0.2)
        d.api("POST", url + "/stop", {})
        while d.api("GET", "/status").get("running"):
            assert time.monotonic() < deadline, "waiting debugger could not be stopped"
            time.sleep(0.2)
        assert not d.api("GET", "/debug/status")["connected"]
        time.sleep(0.3)
        cursor = d.api("GET", "/logs?since=0")["next"]
        d.api("POST", url + "/run", {})
        while "XSCRIPT_DAP_OK 42" not in json.dumps(d.api("GET", "/logs?since=" + str(cursor))):
            assert time.monotonic() < deadline, "normal run affected by previous debugger"
            time.sleep(0.2)
        time.sleep(0.3)
        d.api("POST", url + "/debug", {})
        deadline = time.monotonic() + 15
        while True:
            try:
                d.api("POST", "/debug/connect", {})
                break
            except urllib.error.HTTPError:
                assert time.monotonic() < deadline, "detach debugger did not start"
                time.sleep(0.2)
        d.cursor, d.messages = 0, []
        d.response(d.send("initialize", {"adapterID": "python", "pathFormat": "path"}))
        attach = d.send("attach", {"justMyCode": True})
        d.event("initialized")
        d.response(d.send("setBreakpoints", {"source": {"path": source}, "breakpoints": [{"line": 2}]}))
        d.response(d.send("configurationDone"))
        d.response(attach)
        d.event("stopped")
        d.response(d.send("disconnect", {"terminateDebuggee": False}))
        while d.api("GET", "/status").get("running"):
            assert time.monotonic() < deadline, "disconnect left paused script suspended"
            time.sleep(0.2)
        return {"breakpoint": True, "variables": True, "step_over": True, "evaluate": True,
            "continue": True, "project_finished": True, "stop_while_waiting": True,
            "normal_run_after_debug": True, "detach_resumes_script": True, "source": source}
    finally:
        d.api("POST", url + "/stop", {})
        deadline = time.monotonic() + 5
        while d.api("GET", "/status").get("running") and time.monotonic() < deadline:
            time.sleep(0.1)
        d.api("DELETE", url)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:19860")
    print(json.dumps(smoke(parser.parse_args().base), ensure_ascii=False, indent=2))
