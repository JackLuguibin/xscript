#!/usr/bin/env python3
"""Runtime pip + ONNX Runtime + real model inference on a real device or emulator (needs numpy/OpenCV; works on 16 KB and 4 KB page devices).

    adb -s emulator-5556 forward tcp:19861 tcp:9860
    python3 scripts/device_ml_e2e.py http://127.0.0.1:19861 [--models DIR]   # DIR: yolo11n.onnx + bus.jpg (uploaded over PUT /models)

Steps (each reported separately, the exit code is non-zero if any fails):
  1. pip:  POST /packages installs a pure-Python wheel from PyPI; a project with requirements.txt gets a native Chaquopy wheel
           (MarkupSafe) and a pure wheel installed automatically before it runs; both import and work; then everything is uninstalled.
  2. ocr:  PaddleOCR v5 models are downloaded by the device itself (pinned SHA-256), then a Pillow-rendered image is read.
  3. yolo: yolo11n.onnx (uploaded with PUT /models) detects the people and the bus in bus.jpg through ONNX Runtime for Android.
Needs network on the device for steps 1-2 and Pillow + the models on the host for steps 2-3. Creates/deletes project `_ml_e2e`.
"""
import argparse
import base64
import io
import json
import os
import sys
import time
import urllib.request
import devauth  # scripts/devauth.py: pairing code (XSCRIPT_TOKEN or adb)

