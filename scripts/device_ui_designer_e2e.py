#!/usr/bin/env python3
"""UI designer output on a real emulator/phone: the generated res/ui/<name>.html + ui_<name>.py show a form and
return the filled values.

usage: scripts/device_ui_designer_e2e.py SERIAL DEVICE_URL      e.g. emulator-5554 http://127.0.0.1:19861
(needs `adb forward tcp:19861 tcp:9860`; the app answering there is the one tested, e.g. com.xscript.app.perf).

Generates the files with the designers' shared generator (android/app/src/main/assets/tools/ui-form.js, used by
both the VS Code extension and the Web IDE; needs node), for a form that uses every control kind. Uploads them as project `_ui_e2e`, runs it, fills
the form through uiautomator (text, password, textarea, number, checkbox, select, radio), taps the submit button and
checks the dict the script prints. A second run taps cancel and expects None. A third passes values to show() and
checks the form comes up pre-filled. XS_SHOTS=dir keeps screenshots.
Only creates and deletes its own project; never installs, uninstalls or clears data.
"""
import base64, html, json, os, re, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import devauth  # noqa: E402  scripts/devauth.py: pairing code (XSCRIPT_TOKEN or adb), never printed

SERIAL, BASE = sys.argv[1], sys.argv[2].rstrip("/")
ADB = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
if not os.path.exists(ADB):
    ADB = "adb"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.environ.get("XS_SHOTS", "")
PROJECT = "_ui_e2e"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
fails, passes = [], []

SPEC = {
    "version": 1, "title": "E2E 设置", "submit": "开始", "cancel": "取消", "width": "90vw", "height": "85vh",
    "fields": [
        {"kind": "label", "id": "note1", "label": "UI designer e2e"},
        {"kind": "text", "id": "name", "label": "Name", "default": "abc"},
        {"kind": "password", "id": "secret", "label": "Secret", "default": ""},
        {"kind": "number", "id": "count", "label": "Count", "default": 3, "min": 0, "max": 99},
        {"kind": "checkbox", "id": "fast", "label": "Fast mode", "default": False},
        {"kind": "select", "id": "mode", "label": "Mode", "options": ["easy", "hard"], "default": "easy"},
        {"kind": "radio", "id": "side", "label": "Side", "options": ["left", "right"], "default": "left"},
        {"kind": "textarea", "id": "memo", "label": "Memo", "default": ""},
    ],
}
MAIN = '''import json
from ui_e2e_form import show
print("UI_E2E start", flush=True)
v = show(%s)
print("UI_E2E_RESULT " + json.dumps(v, ensure_ascii=False, sort_keys=True), flush=True)
'''


def generate():
    js = ("const m = require(process.argv[1]); const s = m.parseSpec(process.argv[2]); const e = m.validateSpec(s);"
          " if (e.length) throw new Error(e.join('; ')); process.stdout.write(JSON.stringify(m.outputs(s, 'e2e_form')));")
    r = subprocess.run(["node", "-e", js, os.path.join(ROOT, "android/app/src/main/assets/tools/ui-form.js"),
                        json.dumps(SPEC)], capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def adb(*a, out=False):
    r = subprocess.run([ADB, "-s", SERIAL, *a], capture_output=True)
    return r.stdout.decode("utf-8", "replace") if out else None


def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers=devauth.headers(BASE, {"Content-Type": "application/json"}))
    with OPENER.open(req, timeout=30) as r:
        return json.load(r)


def check(ok, name, detail=""):
    (passes if ok else fails).append(name)
    print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else "  -- " + devauth.mask(detail)[:300]), flush=True)
    return ok


def wait(pred, secs=15, step=0.5):
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
        os.makedirs(SHOTS, exist_ok=True)
        with open(os.path.join(SHOTS, name + ".png"), "wb") as f:
            f.write(subprocess.run([ADB, "-s", SERIAL, "exec-out", "screencap", "-p"], capture_output=True).stdout)


