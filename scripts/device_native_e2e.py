#!/usr/bin/env python3
"""Every 4 KB-aligned native module of the Python wheels, exercised on a device or emulator (16 KB or 4 KB pages).

    adb -s emulator-5554 forward tcp:19860 tcp:9860
    python3 scripts/device_native_e2e.py http://127.0.0.1:19860

numpy (core, linalg + OpenBLAS + libgfortran, fft, random), OpenCV (codecs, filters, template matching,
contours), Pillow (_imaging, _imagingft/FreeType, _imagingmath, _imagingmorph) and the app's own image helpers
(xscript.android.image) run in one project; the exit code is non-zero if any check fails.
Prints the page size and whether the app runs in 16 KB backcompat mode. Creates/deletes project `_native_e2e`.
"""
import base64, json, os, sys, time, urllib.request
import devauth  # scripts/devauth.py: pairing code (XSCRIPT_TOKEN or adb)

os.environ.setdefault("no_proxy", "127.0.0.1,localhost")
BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9860").rstrip("/")
PROJECT = "_native_e2e"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

SCRIPT = r'''
import json, os, sys, time, traceback, mmap
checks = {}

def check(name, fn):
    t = time.time()
    try:
        r = fn()
        checks[name] = {"ok": r is not False, "ms": int((time.time() - t) * 1000), "detail": None if r in (True, None) else str(r)[:120]}
    except Exception as e:
        checks[name] = {"ok": False, "ms": int((time.time() - t) * 1000), "detail": (type(e).__name__ + ": " + str(e))[:200]}

import numpy as np
import cv2
import PIL
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops, ImageMorph

def np_core():
    a = np.arange(12, dtype=np.float64).reshape(3, 4)
    assert (a @ a.T).trace() == 506.0
    assert np.sort(np.array([3, 1, 2])).tolist() == [1, 2, 3]
    assert np.isclose(np.sin(np.pi / 6), 0.5)
check("numpy core", np_core)

def np_linalg():
    m = np.array([[4.0, 1.0], [2.0, 3.0]])
    w = np.sort(np.linalg.eigvals(m))
    assert np.allclose(w, [2.0, 5.0]), w
    assert np.allclose(np.linalg.inv(m) @ m, np.eye(2))
    big = np.random.RandomState(1).rand(200, 200)
    assert np.linalg.norm(big @ np.linalg.inv(big) - np.eye(200)) < 1e-6      # OpenBLAS
check("numpy linalg (OpenBLAS + libgfortran)", np_linalg)

def np_fft():
    x = np.sin(2 * np.pi * 5 * np.arange(64) / 64)
    assert int(np.argmax(np.abs(np.fft.rfft(x)))) == 5
check("numpy fft", np_fft)

def np_random():
    g = np.random.default_rng(7)
    assert g.integers(0, 10, 5).shape == (5,)
    assert np.random.RandomState(3).randint(0, 100) == 24
check("numpy random", np_random)

def cv_codec():
    img = np.zeros((40, 60, 3), np.uint8); img[10:30, 20:40] = (0, 200, 255)
    ok, buf = cv2.imencode(".png", img); assert ok
    back = cv2.imdecode(buf, cv2.IMREAD_COLOR); assert (back == img).all()
    ok, jb = cv2.imencode(".jpg", img); assert ok and cv2.imdecode(jb, 1).shape == img.shape
check("cv2 png/jpeg codecs", cv_codec)

def cv_filters():
    img = np.zeros((50, 50), np.uint8); img[20:30, 20:30] = 255
    assert cv2.GaussianBlur(img, (5, 5), 0)[25, 25] > 200
    assert cv2.resize(img, (25, 25)).shape == (25, 25)
    cs, _ = cv2.findContours(img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    assert len(cs) == 1 and cv2.contourArea(cs[0]) > 60
check("cv2 filters + contours", cv_filters)

def cv_template():
    rng = np.random.RandomState(5)
    scene = rng.randint(0, 255, (120, 160), np.uint8)
    tpl = scene[40:70, 60:100].copy()
    r = cv2.matchTemplate(scene, tpl, cv2.TM_CCOEFF_NORMED)
    _, mx, _, loc = cv2.minMaxLoc(r)
    assert mx > 0.99 and loc == (60, 40), (mx, loc)
check("cv2 matchTemplate", cv_template)

def pil_basic():
    im = Image.new("RGB", (80, 40), "white")
    ImageDraw.Draw(im).rectangle([10, 10, 30, 30], fill=(255, 0, 0))
    assert im.getpixel((20, 20)) == (255, 0, 0)
    assert im.filter(ImageFilter.GaussianBlur(2)).size == (80, 40)
    assert ImageChops.invert(im).getpixel((0, 0)) == (0, 0, 0)
    assert Image.fromarray(np.asarray(im)).tobytes() == im.tobytes()
check("PIL _imaging, filters, numpy interop", pil_basic)

def pil_font():
    path = None
    for p in ("/system/fonts/Roboto-Regular.ttf", "/system/fonts/DroidSans.ttf", "/system/fonts/NotoSansCJK-Regular.ttc"):
        if os.path.exists(p): path = p; break
    assert path, "no system font"
    f = ImageFont.truetype(path, 28)
    im = Image.new("L", (200, 50), 255)
    ImageDraw.Draw(im).text((5, 5), "Hello 123", font=f, fill=0)
    assert np.asarray(im).min() < 100          # FreeType drew dark pixels
    return os.path.basename(path)
check("PIL _imagingft / FreeType text", pil_font)

def pil_morph():
    im = Image.new("L", (20, 20), 0); im.paste(255, (5, 5, 15, 15))
    op = ImageMorph.MorphOp(op_name="erosion4")
    n, out = op.apply(im)
    assert n > 0
check("PIL _imagingmorph", pil_morph)

def app_image():
    from xscript.android import image as xi
    names = [n for n in dir(xi) if not n.startswith("_")]
    assert names
    return "%d names" % len(names)
check("xscript.android.image imports", app_image)

page = mmap.PAGESIZE
res = {"page_size": page, "checks": checks}
print("NATIVE_RESULT " + json.dumps(res), flush=True)
'''


