#!/usr/bin/env python3
"""xscript:// scheme links from a real Chrome page on an emulator/phone.

usage: scripts/device_scheme_e2e.py SERIAL DEVICE_URL   e.g. emulator-5556 http://127.0.0.1:19861
(needs `adb forward` to the device API; the emulator reaches this Mac as 10.0.2.2)

Serves a small page, opens it in Chrome with an adb VIEW intent, and taps real links (uiautomator
taps, so Chrome sees genuine user gestures). Covers: confirm dialog (caller shown, cancel, run), launch
params, stop (no dialog), invalid / missing project (toast), a JS button, navigation without a gesture
(still only the confirm dialog), and the 直接运行 / 已关闭 modes. Restores the mode to 每次确认.
Chrome 155 needs the Nearby devices (local network) permission once for the 10.0.2.2 page.
Project `linkdemo` is created and deleted on the device.
"""
import base64, html, http.server, json, os, re, subprocess, sys, threading, time, urllib.request

SERIAL, BASE = sys.argv[1], sys.argv[2].rstrip("/")
PORT = int(os.environ.get("XS_PAGE_PORT", "8089"))
ADB = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
PAGE = """<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1"><title>xscript link test</title>
<style>a,button{display:block;font-size:28px;margin:28px;padding:24px;background:#def;border-radius:12px}</style></head><body>
<a href="xscript://run?name=linkdemo">RUNLINK</a>
<a href='xscript://run?name=linkdemo&params={"k":"v"}'>PARAMLINK</a>
<a href="xscript://stop">STOPLINK</a>
<a href="xscript://run?name=../etc">BADLINK</a>
<a href="xscript://run?name=nosuchproj">MISSINGLINK</a>
<button onclick="location.href='xscript://run?name=linkdemo'">JSBUTTON</button>
<a href="/auto">AUTOPAGE</a>
</body></html>"""
AUTO = "<!doctype html><title>auto</title><body><h1>AUTOLOADED</h1><script>setTimeout(()=>{location.href='xscript://run?name=linkdemo'},300)</script>"
SCRIPT = '''import builtins, time
print("LINK_RAN k=" + str(getattr(builtins, "k", "NONE")), flush=True)
for i in range(120):
    time.sleep(1)
    if i % 5 == 0: print("tick", i, flush=True)
'''


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = (AUTO if self.path.startswith("/auto") else PAGE).encode()
        self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def log_message(self, *a): pass


def adb(*a, out=False):
    r = subprocess.run([ADB, "-s", SERIAL, *a], capture_output=True)
    return r.stdout.decode("utf-8", "replace") if out else None


def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=30) as r:
        return json.load(r)


