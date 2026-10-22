#!/usr/bin/env python3
"""Projects list (小程序列表) and run log (运行日志) benchmarks on a disposable emulator; soft (warnings only).

usage: device_screens.py <serial> <device-api-base> [pkg]
  e.g. ANDROID_SERIAL run in scripts/ci_emulator_checks.sh: device_screens.py emulator-5554 http://127.0.0.1:19860

1. projects: creates XS_BENCH_PROJECTS (default 40) xs_pb_NNN projects of 30 small files, opens 小程序列表 from the home
   screen 5 times (ActivityTaskManager "Displayed" time) and scrolls it (gfxinfo janky %).
2. run log: opens 日志, runs a project printing XS_BENCH_RATE (default 500) lines/s, waits until the log is past its cap,
   then measures 20 s of gfxinfo.
Results go to stdout and $GITHUB_STEP_SUMMARY; a value over its budget prints a ::warning:: (exit code stays 0 unless
the screens could not be reached). Temporary projects are deleted at the end.
"""
import json
import os
import re
import statistics
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import devauth  # noqa: E402  pairing code (XSCRIPT_TOKEN or adb), never printed

SERIAL, BASE = sys.argv[1], sys.argv[2].rstrip("/")
PKG = sys.argv[3] if len(sys.argv) > 3 else "com.xscript.app"
N_PROJ = int(os.environ.get("XS_BENCH_PROJECTS", "40"))
RATE = int(os.environ.get("XS_BENCH_RATE", "500"))
# budgets for the CI emulator (software GPU, so frame numbers are much worse than on a phone); warnings only
BUDGET = {"open_ms": int(os.environ.get("XS_BUDGET_OPEN_MS", "2500")),
          "proj_jank": float(os.environ.get("XS_BUDGET_PROJ_JANK", "60")),
          "log_jank": float(os.environ.get("XS_BUDGET_LOG_JANK", "60"))}
LOG_PROJECT = "xs_bench_log"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def adb(*a, check=True):
    return subprocess.run(["adb", "-s", SERIAL, *a], capture_output=True, text=True, check=check).stdout


def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers=devauth.headers(BASE, {"Content-Type": "application/json"}, serial=SERIAL))
    with OPENER.open(req, timeout=60) as r:
        return r.read()


def find_text(text):
    adb("shell", "uiautomator", "dump", "/sdcard/xs-bench.xml", check=False)
    xml = adb("shell", "cat", "/sdcard/xs-bench.xml", check=False)  # parsed in memory only, never printed
    adb("shell", "rm", "-f", "/sdcard/xs-bench.xml", check=False)
    return re.search(r'text="%s"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"' % re.escape(text), xml)


