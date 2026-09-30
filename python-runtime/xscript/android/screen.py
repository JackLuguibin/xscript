"""Screen capture, color and image search, OCR.

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


def compare_colors(colors, sim=0.9, image=None):
    """True if all color points match at their positions. `colors` = 'x,y,#RRGGBB|...'."""
    return _img.compare_colors(colors, sim=sim, image=image)


def find_colors(colors, rect=None, sim=0.9, space=5, ori=2, image=None):
    """First match of a multi-point color pattern → Point or None."""
    hits = _img.find_colors(colors, rect, sim, space, ori, 1, image)
    return hits[0] if hits else None


def find_all_colors(colors, rect=None, sim=0.9, space=5, ori=2, max_num=0, image=None):
    return _img.find_colors(colors, rect, sim, space, ori, max_num, image)


def find_image(template, rect=None, confidence=0.9, rgb=False, scale_range=None, image=None):
    """Best template match → dict {center_x, center_y, rect, confidence, ...} or None."""
    hits = _img.find_templates(template, rect, confidence, rgb, 1, scale_range, image)
    return hits[0] if hits else None


def find_all_images(template, rect=None, confidence=0.9, rgb=False, maxcnt=0, scale_range=None, image=None):
    return _img.find_templates(template, rect, confidence, rgb, maxcnt, scale_range, image)


OCR_MLKIT = "mlkit"
OCR_PADDLE = "paddle"      # PP-OCRv5 (downloaded on first use)
OCR_PADDLE_V4 = "paddle_v4"
_ocr_engine = {"name": OCR_MLKIT}


def set_ocr_engine(name):
    """Default OCR engine: "mlkit" (built in), "paddle" (PP-OCRv5) or "paddle_v4"."""
    if name not in (OCR_MLKIT, OCR_PADDLE, OCR_PADDLE_V4):
        raise ValueError("engine must be mlkit, paddle or paddle_v4")
    _ocr_engine["name"] = name


def ocr(rect=None, image=None, engine=None, confidence=None):
    """All text lines → [OcrResult(text, rect, center_x, center_y, confidence)].

    engine: None (the default from set_ocr_engine), "mlkit", "paddle" or "paddle_v4".
    PaddleOCR loads its models on first use (about 1 s per full screen afterwards), reads
    small Chinese text better and works on emulators where ML Kit cannot run.
    confidence: drop lines below it. Default 0 for ML Kit, 0.5 for PaddleOCR (which
    otherwise reports icons as low-confidence "text").
    """
    name = engine or _ocr_engine["name"]
    if name == OCR_MLKIT:
        res = _img.ocr(rect, image)
        return [r for r in res if not confidence or r.confidence >= confidence]
    from xscript.android import paddle

    conf = 0.5 if confidence is None else confidence
    return paddle.engine("v4" if name == OCR_PADDLE_V4 else "v5").ocr(image, rect, conf)


def ocr_find(pattern, rect=None, image=None, engine=None):
    hits = _img.ocr_filter(ocr(rect, image, engine), pattern)
    return hits[0] if hits else None


def ocr_find_all(pattern, rect=None, image=None, engine=None):
    return _img.ocr_filter(ocr(rect, image, engine), pattern)


def ocr_wait(pattern, timeout=10, rect=None, engine=None):
    deadline = time.time() + float(timeout)
    while True:
        hit = ocr_find(pattern, rect, engine=engine)
        if hit or time.time() >= deadline:
            return hit
        time.sleep(0.3)


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
