"""Screen capture, color and image search, OCR, AI vision.

    from xscript.android import screen
    screen.capture()                                  # PNG path on device
    img = screen.capture_cv()                         # BGR ndarray
    screen.find_colors("100,200,#FF0000|110,200,#FFFFFF", sim=0.9)
    screen.find_image(R.img("ok.png"), confidence=0.85)
    screen.ocr_find("确定")
"""

import time

from xscript.android import image as _img
from xscript.android.image import OcrResult, Point  # noqa: F401
from xscript.runtime.bridge import bridge


def capture(path=None):
    """Save a PNG on the device. Returns the file path or None."""
    result = bridge.capture_to_file("" if path is None else str(path))
    return str(result) if result else None


def capture_cv(rect=None):
    """BGR numpy array of the screen (or [l, t, r, b] region)."""
    return _img.capture_bgr(rect)


def capture_bitmap(rect=None):
    """android.graphics.Bitmap of the screen (or region)."""
    r = _img._norm_rect(rect) or (0, 0, 0, 0)
    return bridge.capture_bitmap(*r)


def capture_pil(rect=None):
    from PIL import Image

    rgba = _img.capture_rgba(rect)
    return None if rgba is None else Image.fromarray(rgba[:, :, :3].copy(), "RGB")


def cache(enabled=True):
    """Freeze one frame for all following searches (faster multi-feature checks)."""
    return _img.set_cache(enabled) is not None if enabled else _img.set_cache(False)


def size():
    """(width, height) in pixels."""
    import json

    s = json.loads(bridge.control("status", "") or "{}")
    return int(s.get("width", 0)), int(s.get("height", 0))


def get_color(x, y, image=None):
    """'#rrggbb' at (x, y) or None."""
    px = _img.get_pixel(x, y, image)
    return None if px is None else "#%02x%02x%02x" % px


def compare_colors(colors, sim=0.9, image=None, color_space="rgb", tolerance=None):
    """True if all color points match at their positions. `colors` = 'x,y,#RRGGBB|...'.

    color_space: "rgb" (default, per-channel ±tolerance), "hsv" (survives dimming / night mode) or "lab"
    (perceptual delta E). `tolerance` defaults from `sim`; see docs/API.md.
    """
    return _img.compare_colors(colors, sim=sim, image=image, color_space=color_space, tolerance=tolerance)


def find_colors(colors, rect=None, sim=0.9, space=5, ori=2, image=None, color_space="rgb", tolerance=None):
    """First match of a multi-point color pattern → Point or None. `space` = min distance between results."""
    hits = _img.find_colors(colors, rect, sim, space, ori, 1, image, color_space, tolerance)
    return hits[0] if hits else None


def find_all_colors(colors, rect=None, sim=0.9, space=5, ori=2, max_num=0, image=None, color_space="rgb",
                    tolerance=None):
    return _img.find_colors(colors, rect, sim, space, ori, max_num, image, color_space, tolerance)


def count_color(color, rect=None, sim=0.9, image=None, color_space="rgb", tolerance=None):
    """Pixels in `rect` matching `color` ('#rrggbb', several joined by '|')."""
    return _img.count_color(color, rect, sim, image, color_space, tolerance)


def find_color_blobs(color, rect=None, sim=0.9, color_space="hsv", tolerance=None, min_area=50, max_num=0,
                     image=None):
    """Connected regions of a colour → [{rect, center_x, center_y, area, fill}], largest first."""
    return _img.find_color_blobs(color, rect, sim, color_space, tolerance, min_area, max_num, image)


def dominant_colors(rect=None, k=3, image=None):
    """Main colours of a region (k-means in Lab) → [{color: '#rrggbb', rgb, ratio}], most common first."""
    return _img.dominant_colors(rect, k, image)


def find_image(template, rect=None, confidence=0.9, rgb=False, scale_range=None, image=None, method=None):
    """Best match → dict {center_x, center_y, rect, confidence, quad, angle, scale, method, ...} or None.

    method: None/"template" (default), "multiscale", "feature" (any scale / rotation), "auto" (template, then
    features) or "hash" (is `rect` the same picture). See docs/API.md.
    """
    hits = _img.find_templates(template, rect, confidence, rgb, 1, scale_range, image, method=method)
    return hits[0] if hits else None


def find_all_images(template, rect=None, confidence=0.9, rgb=False, maxcnt=0, scale_range=None, image=None,
                    method=None):
    return _img.find_templates(template, rect, confidence, rgb, maxcnt, scale_range, image, method=method)


