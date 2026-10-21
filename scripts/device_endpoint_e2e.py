#!/usr/bin/env python3
"""Drive the home screen's 开发者地址 row through its states on a disposable, root-capable emulator.

    ANDROID_SERIAL=emulator-5556 python3 scripts/device_endpoint_e2e.py com.xscript.app.perf

Checks, reading the row's text with uiautomator:
  RUNNING        http://<ip>:<port>/
  NO_FREE_PORT   10 listeners on 9860–9869  -> "端口 9860–9869 都被占用，点此重试"; tap after freeing -> RUNNING
  NOT_STARTED    `am stopservice`           -> "服务未启动，点此启动"; tap -> RUNNING
  USB only       Wi-Fi off, eth0 address removed -> "127.0.0.1:<port>（仅 USB）"; tap -> dialog with the adb forward command
(DISABLED only happens in packaged apps; HomeModelTest covers it.)

It force-stops the app, needs `adb root` (google_apis images) and turns networking off for a while, so it refuses to
run without an explicit ANDROID_SERIAL: never point it at a device whose data matters. Networking is restored at the end.
"""
import os
import re
import subprocess
import sys
import time

serial = os.environ.get("ANDROID_SERIAL")
if not serial or len(sys.argv) < 2:
    raise SystemExit(__doc__)
pkg = sys.argv[1]
adb_bin = os.path.join(os.environ.get("ANDROID_HOME", os.path.expanduser("~/Library/Android/sdk")), "platform-tools", "adb")
if not os.path.isfile(adb_bin):
    adb_bin = "adb"


def adb(*args, check=False):
    return subprocess.run([adb_bin, "-s", serial, *args], capture_output=True, text=True, timeout=60, check=check).stdout


def sh(cmd):
    return adb("shell", cmd)


def launch(restart=True):
    if restart:
        sh("am force-stop " + pkg)
    sh("am start -n %s/com.xscript.app.LauncherActivity" % pkg)


def row(timeout=12, want=None):
    """(text, centre) of the value next to 开发者地址, polling until it matches `want` (a regex)."""
    end = time.time() + timeout
    text, centre = "", None
    while time.time() < end:
        sh("uiautomator dump /sdcard/xs_endpoint.xml")
        xml = sh("cat /sdcard/xs_endpoint.xml")
        nodes = re.findall(r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
        for i, n in enumerate(nodes):
            if n[0] == "开发者地址" and i + 1 < len(nodes):
                t, x1, y1, x2, y2 = nodes[i + 1]
                text, centre = t, ((int(x1) + int(x2)) // 2, (int(y1) + int(y2)) // 2)
        if text and (want is None or re.search(want, text)):
            return text, centre
        time.sleep(1)
    raise AssertionError("开发者地址 shows %r, expected /%s/" % (text, want))


def tap(centre):
    sh("input tap %d %d" % centre)


def check(name, want, **kw):
    text, centre = row(want=want, **kw)
    print("ok  %-14s %s" % (name, text))
    return centre


if adb("root").find("cannot") >= 0:
    raise SystemExit("needs adb root (use a google_apis emulator image)")
time.sleep(2)
adb("wait-for-device")
a11y = sh("settings get secure enabled_accessibility_services").strip()
try:
    launch()
    check("RUNNING", r"^http://[\d.]+:986\d/$")

    sh("am force-stop " + pkg)  # frees the app's port before the listeners take them all
    time.sleep(1)
    sh("for p in $(seq 9860 9869); do nohup toybox nc -L -s 0.0.0.0 -p $p cat >/dev/null 2>&1 & done")
    time.sleep(1)
    launch(restart=False)
    c = check("NO_FREE_PORT", "都被占用")
    sh("pkill -f 'nc -L'")
    time.sleep(1)
    tap(c)
    check("retry→RUNNING", r"^http://")

    sh("am stopservice -n %s/com.xscript.app.http.DeviceHttpService" % pkg)
    sh("input keyevent HOME")
    launch(restart=False)
    c = check("NOT_STARTED", "服务未启动")
    tap(c)
    check("start→RUNNING", r"^http://")

    sh("svc wifi disable")
    # Android re-adds eth0's address, so keep removing it while the app looks.
    sh("rm -f /data/local/tmp/xs_net_on; nohup sh -c 'for i in $(seq 1 120); do [ -e /data/local/tmp/xs_net_on ] && break; "
       "ip link set eth0 down; ip addr flush dev eth0; sleep 0.5; done' >/dev/null 2>&1 &")
    time.sleep(2)
    launch()
    c = check("USB only", r"^127\.0\.0\.1:986\d（仅 USB）$")
    tap(c)
    time.sleep(1.5)
    sh("uiautomator dump /sdcard/xs_endpoint.xml")
    dlg = sh("cat /sdcard/xs_endpoint.xml")
    assert "复制命令" in dlg and "adb forward tcp:986" in dlg, "tapping the USB-only row shows the adb forward dialog"
    print("ok  USB dialog     adb forward command shown")
    sh("input keyevent BACK")
finally:
    sh("pkill -f 'nc -L'; touch /data/local/tmp/xs_net_on")
    time.sleep(1.5)  # let the address-removing loop see the marker and exit
    sh("ip link set eth0 up; svc wifi enable")
    if a11y and a11y != "null":  # force-stop switches the accessibility service off
        sh("settings put secure enabled_accessibility_services " + a11y)
        sh("settings put secure accessibility_enabled 1")
    launch(restart=False)
print("all endpoint states ok")