def tap_text(text):
    for _ in range(3):
        m = find_text(text)
        if m:
            a, b, c, d = map(int, m.groups())
            adb("shell", "input", "tap", str((a + c) // 2), str((b + d) // 2))
            return
        time.sleep(1)
    raise SystemExit("bench: %r not found on screen" % text)


def home():
    """The app's home screen: starting LauncherActivity only brings the task forward, so back out of whatever screen
    an earlier check (or run) left on top first."""
    for _ in range(5):
        adb("shell", "am", "start", "-W", "-n", PKG + "/com.xscript.app.LauncherActivity")
        time.sleep(2)
        if find_text("小程序列表"):
            return
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(1)
    raise SystemExit("bench: could not reach the home screen")


def gfx_reset():
    adb("shell", "dumpsys", "gfxinfo", PKG, "reset")


def gfx():
    out = adb("shell", "dumpsys", "gfxinfo", PKG)
    total = int((re.search(r"Total frames rendered: (\d+)", out) or [0, 0])[1])
    jank = float((re.search(r"Janky frames: \d+ \(([\d.]+)%\)", out) or [0, 0])[1])
    p90 = (re.search(r"90th percentile: (\d+)ms", out) or [0, "?"])[1]
    return total, jank, p90


def top_is(activity):
    return ("ACTIVITY %s/com.xscript.app.ui.%s" % (PKG, activity)) in adb("shell", "dumpsys", "activity", "top")


def wait_top(activity, timeout=20):
    """The CI emulator renders in software, so a screen can take several seconds to come up."""
    end = time.time() + timeout
    while time.time() < end:
        if top_is(activity):
            return True
        time.sleep(1)
    return False


def bench_projects():
    for i in range(N_PROJ):
        files = [{"path": "__init__.py", "content": "print('hi')\n"}] + \
                [{"path": "lib/m%d/f%d.py" % (j // 10, j), "content": "X = %d\n" % j} for j in range(29)]
        api("PUT", "/projects/xs_pb_%03d/files" % i, {"files": files})
    times = []
    try:
        for k in range(5):
            home()
            adb("logcat", "-c")
            tap_text("小程序列表")
            if not wait_top("ProjectsActivity"):
                raise SystemExit("bench: 小程序列表 did not open")
            time.sleep(1)
            log = adb("logcat", "-d", "-s", "ActivityTaskManager")
            m = re.search(r"Displayed %s/com\.xscript\.app\.ui\.ProjectsActivity[^+]*\+(?:(\d+)s)?(\d+)ms" % re.escape(PKG), log)
            if m:
                times.append(int(m[1] or 0) * 1000 + int(m[2]))
            if k < 4:
                adb("shell", "input", "keyevent", "KEYCODE_BACK")
                time.sleep(1)
        if not top_is("ProjectsActivity"):
            raise SystemExit("bench: 小程序列表 did not open")
        gfx_reset()
        for a, b in [(1900, 500)] * 4 + [(500, 1900)] * 4:
            adb("shell", "input", "swipe", "540", str(a), "540", str(b), "300")
            time.sleep(0.7)
        frames, jank, p90 = gfx()
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
    finally:
        for i in range(N_PROJ):
            try:
                api("DELETE", "/projects/xs_pb_%03d" % i)
            except Exception as e:  # noqa: BLE001 - cleanup is best effort, report it
                print("bench: could not delete xs_pb_%03d: %s" % (i, e))
    return times, frames, jank, p90


def bench_log():
    src = ("import time\ni = 0\nwhile True:\n    for _ in range(%d):\n        i += 1\n"
           "        print(\"line %%06d the quick brown fox jumps over the lazy dog 0123456789\" %% i, flush=True)\n"
           "    time.sleep(0.1)\n") % max(1, RATE // 10)
    api("PUT", "/projects/%s/files" % LOG_PROJECT, {"path": "__init__.py", "content": src})
    try:
        home()
        tap_text("日志")
        if not wait_top("LogActivity"):
            raise SystemExit("bench: 运行日志 did not open")
        api("POST", "/projects/%s/run" % LOG_PROJECT)
        time.sleep(30)  # past the log's line cap, so trimming is part of what is measured
        gfx_reset()
        time.sleep(20)
        return gfx()
    finally:
        try:
            api("POST", "/projects/%s/stop" % LOG_PROJECT)
            adb("shell", "input", "keyevent", "KEYCODE_BACK")
        except Exception:  # noqa: BLE001
            pass
        api("DELETE", "/projects/%s" % LOG_PROJECT)


def main():
    rows, warns = [], []
    times, frames, jank, p90 = bench_projects()
    med = statistics.median(times) if times else None
    rows.append(("小程序列表 open (%d projects), median of %d" % (N_PROJ, len(times)), "%s ms" % med, "%d ms" % BUDGET["open_ms"]))
    rows.append(("小程序列表 scroll janky (%d frames, p90 %s ms)" % (frames, p90), "%.1f%%" % jank, "%.0f%%" % BUDGET["proj_jank"]))
    if med is None or med > BUDGET["open_ms"]:
        warns.append("小程序列表 open %s ms (budget %d)" % (med, BUDGET["open_ms"]))
    if jank > BUDGET["proj_jank"]:
        warns.append("小程序列表 scroll janky %.1f%% (budget %.0f%%)" % (jank, BUDGET["proj_jank"]))
    frames, jank, p90 = bench_log()
    rows.append(("运行日志 at %d lines/s janky (%d frames, p90 %s ms)" % (RATE, frames, p90), "%.1f%%" % jank, "%.0f%%" % BUDGET["log_jank"]))
    if jank > BUDGET["log_jank"]:
        warns.append("运行日志 janky %.1f%% (budget %.0f%%)" % (jank, BUDGET["log_jank"]))
    md = "### Device screen benchmarks (soft)\n\n| measure | value | budget |\n|---|---|---|\n" + \
         "".join("| %s | %s | %s |\n" % r for r in rows)
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md + "\n")
    for w in warns:
        print("::warning title=Device screen benchmark::%s" % w)


if __name__ == "__main__":
    main()