def nodes():
    for _ in range(3):
        adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
        x = adb("shell", "cat", "/sdcard/ui.xml", out=True)
        if "<node" in x:
            break
    res = []
    for m in re.finditer(r"<node [^>]*>", x):
        n = m.group(0)
        t = html.unescape(re.search(r'text="([^"]*)"', n).group(1))
        pk = re.search(r'package="([^"]*)"', n).group(1)
        b = list(map(int, re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n).groups()))
        res.append((pk, t, ((b[0] + b[2]) // 2, (b[1] + b[3]) // 2)))
    return res


def texts(pkg=None):
    return [t for pk, t, _ in nodes() if t and (pkg is None or pk == pkg)]


def tap(label, exact=False, retries=6):
    for _ in range(retries):
        for _pk, t, (x, y) in nodes():
            if t and (t == label if exact else label in t):
                adb("shell", "input", "tap", str(x), str(y))
                return True
        time.sleep(0.7)
    return False


def wait_text(substr, pkg=None, secs=8):
    end = time.time() + secs
    while time.time() < end:
        for t in texts(pkg):
            if substr in t:
                return t
    return None


SHOTS = os.environ.get("XS_SHOTS", "")


def wait_toast(name, secs=6):
    """uiautomator does not see toasts; their window shows up in dumpsys within a moment. Optionally keep a screenshot."""
    end = time.time() + secs
    while time.time() < end:
        if " u0 Toast}" in adb("shell", "dumpsys", "window", "windows", out=True):
            if SHOTS:
                with open(os.path.join(SHOTS, "scheme_toast_%s.png" % name), "wb") as f:
                    f.write(subprocess.run([ADB, "-s", SERIAL, "exec-out", "screencap", "-p"], capture_output=True).stdout)
            return True
        time.sleep(0.15)
    return False


def open_page(path="/"):
    adb("shell", "am", "force-stop", "com.android.chrome")
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "http://10.0.2.2:%d%s" % (PORT, path), "com.android.chrome")
    if path == "/":
        if not wait_text("RUNLINK", "com.android.chrome", 15):
            if any("nearby devices" in t.lower() for t in texts("com.android.chrome")):
                sys.exit("Chrome 147+ asks 'Connect to nearby devices?' for a page on a private IP (10.0.2.2): once, "
                         "tap Continue > Permissions > Nearby devices > Allow, then rerun")
        assert wait_text("RUNLINK", "com.android.chrome", 5), "page did not load in Chrome"


def running():
    return api("GET", "/status").get("running")


def logs_since(mark):
    r = api("GET", "/logs?since=%d" % mark)
    return [e["line"].rstrip() for e in r.get("entries", [])], r.get("next", mark)


def stop_if_running():
    if running():
        api("POST", "/projects/linkdemo/stop", {})
        time.sleep(2)


def set_mode(label):
    adb("shell", "am", "start", "-n", "com.xscript.app/.LauncherActivity")
    time.sleep(2)
    for _ in range(4):  # the app may be on a sub screen (project list...): back out to the home screen
        if any("链接启动" in t for t in texts("com.xscript.app")):
            break
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(1)
        adb("shell", "am", "start", "-n", "com.xscript.app/.LauncherActivity")
        time.sleep(1.5)
    assert tap("链接启动"), "链接启动 row"
    time.sleep(1)
    assert tap(label, exact=True), "mode " + label
    time.sleep(1)


results = []


def check(ok, name, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (" (%s)" % detail if detail else ""))


def main():
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        api("DELETE", "/projects/linkdemo")
    except Exception:
        pass
    api("POST", "/projects/linkdemo", {})
    api("PUT", "/projects/linkdemo/files", {"files": [{"path": "__init__.py", "encoding": "base64", "content": base64.b64encode(SCRIPT.encode()).decode()}]})
    try:
        stop_if_running()
        mark = api("GET", "/logs?since=0").get("next", 0)
        print("device:", api("GET", "/status").get("model"), "mode set to 每次确认 first")
        set_mode("每次确认")

        # 1. confirm dialog: project, caller, cancel
        open_page()
        check(tap("RUNLINK"), "tap RUNLINK in Chrome")
        msg = wait_text("linkdemo", "com.xscript.app")
        check(msg is not None and "10.0.2.2" in "\n".join(texts("com.xscript.app")), "confirm dialog names the project and the caller (10.0.2.2)", (msg or "")[:40])
        check(not running(), "nothing runs while the dialog is open")
        check(tap("取消", exact=True), "tap 取消")
        time.sleep(2)
        check(not running(), "cancel does not run the project")

        # 2. confirm -> run
        open_page()
        tap("RUNLINK"); wait_text("linkdemo", "com.xscript.app")
        check(tap("运行", exact=True), "tap 运行")
        time.sleep(4)
        lines, mark = logs_since(mark)
        check(running() and any(l == "LINK_RAN k=NONE" for l in lines), "运行 starts linkdemo (no params)", str(lines[-3:]))

        # 3. already running: second run link is refused
        open_page()
        tap("RUNLINK"); wait_text("linkdemo", "com.xscript.app"); tap("运行", exact=True)
        check(wait_toast("busy") and running(), "second run while busy: a toast is shown and the first script keeps running")

        # 4. stop link: no dialog, stops
        open_page()
        tap("STOPLINK")
        toast = wait_toast("stop")
        time.sleep(2)
        check(not running() and not any("运行小程序" in t for t in texts("com.xscript.app")), "xscript://stop stops without a dialog", "toast=%s" % toast)

        # 5. params
        open_page()
        tap("PARAMLINK"); wait_text("linkdemo", "com.xscript.app"); tap("运行", exact=True)
        time.sleep(4)
        lines, mark = logs_since(mark)
        check(any(l == "LINK_RAN k=v" for l in lines), "params {\"k\":\"v\"} reach the script", str(lines[-3:]))
        stop_if_running()

        # 6. invalid / missing
        open_page(); tap("BADLINK")
        toast = wait_toast("bad")
        check(toast and not running() and not any("运行小程序" in t for t in texts("com.xscript.app")), "invalid name is refused with a toast and no dialog")
        open_page(); tap("MISSINGLINK")
        check(wait_text("nosuchproj", "com.xscript.app") is not None, "unknown project still asks first (dialog names it)")
        tap("运行", exact=True)
        toast = wait_toast("missing")
        check(toast and not running(), "unknown project is refused with a toast after confirming")

        main2(mark)
    finally:
        srv.shutdown()


def main2(mark):
    # 7. JS button (user gesture)
    open_page(); check(tap("JSBUTTON"), "tap JSBUTTON")
    msg = wait_text("linkdemo", "com.xscript.app")
    check(msg is not None, "location.href from a tapped button opens the confirm dialog")
    tap("取消", exact=True); time.sleep(1)
    # a page that navigates by itself (no tap): Chrome may pass it on, so the confirm dialog is the protection
    open_page("/auto")
    msg = wait_text("linkdemo", "com.xscript.app", 12)
    check(not running(), "gesture-less JS redirect never runs anything (Chrome %s)" % ("handed it over, the app only asked" if msg else "blocked it"))
    tap("取消", exact=True); time.sleep(1)
    check(not running(), "cancelling that dialog runs nothing")

    # 8. modes
    set_mode("直接运行")
    open_page(); tap("RUNLINK"); time.sleep(4)
    lines, mark = logs_since(mark)
    check(running() and any(l.startswith("LINK_RAN") for l in lines) and not any("运行小程序" in t for t in texts("com.xscript.app")),
          "直接运行 mode: starts without a dialog")
    stop_if_running()
    set_mode("已关闭")
    open_page(); tap("RUNLINK")
    toast = wait_toast("off")
    time.sleep(1)
    check(toast and not running(), "已关闭 mode: refused with a toast, nothing runs")
    set_mode("每次确认")
    open_page(); tap("RUNLINK")
    check(wait_text("运行小程序", "com.xscript.app") is not None, "back to 每次确认: dialog is shown again")
    tap("取消", exact=True)


if __name__ == "__main__":
    try:
        main()
    finally:
        try:
            stop_if_running()
            api("DELETE", "/projects/linkdemo")
        except Exception as e:
            print("cleanup:", e)
    print("ALL PASS" if all(results) else "SOME CHECKS FAILED")
    sys.exit(0 if all(results) else 1)
