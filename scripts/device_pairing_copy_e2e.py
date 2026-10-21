#!/usr/bin/env python3
"""The home screen's 配对码 dialog: 复制配对码 puts the current code on the clipboard. The code is never printed.

    ANDROID_SERIAL=emulator-5556 python3 scripts/device_pairing_copy_e2e.py com.xscript.app.perf http://127.0.0.1:19860

Taps the value next to 配对码, then 复制配对码 in the dialog, reads the clipboard with an on-device script (through the
HTTP API, its log lines are not echoed) and compares it with the code from the app's USB-only pairing socket
(scripts/devauth.py, read directly even when this computer is already paired), ignoring the display dashes. Prints only whether they match. Refuses to run without ANDROID_SERIAL.
"""
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import devauth  # noqa: E402
import device_guide_smoke as api  # noqa: E402

serial = os.environ.get("ANDROID_SERIAL")
if not serial or len(sys.argv) < 3:
    raise SystemExit(__doc__)
pkg, api.base = sys.argv[1], sys.argv[2].rstrip("/")


def sh(cmd):
    return subprocess.run(["adb", "-s", serial, "shell", cmd], capture_output=True, text=True, timeout=60).stdout


def centre(label, after=False, timeout=12):
    """Centre of the node with text `label` (after=True: of the node right after it, i.e. the row's value)."""
    end = time.time() + timeout
    while time.time() < end:
        sh("uiautomator dump /sdcard/xs_pair.xml")
        nodes = re.findall(r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', sh("cat /sdcard/xs_pair.xml"))
        for i, n in enumerate(nodes):
            if n[0] == label and (not after or i + 1 < len(nodes)):
                _, x1, y1, x2, y2 = nodes[i + 1] if after else n
                return (int(x1) + int(x2)) // 2, (int(y1) + int(y2)) // 2
        time.sleep(1)
    raise AssertionError("no %r on screen" % label)


def norm(code):
    return re.sub(r"[^A-Za-z0-9]", "", code or "").upper()


status = api.call("GET", "/status")
if not status.get("pairing"):
    print("SKIP copy pairing code: pairing is switched off on this device")
    sys.exit(0)
# straight from the USB-only socket: devauth.token() returns nothing once this computer is already paired
expected = norm(devauth._from_adb(str(status.get("app_id") or pkg), serial))
assert expected, "the pairing socket did not answer"
sh("am start -n %s/com.xscript.app.LauncherActivity" % pkg)
time.sleep(2)
x, y = centre("配对码", after=True)
sh("input tap %d %d" % (x, y))
x, y = centre("复制配对码")
sh("input tap %d %d" % (x, y))
time.sleep(1)
lines = api.run("xs_pair_clip", "from xscript.android import system\nprint('clip=' + system.clipboard_get())\n", wait=30, quiet=True)
got = next((s[len("clip="):] for s in lines if s.startswith("clip=")), None)
sh("rm -f /sdcard/xs_pair.xml")
assert got is not None, "the clipboard script printed nothing"
assert norm(got) == expected, "the clipboard does not hold the pairing code (lengths %d / %d)" % (len(norm(got)), len(expected))
assert re.fullmatch(r"[A-Z0-9]{4}(-[A-Z0-9]{4})+", got.strip()), "copied in the dashed display form"
print("ok  copy pairing code   clipboard matches the pairing code (not shown)")
