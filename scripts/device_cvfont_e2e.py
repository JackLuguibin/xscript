#!/usr/bin/env python3
"""CvFontLib (图片字库) end to end on a real device or emulator.

Renders real glyph images with a TrueType font (Pillow, on the host), uploads them as a project, runs a project
script on the device that recognises several rendered "screens" with CvFontLib (file templates and ndarray
templates), and compares the text the device read with what was drawn. Needs numpy/OpenCV on the device, so use a
a 16 KB- or 4 KB-page emulator (the app enables Android's 16 KB backcompat mode, see docs/功能对照.md).

    adb -s emulator-5556 forward tcp:19861 tcp:9860
    python3 scripts/device_cvfont_e2e.py http://127.0.0.1:19861

Creates and deletes its own project (`_cvfont_e2e`). Exits non-zero on any mismatch.
"""
import base64
import io
import json
import os
import random
import sys
import time
import urllib.request

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    raise SystemExit("needs Pillow on the host: pip install pillow")

os.environ.setdefault("no_proxy", "127.0.0.1,localhost")
BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9860").rstrip("/")
PROJECT = "_cvfont_e2e"
FONTS = {
    "mono": ["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"],
    "sans": ["/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
}
CHARS = "0123456789:-"
ORDER = "0123456789:-"      # glyph order: digits first, the small ':' and '-' last (see CvFontLib docs)


def font(kind, size):
    for p in FONTS[kind]:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    raise SystemExit("no TrueType font found for " + kind)


def glyph_image(fnt, ch):
    canvas = Image.new("L", (80, 80), 0)
    ImageDraw.Draw(canvas).text((10, 10), ch, font=fnt, fill=255)
    return canvas.crop(canvas.getbbox()).convert("RGB")


def screen_image(fnt, lines, width=340, height=None, gap=5, bg=0, noise=0, seed=1):
    height = height or 20 + 46 * len(lines)
    img = Image.new("L", (width, height), bg)
    d = ImageDraw.Draw(img)
    for row, (x0, text) in enumerate(lines):
        x = x0
        for ch in text:
            g = glyph_image(fnt, ch)
            img.paste(g.convert("L"), (x, 14 + 46 * row + (28 - g.size[1]) // 2 if ch in "-" else 14 + 46 * row))
            x += g.size[0] + gap
    if noise:
        rnd = random.Random(seed)
        px = img.load()
        for yy in range(img.size[1]):
            for xx in range(img.size[0]):
                px[xx, yy] = max(0, min(255, px[xx, yy] + rnd.randint(-noise, noise)))
    return img.convert("RGB")


def png(img):
    b = io.BytesIO()
    img.save(b, "PNG")
    return b.getvalue()


def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=30) as r:
        return json.load(r)


DEVICE_SCRIPT = r'''
import json, os, time
import cv2
import numpy as np
from ascript.android.screen.gp_tasks import CvFontLib

root = os.path.dirname(os.path.abspath(__file__))
cases = json.load(open(os.path.join(root, "cases.json")))

def img(name):
    im = cv2.imread(os.path.join(root, "res", "img", name))
    assert im is not None, name
    return im

out = []
for c in cases:
    parts = [os.path.join(root, "res", "img", c["set"] + "_" + ("colon" if ch == ":" else "dash" if ch == "-" else ch) + ".png") for ch in c["order"]]
    if c.get("ndarray"):
        parts = [cv2.imread(p) for p in parts]
    t0 = time.time()
    kw = {k: c[k] for k in ("confidence", "spacing", "rect") if k in c}
    res = CvFontLib(parts, list(c["order"]), **kw).run(img(c["screen"]))
    d = res.data or {}
    out.append({"name": c["name"], "text": d.get("text", ""), "group": d.get("group", []),
                "ms": int((time.time() - t0) * 1000), "n": sum(len(w) for w in d.get("words", []))})
    helper = CvFontLib.recognize(parts, list(c["order"]), image=img(c["screen"]), **kw)
    out[-1]["recognize"] = helper
print("CVFONT_RESULT " + json.dumps(out, ensure_ascii=False))
print("CVFONT_DONE")
'''


def main():
    st = api("GET", "/status")
    print("device:", st.get("model"), "sdk", st.get("sdk"))
    assert not st.get("running"), "a user project is running"
    mono, sans = font("mono", 30), font("sans", 30)
    files, screens = [], {}
    for set_name, fnt in (("mono", mono), ("sans", sans)):
        for ch in CHARS:
            name = "colon" if ch == ":" else "dash" if ch == "-" else ch
            files.append(("res/img/%s_%s.png" % (set_name, name), png(glyph_image(fnt, ch))))
    spec = [  # name, glyph set, screen font, lines, expected text, extra
        ("clean mono digits+punctuation", "mono", mono, [(12, "2026-10:15")], "2026-10:15", {}),
        ("repeated glyphs", "mono", mono, [(12, "1212-7777")], "1212-7777", {}),
        ("two lines read top to bottom", "mono", mono, [(12, "12:30"), (40, "45-67")], "12:3045-67", {"spacing": 8}),
        ("sans font", "sans", sans, [(12, "0987-654:321")], "0987-654:321", {}),
        ("noise needs lower confidence", "mono", mono, [(12, "3141:59")], "3141:59", {"confidence": 0.7, "noise": 18}),
        ("bright background inverted? (wrong polarity must not read)", "mono", mono, [(12, "2026")], "", {"bg": 255, "confidence": 0.95}),
        ("wrong font does not read at 0.95", "mono", sans, [(12, "2026-10")], "", {}),
        ("ndarray templates", "mono", mono, [(12, "8051")], "8051", {"ndarray": True}),
    ]
    cases = []
    for i, (name, gset, fnt, lines, expect, extra) in enumerate(spec):
        extra = dict(extra)
        scr = "screen%d.png" % i
        img = screen_image(fnt, lines, bg=extra.pop("bg", 0), noise=extra.pop("noise", 0))
        if name.startswith("bright"):    # same text drawn dark-on-light: templates are light-on-dark
            from PIL import ImageOps
            img = ImageOps.invert(img)
        files.append(("res/img/" + scr, png(img)))
        cases.append(dict({"name": name, "set": gset, "order": ORDER, "screen": scr, "expect": expect}, **extra))
    # a rect case: only the second line is searched (result coordinates stay in the full image)
    files.append(("res/img/screen_rect.png", png(screen_image(mono, [(12, "11"), (40, "22")]))))
    cases.append({"name": "rect keeps only the second line", "set": "mono", "order": ORDER, "screen": "screen_rect.png", "expect": "22", "rect": [0, 56, 340, 112]})
    files.append(("cases.json", json.dumps(cases).encode()))
    files.append(("__init__.py", DEVICE_SCRIPT.encode()))

    try:
        api("DELETE", "/projects/" + PROJECT)
    except Exception:
        pass
    api("POST", "/projects/" + PROJECT, {})
    try:
        api("PUT", "/projects/%s/files" % PROJECT, {"files": [
            {"path": p, "encoding": "base64", "content": base64.b64encode(data).decode()} for p, data in files]})
        since = api("GET", "/logs?since=0").get("next", 0)
        print("run:", api("POST", "/projects/%s/run" % PROJECT, {}))
        deadline, lines_seen, result, t_start = time.time() + 120, [], None, time.time()
        while time.time() < deadline:
            logs = api("GET", "/logs?since=%d" % since)
            since = logs.get("next", since)
            for e in logs.get("entries", []):
                lines_seen.append(e["line"].rstrip())
                if e["line"].startswith("CVFONT_RESULT "):
                    result = json.loads(e["line"][len("CVFONT_RESULT "):])
            if result is not None or (time.time() - t_start > 4 and not api("GET", "/status").get("running")):
                time.sleep(0.5)
                for e in api("GET", "/logs?since=%d" % since).get("entries", []):
                    lines_seen.append(e["line"].rstrip())
                    if e["line"].startswith("CVFONT_RESULT "):
                        result = json.loads(e["line"][len("CVFONT_RESULT "):])
                break
            time.sleep(0.4)
        if result is None:
            print("no result from the device script; log:")
            print("\n".join(lines_seen[-25:]))
            if any("dlopen failed" in l or "libgfortran" in l for l in lines_seen):
                print("(numpy cannot load: check the APK with scripts/check_16kb.py and that android:pageSizeCompat is in the manifest)")
            return 2
        bad = 0
        print("%-62s %-14s %-14s %s" % ("case", "expected", "device read", "ms"))
        for c, r in zip(cases, result):
            ok = r["text"] == c["expect"] and r["recognize"] == c["expect"]
            bad += not ok
            print("%-62s %-14s %-14s %4d %s" % (c["name"][:62], c["expect"] or "(nothing)", r["text"] or "(nothing)", r["ms"], "ok" if ok else "MISMATCH recognize=%r group=%r" % (r["recognize"], r["group"])))
        print("PASS" if not bad else "FAIL: %d mismatches" % bad)
        return 1 if bad else 0
    finally:
        try:
            api("POST", "/stop", {})
        except Exception:
            pass
        api("DELETE", "/projects/" + PROJECT)


if __name__ == "__main__":
    sys.exit(main())
