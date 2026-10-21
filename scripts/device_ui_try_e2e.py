#!/usr/bin/env python3
"""桌面端「在手机上试运行」 on a real emulator/phone, step for step like ProjectsPage.tryForm.

usage: scripts/device_ui_try_e2e.py SERIAL DEVICE_URL      e.g. emulator-5556 http://127.0.0.1:19861
(needs `adb forward tcp:19861 tcp:9860` and the app's overlay permission; the app answering there is the one tested).

Generates the form files with the shared generator (android/app/src/main/assets/tools/ui-form.js, the same bytes the
desktop vendors) and the entry script from desktop/frontend/src/ui-try.ts, writes them into the scratch project
_ui_try (creating it, or reusing it when it already exists: 409), runs it, taps 开始 and checks the run log has
`界面返回：{...}` with the defaults; a second run taps 取消 and expects `界面返回：null`. Deletes _ui_try at the end.
UI dumps are parsed in memory and anything printed goes through mask(): the pairing code shown on the app's home
screen never reaches the output. Never installs, uninstalls or clears data.
"""
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import devauth  # noqa: E402  pairing code (XSCRIPT_TOKEN or adb), never printed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADB = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
if not os.path.exists(ADB):
    ADB = "adb"
PROJECT = "_ui_try"
NAME = "try_e2e"
SPEC = {"version": 1, "title": "试运行 E2E", "submit": "开始", "cancel": "取消", "width": "85vw", "height": "60vh",
        "fields": [{"kind": "text", "id": "account", "label": "账号", "default": "abc"},
                   {"kind": "checkbox", "id": "notify", "label": "完成后通知", "default": True}]}
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
mask = devauth.mask  # pairing codes become ****-****; used on everything this script prints


def try_main(name):
    """The entry script the desktop writes (uiTryMain in desktop/frontend/src/ui-try.ts), read from that file."""
    src = open(os.path.join(ROOT, "desktop/frontend/src/ui-try.ts"), encoding="utf-8").read()
    body = src[src.index("return `") + len("return `"):src.rindex("`;")]
    body = body.replace("${name}", name)
    return body.encode("utf-8").decode("unicode_escape").encode("latin-1").decode("utf-8")


def generate(name):
    js = ("const m = require(process.argv[1]); const s = m.parseSpec(process.argv[2]); const e = m.validateSpec(s);"
          " if (e.length) throw new Error(e.join('; ')); process.stdout.write(JSON.stringify(m.outputs(s, process.argv[3])));")
    r = subprocess.run(["node", "-e", js, os.path.join(ROOT, "android/app/src/main/assets/tools/ui-form.js"),
                        json.dumps(SPEC), name], capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


class Device:
    def __init__(self, serial, base):
        self.serial, self.base = serial, base.rstrip("/")

    def api(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers=devauth.headers(self.base, {"Content-Type": "application/json"}))
        try:
            with OPENER.open(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, {}

    def adb(self, *a):
        return subprocess.run([ADB, "-s", self.serial, *a], capture_output=True).stdout.decode("utf-8", "replace")

    def nodes(self):
        """(text, center) of every node; the raw dump stays in memory and is never printed."""
        x = self.adb("exec-out", "uiautomator", "dump", "/dev/tty")
        out = []
        for m in re.finditer(r"<node [^>]*>", x):
            t = re.search(r'\btext="([^"]*)"', m.group(0))
            b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', m.group(0))
            if t and b:
                x1, y1, x2, y2 = map(int, b.groups())
                out.append((html.unescape(t.group(1)), ((x1 + x2) // 2, (y1 + y2) // 2)))
        return out

    def log_lines(self, since):
        return [e["line"].rstrip("\n") for e in self.api("GET", "/logs?since=%d" % since)[1].get("entries", [])]


def run_and_answer(dev, button):
    """Run _ui_try, wait for the form, tap `button`; the 界面返回 line from this run's log, or None."""
    since = dev.api("GET", "/logs?since=0")[1].get("next", 0)
    code, r = dev.api("POST", "/projects/%s/run" % PROJECT, {})
    if code != 200 or not r.get("running"):
        print(mask("run refused: %s %s" % (code, r)))
        return None
    for _ in range(25):
        time.sleep(1)
        ns = dev.nodes()
        if any(t == "完成后通知" for t, _ in ns):
            hit = next((c for t, c in ns if t == button), None)
            if hit:
                dev.adb("shell", "input", "tap", str(hit[0]), str(hit[1]))
                break
    else:
        return None
    for _ in range(15):
        time.sleep(1)
        got = [ln for ln in dev.log_lines(since) if ln.startswith("界面返回：")]
        if got:
            return got[-1]
    print(mask("no result; log tail: %s" % dev.log_lines(since)[-8:]))
    return None


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    dev = Device(sys.argv[1], sys.argv[2])
    fails = []

    def check(ok, what, detail=""):
        print(("PASS " if ok else "FAIL ") + what + ("" if ok or not detail else "  -- " + mask(str(detail))[:300]), flush=True)
        if not ok:
            fails.append(what)

    files = {**generate(NAME), "__init__.py": try_main(NAME)}
    check("from ui_%s import show" % NAME in files["__init__.py"], "entry script read from desktop/frontend/src/ui-try.ts")
    dev.adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    created = dev.api("POST", "/projects/" + PROJECT)[0]
    check(created in (200, 409), "scratch project created or reused (409)", created)
    try:
        for path, content in files.items():
            check(dev.api("PUT", "/projects/%s/files" % PROJECT, {"path": path, "content": content})[0] == 200, "wrote " + path)
        check(dev.api("POST", "/projects/" + PROJECT)[0] == 409, "a second create answers 409 (the desktop then reuses it)")
        got = run_and_answer(dev, "开始")
        check(got == '界面返回：{"account": "abc", "notify": true}', "submit prints the defaults", got)
        got = run_and_answer(dev, "取消")
        check(got == "界面返回：null", "cancel prints null", got)
    finally:
        dev.api("POST", "/projects/%s/stop" % PROJECT, {})
        check(dev.api("DELETE", "/projects/" + PROJECT)[0] == 200, "removed _ui_try")
    print("%d failed" % len(fails) if fails else "all passed")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
