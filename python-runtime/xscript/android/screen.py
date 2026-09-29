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


def ocr(rect=None, image=None):
    """All text lines → [OcrResult(text, rect, center_x, center_y, confidence)]."""
    return _img.ocr(rect, image)


def ocr_find(pattern, rect=None, image=None):
    hits = _img.ocr_filter(_img.ocr(rect, image), pattern)
    return hits[0] if hits else None


def ocr_find_all(pattern, rect=None, image=None):
    return _img.ocr_filter(_img.ocr(rect, image), pattern)


def ocr_wait(pattern, timeout=10, rect=None):
    deadline = time.time() + float(timeout)
    while True:
        hit = ocr_find(pattern, rect)
        if hit or time.time() >= deadline:
            return hit
        time.sleep(0.3)


def ocr_click(pattern, timeout=0, rect=None):
    hit = ocr_wait(pattern, timeout, rect) if timeout else ocr_find(pattern, rect)
    if not hit:
        return False
    from xscript.android import action

    return action.click(hit.center_x, hit.center_y)


def imread(path):
    """cv2.imread that handles non-ASCII paths."""
    return _img.imread(path)
