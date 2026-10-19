"""Reproducible benchmarks of the core algorithm paths (screen/image/OCR/ONNX/bridge).

Runs unchanged on a PC (python-runtime on sys.path, numpy + cv2 + onnxruntime) and on the device
(uploaded as a project by scripts/bench_algo.py). Frames are synthetic and seeded, so runs compare.
`run(only=None, repeat=None)` returns {"env", "results": [{"name", "n", "median_ms", "p95_ms", ...}]}.
"""

import json
import os
import struct
import sys
import tempfile
import time

import cv2
import numpy as np

from xscript.android import image as _img
from xscript.runtime.bridge import bridge

W, H = 1080, 2400
_TMP = tempfile.mkdtemp(prefix="xsbench")


def _frame():
    """A UI-like 1080x2400 BGR frame: flat background, cards, text, icons, mild noise."""
    rng = np.random.RandomState(7)
    img = np.full((H, W, 3), (245, 243, 242), np.uint8)
    for i in range(12):
        y = 120 + i * 180
        cv2.rectangle(img, (24, y), (W - 24, y + 150), (255, 255, 255), -1)
        cv2.circle(img, (90, y + 75), 36, (int(rng.randint(40, 220)), int(rng.randint(40, 220)), 200), -1)
        cv2.putText(img, "Item %02d settings" % i, (150, y + 90), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (40, 40, 40), 3)
    cv2.rectangle(img, (700, 2210), (1000, 2330), (60, 120, 230), -1)
    cv2.putText(img, "HELLO 2026", (40, 2290), cv2.FONT_HERSHEY_SIMPLEX, 2.2, (0, 0, 0), 5)
    noise = rng.randint(-3, 4, img.shape).astype(np.int16)
    return np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)


