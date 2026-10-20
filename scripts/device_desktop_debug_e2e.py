#!/usr/bin/env python3
"""Desktop debugger (desktop/app DebugSession) against a real device's debugpy: conditional breakpoint, hit count set
mid-session, logpoints, watch evaluation.

usage: .venv-desktop/bin/python scripts/device_desktop_debug_e2e.py [DEVICE_URL]   default http://127.0.0.1:19860
(needs `adb forward tcp:19860 tcp:9860`; creates and deletes project `dbgopt` on the device)
"""
import asyncio, json, os, sys, urllib.parse, urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "desktop", "app"))
from xscript_desktop.services.debugger import DebugSession  # noqa: E402
from xscript_desktop.services.device_client import DeviceClient, DeviceTarget  # noqa: E402
import devauth  # scripts/devauth.py: pairing code (XSCRIPT_TOKEN or adb)  # noqa: E402

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:19860").rstrip("/")
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
SRC = "total = 0\nfor i in range(6):\n    total += i\n    x = i * 10\nprint('done', total)\n"
results = []


def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers=devauth.headers(BASE, {"Content-Type": "application/json"}))
    try:
        return json.load(OPENER.open(req, timeout=30))
    except Exception as e:  # DELETE of a missing project is fine
        return {"error": str(e)}


def check(ok, name, detail=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (" (%s)" % detail if detail else ""))


async def main():
    api("DELETE", "/projects/dbgopt")
    api("POST", "/projects/dbgopt", {})
    api("PUT", "/projects/dbgopt/files", {"files": [{"path": "__init__.py", "content": SRC}]})
    events = []
    u = urllib.parse.urlparse(BASE)
    s = DebugSession("dev", DeviceClient(DeviceTarget(host=u.hostname, port=u.port or 80), token=devauth.token(BASE) or None), "dbgopt", lambda t, d: events.append((t, d)))

    async def paused():
        for _ in range(600):
            if s.state in ("stopped", "ended"):
                return s.state
            await asyncio.sleep(0.1)

    try:
        await s.start({"__init__.py": [{"line": 3, "logMessage": "LP i={i} total={total}"}, {"line": 4, "condition": "i == 3"}]})
        st = await paused()
        top = s.frames[0] if s.frames else {}
        i = (await s.evaluate("i", top.get("id"), "watch"))["result"] if st == "stopped" else None
        check(st == "stopped" and top.get("line") == 4 and i == "3", "condition i == 3 pauses at line 4 with i = 3", "%s %s i=%s" % (st, top.get("line"), i))
        total = (await s.evaluate("total", top.get("id"), "watch"))["result"]
        check(total == "6", "watch evaluates total in the paused frame", total)
        await s.set_breakpoints("__init__.py", [{"line": 4, "hitCondition": "2"}])
        await s.step("continue")
        await asyncio.sleep(0.5)
        st = await paused()
        top = s.frames[0] if s.frames else {}
        i = (await s.evaluate("i", top.get("id"), "watch"))["result"] if st == "stopped" else None
        check(st == "stopped" and i == "5", "hit count 2 set mid-session pauses on the 2nd hit (i = 5)", "%s i=%s" % (st, i))
    finally:
        await s.stop(terminate=True)
        api("DELETE", "/projects/dbgopt")
    out = "".join(d["text"] for t, d in events if t == "debug.output")
    lp = [line for line in out.splitlines() if line.startswith("LP ")]
    check(lp == ["LP i=0 total=0", "LP i=1 total=0", "LP i=2 total=1", "LP i=3 total=3"],
          "logpoints print without pausing, until removed", str(lp))


if __name__ == "__main__":
    asyncio.run(main())
    print("ALL PASS" if all(results) else "SOME CHECKS FAILED")
    sys.exit(0 if all(results) else 1)
