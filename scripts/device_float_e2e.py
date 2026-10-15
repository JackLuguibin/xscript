#!/usr/bin/env python3
"""Floating window (悬浮窗) on a real emulator/phone: shown in the background, hidden in the foreground.

usage: scripts/device_float_e2e.py SERIAL DEVICE_URL      e.g. emulator-5556 http://127.0.0.1:19861
(needs `adb forward` to the device API). XS_SHOTS=dir keeps screenshots.

Grants the overlay with `appops set <pkg> SYSTEM_ALERT_WINDOW`, runs a script, presses HOME and checks the
window with `dumpsys window` (title XScriptFloat, TYPE_APPLICATION_OVERLAY) and `/status` -> overlay;
taps the pill to expand it, taps 日志/打开, drags it to the other edge (snap + remembered), taps 停止 and checks the
script really stopped; checks it is hidden while the app is on screen, that "后台一直显示" shows the idle pill,
that mode "关闭" and a revoked grant show nothing, and that the stored position survives a settings round trip.
Restores the settings and the overlay grant (appops mode) it found. XS_PKG=<applicationId> XS_PACKED=1 XS_PROJECT=<name> test a packed app (its dev server must be on). Project `_float_e2e` is created and deleted on the device.
Never uninstalls or clears data.
"""
import base64, html, json, os, re, subprocess, sys, time, urllib.request

SERIAL, BASE = sys.argv[1], sys.argv[2].rstrip("/")
PKG = os.environ.get("XS_PKG", "com.xscript.app")
ADB = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
if not os.path.exists(ADB):
    ADB = "adb"
SHOTS = os.environ.get("XS_SHOTS", "")
PACKED = os.environ.get("XS_PACKED") == "1"   # packed app: run its bundled project, create/delete nothing
PROJECT = os.environ.get("XS_PROJECT", "_float_e2e")
SCRIPT = '''import time
print("FLOAT_E2E start", flush=True)
for i in range(600):
    time.sleep(1)
    if i % 5 == 0: print("tick", i, flush=True)
'''
SCRIPT_API = '''import time
from ascript.android.ui import FloatWindow
print("FLOAT_API start", flush=True)
time.sleep(4)
FloatWindow.show(-1, -1, 0.6)      # AScript: right-bottom, 60% opacity (shown even with the app on screen)
print("shown", flush=True)
time.sleep(8)
FloatWindow.hide()
print("hidden", flush=True)
time.sleep(120)
'''
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
fails = []


def adb(*a, out=False):
    r = subprocess.run([ADB, "-s", SERIAL, *a], capture_output=True)
    return r.stdout.decode("utf-8", "replace") if out else None


def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with OPENER.open(req, timeout=30) as r:
        return json.load(r)


def overlay():
    return api("GET", "/status")["overlay"]


def check(ok, name, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ((" — " + str(detail)) if detail and not ok else ""), flush=True)
    if not ok:
        fails.append(name)
    return ok


def wait(pred, secs=10, step=0.4):
    end = time.time() + secs
    while time.time() < end:
        try:
            v = pred()
            if v:
                return v
        except Exception:
            pass
        time.sleep(step)
    return None


def shot(name):
    if SHOTS:
        with open(os.path.join(SHOTS, "float_%s_%s.png" % (SERIAL.replace("emulator-", "e"), name)), "wb") as f:
            f.write(subprocess.run([ADB, "-s", SERIAL, "exec-out", "screencap", "-p"], capture_output=True).stdout)


def window_lines():
    """dumpsys lines for the overlay window (title XScriptFloat) of our package."""
    d = adb("shell", "dumpsys", "window", "windows", out=True)
    blocks = re.split(r"\n(?=  Window #)", d)
    return [b for b in blocks if "XScriptFloat" in b and PKG in b]


def window_exists():
    return bool(window_lines())