def _stats(name, times, **extra):
    t = sorted(times)
    p95 = t[min(len(t) - 1, int(round(0.95 * (len(t) - 1))))]
    out = {"name": name, "n": len(t), "median_ms": round(t[len(t) // 2] * 1000, 3), "p95_ms": round(p95 * 1000, 3)}
    out.update(extra)
    return out


def _time(fn, n, warmup=1):
    for _ in range(warmup):
        fn()
    ts = []
    for _ in range(n):
        t0 = time.perf_counter()
        fn()
        ts.append(time.perf_counter() - t0)
    return ts


def _write(name, img):
    p = os.path.join(_TMP, name)
    cv2.imwrite(p, img)
    return p


def cases(repeat=None):
    """(name, setup -> callable, n, device_only) in run order."""
    frame = _frame()
    f = lambda n: repeat or n  # noqa: E731
    raw = struct.pack("<ii", W, H) + np.dstack([frame[:, :, ::-1], np.full((H, W), 255, np.uint8)]).tobytes()
    tpl = frame[1200:1290, 600:700].copy()                       # 100x90 text patch
    tpl_small = frame[2242:2278, 52:88].copy()                   # 36x36 inside "HELLO"
    tpl_path = _write("tpl.png", tpl)
    tpl_small_path = _write("tpl_small.png", tpl_small)
    absent = np.random.RandomState(3).randint(0, 255, (80, 80, 3)).astype(np.uint8)  # textured, not on screen
    absent_path = _write("absent.png", absent)
    bgra = np.dstack([tpl, np.where(np.arange(90)[:, None] % 3 == 0, 0, 255).repeat(100, 1).astype(np.uint8)])
    masked_path = _write("masked.png", bgra)
    many = [_write("m%d.png" % i, frame[300 + i * 180:360 + i * 180, 140:400].copy()) for i in range(5)]
    px = frame[2270, 850]
    colors = "850,2270,#%02x%02x%02x|870,2270,#%02x%02x%02x|850,2300,#%02x%02x%02x" % (
        tuple(int(v) for v in frame[2270, 850][::-1]) + tuple(int(v) for v in frame[2270, 870][::-1])
        + tuple(int(v) for v in frame[2300, 850][::-1]))
    colors_absent = "10,10,#00ff00|30,10,#ff00ff|10,30,#0000ff"
    cmp10 = "|".join("%d,%d,#%02x%02x%02x" % ((x, y) + tuple(int(v) for v in frame[y, x][::-1]))
                     for x, y in [(100 + 90 * i, 200 + 200 * i) for i in range(10)])
    del px

    yield "frame.raw_to_bgr", lambda: _img.rgba_to_bgr(_img.raw_to_rgba(raw)), f(30), False
    yield "frame.bgr_to_raw", lambda: _img.bgr_to_raw(frame), f(20), False
    yield "colors.compare_10pt", lambda: _img.compare_colors(cmp10, 0.9, frame), f(50), False
    yield "colors.find_3pt_hit", lambda: _img.find_colors(colors, None, 0.9, 5, 2, 1, frame), f(20), False
    yield "colors.find_3pt_absent", lambda: _img.find_colors(colors_absent, None, 0.9, 5, 2, 1, frame), f(20), False
    yield "colors.find_3pt_all", lambda: _img.find_colors(colors, None, 0.95, 5, 2, 0, frame), f(20), False
    yield "image.find_1", lambda: _img.find_templates(tpl_path, None, 0.9, False, 1, None, frame), f(20), False
    yield "image.find_all", lambda: _img.find_templates(tpl_path, None, 0.9, False, 0, None, frame), f(10), False
    yield "image.find_small", lambda: _img.find_templates(tpl_small_path, None, 0.9, False, 1, None, frame), f(20), False
    yield "image.find_absent", lambda: _img.find_templates(absent_path, None, 0.9, False, 1, None, frame), f(20), False
    yield "image.find_multiscale", lambda: _img.find_templates(tpl_path, None, 0.85, False, 1, (0.8, 1.2), frame), f(10), False
    yield "image.find_masked", lambda: _img.find_templates(masked_path, None, 0.85, False, 1, None, frame), f(10), False
    yield "image.find_5_templates", lambda: _img.find_templates(many, None, 0.9, False, 0, None, frame), f(10), False
    yield "image.find_rgb", lambda: _img.find_templates(tpl_path, None, 0.9, True, 1, None, frame), f(10), False

    # Device-only: real capture, ML Kit, the Java bridge.
    yield "bridge.call_overhead", lambda: bridge.is_accessibility_on(), f(200), True
    yield "capture.raw_full", lambda: bridge.capture_raw(0, 0, 0, 0), f(15), True
    yield "capture.bgr_full", lambda: _img.capture_bgr(None), f(15), True
    yield "capture.find_colors_live", lambda: _img.find_colors(colors_absent, None, 0.9, 5, 2, 1, None), f(15), True
    hello = np.full((120, 480, 3), 255, np.uint8)
    cv2.putText(hello, "HELLO 2026", (10, 80), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 0), 4)
    yield "ocr.mlkit_small_ndarray", lambda: _img.ocr(None, hello), f(15), True
    yield "ocr.mlkit_full_ndarray", lambda: _img.ocr(None, frame), f(8), True


def _onnx_cases(repeat):
    """Tiny model: bridge/marshalling overhead. Paddle det: real inference (needs the models)."""
    from xscript.android import onnx as _onnx
    import base64

    p = os.path.join(_TMP, "sq.onnx")
    with open(p, "wb") as fh:
        fh.write(base64.b64decode(
            "CAg6PgoOCgF4CgF4EgF5IgNNdWwSAnNxWhMKAXgSDgoMCAESCAoCCAEKAggEYhMKAXkSDgoMCAESCAoCCAEKAggEQgQKABAN"))
    m = _onnx.load(p, 1)
    x = np.arange(4, dtype=np.float32).reshape(1, 4) + 1
    yield _stats("onnx.tiny_run", _time(lambda: m.run(x), repeat or 100), ok=bool(np.allclose(m.run_first(x), x * x)))


def _paddle_cases(repeat, frame):
    from xscript.android import paddle

    t0 = time.perf_counter()
    eng = paddle.engine("v5")
    load = time.perf_counter() - t0
    t0 = time.perf_counter()
    first = eng.ocr(frame, None, 0.5)
    cold = time.perf_counter() - t0
    texts = [r.text for r in first]
    yield _stats("ocr.paddle_load", [load])
    yield _stats("ocr.paddle_full_cold", [cold], lines=len(texts), hello=any("HELLO 2026" in t for t in texts))
    yield _stats("ocr.paddle_full_warm", _time(lambda: eng.ocr(frame, None, 0.5), repeat or 5, 0))
    small = frame[2200:2340, 0:540].copy()
    res = []
    yield _stats("ocr.paddle_small_warm", _time(lambda: res.append(eng.ocr(small, None, 0.5)), repeat or 10),
                 text=[r.text for r in res[-1]] if res else [])
    import cProfile
    import io
    import pstats

    pr = cProfile.Profile()
    pr.enable()
    for _ in range(2):
        eng.ocr(frame, None, 0.5)
    pr.disable()
    s = io.StringIO()
    pstats.Stats(pr, stream=s).sort_stats("cumulative").print_stats(25)
    yield {"name": "ocr.paddle_profile", "profile": s.getvalue()[-6000:]}


def run(only=None, repeat=None, paddle=True, profile=None):
    device = bool(bridge.available)
    env = {"device": device, "python": sys.version.split()[0], "numpy": np.__version__, "cv2": cv2.__version__,
           "cpus": os.cpu_count()}
    results = []
    gen = list(cases(repeat))
    for name, fn, n, dev_only in gen:
        if only and not any(name.startswith(o) for o in only):
            continue
        if dev_only and not device:
            continue
        try:
            if name.startswith("ocr.mlkit") and not any(r["name"].startswith("ocr.mlkit") for r in results):
                t0 = time.perf_counter()
                out = fn()
                results.append(_stats(name.replace("ocr.", "ocr.cold_"), [time.perf_counter() - t0],
                                      text=[r.text for r in out]))
            out = []
            ts = _time(lambda: out.append(fn()), n)
            last = out[-1] if out else None
            extra = {}
            if isinstance(last, list):
                extra["hits"] = len(last)
                if last and isinstance(last[0], dict):
                    extra["first"] = [last[0].get("center_x"), last[0].get("center_y"), round(last[0].get("confidence", 0), 3)]
                elif last and hasattr(last[0], "text"):
                    extra["text"] = [r.text for r in last][:6]
                elif last and hasattr(last[0], "x"):
                    extra["first"] = [last[0].x, last[0].y]
            results.append(_stats(name, ts, **extra))
        except Exception as e:  # keep going: one broken path must not hide the rest
            results.append({"name": name, "error": repr(e)[:300]})
    if not only or any(o.startswith("onnx") for o in only):
        try:
            results.extend(_onnx_cases(repeat))
        except Exception as e:
            results.append({"name": "onnx.tiny_run", "error": repr(e)[:300]})
    if paddle and (not only or any(o.startswith("ocr.paddle") for o in only)):
        try:
            results.extend(_paddle_cases(repeat, _frame()))
        except Exception as e:
            results.append({"name": "ocr.paddle", "error": repr(e)[:300]})
    if profile:
        import cProfile
        import io
        import pstats

        fns = {name: fn for name, fn, _, _ in gen}
        pr = cProfile.Profile()
        pr.enable()
        for _ in range(5):
            fns[profile]()
        pr.disable()
        s = io.StringIO()
        pstats.Stats(pr, stream=s).sort_stats("tottime").print_stats(20)
        results.append({"name": "profile." + profile, "profile": s.getvalue()[-6000:]})
    return {"env": env, "results": results}


if __name__ == "__main__":
    print(json.dumps(run(), ensure_ascii=False))
