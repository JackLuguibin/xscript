#!/usr/bin/env python3
"""Floating window (悬浮窗) on a real emulator/phone: shown in the background, hidden in the foreground.

usage: scripts/device_float_e2e.py SERIAL DEVICE_URL      e.g. emulator-5556 http://127.0.0.1:19861
(needs `adb forward` to the device API). XS_SHOTS=dir keeps screenshots.

Grants the overlay with `appops set <pkg> SYSTEM_ALERT_WINDOW`, runs a script, presses HOME and checks the
window with `dumpsys window` (title XScriptFloat, TYPE_APPLICATION_OVERLAY) and `/status` -> overlay;
taps the pill to expand it, taps 日志/打开/隐藏, drags it to the other edge (snap + remembered, never over the
status / navigation bar), taps 停止 and checks the script really stopped; checks the idle ball (small, dimmed), the
48dp touch targets, the error flash after a failed run, FloatWindow.add_menu buttons (tap → script callback, 
remove_system), per-orientation position, rebuild after a font-size / dark-mode change and the ticker's CPU use;
checks it is hidden while the app is on screen, that "后台一直显示" shows the idle pill, that mode "关闭" and a
revoked grant show nothing, and that the stored position survives a settings round trip.
Restores the settings and the overlay grant (appops mode) it found. XS_ONLY=<section> runs one section. XS_PKG=<applicationId> XS_PACKED=1 XS_PROJECT=<name> test a packed app (its dev server must be on). Project `_float_e2e` is created and deleted on the device.
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
time.sleep(13)
FloatWindow.hide()
print("hidden", flush=True)
time.sleep(120)
'''
SCRIPT_ERR = '''import time
print("FLOAT_ERR start", flush=True)
time.sleep(6)
raise RuntimeError("boom for the float test")
'''
SCRIPT_OK = '''import time
print("FLOAT_OK start", flush=True)
time.sleep(6)
'''
SCRIPT_MENU = '''import time
from ascript.android.ui import FloatWindow
def hello():
    print("MENU_HELLO_CLICKED", flush=True)
def bye(menu_id):
    print("MENU_BYE_CLICKED " + menu_id, flush=True)
FloatWindow.add_menu("hello", "", hello)
FloatWindow.add_menu("bye", "", bye%s)
print("FLOAT_MENU start", flush=True)
time.sleep(300)
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
            res.append((g("package"), g("text"), g("content-desc"), ((b[0] + b[2]) // 2, (b[1] + b[3]) // 2), tuple(b)))
        except AttributeError:
            continue
    return res


def tap_overlay(label):
    """Tap the overlay node whose content description (or text) is exactly `label`."""
    for pk, t, d, (x, y), _b in uia_nodes():
        if pk == PKG and (label == d or label == t):
            adb("shell", "input", "tap", str(x), str(y))
            return True
    return False


def dp(v):
    """dp → px for this device."""
    global DENSITY
    if not DENSITY:
        m = re.search(r"(\d+)\s*$", adb("shell", "wm", "density", out=True).strip().splitlines()[-1])
        DENSITY = int(m.group(1)) if m else 420
    return int(round(v * DENSITY / 160.0))


DENSITY = 0


def tap_head():
    """Tap the header row (works for ball, pill and panel)."""
    o = overlay()
    adb("shell", "input", "tap", str(o["x"] + o["width"] // 2), str(o["y"] + dp(26)))


def to_mode(target, secs=8):
    """Tap until the window is in `target` (ball / pill / panel). ball → panel → pill → panel …"""
    end = time.time() + secs
    while time.time() < end:
        s = overlay().get("state")
        if s == target:
            return True
        if s is None:
            return False
        tap_head()
        time.sleep(0.7)
    return overlay().get("state") == target


def node_texts():
    return [t for pk, t, d, _c, _b in uia_nodes() if pk == PKG and t]


BTN_STOP = "停止脚本"
BTN_RUN = "运行脚本"
BTN_LOG = "查看日志"
BTN_OPEN = "打开应用"
BTN_HIDE = "隐藏悬浮窗，下次运行或打开应用后再出现"
BTN_DESCS = (BTN_STOP, BTN_LOG, BTN_OPEN, BTN_HIDE)


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
        # XS_ONLY=orientation|menus|menu_icon|error_flash|appearance|cpu_ticks|scripted_api runs just that section
        only = os.environ.get("XS_ONLY")
        if only:
            home()
            for name in only.split(","):
                globals()[name]()
        else:
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


def make_project(name, code):
    if name in [p["name"] if isinstance(p, dict) else p for p in api("GET", "/projects").get("projects", [])]:
        api("DELETE", "/projects/" + name)
    api("POST", "/projects/" + name, {})
    api("PUT", "/projects/%s/files" % name, {"files": [{"path": "__init__.py", "encoding": "base64", "content": base64.b64encode(code.encode()).decode()}]})


def script_gone(secs=15):
    """The :script process is really gone (a new run right after a stop can otherwise be lost on a slow device)."""
    return wait(lambda: not adb("shell", "pidof", PKG + ":script", out=True).strip(), secs)


def drop_project(name):
    try:
        if api("GET", "/status")["running"]:
            api("POST", "/projects/%s/stop" % name, {})
            wait(lambda: not api("GET", "/status")["running"], 15)
        script_gone()
        api("DELETE", "/projects/" + name)
    except Exception:
        pass


def stop_running():
    try:
        api("POST", "/projects/%s/stop" % PROJECT, {})
    except Exception:
        pass
    wait(lambda: not api("GET", "/status")["running"], 15)


def run_in_background(name):
    """Start `name` with the app in the foreground, then go HOME."""
    open_app()
    wait(lambda: overlay()["app_foreground"], 10)
    script_gone()
    r = api("POST", "/projects/%s/run" % name, {})
    ok = wait(lambda: api("GET", "/status")["running"], 15)
    if not ok:
        print("INFO run did not start:", r, api("GET", "/status").get("running"), flush=True)
    home()
    return ok


def full(o):
    return {"width": o["screen_width"], "height": o["screen_height"]}


def inside_safe_area(o, st=None):
    """`st` is unused; the overlay reports the full screen size it places itself in (/status width/height exclude the nav bar)."""
    i = o["insets"]
    W, H = o["screen_width"], o["screen_height"]
    return (o["x"] >= i["left"] and o["x"] + o["width"] <= W - i["right"]
            and o["y"] >= i["top"] and o["y"] + o["height"] <= H - i["bottom"])


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

    # 2 HOME: overlay appears as the readable pill
    home()
    check(wait(lambda: overlay()["visible"], 10), "HOME + running: overlay visible in /status", overlay())
    t_shown = time.time()
    check(wait(window_exists, 5), "XScriptFloat window exists in dumpsys")
    wl = "\n".join(window_lines())
    check("APPLICATION_OVERLAY" in wl or "ty=2038" in wl or "type=2038" in wl, "window type is TYPE_APPLICATION_OVERLAY", wl[:300])
    o = wait(lambda: overlay() if overlay()["visible"] and "width" in overlay() else None, 5) or overlay()
    st = full(o)
    check(o["state"] == "pill", "a new window starts as the pill (name readable)", o)
    check(o["permitted"] and o.get("width", 0) > 0 and inside_safe_area(o, st), "window is on screen, outside status/navigation bars", (o, st["width"], st["height"]))
    i = o["insets"]
    check(o["x"] == i["left"] or o["x"] + o["width"] == st["width"] - i["right"], "docked flush to a screen edge (inside the insets)", o)
    check(o["insets"]["top"] > 0, "/status reports the top inset (status bar)", o["insets"])
    check(o["height"] >= dp(48) - 1, "pill is at least 48dp tall", (o["height"], dp(48)))
    nodes = uia_nodes()
    texts = [t for pk, t, d, _c, _b in nodes if pk == PKG and t]
    descs = [d for pk, t, d, _c, _b in nodes if pk == PKG and d]
    check(any(PROJECT in t for t in texts), "pill shows the script name (uiautomator)", texts)
    check(any(re.fullmatch(r"\d+:\d\d", t) for t in texts), "pill shows the elapsed time m:ss", texts)
    check(any("运行中" in d and PROJECT in d and "已运行" in d for d in descs), "pill content description is spoken state + name + time", descs)
    shot("pill")
    t1 = [t for t in texts if re.fullmatch(r"\d+:\d\d", t)]
    time.sleep(2.2)
    t2 = [t for t in node_texts() if re.fullmatch(r"\d+:\d\d", t)]
    check(bool(t1) and bool(t2) and t1 != t2, "timer advances", (t1, t2))

    # 3 idle: shrinks to a dimmed 48dp ball at the same edge
    check(wait(lambda: overlay()["state"] == "ball", 12), "after ~5 s idle the pill shrinks to the ball", overlay())
    check(time.time() - t_shown >= 4, "…not earlier than the idle delay", time.time() - t_shown)
    time.sleep(0.5)
    o = overlay()
    check(abs(o["width"] - dp(48)) <= 2 and abs(o["height"] - dp(48)) <= 2, "ball is 48dp x 48dp (touch target)", (o["width"], o["height"], dp(48)))
    check(o["alpha"] < 0.7, "ball is dimmed", o)
    check(inside_safe_area(o, st) and (o["x"] == i["left"] or o["x"] + o["width"] == st["width"] - i["right"]), "ball stays docked at the edge", o)
    shot("ball")
    check(any(re.fullmatch(r"\d+:\d\d", t) for t in node_texts()), "ball shows the elapsed time")

    # 4 tap ball → panel (full opacity, buttons), tap again → pill
    check(to_mode("panel"), "tap on the ball opens the panel", overlay())
    time.sleep(0.5)
    o = overlay()
    check(o["alpha"] >= 0.99, "panel is fully opaque", o)
    shot("panel")
    nodes = uia_nodes()
    buttons = {d: b for pk, t, d, _c, b in nodes if pk == PKG and d in BTN_DESCS}
    check(set(buttons) == set(BTN_DESCS), "panel has 停止 / 日志 / 打开 / 隐藏 (icon buttons)", list(buttons))
    small = {t: (b[2] - b[0], b[3] - b[1]) for t, b in buttons.items() if b[3] - b[1] < dp(48) - 1 or b[2] - b[0] < dp(48) - 1}
    check(not small, "every panel button is at least 48dp x 48dp", small)
    labels = [(t, c) for pk, t, d, c, b in nodes if pk == PKG and t in ("停止", "日志", "打开", "隐藏")]
    inside = [t for t, (cx, cy) in labels for b in buttons.values() if b[0] <= cx <= b[2] and b[1] <= cy <= b[3]]
    check(sorted(inside) == sorted(["停止", "日志", "打开", "隐藏"]), "each button shows its label inside its own bounds", labels)
    gaps = sorted(((b[0] + b[2]) // 2) for b in buttons.values())
    steps = [gaps[i + 1] - gaps[i] for i in range(len(gaps) - 1)]
    check(steps and max(steps) - min(steps) <= 3, "buttons are evenly spaced", steps)
    check(inside_safe_area(overlay(), st), "panel fits inside the safe area", overlay())
    check(to_mode("pill"), "tap on the header collapses the panel to the pill", overlay())

    # 5 drag to the other edge: snaps there and is remembered; never over the bars
    time.sleep(0.5)
    o = overlay()
    was_right = o["side"] == "right"
    sx, sy = o["x"] + o["width"] // 2, o["y"] + dp(26)
    tx = 80 if was_right else st["width"] - 80
    ty = int(st["height"] * 0.35)
    adb("shell", "input", "swipe", str(sx), str(sy), str(tx), str(ty), "600")
    check(wait(lambda: overlay()["side"] == ("left" if was_right else "right"), 5), "drag snaps to the other edge", overlay())
    time.sleep(0.7)
    o = overlay()
    check((o["x"] == i["left"]) if was_right else (o["x"] + o["width"] == st["width"] - i["right"]), "snapped flush to the edge", o)
    check(abs(o["y"] - (ty - dp(26))) < st["height"] * 0.1, "vertical position follows the drop", (o["y"], ty))
    shot("dragged")
    # extremes: dropped on the status bar / navigation bar → pulled inside
    o = overlay()
    adb("shell", "input", "swipe", str(o["x"] + o["width"] // 2), str(o["y"] + dp(26)), str(o["x"] + o["width"] // 2), "2", "500")
    time.sleep(0.9)
    o = overlay()
    check(o["y"] == o["insets"]["top"], "dropped on the status bar: rests below it", (o["y"], o["insets"]))
    shot("top")
    adb("shell", "input", "swipe", str(o["x"] + o["width"] // 2), str(o["y"] + dp(26)), str(o["x"] + o["width"] // 2), str(st["height"] - 2), "500")
    time.sleep(0.9)
    o = overlay()
    check(o["y"] + o["height"] == st["height"] - o["insets"]["bottom"], "dropped on the navigation bar: rests above it", (o, st["height"]))
    shot("bottom")
    # back to a mid-screen spot for the rest
    adb("shell", "input", "swipe", str(o["x"] + o["width"] // 2), str(o["y"] + dp(26)), str(o["x"] + o["width"] // 2), str(ty), "500")
    time.sleep(0.9)
    o = overlay()
    pos = (o["side"], o["y"])
    # position survives hide/show (foreground and back); the new window is the readable pill again
    open_app()
    check(wait(lambda: not overlay()["visible"], 8), "opening the app hides it again")
    check(wait(lambda: not window_exists(), 5), "dumpsys shows no window in the foreground")
    home()
    check(wait(lambda: overlay()["visible"], 10), "HOME shows it again")
    time.sleep(0.8)
    o = overlay()
    check((o["side"], o["y"]) == pos or (o["side"] == pos[0] and abs(o["y"] - pos[1]) <= 2), "position remembered after hide/show", (pos, o))
    check(o["state"] == "pill", "re-shown window is a pill again, not a ball", o)

    # 6 日志 / 打开 buttons bring the app up (and hide the window)
    check(to_mode("panel"), "panel open (for 日志)")
    time.sleep(0.4)
    check(tap_overlay(BTN_LOG), "tap 日志")
    check(wait(lambda: overlay()["app_foreground"], 8), "日志 opens the app", overlay())
    check(wait(lambda: any(pk == PKG and t in ("运行日志", "清空") for pk, t, _, _c, _b in uia_nodes()), 6), "日志 shows the log screen")
    shot("logs")
    check(wait(lambda: not overlay()["visible"], 5), "window hidden while the log screen is up")
    home()
    check(wait(lambda: overlay()["visible"], 10), "HOME: visible again")

    # 7 隐藏: gone until the next run / opening the app, script keeps running
    check(to_mode("panel"), "panel open (for 隐藏)")
    time.sleep(0.4)
    check(tap_overlay(BTN_HIDE), "tap 隐藏")
    check(wait(lambda: not overlay()["visible"], 5) and overlay()["reason"] == "user_hidden", "隐藏 hides it (reason user_hidden)", overlay())
    check(wait(lambda: not window_exists(), 5), "no XScriptFloat window after 隐藏")
    time.sleep(2.5)
    check(not overlay()["visible"] and api("GET", "/status")["running"], "stays hidden while the script keeps running", overlay())
    open_app()
    wait(lambda: overlay()["app_foreground"], 8)
    home()
    check(wait(lambda: overlay()["visible"], 10), "opening the app brings it back after 隐藏", overlay())

    # 8 expand, tap 停止: script stops, window hides (mode 运行时显示), no error flash for a user stop
    time.sleep(0.5)
    check(to_mode("panel"), "panel open (for 停止)")
    time.sleep(0.4)
    check(tap_overlay(BTN_STOP), "tap 停止 in the panel")
    check(wait(lambda: not api("GET", "/status")["running"], 15), "script stopped", api("GET", "/status").get("running"))
    seen_error = bool(wait(lambda: overlay()["error"], 2))
    check(wait(lambda: not overlay()["visible"], 8), "window gone after the script ended", overlay())
    check(not seen_error, "a user stop is not flagged as an error")
    check(overlay()["reason"] == "idle", "reason is idle", overlay())
    check(wait(lambda: not window_exists(), 5), "no XScriptFloat window after stop")

    # 9 always mode: idle pill with 运行 button
    api("PUT", "/settings", {"float_always": True})
    check(wait(lambda: overlay()["visible"], 8), "后台一直显示: idle pill visible", overlay())
    time.sleep(0.8)
    shot("idle")
    check(to_mode("panel"), "panel open in idle")
    time.sleep(0.4)
    texts = node_texts()
    check(any("空闲" in t for t in texts) and any("运行" in t for t in texts), "idle pill + 运行 button", texts)
    api("PUT", "/settings", {"float_always": False})
    check(wait(lambda: not overlay()["visible"], 8), "turning 后台一直显示 off hides the idle window", overlay())

    # 10 closed mode / revoked grant: nothing, and no crash
    api("POST", "/projects/%s/run" % PROJECT, {})
    check(wait(lambda: api("GET", "/status")["running"], 15), "script running again")
    check(wait(lambda: overlay()["visible"], 10), "window back with the run")
    api("PUT", "/settings", {"float_on_run": False})
    check(wait(lambda: not overlay()["visible"], 8), "mode 关闭: hidden", overlay())
    api("PUT", "/settings", {"float_on_run": True})
    check(wait(lambda: overlay()["visible"], 8), "mode 运行时显示: back")
    adb("shell", "appops", "set", PKG, "SYSTEM_ALERT_WINDOW", "deny")
    check(wait(lambda: overlay()["reason"] == "no_permission" and not overlay()["visible"], 8), "grant revoked: quietly hidden", overlay())
    check(api("GET", "/status")["running"], "script still runs without the overlay")
    check(not overlay()["permitted"], "/status reports permitted=false", overlay())
    adb("shell", "appops", "set", PKG, "SYSTEM_ALERT_WINDOW", "allow")
    # nothing polls while hidden (battery); the next foreground / background switch picks the grant up
    open_app()
    wait(lambda: overlay()["app_foreground"], 8)
    home()
    check(wait(lambda: overlay()["visible"], 8), "grant back: window back after the next app switch", overlay())

    # 11 ticker cost: process CPU ticks (utime+stime) over 20 s with the window up and the screen on
    cpu_ticks()
    # 12 font size / dark mode: the window is rebuilt, not left stale
    appearance()
    api("POST", "/projects/%s/stop" % PROJECT, {})
    wait(lambda: not api("GET", "/status")["running"], 15)
    if not PACKED:
        error_flash()
        menus()
        menu_icon()
        orientation()
        scripted_api()


def main_pid():
    out = adb("shell", "pidof", PKG, out=True).split()
    return out[0] if out else None


def ticks(pid):
    f = adb("shell", "cat", "/proc/%s/stat" % pid, out=True).split(")")[-1].split()
    return int(f[11]) + int(f[12])


def cpu_ticks():
    pid = main_pid()
    if not pid:
        return check(False, "main process found for the CPU sample")
    to_mode("pill")
    a = ticks(pid)
    time.sleep(20)
    b = ticks(pid)
    # 100 ticks = 1 s of one core; emulators are noisy, so only a loose bound
    print("INFO ticker CPU: %d ticks (%.2f%% of one core) over 20 s" % (b - a, (b - a) / 20.0), flush=True)
    check(b - a <= 100, "main process CPU stays low with the window up (≤ 5% of a core)", b - a)


def appearance():
    f_old = adb("shell", "settings", "get", "system", "font_scale", out=True).strip()
    night_old = adb("shell", "cmd", "uimode", "night", out=True)
    try:
        to_mode("pill")
        w1 = overlay()["width"]
        adb("shell", "settings", "put", "system", "font_scale", "1.5")
        check(wait(lambda: overlay()["visible"] and overlay()["width"] > w1 + 10, 8), "font size 1.5x: window is rebuilt wider", (w1, overlay()))
        check(to_mode("panel"), "large font: panel opens")
        time.sleep(0.6)
        shot("font15_panel")
        o = overlay()
        nodes = uia_nodes()
        btn = {d: b for pk, t, d, _c, b in nodes if pk == PKG and d in BTN_DESCS}
        check(set(btn) == set(BTN_DESCS), "large font: all four buttons present", list(btn))
        check(all(b[0] >= o["x"] - 1 and b[2] <= o["x"] + o["width"] + 1 and b[1] >= o["y"] - 1 and b[3] <= o["y"] + o["height"] + 1 for b in btn.values()),
              "large font: no button is clipped by the window", (o, btn))
        check(all(b[2] - b[0] >= dp(48) - 1 and b[3] - b[1] >= dp(48) - 1 for b in btn.values()), "large font: buttons still ≥ 48dp", btn)
        check(inside_safe_area(overlay(), None), "large font: still inside the safe area", overlay())
        to_mode("pill")
        adb("shell", "settings", "put", "system", "font_scale", f_old if f_old not in ("", "null") else "1.0")
        check(wait(lambda: overlay()["visible"] and overlay()["width"] <= w1 + 6, 8), "font size back: window shrinks again", (w1, overlay()))
        adb("shell", "cmd", "uimode", "night", "yes")
        time.sleep(2.5)
        check(overlay()["visible"], "dark mode switched: window still up (rebuilt)", overlay())
        to_mode("pill")
        time.sleep(0.4)
        shot("dark")
        check(any(PROJECT in t for t in node_texts()), "dark mode: name still readable in the tree")
    finally:
        adb("shell", "settings", "put", "system", "font_scale", f_old if f_old not in ("", "null") else "1.0")
        adb("shell", "cmd", "uimode", "night", "yes" if "yes" in night_old else "auto" if "auto" in night_old else "no")


def error_flash():
    """A script that ends with an error keeps the window up for a few seconds; a clean exit does not."""
    name = PROJECT + "_err"
    make_project(name, SCRIPT_ERR)
    try:
        check(run_in_background(name), "error script running")
        check(wait(lambda: overlay()["visible"], 10), "error script: window up while running", overlay())
        check(wait(lambda: not api("GET", "/status")["running"], 15), "error script ended")
        check(wait(lambda: overlay()["visible"] and overlay()["error"], 4), "failed run: window stays up flagged as error", overlay())
        check(overlay().get("state") == "pill", "error flash is the readable pill, not a ball", overlay())
        texts = node_texts()
        check(any("出错" in t for t in texts), "window says 出错", texts)
        shot("error")
        check(wait(lambda: not overlay()["visible"], 14), "error flash disappears after a few seconds", overlay())
        check(overlay()["reason"] == "idle" and not overlay()["error"], "…then idle, error cleared", overlay())
    finally:
        drop_project(name)
    name = PROJECT + "_ok"
    make_project(name, SCRIPT_OK)
    try:
        check(run_in_background(name), "clean-exit script running")
        check(wait(lambda: overlay()["visible"], 10), "clean-exit script: window up while running", overlay())
        check(wait(lambda: not api("GET", "/status")["running"], 15), "clean-exit script ended")
        flagged = bool(wait(lambda: overlay()["error"], 3))
        check(not flagged, "exit 0 is not flagged as an error")
        check(wait(lambda: not overlay()["visible"], 5), "exit 0: window goes away at once", overlay())
    finally:
        drop_project(name)


def menus():
    """FloatWindow.add_menu: round buttons in the panel call back into the running script."""
    for variant, remove in (("", False), (", True", True)):
        name = PROJECT + "_menu"
        make_project(name, SCRIPT_MENU % variant)
        try:
            check(run_in_background(name), "menu script running (remove_system=%s)" % remove)
            check(wait(lambda: overlay()["visible"] and overlay().get("menus") == 2, 12), "window shows with 2 script buttons registered", overlay())
            check(to_mode("panel"), "panel open (menus)")
            time.sleep(0.5)
            print("INFO panel with menus:", {k: overlay().get(k) for k in ("x", "y", "width", "height", "side", "screen_width")}, flush=True)
            nodes = uia_nodes()
            descs = {d: b for pk, t, d, _c, b in nodes if pk == PKG and d.startswith("悬浮窗按钮 ")}
            texts = [t for pk, t, d, _c, b in nodes if pk == PKG and t]
            check(set(descs) == {"悬浮窗按钮 hello", "悬浮窗按钮 bye"}, "panel has the two script buttons", list(descs))
            check(all(b[2] - b[0] >= dp(48) - 1 and b[3] - b[1] >= dp(48) - 1 for b in descs.values()), "script buttons are 48dp touch targets", descs)
            if remove:
                check(not any(d in BTN_DESCS + (BTN_RUN,) for d in [d for pk, t, d, _c, b in nodes if pk == PKG]), "remove_system=True hides the built-in buttons", texts)
            else:
                check(all(any(d == x for pk, t, d, _c, b in nodes if pk == PKG) for x in BTN_DESCS), "built-in buttons stay with custom ones", texts)
                labels = [t for t in texts if t in ("hello", "bye")]
                check(sorted(labels) == ["bye", "hello"], "script buttons show their id as the label", texts)
            shot("menu_removed" if remove else "menu")
            to_mode("panel")   # uiautomator dumps are slow; the panel shrinks to the ball after 10 s idle
            check(tap_overlay("悬浮窗按钮 hello"), "tap the hello button")
            check(wait(lambda: "MENU_HELLO_CLICKED" in json.dumps(api("GET", "/logs")), 8), "hello callback ran in the script (no-arg callback)")
            to_mode("panel")
            check(tap_overlay("悬浮窗按钮 bye"), "tap the bye button")
            check(wait(lambda: "MENU_BYE_CLICKED bye" in json.dumps(api("GET", "/logs")), 8), "bye callback ran with its menu id")
            check(overlay().get("state") == "panel", "panel stays open after a script button", overlay())
            api("POST", "/projects/%s/stop" % name, {})
            check(wait(lambda: not api("GET", "/status")["running"], 15), "menu script stopped")
            check(wait(lambda: overlay().get("menus") == 0, 5), "buttons are dropped with the run", overlay())
        finally:
            drop_project(name)
            wait(lambda: not api("GET", "/status")["running"], 10)


def red_png(n=48):
    import struct, zlib
    raw = b"".join(b"\x00" + b"\xff\x00\x00\xff" * n for _ in range(n))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


SCRIPT_ICON = '''import os, time
from ascript.android.ui import FloatWindow
ico = os.path.join(os.path.dirname(os.path.abspath(__file__)), "red.png")
FloatWindow.add_menu("pic", ico, lambda: None)
FloatWindow.add_menu("gen", "", lambda: None)
time.sleep(300)
'''


def menu_icon():
    """A script-provided icon file is drawn as is; a missing one falls back to the generic icon (tinted, not red)."""
    try:
        from PIL import Image
        import io
    except ImportError:
        print("SKIP menu_icon: PIL not available (run with the repo's .venv-rt python)", flush=True)
        return
    name = PROJECT + "_icon"
    make_project(name, SCRIPT_ICON)
    api("PUT", "/projects/%s/files" % name, {"files": [{"path": "red.png", "encoding": "base64", "content": base64.b64encode(red_png()).decode()}]})
    try:
        check(run_in_background(name), "icon script running")
        check(wait(lambda: overlay()["visible"] and overlay().get("menus") == 2, 12), "icon script: 2 buttons registered", overlay())
        check(to_mode("panel"), "panel open (icons)")
        time.sleep(0.6)
        nodes = uia_nodes()
        btn = {d: b for pk, t, d, _c, b in nodes if pk == PKG and d.startswith("悬浮窗按钮 ")}
        check(set(btn) == {"悬浮窗按钮 pic", "悬浮窗按钮 gen"}, "both script buttons are in the panel", list(btn))
        png = subprocess.run([ADB, "-s", SERIAL, "exec-out", "screencap", "-p"], capture_output=True).stdout
        im = Image.open(io.BytesIO(png)).convert("RGB")

        def red_pixels(b):
            n = 0
            for x in range(b[0], b[2], 3):
                for y in range(b[1], b[3], 3):
                    r, g, bl = im.getpixel((x, y))
                    if r > 200 and g < 70 and bl < 70:
                        n += 1
            return n
        shot("menu_icon")
        check(red_pixels(btn["悬浮窗按钮 pic"]) > 20, "script icon (red.png) is drawn in its own colours", red_pixels(btn["悬浮窗按钮 pic"]))
        check(red_pixels(btn["悬浮窗按钮 gen"]) == 0, "no icon given: generic icon, not the script's", red_pixels(btn["悬浮窗按钮 gen"]))
        texts = [t for pk, t, d, _c, b in nodes if pk == PKG and t]
        check("pic" in texts and "gen" in texts, "labels come from the ids", texts)
    finally:
        drop_project(name)


def orientation():
    """Portrait and landscape keep separate positions; rotation re-fits the window into the safe area."""
    if "deskclock" not in adb("shell", "pm", "list", "packages", "com.google.android.deskclock", out=True):
        print("SKIP orientation: no rotatable app (deskclock) on this device", flush=True)
        return
    acc = adb("shell", "settings", "get", "system", "accelerometer_rotation", out=True).strip()
    rot = adb("shell", "settings", "get", "system", "user_rotation", out=True).strip()
    try:
        wait(lambda: not api("GET", "/status")["running"], 20)
        script_gone()
        try:
            r = api("POST", "/projects/%s/run" % PROJECT, {})
        except Exception as e:
            r = str(e)
        check(wait(lambda: api("GET", "/status")["running"], 15), "script running for the rotation test", r)
        adb("shell", "am", "start", "-a", "android.intent.action.SHOW_ALARMS")
        check(wait(lambda: overlay()["visible"] and not overlay()["app_foreground"], 10), "window up over another app", overlay())
        time.sleep(1)
        o = overlay()
        st = full(o)
        portrait = (o["side"], o["y"])
        pw = api("GET", "/status")["width"]
        adb("shell", "settings", "put", "system", "accelerometer_rotation", "0")
        adb("shell", "cmd", "window", "user-rotation", "lock", "1")
        check(wait(lambda: api("GET", "/status")["width"] > pw, 8), "device rotated to landscape", api("GET", "/status")["width"])
        time.sleep(2.2)
        o = overlay()
        st = full(o)
        check(o["visible"] and inside_safe_area(o, st), "landscape: window re-fitted into the safe area", (o, st["width"], st["height"]))
        shot("landscape")
        # drag to the opposite side in landscape
        want = "left" if o["side"] == "right" else "right"
        to_mode("pill")
        o = overlay()
        tx = 100 if want == "left" else st["width"] - 100
        adb("shell", "input", "swipe", str(o["x"] + o["width"] // 2), str(o["y"] + dp(26)), str(tx), str(int(st["height"] * 0.4)), "600")
        check(wait(lambda: overlay()["side"] == want, 5), "landscape drag snaps to the other edge", overlay())
        time.sleep(0.8)
        land = (overlay()["side"], overlay()["y"])
        adb("shell", "cmd", "window", "user-rotation", "lock", "0")
        check(wait(lambda: api("GET", "/status")["width"] == pw, 8), "device rotated back to portrait")
        time.sleep(2.2)
        o = overlay()
        check((o["side"], o["y"]) == portrait or (o["side"] == portrait[0] and abs(o["y"] - portrait[1]) <= 2), "portrait position unchanged by the landscape drag", (portrait, o))
        adb("shell", "cmd", "window", "user-rotation", "lock", "1")
        check(wait(lambda: api("GET", "/status")["width"] > pw, 8), "rotated to landscape again")
        time.sleep(2.2)
        o = overlay()
        # ball and pill differ in height by a few px, so allow a small difference in y
        check(o["side"] == land[0] and abs(o["y"] - land[1]) <= dp(12), "landscape position remembered separately", (land, o))
    finally:
        adb("shell", "cmd", "window", "user-rotation", "lock", "0")
        adb("shell", "cmd", "window", "user-rotation", "free")
        adb("shell", "settings", "put", "system", "accelerometer_rotation", acc or "1")
        if rot:
            adb("shell", "settings", "put", "system", "user_rotation", rot)
        adb("shell", "input", "keyevent", "KEYCODE_HOME")
        api("POST", "/projects/%s/stop" % PROJECT, {})
        wait(lambda: not api("GET", "/status")["running"], 15)


def scripted_api():
    """AScript FloatWindow.show(x, y, dim) / hide() called by the script itself."""
    name = PROJECT + "_api"
    make_project(name, SCRIPT_API)
    try:
        api("PUT", "/settings", {"float_on_run": False})   # setting off: only the script's own call may show it
        open_app()
        wait(lambda: overlay()["app_foreground"], 10)
        api("POST", "/projects/%s/run" % name, {})
        check(wait(lambda: api("GET", "/status")["running"], 15), "script (FloatWindow API) running")
        check(not overlay()["visible"], "setting off: hidden until the script asks", overlay())
        check(wait(lambda: overlay()["visible"], 12), "FloatWindow.show() shows it, even in the foreground and with the setting off", overlay())
        time.sleep(0.8)
        o = overlay()
        st = full(o)
        check(o["side"] == "right" and o["y"] + o["height"] > st["height"] * 0.85, "show(-1, -1) = right edge, bottom", o)
        check(o["state"] == "pill" and abs(o["alpha"] - 0.6) < 0.03, "dim=0.6 is the window opacity", o)
        shot("script_show")
        check(wait(lambda: overlay()["state"] == "ball", 8), "script window also shrinks to the ball when idle", overlay())
        time.sleep(0.5)
        check(abs(overlay()["alpha"] - 0.6 * 0.6) < 0.03, "ball opacity = dim x ball factor", overlay())
        check(wait(lambda: not overlay()["visible"], 16), "FloatWindow.hide() hides it", overlay())
        check(overlay()["reason"] == "script_hidden", "reason script_hidden", overlay())
        api("POST", "/projects/%s/stop" % name, {})
        wait(lambda: not api("GET", "/status")["running"], 15)
        api("PUT", "/settings", {"float_on_run": True})
    finally:
        drop_project(name)


if __name__ == "__main__":
    try:
        main()
    finally:
        pass
    print("\n%d failed" % len(fails) if fails else "\nall checks passed")
    sys.exit(1 if fails else 0)
