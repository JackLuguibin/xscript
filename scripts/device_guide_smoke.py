#!/usr/bin/env python3
"""Run the docs/十分钟上手.md sample and an OCR smoke on a device or emulator through the HTTP API.

    adb forward tcp:19860 tcp:9860
    python3 scripts/device_guide_smoke.py http://127.0.0.1:19860

The sample is read from the guide itself (its first ```python block), so the doc and this check cannot drift.
Projects are uploaded as `xs_guide_smoke` / `xs_ocr_smoke` / `xs_size_smoke` and deleted afterwards. Exits non-zero on a failure.
With ANDROID_SERIAL set it also rotates the screen to landscape (via adb) and checks that screen.size() follows, then
restores the rotation settings.
"""
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile

import devauth  # scripts/devauth.py: pairing code (XSCRIPT_TOKEN or adb)

os.environ.setdefault("no_proxy", "127.0.0.1,localhost")
base = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9860").rstrip("/")
GUIDE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "十分钟上手.md")

OCR = '''import time
from xscript.android import screen
t = time.time()
items = screen.ocr()
print("ocr items:", len(items or []), "in %.1fs" % (time.time() - t))
print("ocr found XScript:", screen.ocr_find("XScript") is not None)
'''

SIZE = '''from xscript.android import screen
print("size %d %d" % screen.size())
'''


def call(method, path, data=None, ctype=None):
    h = devauth.headers(base, {"Content-Type": ctype} if ctype else None)
    req = urllib.request.Request(base + path, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
    return json.loads(body) if body else {}


def run(name, source, wait=60, quiet=False):
    """Upload `source` as project `name`, run it and return its log lines (printed unless `quiet`)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("__init__.py", source)
    q = urllib.parse.quote(name)
    call("PUT", "/projects/%s/zip" % q, buf.getvalue(), "application/zip")
    call("DELETE", "/logs")
    r = call("POST", "/projects/%s/run" % q)
    assert r.get("running"), r
    lines, since, end = [], 0, time.time() + wait
    while time.time() < end:
        got = call("GET", "/logs?since=%d" % since)
        for e in got.get("entries", []):
            lines.append(e["line"].rstrip())
        since = got.get("next", since)
        if any(("finished " + name) in s or ("error" in s.lower() and "xscript:" in s) for s in lines):
            break
        time.sleep(1)
    call("DELETE", "/projects/%s" % q)
    if not quiet:
        for s in lines:
            print("   ", s)
    return lines


def main():
    sample = re.search(r"```python\n(.*?)```", open(GUIDE, encoding="utf-8").read(), re.S).group(1)
    st = call("GET", "/status")
    lines = run("xs_guide_smoke", sample)
    size = next((s for s in lines if s.startswith("屏幕大小")), None)
    assert size, "the guide sample printed no screen size"
    w, h = (int(x) for x in size.split()[1:3])
    assert (w, h) == (st["width"], st["height"]), (size, st["width"], st["height"])
    assert any("设置" in s for s in lines[lines.index(size) + 1:]), "the guide sample printed neither branch"
    assert any("finished xs_guide_smoke" in s for s in lines), "the guide sample did not finish"
    print("ok  guide sample")

    lines = run("xs_ocr_smoke", OCR, wait=120)
    n = next((s for s in lines if s.startswith("ocr items:")), "")
    assert n and int(n.split()[2]) > 0, "OCR read nothing: " + n
    assert any("finished xs_ocr_smoke" in s for s in lines), "the OCR smoke did not finish"
    print("ok  ocr smoke")

    if os.environ.get("ANDROID_SERIAL"):
        check_landscape()


def adb_shell(cmd):
    return subprocess.run(["adb", "-s", os.environ["ANDROID_SERIAL"], "shell", cmd], capture_output=True, text=True, timeout=60).stdout.strip()


def script_size():
    lines = run("xs_size_smoke", SIZE, wait=30)
    got = next((s for s in lines if s.startswith("size ")), None)
    assert got, "screen.size() printed nothing"
    return tuple(int(x) for x in got.split()[1:3])


def check_landscape():
    """screen.size() and /status report the rotated size once the display turns to landscape."""
    auto = adb_shell("settings get system accelerometer_rotation")
    rot = adb_shell("settings get system user_rotation")
    try:
        adb_shell("am start -a android.settings.SETTINGS")  # the launcher stays portrait; Settings rotates
        adb_shell("settings put system accelerometer_rotation 0; settings put system user_rotation 0")
        time.sleep(2)
        pw, ph = script_size()
        assert pw < ph, ("portrait", pw, ph)
        adb_shell("settings put system user_rotation 1")
        for _ in range(10):
            time.sleep(1)
            st = call("GET", "/status")
            if st["width"] > st["height"]:
                break
        lw, lh = script_size()
        assert (lw, lh) == (ph, pw) == (st["width"], st["height"]), ("landscape", (lw, lh), (pw, ph), st)
        print("ok  landscape     %dx%d -> %dx%d" % (pw, ph, lw, lh))
    finally:
        adb_shell("settings put system user_rotation %s" % (rot if rot.isdigit() else 0))
        adb_shell("settings put system accelerometer_rotation %s" % (auto if auto.isdigit() else 1))
        adb_shell("input keyevent HOME")


if __name__ == "__main__":
    main()