def uia_nodes():
    for _ in range(3):
        # --windows: the overlay is not the active window, a plain dump would only show the app below it
        adb("shell", "uiautomator", "dump", "--windows", "/sdcard/float-ui.xml")
        x = adb("shell", "cat", "/sdcard/float-ui.xml", out=True)
        if "<node" in x:
            break
    res = []
    for m in re.finditer(r"<node [^>]*>", x):
        n = m.group(0)
        try:
            g = lambda k: html.unescape(re.search(r'\b' + k + r'="([^"]*)"', n).group(1))
            b = list(map(int, re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n).groups()))
            res.append((g("package"), g("text"), g("content-desc"), ((b[0] + b[2]) // 2, (b[1] + b[3]) // 2)))
        except AttributeError:
            continue
    return res


def tap_overlay(label):
    for pk, t, d, (x, y) in uia_nodes():
        if pk == PKG and (label in t or label == d):
            adb("shell", "input", "tap", str(x), str(y))
            return True
    return False


def home():
    adb("shell", "input", "keyevent", "KEYCODE_HOME")


def open_app():
    adb("shell", "am", "start", "-n", PKG + "/com.xscript.app.LauncherActivity")
    # MainActivity or PackActivity: launched through the launcher alias


def main():
    st = api("GET", "/status")
    print("device", SERIAL, "sdk", st["sdk"], "version", st["version"])
    check("overlay" in st, "/status has overlay", list(st))
    if "overlay" not in st:
        return
    old = api("GET", "/settings")
    api("PUT", "/settings", {"float_on_run": True, "float_always": False})
    was = adb("shell", "appops", "get", PKG, "SYSTEM_ALERT_WINDOW", out=True)
    old_mode = (re.search(r"SYSTEM_ALERT_WINDOW: (\w+)", was) or [None, "default"])[1]
    adb("shell", "appops", "set", PKG, "SYSTEM_ALERT_WINDOW", "allow")
    ops = adb("shell", "appops", "get", PKG, "SYSTEM_ALERT_WINDOW", out=True)
    check("allow" in ops, "SYSTEM_ALERT_WINDOW granted by appops", ops.strip())
    if not PACKED:
        if PROJECT in [p["name"] if isinstance(p, dict) else p for p in api("GET", "/projects").get("projects", [])]:
            api("DELETE", "/projects/" + PROJECT)
        api("POST", "/projects/" + PROJECT, {})
        api("PUT", "/projects/%s/files" % PROJECT, {"files": [{"path": "__init__.py", "encoding": "base64", "content": base64.b64encode(SCRIPT.encode()).decode()}]})
    try:
        flow()
    finally:
        try:
            api("POST", "/projects/%s/stop" % PROJECT, {})
        except Exception:
            pass
        time.sleep(1)
        if not PACKED:
            try:
                api("DELETE", "/projects/" + PROJECT)
            except Exception:
                pass
        api("PUT", "/settings", {"float_on_run": old.get("float_on_run", True), "float_always": old.get("float_always", False)})
        if os.environ.get("XS_KEEP_GRANT") != "1":
            adb("shell", "appops", "set", PKG, "SYSTEM_ALERT_WINDOW", old_mode)


def flow():
    # 1 foreground: nothing shown, even with a running script
    open_app()
    check(wait(lambda: overlay()["app_foreground"], 10), "app is in the foreground")
    api("POST", "/projects/%s/run" % PROJECT, {})
    check(wait(lambda: api("GET", "/status")["running"], 15), "script is running")
    time.sleep(1.5)
    o = overlay()
    check(not o["visible"] and o["reason"] == "foreground", "foreground + running: overlay hidden", o)
    check(wait(lambda: not window_exists(), 5), "foreground: no XScriptFloat window in dumpsys")

    # 2 HOME: overlay appears
    home()
    check(wait(lambda: overlay()["visible"], 10), "HOME + running: overlay visible in /status", overlay())
    check(wait(window_exists, 5), "XScriptFloat window exists in dumpsys")
    wl = "\n".join(window_lines())
    check("APPLICATION_OVERLAY" in wl or "ty=2038" in wl or "type=2038" in wl, "window type is TYPE_APPLICATION_OVERLAY", wl[:300])
    o = wait(lambda: overlay() if overlay()["visible"] and "width" in overlay() else None, 5) or overlay()
    st = api("GET", "/status")
    check(o["permitted"] and o.get("width", 0) > 0 and 0 <= o["x"] <= st["width"] - o["width"] and 0 <= o["y"] <= st["height"] - o["height"], "window is fully on screen and docked", o)
    check(o["x"] == 0 or o["x"] + o["width"] == st["width"], "docked flush to a screen edge", o)
    time.sleep(3)
    shot("collapsed")
    nodes = uia_nodes()
    texts = [t for pk, t, d, _ in nodes if pk == PKG and t]
    check(any(PROJECT in t for t in texts), "pill shows the script name (uiautomator)", texts)
    check(any(re.fullmatch(r"\d+:\d\d", t) for t in texts), "pill shows the elapsed time m:ss", texts)
    t1 = [t for t in texts if re.fullmatch(r"\d+:\d\d", t)]
    time.sleep(2.2)
    t2 = [t for pk, t, d, _ in uia_nodes() if pk == PKG and re.fullmatch(r"\d+:\d\d", t)]
    check(bool(t1) and bool(t2) and t1 != t2, "timer advances", (t1, t2))

    # 3 tap pill: panel expands, then collapses
    o = overlay()
    adb("shell", "input", "tap", str(o["x"] + o["width"] // 2), str(o["y"] + 30))
    check(wait(lambda: overlay()["expanded"], 5), "tap expands the panel", overlay())
    time.sleep(0.6)
    shot("expanded")
    labels = [t for pk, t, d, _ in uia_nodes() if pk == PKG]
    check(any("停止" in t for t in labels) and any("日志" in t for t in labels) and any("打开" in t for t in labels), "panel has 停止 / 日志 / 打开", labels)
    o = overlay()
    adb("shell", "input", "tap", str(o["x"] + o["width"] // 2), str(o["y"] + 30))
    check(wait(lambda: not overlay()["expanded"], 5), "second tap collapses it", overlay())

    # 4 drag to the other edge: snaps there and is remembered
    time.sleep(1.0)
    o = overlay()
    st = api("GET", "/status")
    was_right = o["side"] == "right"
    sx, sy = o["x"] + o["width"] // 2, o["y"] + 30
    tx = 80 if was_right else st["width"] - 80
    ty = int(st["height"] * 0.35)
    adb("shell", "input", "swipe", str(sx), str(sy), str(tx), str(ty), "600")
    check(wait(lambda: overlay()["side"] == ("left" if was_right else "right"), 5), "drag snaps to the other edge", overlay())
    time.sleep(0.6)
    o = overlay()
    check((o["x"] == 0) if was_right else (o["x"] + o["width"] == st["width"]), "snapped flush to the edge", o)
    check(abs(o["y"] - (ty - 30)) < st["height"] * 0.1, "vertical position follows the drop", (o["y"], ty))
    shot("dragged")
    pos = (o["side"], o["y"])
    # position survives hide/show (foreground and back)
    open_app()
    check(wait(lambda: not overlay()["visible"], 8), "opening the app hides it again")
    check(wait(lambda: not window_exists(), 5), "dumpsys shows no window in the foreground")
    home()
    check(wait(lambda: overlay()["visible"], 10), "HOME shows it again")
    time.sleep(0.8)
    o = overlay()
    check((o["side"], o["y"]) == pos or (o["side"] == pos[0] and abs(o["y"] - pos[1]) <= 2), "position remembered after hide/show", (pos, o))

    # 5 日志 / 打开 buttons bring the app up (and hide the pill)
    adb("shell", "input", "tap", str(o["x"] + o["width"] // 2), str(o["y"] + 30))
    wait(lambda: overlay()["expanded"], 5)
    time.sleep(0.5)
    check(tap_overlay("日志"), "tap 日志")
    check(wait(lambda: overlay()["app_foreground"], 8), "日志 opens the app", overlay())
    check(wait(lambda: any(pk == PKG and t in ("运行日志", "清空") for pk, t, _, _ in uia_nodes()), 6), "日志 shows the log screen")
    shot("logs")
    check(wait(lambda: not overlay()["visible"], 5), "pill hidden while the log screen is up")
    home()
    check(wait(lambda: overlay()["visible"], 10), "HOME: visible again")

    # 6 expand, tap 停止: script stops, pill hides (mode 运行时显示)
    time.sleep(0.8)
    o = overlay()
    adb("shell", "input", "tap", str(o["x"] + o["width"] // 2), str(o["y"] + 30))
    wait(lambda: overlay()["expanded"], 5)
    time.sleep(0.5)
    check(tap_overlay("停止"), "tap 停止 in the panel")
    check(wait(lambda: not api("GET", "/status")["running"], 15), "script stopped", api("GET", "/status").get("running"))
    check(wait(lambda: not overlay()["visible"], 8), "overlay gone after the script ended", overlay())
    check(overlay()["reason"] == "idle", "reason is idle", overlay())
    check(wait(lambda: not window_exists(), 5), "no XScriptFloat window after stop")

    # 7 always mode: idle pill with 运行 button; it starts the script
    api("PUT", "/settings", {"float_always": True})
    check(wait(lambda: overlay()["visible"], 8), "后台一直显示: idle pill visible", overlay())
    time.sleep(0.8)
    shot("idle")
    o = overlay()
    adb("shell", "input", "tap", str(o["x"] + o["width"] // 2), str(o["y"] + 30))
    wait(lambda: overlay()["expanded"], 5)
    time.sleep(0.5)
    texts = [t for pk, t, d, _ in uia_nodes() if pk == PKG]
    check(any("空闲" in t for t in texts) and any("运行" in t for t in texts), "idle pill + 运行 button", texts)
    api("PUT", "/settings", {"float_always": False})
    check(wait(lambda: not overlay()["visible"], 8), "turning 后台一直显示 off hides the idle pill", overlay())

    # 8 closed mode / revoked grant: nothing, and no crash
    api("POST", "/projects/%s/run" % PROJECT, {})
    check(wait(lambda: api("GET", "/status")["running"], 15), "script running again")
    check(wait(lambda: overlay()["visible"], 10), "pill back with the run")
    api("PUT", "/settings", {"float_on_run": False})
    check(wait(lambda: not overlay()["visible"], 8), "mode 关闭: hidden", overlay())
    api("PUT", "/settings", {"float_on_run": True})
    check(wait(lambda: overlay()["visible"], 8), "mode 运行时显示: back")
    adb("shell", "appops", "set", PKG, "SYSTEM_ALERT_WINDOW", "deny")
    check(wait(lambda: overlay()["reason"] == "no_permission" and not overlay()["visible"], 8), "grant revoked: quietly hidden", overlay())
    check(api("GET", "/status")["running"], "script still runs without the overlay")
    check(not overlay()["permitted"], "/status reports permitted=false", overlay())
    adb("shell", "appops", "set", PKG, "SYSTEM_ALERT_WINDOW", "allow")
    api("POST", "/projects/%s/stop" % PROJECT, {})
    wait(lambda: not api("GET", "/status")["running"], 15)
    if not PACKED:
        scripted_api()


def scripted_api():
    """AScript FloatWindow.show(x, y, dim) / hide() called by the script itself."""
    name = PROJECT + "_api"
    api("POST", "/projects/" + name, {})
    try:
        api("PUT", "/projects/%s/files" % name, {"files": [{"path": "__init__.py", "encoding": "base64", "content": base64.b64encode(SCRIPT_API.encode()).decode()}]})
        api("PUT", "/settings", {"float_on_run": False})   # setting off: only the script's own call may show it
        open_app()
        wait(lambda: overlay()["app_foreground"], 10)
        api("POST", "/projects/%s/run" % name, {})
        check(wait(lambda: api("GET", "/status")["running"], 15), "script (FloatWindow API) running")
        check(not overlay()["visible"], "setting off: hidden until the script asks", overlay())
        check(wait(lambda: overlay()["visible"], 12), "FloatWindow.show() shows it, even in the foreground and with the setting off", overlay())
        time.sleep(0.8)
        o = overlay()
        st = api("GET", "/status")
        check(o["side"] == "right" and o["y"] + o["height"] > st["height"] * 0.85, "show(-1, -1) = right edge, bottom", o)
        shot("script_show")
        check(wait(lambda: not overlay()["visible"], 14), "FloatWindow.hide() hides it", overlay())
        check(overlay()["reason"] == "script_hidden", "reason script_hidden", overlay())
        api("POST", "/projects/%s/stop" % name, {})
        wait(lambda: not api("GET", "/status")["running"], 15)
        api("PUT", "/settings", {"float_on_run": True})
    finally:
        try:
            api("POST", "/projects/%s/stop" % name, {})
            time.sleep(1)
            api("DELETE", "/projects/" + name)
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    finally:
        pass
    print("\n%d failed" % len(fails) if fails else "\nall checks passed")
    sys.exit(1 if fails else 0)