def nodes():
    x = ""
    for _ in range(3):
        adb("shell", "uiautomator", "dump", "--windows", "/sdcard/ui-e2e.xml")
        x = adb("shell", "cat", "/sdcard/ui-e2e.xml", out=True)
        if "<node" in x:
            break
    res = []
    for m in re.finditer(r"<node [^>]*>", x):
        n = m.group(0)
        try:
            g = lambda k: html.unescape(re.search(r'\b' + k + r'="([^"]*)"', n).group(1))  # noqa: E731
            b = list(map(int, re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n).groups()))
            res.append({"text": g("text"), "desc": g("content-desc"), "cls": g("class"), "res": g("resource-id"),
                        "checked": g("checked") == "true", "at": ((b[0] + b[2]) // 2, (b[1] + b[3]) // 2), "b": b})
        except AttributeError:
            continue
    return res


def find(ns, pred):
    return next((n for n in ns if pred(n)), None)


def tap(n):
    adb("shell", "input", "tap", str(n["at"][0]), str(n["at"][1]))
    time.sleep(0.6)


def logs_text():
    return json.dumps(api("GET", "/logs"), ensure_ascii=False)


def result_after(mark):
    t = logs_text()
    i = t.rfind(mark)
    if i < 0:
        return None
    m = re.search(r"UI_E2E_RESULT (null|\{.*?\})(?:\\n|\")", t[i:])
    return m and m.group(1).replace('\\"', '"')


def type_into(n, text):
    tap(n)
    adb("shell", "input", "keyevent", "KEYCODE_MOVE_END")
    for _ in range(12):
        adb("shell", "input", "keyevent", "KEYCODE_DEL")
    adb("shell", "input", "text", text)
    time.sleep(0.4)


def run(values_literal):
    api("PUT", "/projects/%s/files" % PROJECT, {"files": [
        {"path": "__init__.py", "encoding": "base64", "content": base64.b64encode((MAIN % values_literal).encode()).decode()}]})
    mark = "run-%d" % time.time()
    api("POST", "/projects/%s/run" % PROJECT, {})
    return mark


def form_up():
    ns = nodes()
    return ns if find(ns, lambda n: n["text"] == "E2E 设置") and find(ns, lambda n: n["text"] == "开始") else None


def field(ns, label, cls="EditText"):
    """The input that follows its <label> in the accessibility tree."""
    idx = next((i for i, n in enumerate(ns) if n["text"] == label), None)
    if idx is None:
        return None
    return next((n for n in ns[idx + 1:] if cls in n["cls"]), None)


def main():
    files = generate()
    check(set(files) == {"res/ui/e2e_form.html", "ui_e2e_form.py"}, "generator wrote the html and the module", list(files))
    adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    adb("shell", "monkey", "-p", api("GET", "/status").get("app_id", ""), "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(1.5)
    names = [p["name"] if isinstance(p, dict) else p for p in api("GET", "/projects").get("projects", [])]
    if PROJECT in names:
        api("DELETE", "/projects/" + PROJECT)
    api("POST", "/projects/" + PROJECT, {})
    try:
        api("PUT", "/projects/%s/files" % PROJECT, {"files": [
            {"path": p, "encoding": "base64", "content": base64.b64encode(c.encode()).decode()} for p, c in files.items()]})

        # 1) fill every control and submit
        run("None")
        ns = wait(form_up, 25)
        if not check(ns is not None, "show() opened the form window"):
            shot("ui-e2e-noform")
            print(devauth.mask(logs_text()[-1500:]))
            return
        shot("ui-e2e-form")
        check(find(ns, lambda n: n["text"] == "UI designer e2e") is not None, "label text rendered")
        name = field(ns, "Name")
        check(name is not None and name["text"] == "abc", "text field shows its default", name and name["text"])
        type_into(name, "xyz")
        type_into(field(nodes(), "Secret"), "s3cret")
        type_into(field(nodes(), "Count"), "42")
        type_into(field(nodes(), "Memo"), "hello")
        adb("shell", "input", "keyevent", "KEYCODE_BACK")   # hide the keyboard (the form window stays)
        time.sleep(0.8)
        ns = nodes()
        cb = find(ns, lambda n: "CheckBox" in n["cls"]) or field(ns, "Fast mode", "CheckBox")
        if check(cb is not None, "checkbox present"):
            tap(cb)
        ns = nodes()
        right = find(ns, lambda n: "RadioButton" in n["cls"] and n["text"] in ("right", "")) and \
            [n for n in ns if "RadioButton" in n["cls"]]
        if check(bool(right) and len(right) == 2, "two radio buttons", right):
            tap(right[1])
        ns = nodes()
        # The generator renders a select field as an in-page option list: a native <select> cannot open its
        # pop-up in the overlay window ui.Window uses (tapping only focused it).
        opt = find(ns, lambda n: n["text"] == "hard")
        if check(opt is not None, "select shows its options inline"):
            tap(opt)
        shot("ui-e2e-filled")
        ok_btn = wait(lambda: find(nodes(), lambda n: n["text"] == "开始"), 5)
        tap(ok_btn)
        got = wait(lambda: result_after("UI_E2E start"), 15)
        want = {"count": 42, "fast": True, "memo": "hello", "mode": "hard", "name": "xyz", "secret": "s3cret", "side": "right"}
        check(got and json.loads(got) == want, "submit returns every value with its type", got)
        check(wait(lambda: not form_up(), 8, 1) is not None, "the window closes after submit")

        # 2) cancel returns None
        api("POST", "/projects/%s/stop" % PROJECT, {})
        time.sleep(1)
        before = logs_text().count("UI_E2E start")
        run("None")
        ns = wait(form_up, 25)
        if check(ns is not None, "form opens again"):
            tap(find(ns, lambda n: n["text"] == "取消"))
            got = wait(lambda: logs_text().count("UI_E2E start") > before and
                       logs_text().rsplit("UI_E2E start", 1)[1].find("UI_E2E_RESULT null") >= 0, 15)
            check(got, "cancel returns None")

        # 3) show(values) pre-fills, and submitting unchanged keeps them
        api("POST", "/projects/%s/stop" % PROJECT, {})
        time.sleep(1)
        run('{"name": "preset", "count": 7, "fast": True, "side": "right", "mode": "hard"}')
        ns = wait(form_up, 25)
        if check(ns is not None, "form opens with values"):
            n = field(ns, "Name")
            check(n and n["text"] == "preset", "show(values) pre-fills text", n and n["text"])
            c = field(ns, "Count")
            # a number input reads "<value>, <label>" in the accessibility tree
            check(c and c["text"].split(",")[0] == "7", "show(values) pre-fills number", c and c["text"])
            shot("ui-e2e-prefilled")
            tap(find(ns, lambda n: n["text"] == "开始"))
            got = wait(lambda: result_after("UI_E2E start") if logs_text().rsplit("UI_E2E start", 1)[1].find("UI_E2E_RESULT {") >= 0 else None, 15)
            v = json.loads(got) if got else {}
            check(v.get("name") == "preset" and v.get("count") == 7 and v.get("fast") is True and v.get("side") == "right"
                  and v.get("mode") == "hard", "unchanged submit returns the pre-filled values", got)
    finally:
        api("POST", "/projects/%s/stop" % PROJECT, {})  # 200 even when idle: an error here is real, let it show
        time.sleep(1)
        api("DELETE", "/projects/" + PROJECT)
    print("\n%d passed, %d failed%s" % (len(passes), len(fails), (": " + ", ".join(fails)) if fails else ""))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
