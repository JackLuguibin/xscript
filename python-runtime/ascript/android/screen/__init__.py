"""ascript.android.screen on XScript: capture, colors, template matching, OCR.

`capture()` returns an android.graphics.Bitmap like AScript. Anywhere AScript accepts
`image=` / `bitmap=` / `source_img=`, a Bitmap, a BGR ndarray, a PIL image or a path works.
"""

import base64 as _b64
import json
import threading
import time

from ascript._compat import warn_once
from ascript.android.screen.gp import GPTask, Result
from xscript.android import image as _img
from xscript.runtime.bridge import bridge

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None
try:
    import cv2
except Exception:  # pragma: no cover
    cv2 = None

IMG_ANDROID_BITMAP = 1
IMG_PYTHON_IMAGE = 2

MODE_FIND = 1
MODE_FIND_ALL = 2
MODE_FIND_SIFT = 3
MODE_FIND_SIFT_ALL = 4
MODE_FIND_TEMPLATE = 5
MODE_FIND_TEMPLATE_ALL = 6

FORMAT_BITMAP = 1
FORMAT_ANDROID_IMAGE = 2
FORMAT_PIL_IMAGE = 3
FORMAT_CV_MAT = 4
FORMAT_IMAGE_DATA = 5

DRAW_THRESHOLD = 0

cache_data = {}
is_cacheing = False
capture_lock = threading.Lock()


# ---------------------------------------------------------------- capture & conversion

def _rect4(x, y, x1, y1):
    if x is None:
        return None
    return [int(x), int(y), int(x1), int(y1)]


def cache(is_cache=False, bitmap=None, file=None, pixel_format=FORMAT_BITMAP):
    """Freeze a frame so following searches reuse it. Call cache(False) to release."""
    global is_cacheing
    is_cacheing = bool(is_cache)
    cache_data.clear()
    if not is_cacheing:
        _img.set_cache(False)
        return None
    if bitmap is not None or file is not None:
        src = file_to_bitmap(file) if file is not None else bitmap
        _img._cached_frame["rgba"] = _img.raw_to_rgba(bridge.bitmap_to_raw(src))
    else:
        _img.set_cache(True)
    cache_data[pixel_format] = capture(pixel_format=pixel_format)
    return cache_data[pixel_format]


def capture(x=None, y=None, x1=None, y1=None, pixel_format=FORMAT_BITMAP):
    rect = _rect4(x, y, x1, y1)
    if is_cacheing and rect is None and pixel_format in cache_data:
        return cache_data[pixel_format]
    with capture_lock:
        if pixel_format == FORMAT_CV_MAT:
            return _img.capture_bgr(rect)
        if pixel_format == FORMAT_PIL_IMAGE:
            return capture_pil(x, y, x1, y1)
        if pixel_format == FORMAT_IMAGE_DATA:
            return _img.capture_rgba(rect)
        if _img._cached_frame["rgba"] is not None:
            rgba = _img.capture_rgba(rect)
            return bridge.raw_to_bitmap(_img.bgr_to_raw(_img.rgba_to_bgr(rgba)))
        r = _img._norm_rect(rect) or (0, 0, 0, 0)
        for _ in range(3):
            bmp = bridge.capture_bitmap(*r)
            if bmp is not None:
                return bmp
            time.sleep(0.1)
        return None


def capture_cv(x=None, y=None, x1=None, y1=None):
    return _img.capture_bgr(_rect4(x, y, x1, y1))


def capture_bitmap(x=None, y=None, x1=None, y1=None):
    return capture(x, y, x1, y1, FORMAT_BITMAP)


def capture_pil(x=None, y=None, x1=None, y1=None):
    from PIL import Image

    rgba = _img.capture_rgba(_rect4(x, y, x1, y1))
    return None if rgba is None else Image.fromarray(np.ascontiguousarray(rgba[:, :, :3]), "RGB")