os.environ.setdefault("no_proxy", "127.0.0.1,localhost")
ap = argparse.ArgumentParser()
ap.add_argument("base", nargs="?", default="http://127.0.0.1:9860")
ap.add_argument("--models", default="")
args = ap.parse_args()
BASE = args.base.rstrip("/")
PROJECT = "_ml_e2e"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(method, path, body=None, raw=None, timeout=60, ctype="application/json"):
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    req = urllib.request.Request(BASE + path, method=method, data=data, headers=devauth.headers(BASE, {"Content-Type": ctype}))
    try:
        with OPENER.open(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return dict(json.load(e), _status=e.code)
        except Exception:
            return {"error": str(e), "_status": e.code}


def run_project(files, wait=300):
    api("DELETE", "/projects/" + PROJECT)
    api("POST", "/projects/" + PROJECT, {})
    api("PUT", "/projects/%s/files" % PROJECT, {"files": [
        {"path": p, "encoding": "base64", "content": base64.b64encode(d).decode()} for p, d in files]})
    since = api("GET", "/logs?since=0").get("next", 0)
    devauth.wait_idle(BASE)  # a script left running (e.g. from a manual session) would refuse the run: 409
    print("   run:", api("POST", "/projects/%s/run" % PROJECT, {}).get("running"))
    t0, lines, result = time.time(), [], None
    while time.time() - t0 < wait:
        logs = api("GET", "/logs?since=%d" % since)
        since = logs.get("next", since)
        for e in logs.get("entries", []):
            lines.append(e["line"].rstrip())
            if e["line"].startswith("ML_RESULT "):
                result = json.loads(e["line"][len("ML_RESULT "):])
        if result is not None or (time.time() - t0 > 5 and not api("GET", "/status").get("running")):
            time.sleep(0.5)
            for e in api("GET", "/logs?since=%d" % since).get("entries", []):
                lines.append(e["line"].rstrip())
                if e["line"].startswith("ML_RESULT "):
                    result = json.loads(e["line"][len("ML_RESULT "):])
            break
        time.sleep(0.5)
    api("POST", "/projects/%s/stop" % PROJECT, {})
    return result, lines


PIP_SCRIPT = r'''
import json, sys
from xscript.android import pip
out = {}
import markupsafe, schedule
out["markupsafe"] = [markupsafe.__version__ if hasattr(markupsafe, "__version__") else "?", str(markupsafe.escape("<b>&</b>"))]
calls = []
schedule.every(1).seconds.do(lambda: calls.append(1))
import time; time.sleep(1.2); schedule.run_pending()
out["schedule_ran"] = len(calls)
out["listed"] = sorted(p["name"].lower() for p in pip.list())
print("ML_RESULT " + json.dumps(out))
'''

OCR_SCRIPT = r'''
import json, os, time
import cv2
from xscript.android import models, paddle
root = os.path.dirname(os.path.abspath(__file__))
t0 = time.time()
paths = models.paddle("v5")      # downloads on first use (sha256-pinned)
t1 = time.time()
eng = paddle.engine("v5")
img = cv2.imread(os.path.join(root, "ocr.png"))
res = eng.ocr(image=img)
out = {"download_s": round(t1 - t0, 1), "infer_s": round(time.time() - t1, 1),
       "lines": [{"text": r["text"] if isinstance(r, dict) else getattr(r, "text", str(r))} for r in res]}
print("ML_RESULT " + json.dumps(out, ensure_ascii=False))
'''

YOLO_SCRIPT = r'''
import json, os, time
import cv2
from xscript.android import models, yolo
root = os.path.dirname(os.path.abspath(__file__))
t0 = time.time()
y = yolo.Yolo(models.path("yolo11n.onnx"))
t1 = time.time()
det = y.detect(image=cv2.imread(os.path.join(root, "bus.jpg")), conf=0.4)
out = {"load_s": round(t1 - t0, 1), "infer_s": round(time.time() - t1, 1), "nc": y.nc, "imgsz": list(y.imgsz),
       "dets": [{"label": d.label, "conf": round(d.confidence, 2), "rect": list(d.rect)} for d in det]}
print("ML_RESULT " + json.dumps(out))
'''


def step(name, fn):
    print("== " + name)
    try:
        ok = fn()
    except Exception as e:
        print("   EXCEPTION:", repr(e))
        ok = False
    print("   " + ("PASS" if ok else "FAIL"))
    return ok


def pip_step():
    r = api("POST", "/packages", {"op": "install", "packages": ["schedule==1.2.2"]}, timeout=120)
    print("   POST /packages install schedule:", json.dumps(r, ensure_ascii=False)[:200])
    if not r.get("ok"):
        return False
    listed = api("GET", "/packages")
    print("   GET /packages:", json.dumps(listed)[:200])
    r = api("POST", "/packages", {"op": "uninstall", "packages": ["schedule"]}, timeout=60)
    print("   uninstall:", json.dumps(r)[:120])
    result, lines = run_project([("requirements.txt", b"schedule==1.2.2\nMarkupSafe\n"), ("__init__.py", PIP_SCRIPT.encode())])
    print("   project with requirements.txt:", result or "\n".join(lines[-15:]))
    ok = bool(result) and result["markupsafe"][1] == "&lt;b&gt;&amp;&lt;/b&gt;" and result["schedule_ran"] >= 1 \
        and {"schedule", "markupsafe"} <= set(result["listed"])
    print("   cleanup:", api("POST", "/packages", {"op": "uninstall", "packages": ["schedule", "markupsafe"]}, timeout=60))
    return ok


def ocr_step():
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (640, 220), "white")
    d = ImageDraw.Draw(img)
    d.text((24, 20), "Hello XScript 12345", font=ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 44), fill="black")
    d.text((24, 110), "文字识别测试 2026", font=ImageFont.truetype("/System/Library/Fonts/STHeiti Medium.ttc", 44), fill="black")
    b = io.BytesIO()
    img.save(b, "PNG")
    result, lines = run_project([("ocr.png", b.getvalue()), ("__init__.py", OCR_SCRIPT.encode())], wait=420)
    print("   ", result or "\n".join(lines[-15:]))
    if not result:
        return False
    text = " ".join(l["text"] for l in result["lines"]).replace(" ", "")
    return "HelloXScript12345" in text and "文字识别测试2026" in text


def yolo_step():
    if not args.models:
        print("   skipped (no --models DIR)")
        return True
    for name in ("yolo11n.onnx",):
        with open(os.path.join(args.models, name), "rb") as f:
            print("   PUT /models/%s:" % name, api("PUT", "/models/" + name, raw=f.read(), ctype="application/octet-stream", timeout=120))
    with open(os.path.join(args.models, "bus.jpg"), "rb") as f:
        bus = f.read()
    result, lines = run_project([("bus.jpg", bus), ("__init__.py", YOLO_SCRIPT.encode())], wait=240)
    print("   ", result or "\n".join(lines[-15:]))
    if not result:
        return False
    labels = [d["label"] for d in result["dets"]]
    return labels.count("person") >= 3 and "bus" in labels


try:
    st = api("GET", "/status")
    print("device:", st.get("model"), "sdk", st.get("sdk"))
    assert not st.get("running"), "a user project is running"
    results = [step("pip (PyPI + Chaquopy index)", pip_step), step("PaddleOCR v5 (device downloads models)", ocr_step), step("YOLO11n via ONNX Runtime", yolo_step)]
finally:
    api("DELETE", "/projects/" + PROJECT)
    api("DELETE", "/models/yolo11n.onnx") if args.models else None
print("ALL PASS" if all(results) else "FAILURES")
sys.exit(0 if all(results) else 1)