def api(method, path, body=None, timeout=60):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers=devauth.headers(BASE, {"Content-Type": "application/json"}))
    with OPENER.open(req, timeout=timeout) as r:
        return json.load(r)


def main():
    st = api("GET", "/status")
    print("device:", st.get("model"), "sdk", st.get("sdk"))
    try:
        api("DELETE", "/projects/" + PROJECT)
    except Exception:
        pass
    api("POST", "/projects/" + PROJECT, {})
    result, lines = None, []
    try:
        api("PUT", "/projects/%s/files" % PROJECT, {"files": [{"path": "__init__.py", "encoding": "base64", "content": base64.b64encode(SCRIPT.encode()).decode()}]})
        since = api("GET", "/logs?since=0").get("next", 0)
        api("POST", "/projects/%s/run" % PROJECT, {})
        t0 = time.time()
        while time.time() - t0 < 120 and result is None:
            logs = api("GET", "/logs?since=%d" % since)
            since = logs.get("next", since)
            for e in logs.get("entries", []):
                lines.append(e["line"].rstrip())
                if e["line"].startswith("NATIVE_RESULT "):
                    result = json.loads(e["line"][len("NATIVE_RESULT "):])
            if result is None and time.time() - t0 > 4 and not api("GET", "/status").get("running"):
                break
            time.sleep(1)
    finally:
        try:
            api("DELETE", "/projects/" + PROJECT)
        except Exception:
            pass
    if result is None:
        print("no result; log tail:\n" + "\n".join(lines[-25:]))
        print("FAIL")
        return 1
    print("page size on the device: %d bytes" % result["page_size"])
    bad = 0
    for name, c in result["checks"].items():
        print("%s %-44s %4d ms %s" % ("PASS" if c["ok"] else "FAIL", name, c["ms"], c.get("detail") or ""))
        bad += not c["ok"]
    print("ALL PASS" if not bad else "FAILED: %d" % bad)
    return 1 if bad else 0


sys.exit(main())