def bitmap_to_file(path, bitmap=None, quality=100):
    if bitmap is None:
        bitmap = capture()
    if bitmap is None:
        return None
    if np is not None and isinstance(bitmap, np.ndarray):
        ext = "." + (str(path).rsplit(".", 1)[-1] if "." in str(path) else "png")
        ok, buf = cv2.imencode(ext, bitmap, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
        if ok:
            buf.tofile(path)
        return path if ok else None
    return path if bridge.save_bitmap(bitmap, path, quality) else None


def bitmap_crop(bitmap, rect):
    if bitmap is None:
        return None
    from android.graphics import Bitmap

    l, t, r, b = [int(v) for v in rect[:4]]
    return Bitmap.createBitmap(bitmap, l, t, r - l, b - t)


def file_to_bitmap(path, sampleSize=1):
    return bridge.load_bitmap(path, sampleSize)


def bitmap_base64(bitmap=None, mode=0):
    if bitmap is None:
        bitmap = capture()
    img = _img.to_bgr(bitmap)
    ok, buf = cv2.imencode(".png" if mode == 0 else ".jpg", img)
    return _b64.b64encode(buf.tobytes()).decode("ascii") if ok else None


def base64_bitmap(b64=None, mode=0):
    data = np.frombuffer(_b64.b64decode(b64), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    return cvimage_to_bitmap(img)


def bitmap_maxside(bitmap=None, max_side_len=9999):
    img = _img.to_bgr(bitmap)
    h, w = img.shape[:2]
    s = float(max_side_len) / max(h, w)
    if s < 1:
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    return cvimage_to_bitmap(img)


def bitmap_to_pilimage(bitmap=None):
    from PIL import Image

    img = _img.to_bgr(bitmap)
    return Image.fromarray(np.ascontiguousarray(img[:, :, ::-1]), "RGB")


bitmap_to_pilimage_test = bitmap_to_pilimage


def bitmap_to_cvimage(bitmap=None):
    return _img.to_bgr(bitmap)


def cvimage_to_bitmap(cvimg):
    return bridge.raw_to_bitmap(_img.bgr_to_raw(cvimg))


def hex_to_bgr(hex_color):
    r, g, b = _img.hex_to_rgb(hex_color)
    return b, g, r


def get_color_num(colors, rect=None, sim=0.9):
    return Colors.count(colors, rect, sim)


def _ensure_bitmap(image):
    if image is None or hasattr(image, "getPixel"):
        return image
    return cvimage_to_bitmap(_img.to_bgr(image))


def _ensure_cv(image):
    return _img.to_bgr(image)


# orientation listener (not observed on XScript, kept for API shape)
ori_listener = None


def on_ori_change(width, height):
    if ori_listener is not None:
        ori_listener(width, height)


def set_ori_change_listener(obj_listener):
    global ori_listener
    ori_listener = obj_listener


def reset_capture():
    cache(False)


def rbuild():
    return None


# ---------------------------------------------------------------- color

class Color:
    def __init__(self, bitmap_color):
        c = int(bitmap_color) & 0xFFFFFFFF
        self.color = c
        self.a = (c >> 24) & 0xFF
        self.r = (c >> 16) & 0xFF
        self.g = (c >> 8) & 0xFF
        self.b = c & 0xFF
        self.rgb = "#{:02x}{:02x}{:02x}".format(self.r, self.g, self.b)
        self.argb = "#{:02x}{:02x}{:02x}{:02x}".format(self.a, self.r, self.g, self.b)

    def __str__(self):
        return json.dumps({"r": self.r, "g": self.g, "b": self.b, "rgb": self.rgb, "argb": self.argb})

    __repr__ = __str__

    @staticmethod
    def from_hex(hex_str):
        h = hex_str.lstrip("#")
        if len(h) == 6:
            return Color(0xFF000000 | int(h, 16))
        if len(h) == 8:
            return Color(int(h, 16))
        return Color(0)

    @staticmethod
    def make(r, g, b, a=255):
        return Color((a << 24) | (r << 16) | (g << 8) | b)

    @staticmethod
    def distance(c1, c2):
        return ((c1.r - c2.r) ** 2 + (c1.g - c2.g) ** 2 + (c1.b - c2.b) ** 2) ** 0.5

    @staticmethod
    def similar(c1, c2, threshold=30):
        return Color.distance(c1, c2) <= threshold


def get_color(x, y, bitmap=None):
    px = _img.get_pixel(int(x), int(y), bitmap)
    if px is None:
        return None
    r, g, b = px
    return Color((0xFF << 24) | (r << 16) | (g << 8) | b)


def get_colors(bitmap):
    img = _img.to_bgr(bitmap)
    return img


class Colors(GPTask):
    name = "颜色数量"

    def __init__(self, colors, rect=None, sim=1, draw_mode=DRAW_THRESHOLD):
        self.colors, self.rect, self.sim = colors, rect, sim

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        return Result(cv_image, offset_x, offset_y, Colors.count(self.colors, self.rect, self.sim, image=cv_image))

    @staticmethod
    def count(colors, rect=None, sim=1, bitmap=None, image=None):
        src = image if image is not None else bitmap
        total = 0
        for part in str(colors).split("|"):
            part = part.strip()
            if part:
                total += _img.count_color(part.split(",")[-1], rect, sim, src)
        return total


class FindColors(GPTask):
    name = "多点找色"
    RGB = 0
    NORM = 1

    def __init__(self, colors, rect=None, space=5, ori=2, diff=0.98, p_max_num=999999, mode=0):
        self.colors, self.rect, self.space, self.ori = colors, rect, space, ori
        self.diff, self.p_max_num, self.mode = diff, p_max_num, mode

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        pts = FindColors.find_all(self.colors, self.rect, self.space, self.ori, self.diff, cv_image, self.p_max_num) or []
        return Result(cv_image, offset_x, offset_y, [{"x": p.x, "y": p.y} for p in pts])

    @staticmethod
    def _retry(fn, until):
        deadline = time.time() + max(0, until) / 1000.0
        while True:
            res = fn()
            if res or time.time() >= deadline:
                return res
            time.sleep(0.1)

    @staticmethod
    def find(colors, rect=None, space=5, ori=2, diff=0.98, image=None, mode=0, until=0):
        try:
            def once():
                hits = _img.find_colors(colors, rect, diff, space, ori, 1, image)
                return hits[0] if hits else None
            return FindColors._retry(once, until if image is None else 0)
        except Exception as e:
            print(str(e))
            return None

    @staticmethod
    def find_all(colors, rect=None, space=5, ori=2, diff=0.98, image=None, p_max_num=999999, mode=0, until=0):
        try:
            def once():
                return _img.find_colors(colors, rect, diff, space, ori, p_max_num, image) or None
            return FindColors._retry(once, until if image is None else 0)
        except Exception as e:
            print(str(e))
            return None

    @staticmethod
    def find_color(color, rect=None, diff=0.98, mode=0):
        p = FindColors.find("0,0," + color, rect=rect, diff=diff, mode=mode)
        return {"x": p.x, "y": p.y} if p else None

    @staticmethod
    def find_all_color(color, rect=None, diff=0.98, mode=0, max_num=999999):
        pts = FindColors.find_all("0,0," + color, rect=rect, diff=diff, mode=mode, p_max_num=max_num)
        return [{"x": p.x, "y": p.y} for p in pts] if pts else None


class CompareColors(GPTask):
    name = "多点比色"
    RGB = 0
    NORM = 1
    LAB = 2

    def __init__(self, colors, diff=0.9, until=0, mode=0, sim=1.0):
        self.colors, self.diff, self.until, self.mode, self.sim = colors, diff, until, mode, sim

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        return Result(cv_image, offset_x, offset_y, CompareColors.compare(self.colors, self.diff, cv_image, self.mode, 0, self.sim))

    @staticmethod
    def compare(colors, diff=0.9, bitmap=None, mode=0, until=0, sim=1.0, image=None):
        src = image if image is not None else bitmap
        try:
            deadline = time.time() + max(0, until) / 1000.0
            while True:
                ok = _img.compare_colors(colors, sim=diff, image=src, count_sim=sim)
                if ok or src is not None or time.time() >= deadline:
                    return ok
                time.sleep(0.1)
        except Exception as e:
            print(str(e))
            return None

    @staticmethod
    def compare_multi(colors_list, diff=0.9, mode=0, sim=1.0, image=None):
        src = _img.to_bgr(image)
        for i, colors in enumerate(colors_list):
            if _img.compare_colors(colors, sim=diff, image=src, count_sim=sim):
                return i
        return -1


class FindBlock(GPTask):
    """Find areas where `colors` appear densely (count pixels per width×height cell)."""

    name = "找色块"

    def __init__(self, colors, width=50, height=50, count=100, rect=None, diff=0.9, mode=0, space=0, min_area=10,
                 find_mode="find_all"):
        self.args = (colors, width, height, count, rect, diff, mode, space)

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        return Result(cv_image, offset_x, offset_y, FindBlock.find_all(*self.args, image=cv_image))

    @staticmethod
    def _mask(colors, rect, diff, image):
        img = _img.to_bgr(image)
        rect = _img._norm_rect(rect)
        ox = oy = 0
        if rect:
            l, t, r, b = rect
            img = img[t:b, l:r]
            ox, oy = l, t
        mask = None
        for part in str(colors).split("|"):
            part = part.strip()
            if not part:
                continue
            rgb = _img.hex_to_rgb(part.split(",")[-1].split("-")[0])
            m = _img._channel_ok(img, rgb, _img.diff_from_similarity(diff))
            mask = m if mask is None else (mask | m)
        return mask, ox, oy

    @staticmethod
    def find_all(colors, width=50, height=50, count=100, rect=None, diff=0.9, mode=0, space=0, image=None,
                 max_results=200):
        mask, ox, oy = FindBlock._mask(colors, rect, diff, image)
        if mask is None:
            return []
        m = mask.astype(np.uint8)
        k = np.ones((int(height), int(width)), np.float32)
        dens = cv2.filter2D(m.astype(np.float32), -1, k, anchor=(0, 0), borderType=cv2.BORDER_CONSTANT)
        out = []
        while len(out) < max_results:
            _, mv, _, ml = cv2.minMaxLoc(dens)
            if mv < count:
                break
            x, y = ml
            out.append({"x": x + ox + width // 2, "y": y + oy + height // 2, "count": int(mv),
                        "rect": [x + ox, y + oy, x + ox + width, y + oy + height]})
            y0, x0 = max(0, y - height - space), max(0, x - width - space)
            dens[y0:y + height + space, x0:x + width + space] = 0
        return out

    @staticmethod
    def find(colors, width=50, height=50, count=100, rect=None, diff=0.9, mode=0, space=0, image=None):
        res = FindBlock.find_all(colors, width, height, count, rect, diff, mode, space, image, max_results=1)
        return res[0] if res else None

    @staticmethod
    def count_block(colors, rect=None, diff=0.9, mode=0, min_area=10, image=None):
        mask, _, _ = FindBlock._mask(colors, rect, diff, image)
        if mask is None:
            return 0
        n, _, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
        return int(sum(1 for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= min_area))

    @staticmethod
    def get_range(colors, rect=None, diff=0.9, mode=0, min_area=10, image=None):
        mask, ox, oy = FindBlock._mask(colors, rect, diff, image)
        if mask is None or not mask.any():
            return None
        ys, xs = np.nonzero(mask)
        return [int(xs.min()) + ox, int(ys.min()) + oy, int(xs.max()) + ox + 1, int(ys.max()) + oy + 1]


# ---------------------------------------------------------------- images

class FindImages(GPTask):
    name = "找图"
    MODE_TEMPLATE = 0
    MODE_SIFT = 1
    MODE_TAS = 2
    _TEMPLATE_DEFAULT_CONF = 0.9

    def __init__(self, part_img, rect=None, confidence=0.9, rgb=False, maxcnt=0, mode=MODE_TEMPLATE, ori=2):
        self.part_img, self.rect, self.confidence, self.rgb, self.maxcnt = part_img, rect, confidence, rgb, maxcnt

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        res = FindImages.find_all_template(self.part_img, self.rect, self.confidence, self.rgb, self.maxcnt,
                                           source_img=cv_image)
        return Result(cv_image, offset_x, offset_y, res)

    @staticmethod
    def search_image(image_path):
        return _img.imread(image_path)

    @staticmethod
    def find(part_img, rect=None, confidence=None, rgb=False, source_img=None, ori=2, scale_range=None, image=None,
             method="template", fast=True):
        if method == "smart":
            warn_once("smart", "FindImages method='smart' falls back to template matching")
        conf = FindImages._TEMPLATE_DEFAULT_CONF if confidence is None else confidence
        return FindImages.find_template(part_img, rect, conf, rgb, source_img, ori, scale_range, image, fast)

    @staticmethod
    def find_all(part_img, rect=None, confidence=None, rgb=False, source_img=None, maxcnt=0, ori=2,
                 scale_range=None, image=None, method="template", fast=True):
        conf = FindImages._TEMPLATE_DEFAULT_CONF if confidence is None else confidence
        return FindImages.find_all_template(part_img, rect, conf, rgb, maxcnt, source_img, ori, scale_range, image, fast)

    @staticmethod
    def find_sift(part_img, rect=None, confidence=0.9, rgb=False, source_img=None, ori=2, scale_range=None, fast=True):
        return FindImages.find_template(part_img, rect, confidence, rgb, source_img, ori, scale_range)

    @staticmethod
    def find_all_sift(part_img, rect=None, confidence=0.9, rgb=False, source_img=None, maxcnt=0, ori=2,
                      scale_range=None, fast=True):
        return FindImages.find_all_template(part_img, rect, confidence, rgb, maxcnt, source_img, ori, scale_range)

    @staticmethod
    def find_template(part_img, rect=None, confidence=0.9, rgb=False, source_img=None, ori=2, scale_range=None,
                      image=None, fast=True):
        res = FindImages.find_all_template(part_img, rect, confidence, rgb, 1, source_img, ori, scale_range, image, fast)
        return res[0] if res else None

    @staticmethod
    def find_all_template(part_img, rect=None, confidence=0.9, rgb=False, maxcnt=0, source_img=None, ori=2,
                          scale_range=None, image=None, fast=True):
        src = source_img if source_img is not None else image
        if src is not None:
            src = _ensure_cv(src)
        try:
            res = _img.find_templates(part_img, rect, confidence, rgb, maxcnt, scale_range, src,
                                      ori=ori or 2, fast=fast)
        except Exception as e:
            print(str(e))
            return None
        return res or None


_sort_by_ori = _img.sort_by_ori


class YoLov5:
    def __init__(self, model_name=None, path=None):
        raise NotImplementedError("YOLO models are not supported by XScript")


class CodeScanner(GPTask):
    name = "扫码"

    def __init__(self, rect=None):
        self.rect = rect

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        return Result(cv_image, offset_x, offset_y, CodeScanner.scan(self.rect, image=cv_image))

    @staticmethod
    def scan(rect=None, bitmap=None, image=None):
        img = _img.to_bgr(image if image is not None else bitmap)
        if img is None:
            return None
        if rect:
            l, t, r, b = [int(v) for v in rect[:4]]
            img = img[t:b, l:r]
        det = cv2.QRCodeDetector()
        text, pts, _ = det.detectAndDecode(img)
        return [text] if text else None


# ---------------------------------------------------------------- OCR

class Ocr(GPTask):
    name = "OCR"
    MODE_MLK = 1
    MODE_PADDLE_V5 = 2
    MODE_PADDLE_V2 = 2
    MODE_PADDLE_V3 = 2
    MODE_TESS = 4
    Tess_CHI = "chi_sim"
    RIL_AUTO = 0
    _default_mode = MODE_MLK

    @staticmethod
    def set_engine(engine):
        Ocr._default_mode = engine

    def __init__(self, mode=MODE_MLK, rect=None, pattern=None, confidence=0.1, binary=-1):
        self.mode, self.rect, self.pattern, self.confidence, self.binary = mode, rect, pattern, confidence, binary

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        res = Ocr.find_all(self.pattern, self.rect, self.mode, self.binary, self.confidence, image=cv_image)
        return Result(cv_image, offset_x, offset_y, res)

    @staticmethod
    def _engine_note(mode):
        if mode not in (None, Ocr.MODE_MLK):
            warn_once("ocr-engine", "OCR engine %s maps to ML Kit on XScript" % mode)

    @staticmethod
    def _binarize(image, threshold):
        img = _img.to_bgr(image)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        _, bw = cv2.threshold(gray, int(threshold), 255, cv2.THRESH_BINARY)
        return cv2.cvtColor(bw, cv2.COLOR_GRAY2BGR)

    @staticmethod
    def _raw(rect=None, pattern=None, confidence=0.0, binary=-1, image=None, bitmap=None, file=None):
        src = image if image is not None else (bitmap if bitmap is not None else file)
        if binary is not None and binary >= 0:
            src = Ocr._binarize(src, binary)
        res = _img.ocr(rect, src)
        return _img.ocr_filter(res, pattern, confidence or 0.0)

    @staticmethod
    def paddleocr(rect=None, pattern=None, confidence=0.5, max_side_len=1200, precision=16, bitmap=None, file=None,
                  binary=-1, language="chinese", image=None):
        Ocr._engine_note(Ocr.MODE_PADDLE_V5)
        return Ocr._raw(rect, pattern, 0.0, binary, image, bitmap, file) or None

    paddleocr_v2 = paddleocr
    paddleocr_v3 = paddleocr

    @staticmethod
    def mlkitocr_v2(rect=None, pattern=None, confidence=0.5, bitmap=None, binary=-1, image=None):
        return Ocr._raw(rect, pattern, 0.0, binary, image, bitmap) or None

    @staticmethod
    def tess(data_file=Tess_CHI, rect=None, pattern=None, split_level=RIL_AUTO, white_list=None, black_list=None):
        Ocr._engine_note(Ocr.MODE_TESS)
        return Ocr._raw(rect, pattern) or None

    @staticmethod
    def _result_to_dict(d):
        return d.to_dict()

    @staticmethod
    def find(text, rect=None, mode=None, binary=-1, confidence=0.1, image=None):
        Ocr._engine_note(mode)
        res = Ocr._raw(rect, text, 0.0, binary, image)
        return res[0].to_dict() if res else None

    @staticmethod
    def find_all(text=None, rect=None, mode=None, binary=-1, confidence=0.1, image=None):
        Ocr._engine_note(mode)
        res = Ocr._raw(rect, text, 0.0, binary, image)
        return [r.to_dict() for r in res] if res else None

    @staticmethod
    def exists(text, rect=None, mode=None, binary=-1, confidence=0.1, image=None):
        return Ocr.find(text, rect, mode, binary, confidence, image) is not None

    @staticmethod
    def wait(text, timeout=10, rect=None, mode=None, binary=-1, confidence=0.1, image=None):
        end = time.time() + timeout
        while True:
            r = Ocr.find(text, rect, mode, binary, confidence, image)
            image = None
            if r or time.time() >= end:
                return r
            time.sleep(0.3)

    @staticmethod
    def click(text, rect=None, mode=None, binary=-1, confidence=0.1, timeout=0, image=None):
        from ascript.android.action import click as do_click

        r = Ocr.wait(text, timeout, rect, mode, binary, confidence, image) if timeout > 0 else \
            Ocr.find(text, rect, mode, binary, confidence, image)
        if r:
            do_click(r["center_x"], r["center_y"])
            return True
        return False

    @staticmethod
    def wait_click(text, timeout=10, rect=None, mode=None, binary=-1, confidence=0.1, image=None):
        return Ocr.click(text, rect, mode, binary, confidence, timeout, image)

    @staticmethod
    def octtext_to_dict(res):
        out = []
        for d in res or []:
            dd = d.to_dict() if hasattr(d, "to_dict") else dict(d)
            dd["x"] = dd.get("center_x")
            dd["y"] = dd.get("center_y")
            out.append(dd)
        return out

    @staticmethod
    def matrix(font_lib, rect=None, region=0.9, image=None):
        raise NotImplementedError("Ocr.matrix (dot-matrix font library) is not supported by XScript")

    matrix_detail = matrix


class OcrX(GPTask):
    def __init__(self, *a, **k):
        raise NotImplementedError("OcrX font library OCR is not supported by XScript")

    @staticmethod
    def find_all(*a, **k):
        raise NotImplementedError("OcrX font library OCR is not supported by XScript")


class Eraser(GPTask):
    def __init__(self, rect, color=None):
        self.rect, self.color = rect, color

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        return Result(Eraser.wipe(self.rect, cv_img=cv_image, new_color=self.color), offset_x, offset_y, data)

    @staticmethod
    def wipe(rect, img_file=None, cv_img=None, new_color=None):
        img = _img.imread(img_file) if img_file else cv_img.copy()
        l, t, r, b = [int(v) for v in rect[:4]]
        bgr = hex_to_bgr(new_color) if new_color else (0, 0, 0)
        img[t:b, l:r] = bgr
        return img