OCR_MLKIT = "mlkit"
OCR_AUTO = "auto"          # PP-OCRv6 tiny, ML Kit if its models cannot be loaded
OCR_PADDLE = "paddle"      # PP-OCRv5 (downloaded on first use)
OCR_PADDLE_V4 = "paddle_v4"
OCR_PADDLE_V6T = "paddle_v6t"
OCR_PADDLE_V6S = "paddle_v6s"
OCR_ENGINES = (OCR_MLKIT, OCR_AUTO, OCR_PADDLE, OCR_PADDLE_V4, OCR_PADDLE_V6T, OCR_PADDLE_V6S)
_ocr_engine = {"name": OCR_MLKIT}


def set_ocr_engine(name):
    """Default OCR engine: "mlkit" (built in), "auto", "paddle" (PP-OCRv5), "paddle_v4",
    "paddle_v6t" (PP-OCRv6 tiny) or "paddle_v6s" (PP-OCRv6 small)."""
    if name not in OCR_ENGINES:
        raise ValueError("engine must be one of " + ", ".join(OCR_ENGINES))
    _ocr_engine["name"] = name


def ocr(rect=None, image=None, engine=None, confidence=None):
    """All text lines → [OcrResult(text, rect, center_x, center_y, confidence)].

    engine: None (the default from set_ocr_engine), "mlkit", "auto", "paddle" (PP-OCRv5),
    "paddle_v4", "paddle_v6t" or "paddle_v6s". PaddleOCR models are downloaded on first use.
    "paddle_v6t" (PP-OCRv6 tiny, ~6 MB) is the fastest and, on Chinese UI text, more accurate
    than v5; "auto" uses it and falls back to ML Kit when it cannot be loaded.
    confidence: drop lines below it. Default 0 for ML Kit, 0.5 for PaddleOCR (which
    otherwise reports icons as low-confidence "text").
    """
    name = engine or _ocr_engine["name"]

    def mlkit():
        res = _img.ocr(rect, image)
        return [r for r in res if not confidence or r.confidence >= confidence]

    if name == OCR_MLKIT:
        return mlkit()
    from xscript.android import paddle

    conf = 0.5 if confidence is None else confidence
    return paddle._run_engine(name, image, rect, conf, mlkit)


def ocr_find(pattern, rect=None, image=None, engine=None):
    hits = _img.ocr_filter(ocr(rect, image, engine), pattern)
    return hits[0] if hits else None


def ocr_find_all(pattern, rect=None, image=None, engine=None):
    return _img.ocr_filter(ocr(rect, image, engine), pattern)


def ocr_wait(pattern, timeout=10, rect=None, engine=None, interval=0.3):
    """OCR every `interval` seconds until `pattern` shows up or `timeout` seconds pass (one last look at the deadline)."""
    deadline = time.monotonic() + float(timeout)
    while True:
        hit = ocr_find(pattern, rect, engine=engine)
        left = deadline - time.monotonic()
        if hit or left <= 0:
            return hit
        time.sleep(min(float(interval), left))


def ocr_click(pattern, timeout=0, rect=None, engine=None):
    hit = ocr_wait(pattern, timeout, rect, engine) if timeout else ocr_find(pattern, rect, engine=engine)
    if not hit:
        return False
    from xscript.android import action

    return action.click(hit.center_x, hit.center_y)


def detect(model, rect=None, conf=0.25, iou=0.45, image=None, classes=None):
    """YOLO detections on the screen: `model` is an .onnx path or a loaded `yolo.Yolo`."""
    from xscript.android import yolo

    m = yolo.load(model) if isinstance(model, str) else model
    return m.detect(image=image, rect=rect, conf=conf, iou=iou, classes=classes)


def imread(path):
    """cv2.imread that handles non-ASCII paths."""
    return _img.imread(path)


def ai_find(target, rect=None, image=None, confidence=0.0):
    """Locate an element described in words via ai.config()'s endpoint; dict or None."""
    from xscript.android import ai
    return ai.find(target, rect, image, confidence)


def ai_find_all(target, rect=None, image=None, limit=5, confidence=0.0):
    from xscript.android import ai
    return ai.find_all(target, rect, image, limit, confidence)


def ai_ask(question, rect=None, image=None):
    """Ask a vision model a question about the screen; returns text."""
    from xscript.android import ai
    return ai.ask(question, rect, image)


def ai_click(target, timeout=0, rect=None):
    from xscript.android import ai
    return ai.click(target, timeout, rect)
