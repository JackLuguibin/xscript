#!/usr/bin/env python3
"""A packed app's own scheme (<applicationId>://) from a real Chrome page on an emulator.

usage: scripts/device_packed_scheme_e2e.py SERIAL [APP_ID=com.example.packdemo] [PROJECT=demo]
The packed app (built by the backend pack flow, see docs) must already be installed. It prints
a 3-second demo project; a run is observed as the app's ScriptService being alive (dumpsys).
Checks: <id>://run asks (names the bundled project) and runs only it, <id>://run?name=other is refused,
xscript://run is NOT answered by the packed app (only by the main app), stop link works.
"""
import html, http.server, os, re, subprocess, sys, threading, time

SERIAL = sys.argv[1]
APP = sys.argv[2] if len(sys.argv) > 2 else "com.example.packdemo"
PROJ = sys.argv[3] if len(sys.argv) > 3 else "demo"
PORT = int(os.environ.get("XS_PAGE_PORT", "8089"))
ADB = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
PAGE = f"""<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1">
<style>a{{display:block;font-size:28px;margin:28px;padding:24px;background:#def}}</style></head><body>
<a href="{APP}://run">PACKRUN</a>
<a href="{APP}://run?name={PROJ}">PACKRUNNAMED</a>
<a href="{APP}://run?name=linkdemo">PACKOTHER</a>
<a href="{APP}://stop">PACKSTOP</a>
<a href="xscript://run?name={PROJ}">XSRUN</a>
</body></html>"""


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = PAGE.encode()
        self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def log_message(self, *a): pass


def adb(*a, out=False):
    r = subprocess.run([ADB, "-s", SERIAL, *a], capture_output=True)
    return r.stdout.decode("utf-8", "replace") if out else None


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


def wait_text(sub, pkg=None, secs=8):
    end = time.time() + secs
    while time.time() < end:
        for t in texts(pkg):
            if sub in t:
                return t
    return None


def toast(secs=6):
    end = time.time() + secs
    while time.time() < end:
        if " u0 Toast}" in adb("shell", "dumpsys", "window", "windows", out=True):
            return True
        time.sleep(0.15)
    return False


def open_page():
    adb("shell", "am", "force-stop", "com.android.chrome")
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "http://10.0.2.2:%d/" % PORT, "com.android.chrome")
    assert wait_text("PACKRUN", "com.android.chrome", 20), "page did not load in Chrome"


def ran(secs=6):
    """The packed app's ScriptService is alive (the demo project runs for ~3s) within secs."""
    end = time.time() + secs
    while time.time() < end:
        if "ScriptService" in adb("shell", "dumpsys", "activity", "services", APP, out=True):
            return True
        time.sleep(0.3)
    return False


results = []


def check(ok, name, detail=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (" (%s)" % detail if detail else ""))


def dialog_pkgs():
    return {pk for pk, t, _ in nodes() if "运行小程序" in t}


def main():
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        # 1. own scheme, no name: asks, names the bundled project, shown by the packed app itself
        open_page(); check(tap("PACKRUN"), "tap PACKRUN (%s://run)" % APP)
        msg = wait_text("「%s」" % PROJ, APP)
        check(msg is not None, "the packed app's own dialog names its bundled project", (msg or "").replace("\n", " ")[:50])
        check(not ran(2), "nothing runs while the dialog is open")
        tap("取消", exact=True); time.sleep(1.5)
        check(not ran(2), "cancel runs nothing")
        # 2. confirm -> only the bundled project runs
        open_page(); tap("PACKRUN"); wait_text("「%s」" % PROJ, APP); tap("运行", exact=True)
        check(ran(10), "运行 starts the bundled project (ScriptService running)")
        time.sleep(4)
        # 3. explicit own project name is fine; another project name is refused outright
        open_page(); tap("PACKRUNNAMED")
        check(wait_text("「%s」" % PROJ, APP) is not None, "name=%s is accepted (dialog)" % PROJ)
        tap("取消", exact=True); time.sleep(1)
        open_page(); tap("PACKOTHER")
        t_ok = toast()
        check(t_ok and not dialog_pkgs() and not ran(2), "name=linkdemo is refused with a toast: no dialog, nothing runs")
        # 4. xscript:// is not this app's scheme: only the main app answers it
        open_page(); tap("XSRUN")
        msg = wait_text("运行小程序", None, 8)
        check(msg is not None and dialog_pkgs() == {"com.xscript.app"}, "xscript://run is answered by the main app, not the packed app", str(dialog_pkgs()))
        tap("取消", exact=True); time.sleep(1)
        # 5. stop link
        open_page(); tap("PACKSTOP")
        check(toast() and not dialog_pkgs(), "<id>://stop answers without a dialog")
    finally:
        srv.shutdown()
    print("ALL PASS" if all(results) else "SOME CHECKS FAILED")
    sys.exit(0 if all(results) else 1)


main()
