"""Image core shared by `xscript.android.screen` and `ascript.android.screen`.

Frames come from the device as raw RGBA (8-byte w/h header). numpy is required for
color and template work; OpenCV (cv2) for template matching. Both ship in the APK.
"""

import math
import os
import re
import struct
import threading
import time

from xscript.runtime.bridge import bridge

try:
    import numpy as np
except Exception:  # pragma: no cover - numpy is bundled on device
    np = None

try:
    import cv2
except Exception:  # pragma: no cover
    cv2 = None


class Point(object):
    """Result point. Behaves like AScript's android.graphics.Point (x / y) and like a tuple."""

    __slots__ = ("x", "y")

    def __init__(self, x, y):
        self.x = int(x)
        self.y = int(y)

    def __iter__(self):
        yield self.x
        yield self.y

    def __getitem__(self, i):
        return (self.x, self.y)[i]

    def __len__(self):
        return 2

    def __eq__(self, other):
        try:
            return self.x == other[0] and self.y == other[1]
        except Exception:
            return False

    def __hash__(self):
        return hash((self.x, self.y))

    def __repr__(self):
        return "Point(%d, %d)" % (self.x, self.y)


# ---------------------------------------------------------------- frames

def _need_numpy():
    if np is None:
        raise RuntimeError("numpy is not available in this runtime")


def raw_to_rgba(raw):
    """Device raw frame -> HxWx4 uint8 RGBA ndarray (or None)."""
    _need_numpy()
    if not raw or len(raw) < 8:
        return None
    w, h = struct.unpack("<ii", bytes(raw[:8]))
    if w <= 0 or h <= 0:
        return None
    arr = np.frombuffer(raw, dtype=np.uint8, count=w * h * 4, offset=8)
    return arr.reshape((h, w, 4))


def rgba_to_bgr(rgba):
    return np.ascontiguousarray(rgba[:, :, 2::-1])


def bgr_to_raw(img):
    """BGR / BGRA / gray ndarray -> raw RGBA bytes with header."""
    _need_numpy()
    if img.ndim == 2:
        rgba = np.dstack([img, img, img, np.full(img.shape, 255, np.uint8)])
    elif img.shape[2] == 3:
        rgba = np.dstack([img[:, :, 2], img[:, :, 1], img[:, :, 0], np.full(img.shape[:2], 255, np.uint8)])
    else:
        rgba = np.dstack([img[:, :, 2], img[:, :, 1], img[:, :, 0], img[:, :, 3]])
    h, w = rgba.shape[:2]
    return struct.pack("<ii", w, h) + np.ascontiguousarray(rgba, dtype=np.uint8).tobytes()


def _norm_rect(rect):
    if not rect:
        return None
    l, t, r, b = [int(v) for v in rect[:4]]
    if r <= l or b <= t:
        return None
    return max(0, l), max(0, t), r, b


_cache_lock = threading.Lock()
_cached_frame = {"rgba": None}


def set_cache(enabled):
    """Freeze the current frame for all subsequent captures (AScript `screen.cache`)."""
    with _cache_lock:
        _cached_frame["rgba"] = capture_rgba(None, use_cache=False) if enabled else None
        return _cached_frame["rgba"]


def capture_rgba(rect=None, use_cache=True):
    """Screen (or rect of it) as RGBA ndarray. None when capture is unavailable."""
    rect = _norm_rect(rect)
    if use_cache and _cached_frame["rgba"] is not None:
        full = _cached_frame["rgba"]
        if rect:
            l, t, r, b = rect
            return full[t:b, l:r]
        return full
    last = None
    for _ in range(3):
        raw = bridge.capture_raw(*(rect or (0, 0, 0, 0)))
        last = raw_to_rgba(raw) if raw else None
        if last is not None:
            return last
        time.sleep(0.1)
    return last


def capture_bgr(rect=None):
    rgba = capture_rgba(rect)
    return None if rgba is None else rgba_to_bgr(rgba)


def to_bgr(image):
    """Accept None (capture), BGR ndarray, PIL image, Java Bitmap or file path -> BGR ndarray."""
    if image is None:
        return capture_bgr()
    if np is not None and isinstance(image, np.ndarray):
        if image.ndim == 3 and image.shape[2] == 4:
            return np.ascontiguousarray(image[:, :, :3])
        return image
    if isinstance(image, str):
        return imread(image)
    if hasattr(image, "getPixel") and hasattr(image, "getWidth"):
        return rgba_to_bgr(raw_to_rgba(bridge.bitmap_to_raw(image)))
    if hasattr(image, "convert") and hasattr(image, "size"):
        arr = np.asarray(image.convert("RGB"))
        return np.ascontiguousarray(arr[:, :, ::-1])
    raise TypeError("unsupported image type %r" % type(image))


def imread(path, flags=None):
    """cv2.imread that handles non-ASCII paths."""
    if cv2 is None:
        raise RuntimeError("OpenCV (cv2) is not available in this runtime")
    data = np.fromfile(path, dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_UNCHANGED if flags is None else flags)


# ---------------------------------------------------------------- colors

_HEX = re.compile(r"^#?([0-9a-fA-F]{6})$")


def hex_to_rgb(value):
    m = _HEX.match(value.strip())
    if not m:
        raise ValueError("bad color %r" % value)
    h = m.group(1)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def parse_color_points(colors):
    """'x,y,#RRGGBB[-#DDDDDD]|x2,y2,#RRGGBB|...' -> [(x, y, (r,g,b), (dr,dg,db)|None)]."""
    out = []
    for part in str(colors).split("|"):
        part = part.strip()
        if not part:
            continue
        fields = [f.strip() for f in part.split(",")]
        if len(fields) < 3:
            raise ValueError("bad color point %r" % part)
        color = fields[2]
        diff = None
        if "-" in color:
            color, d = color.split("-", 1)
            diff = hex_to_rgb(d)
        out.append((int(float(fields[0])), int(float(fields[1])), hex_to_rgb(color), diff))
    if not out:
        raise ValueError("empty color string")
    return out


def diff_from_similarity(sim):
    """AScript similarity 0..1 → per-channel tolerance (1 → exact, 0.9 → ±25)."""
    sim = float(sim)
    if sim > 1:  # already a tolerance
        t = int(sim)
    else:
        t = int(round((1.0 - sim) * 255))
    return t, t, t


def _channel_ok(bgr, rgb, tol):
    b = bgr[..., 0].astype(np.int16)
    g = bgr[..., 1].astype(np.int16)
    r = bgr[..., 2].astype(np.int16)
    return (np.abs(r - rgb[0]) <= tol[0]) & (np.abs(g - rgb[1]) <= tol[1]) & (np.abs(b - rgb[2]) <= tol[2])


def get_pixel(x, y, image=None):
    """(r, g, b) at screen/image (x, y) or None."""
    img = to_bgr(image)
    if img is None:
        return None
    h, w = img.shape[:2]
    x, y = int(x), int(y)
    if not (0 <= x < w and 0 <= y < h):
        return None
    px = img[y, x]
    return int(px[2]), int(px[1]), int(px[0])


def compare_colors(colors, sim=0.9, image=None, count_sim=1.0):
    """True if the color points match at their absolute positions."""
    img = to_bgr(image)
    if img is None:
        return False
    pts = parse_color_points(colors)
    tol = diff_from_similarity(sim)
    h, w = img.shape[:2]
    hits = 0
    for x, y, rgb, pdiff in pts:
        if 0 <= x < w and 0 <= y < h and bool(_channel_ok(img[y, x], rgb, pdiff or tol)):
            hits += 1
    need = max(1, int(round(len(pts) * float(count_sim))))
    return hits >= need


def _order(points, ori):
    """AScript search directions: 1 left→right cols, 2 top→bottom rows (default), 3 rows right→left,
    4 cols right→left, 5 cols right→left bottom-up, 6 rows bottom-up right→left,
    7 rows bottom-up left→right, 8 cols left→right bottom-up."""
    ori = int(ori or 2)
    keys = {
        1: lambda p: (p[0], p[1]),
        2: lambda p: (p[1], p[0]),
        3: lambda p: (p[1], -p[0]),
        4: lambda p: (-p[0], p[1]),
        5: lambda p: (-p[0], -p[1]),
        6: lambda p: (-p[1], -p[0]),
        7: lambda p: (-p[1], p[0]),
        8: lambda p: (p[0], -p[1]),
    }
    return sorted(points, key=keys.get(ori, keys[2]))


# Each scan direction as a view of the (rows=y, cols=x) mask whose row-major order is that direction:
# (transpose, flip rows, flip cols). Direction 1 = (x, y) ascending = rows of the transposed mask, and so on.
_ORI_VIEW = {
    1: (True, False, False),
    2: (False, False, False),
    3: (False, False, True),
    4: (True, True, False),
    5: (True, True, True),
    6: (False, True, True),
    7: (False, True, False),
    8: (True, False, True),
}


def _channel_mask(region, rgb, tol):
    """uint8 mask (non-zero = match) of |pixel - rgb| <= tol per channel; cv2.inRange when available."""
    if cv2 is not None:
        lo = (max(0, rgb[2] - tol[2]), max(0, rgb[1] - tol[1]), max(0, rgb[0] - tol[0]))
        hi = (min(255, rgb[2] + tol[2]), min(255, rgb[1] + tol[1]), min(255, rgb[0] + tol[0]))
        return cv2.inRange(np.ascontiguousarray(region[:, :, :3]), lo, hi)
    return _channel_ok(region, rgb, tol).view(np.uint8)


def _greedy_points(mask, ori, space, max_num):
    """Candidates in scan order `ori`, dropping any within `space` (both axes) of an accepted one.

    Same result as sorting every candidate and checking it against all accepted points, but the scan
    walks the mask in place: each accepted point blanks its (2*space+1)^2 square, so later candidates
    inside it are skipped without a Python-level comparison. Returns [(x, y)] in mask coordinates.
    """
    t, fr, fc = _ORI_VIEW.get(int(ori or 2), _ORI_VIEW[2])
    v = mask.T if t else mask
    if fr:
        v = v[::-1]
    if fc:
        v = v[:, ::-1]
    # A private bool copy: blanking must not touch the caller's mask, and argmax on bool stops at the first True.
    v = np.ascontiguousarray(v != 0)
    rows, cols = v.shape
    flat = v.reshape(-1)
    chunk = max(1 << 16, cols * 4)
    out = []
    pos, n = 0, flat.size
    while pos < n:
        seg = flat[pos:pos + chunk]
        j = int(seg.argmax())
        if not seg[j]:
            pos += chunk
            continue
        i = pos + j
        r, c = divmod(i, cols)
        out.append((r, c))
        if max_num and len(out) >= max_num:
            break
        if space:
            v[max(0, r - space):r + space + 1, max(0, c - space):c + space + 1] = 0
        pos = i + 1
    pts = []
    for r, c in out:
        if fr:
            r = rows - 1 - r
        if fc:
            c = cols - 1 - c
        pts.append((r, c) if t else (c, r))  # (x, y): the transposed view's rows are x
    return pts


def find_colors(colors, rect=None, sim=0.9, space=5, ori=2, max_num=0, image=None):
    """Multi-point color search. Returns Points of the first color point (screen coords)."""
    _need_numpy()
    rect = _norm_rect(rect)
    offx = offy = 0
    if image is None and rect:
        # Capture only the region; results are shifted back to screen coordinates.
        img = capture_bgr(rect)
        offx, offy = rect[0], rect[1]
        rect = None
    else:
        img = to_bgr(image)
    if img is None:
        return []
    H, W = img.shape[:2]
    pts = parse_color_points(colors)
    tol = diff_from_similarity(sim)
    x0, y0 = pts[0][0], pts[0][1]
    rel = [(x - x0, y - y0, rgb, d or tol) for x, y, rgb, d in pts]
    l, t, r, b = rect or (0, 0, W, H)
    r, b = min(r, W), min(b, H)
    if r <= l or b <= t:
        return []
    # Candidate origins must keep every offset inside the image.
    min_dx = min(p[0] for p in rel)
    max_dx = max(p[0] for p in rel)
    min_dy = min(p[1] for p in rel)
    max_dy = max(p[1] for p in rel)
    ox0 = max(l, -min_dx)
    oy0 = max(t, -min_dy)
    ox1 = min(r, W - max_dx)
    oy1 = min(b, H - max_dy)
    if ox1 <= ox0 or oy1 <= oy0:
        return []
    mask = None
    for dx, dy, rgb, d in rel:
        ok = _channel_mask(img[oy0 + dy:oy1 + dy, ox0 + dx:ox1 + dx], rgb, d)
        mask = ok if mask is None else (cv2.bitwise_and(mask, ok) if cv2 is not None else mask & ok)
        if not mask.any():
            return []
    found = _greedy_points(mask, ori, max(0, int(space)), int(max_num or 0))
    return [Point(x + ox0 + offx, y + oy0 + offy) for x, y in found]


def count_color(color, rect=None, sim=0.9, image=None):
    rect = _norm_rect(rect)
    img = to_bgr(image) if image is not None else capture_bgr(rect)
    if img is None:
        return 0
    if image is not None and rect:
        l, t, r, b = rect
        img = img[t:b, l:r]
    rgb = hex_to_rgb(color.split("-")[0])
    tol = diff_from_similarity(sim)
    return int(_channel_ok(img, rgb, tol).sum())


# ---------------------------------------------------------------- templates

# Matching strategy follows AScript's ascv (ascript-tip, MIT): grayscale (or H+S when
# rgb=True) matching, SQDIFF+RMSE scoring for transparent templates, log-spaced scales
# keeping only the best scale, a 1/4 coarse-to-fine pass for large templates, a 1/2
# pyramid early-reject, and templates matched in parallel (matchTemplate releases the GIL).

_template_cache = {}
_TEMPLATE_CACHE_MAX = 96
_MAX_WORKERS = 4
_CF_MIN_TPL_SHORT = 48
_PYRAMID_MIN_TPL_SHORT = 48
_CF_MIN_SRC_SHORT = 256
_CF_DOWNSCALE = 4
_CF_TOP_K = 5
_CF_REFINE_STEPS = (0.94, 1.0, 1.06)


class _Tpl(object):
    __slots__ = ("img", "mask", "w", "h")

    def __init__(self, img, mask):
        self.img, self.mask = img, mask
        self.h, self.w = img.shape[:2]


def _significant_alpha(alpha, min_ratio=0.05):
    """All-zero alpha (32-bit BMP padding) and nearly-opaque images are not masks."""
    if not alpha.any():
        return False
    return np.count_nonzero(alpha < 255) > alpha.size * min_ratio


def _to_match_space(img, rgb):
    """BGR/BGRA/gray -> the single space every match runs in (gray, or H+S for rgb)."""
    if img.ndim == 3 and img.shape[2] == 4:
        img = img[:, :, :3]
    if not rgb:
        return img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    return np.ascontiguousarray(hsv[:, :, :2])


def _prepare_template(raw, rgb):
    mask = None
    if raw.ndim == 3 and raw.shape[2] == 4 and _significant_alpha(raw[:, :, 3]):
        mask = np.ascontiguousarray(raw[:, :, 3])
    return _Tpl(_to_match_space(raw, rgb), mask)


def _load_template(part, rgb=False):
    if np is not None and isinstance(part, np.ndarray):
        return _prepare_template(part, rgb)
    path = str(part)
    if not os.path.isfile(path):
        raise FileNotFoundError("template not found: %s" % path)
    key = (path, bool(rgb))
    mtime = os.path.getmtime(path)
    hit = _template_cache.get(key)
    if hit is not None and hit[0] == mtime:
        return hit[1]
    raw = imread(path)
    if raw is None:
        raise ValueError("cannot decode template %s" % path)
    tpl = _prepare_template(raw, rgb)
    if len(_template_cache) >= _TEMPLATE_CACHE_MAX:
        _template_cache.pop(next(iter(_template_cache)))
    _template_cache[key] = (mtime, tpl)
    return tpl


def _do_match(src, tpl, mask):
    """TM_CCOEFF_NORMED, or SQDIFF normalised by RMSE for masked (transparent) templates."""
    if mask is None:
        res = cv2.matchTemplate(src, tpl, cv2.TM_CCOEFF_NORMED)
        return np.nan_to_num(res, nan=0.0, posinf=0.0, neginf=0.0)
    valid = mask > 128  # before matching: OpenCV 4.5 (Chaquopy) rewrites a uint8 mask in place to 0/1
    res = cv2.matchTemplate(src, tpl, cv2.TM_SQDIFF, mask=mask.copy())
    n = float(np.count_nonzero(valid))
    if n < 1:
        return np.zeros_like(res)
    channels = 1 if tpl.ndim == 2 else tpl.shape[2]
    rmse = np.sqrt(np.maximum(res, 0) / (n * channels))
    if tpl.ndim == 2:
        std = float(tpl[valid].std())
    else:
        std = float(np.mean([tpl[:, :, c][valid].std() for c in range(channels)]))
    scale = max(std * 2.0, 10.0)
    return (1.0 - np.minimum(rmse / scale, 1.0)).astype(np.float32)


def _resize(img, w, h):
    interp = cv2.INTER_AREA if w < img.shape[1] else cv2.INTER_LINEAR
    return cv2.resize(img, (w, h), interpolation=interp)


def _scales(scale_range):
    """Log-spaced steps (~1.12 apart, 5..15 of them), plus 1.0 when in range."""
    lo, hi = float(scale_range[0]), float(scale_range[1])
    if lo > hi:
        lo, hi = hi, lo
    lo = max(lo, 1e-3)
    a, b = math.log(lo), math.log(hi)
    steps = max(5, min(15, int(round((b - a) / math.log(1.12)))))
    out = [math.exp(a + i * (b - a) / steps) for i in range(steps + 1)]
    if lo <= 1.0 <= hi:
        out.append(1.0)
    return sorted(set(round(s, 4) for s in out))


_MIN_CONFIDENCE = 0.01


def _extract(res, w, h, threshold, maxcnt):
    out = []
    # Each hit zeroes its neighbourhood. A threshold <= 0 would match those zeros forever, so stop at a
    # non-positive score and never take more hits than there are cells.
    for _ in range(res.size):
        _, mv, _, ml = cv2.minMaxLoc(res)
        if mv < threshold or mv <= 0:
            break
        out.append((float(mv), ml[0], ml[1], w, h))
        if maxcnt and len(out) >= maxcnt:
            break
        y0, y1 = max(0, ml[1] - h + 1), min(res.shape[0], ml[1] + h)
        x0, x1 = max(0, ml[0] - w + 1), min(res.shape[1], ml[0] + w)
        res[y0:y1, x0:x1] = 0
    return out


def _cf_eligible(tpl, src):
    return tpl.mask is None and min(tpl.w, tpl.h) >= _CF_MIN_TPL_SHORT and min(src.shape[:2]) >= _CF_MIN_SRC_SHORT


def _single_cf(src, tpl, threshold, maxcnt):
    """1/4 coarse scan -> top-K candidates -> full-res refine in a padded window."""
    sh, sw = src.shape[:2]
    ds = _CF_DOWNSCALE
    cw, ch = sw // ds, sh // ds
    tw, th = max(4, tpl.w // ds), max(4, tpl.h // ds)
    if sw <= tpl.w or sh <= tpl.h or cw <= tw or ch <= th:
        return []
    res = _do_match(_resize(src, cw, ch), _resize(tpl.img, tw, th), None)
    coarse_th = max(0.3, threshold - 0.2)
    k = max(_CF_TOP_K, maxcnt) if maxcnt and maxcnt > 1 else _CF_TOP_K
    cands = []
    rx, ry = max(1, tw // 2), max(1, th // 2)
    for _ in range(k):
        _, mv, _, ml = cv2.minMaxLoc(res)
        if mv < coarse_th:
            break
        cands.append(ml)
        res[max(0, ml[1] - ry):ml[1] + ry + 1, max(0, ml[0] - rx):ml[0] + rx + 1] = -1.0
    out = []
    pad = max(ds * 2, tpl.w // 6, tpl.h // 6)
    for cx, cy in cands:
        ax, ay = cx * ds, cy * ds
        x0, y0 = max(0, ax - pad), max(0, ay - pad)
        x1, y1 = min(sw, ax + tpl.w + pad), min(sh, ay + tpl.h + pad)
        if x1 - x0 <= tpl.w or y1 - y0 <= tpl.h:
            continue
        r = _do_match(src[y0:y1, x0:x1], tpl.img, None)
        _, mv, _, ml = cv2.minMaxLoc(r)
        if mv < threshold:
            continue
        x, y = x0 + ml[0], y0 + ml[1]
        if any(abs(o[1] - x) < tpl.w // 2 and abs(o[2] - y) < tpl.h // 2 for o in out):
            continue
        out.append((float(mv), x, y, tpl.w, tpl.h))
        if maxcnt == 1:
            break
    out.sort(key=lambda m: -m[0])
    return out[:maxcnt] if maxcnt else out


def _single(src, tpl, threshold, maxcnt, src_half=None):
    sh, sw = src.shape[:2]
    if sw <= tpl.w or sh <= tpl.h:
        return []
    # 1/2 pyramid early reject when hunting for several targets. Only for large templates: halving a thin glyph or
    # icon (a 1px ring, a digit) wipes out its detail and rejected exact matches (confidence 1.0).
    if not (tpl.h < _PYRAMID_MIN_TPL_SHORT or tpl.w < _PYRAMID_MIN_TPL_SHORT or sh < tpl.h * 3 or sw < tpl.w * 3 or maxcnt == 1 or tpl.mask is not None):
        half = src_half if src_half is not None else _resize(src, sw // 2, sh // 2)
        r = _do_match(half, _resize(tpl.img, tpl.w // 2, tpl.h // 2), None)
        if cv2.minMaxLoc(r)[1] < max(0.3, threshold - 0.15):
            return []
    return _extract(_do_match(src, tpl.img, tpl.mask), tpl.w, tpl.h, threshold, maxcnt)


def _multi_cf(src, tpl, threshold, scale_range):
    """Coarse scan over every scale, refine the top-K scales. Single best hit only."""
    sh, sw = src.shape[:2]
    ds = _CF_DOWNSCALE
    cw, ch = sw // ds, sh // ds
    if cw < 32 or ch < 32:
        return []
    small = _resize(src, cw, ch)
    cands = []
    for s in _scales(scale_range):
        fw, fh = max(4, int(round(tpl.w * s))), max(4, int(round(tpl.h * s)))
        tw, th = max(4, fw // ds), max(4, fh // ds)
        if fw >= sw or fh >= sh or tw >= cw or th >= ch:
            continue
        r = _do_match(small, _resize(tpl.img, tw, th), None)
        _, mv, _, ml = cv2.minMaxLoc(r)
        cands.append((mv, ml, s))
    cands.sort(key=lambda c: -c[0])
    best = None
    for _, (cx, cy), s0 in cands[:_CF_TOP_K]:
        ax, ay = cx * ds, cy * ds
        for ratio in _CF_REFINE_STEPS:
            s = s0 * ratio
            w, h = max(4, int(round(tpl.w * s))), max(4, int(round(tpl.h * s)))
            if w >= sw or h >= sh:
                continue
            pad = max(ds * 2, w // 6, h // 6)
            x0, y0 = max(0, ax - pad), max(0, ay - pad)
            x1, y1 = min(sw, ax + w + pad), min(sh, ay + h + pad)
            if x1 - x0 <= w or y1 - y0 <= h:
                continue
            r = _do_match(src[y0:y1, x0:x1], _resize(tpl.img, w, h), None)
            _, mv, _, ml = cv2.minMaxLoc(r)
            if best is None or mv > best[0]:
                best = (float(mv), x0 + ml[0], y0 + ml[1], w, h)
    return [best] if best is not None and best[0] >= threshold else []


_MULTI_REFINE_TOP = 3
_QUARTER_MIN_TPL = 24     # template short side (at the smallest scale) needed for a 1/4 reject
_QUARTER_SLACK = 0.25     # 1/4 scores run low; only clearly-absent templates are rejected
_MASK_REFINE_TOP = 2


_QUARTER_MIN_STD = 2.0


def _quarter_rank(src, tpl, sizes, threshold, src_half):
    """1/4-resolution pass over every scale (~16x cheaper than full res).

    Only used to reject: returns [] when no scale comes close (template absent), the
    unchanged sizes otherwise, or None when the template is too small to judge at 1/4.
    Scale ranking stays on the 1/2 pass; 1/4 scores are too coarse to pick scales.
    """
    if tpl.mask is not None or min(min(w, h) for w, h in sizes) < _QUARTER_MIN_TPL:
        return None
    sh, sw = src.shape[:2]
    if min(sh, sw) < 256:
        return None
    base = src_half if src_half is not None else src
    quarter = _resize(base, sw // 4, sh // 4)
    low = max(0.3, threshold - _QUARTER_SLACK)
    small = [_resize(tpl.img, max(4, w // 4), max(4, h // 4)) for w, h in sizes]
    # Downsampling can wash a sparse template (thin text on a flat background) out to a
    # near-constant patch whose normalized score is noise; such a pass cannot reject.
    if min(float(t.std()) for t in small) < _QUARTER_MIN_STD:
        return None
    for t in small:
        r = _do_match(quarter, t, None)
        if cv2.minMaxLoc(r)[1] >= low:
            return sizes
    return []


_REFINE_PAD = 6
_REFINE_MAX_PEAKS = 48


def _refine_windows(src, tpl_img, half_res, low):
    """Full-resolution response map, computed only in small windows around 1/2 peaks.

    Everywhere else the map is 0, so `_extract` sees the same hits a full scan gives
    wherever the 1/2 pass scored >= `low`. Falls back to a full scan when the 1/2 map
    has too many candidate peaks (repetitive textures).
    """
    th, tw = tpl_img.shape[:2]
    sh, sw = src.shape[:2]
    out = np.zeros((sh - th + 1, sw - tw + 1), np.float32)
    rh = half_res.copy()
    ry, rx = max(1, th // 4), max(1, tw // 4)
    pad = _REFINE_PAD
    for _ in range(_REFINE_MAX_PEAKS):
        _, mv, _, ml = cv2.minMaxLoc(rh)
        if mv < low:
            return out
        x, y = ml[0] * 2, ml[1] * 2
        x0, y0 = max(0, x - pad), max(0, y - pad)
        x1, y1 = min(out.shape[1], x + pad + 1), min(out.shape[0], y + pad + 1)
        if x1 > x0 and y1 > y0:
            r = _do_match(src[y0:y1 + th - 1, x0:x1 + tw - 1], tpl_img, None)
            win = out[y0:y0 + r.shape[0], x0:x0 + r.shape[1]]
            np.maximum(win, r, out=win)
        rh[max(0, ml[1] - ry):ml[1] + ry + 1, max(0, ml[0] - rx):ml[0] + rx + 1] = -1.0
    return _do_match(src, tpl_img, None)


def _mask_rank(src, tpl, sizes, src_half):
    """Masked (SQDIFF) matching is slow; rank scales on the half image first."""
    sh, sw = src.shape[:2]
    if len(sizes) <= _MASK_REFINE_TOP or min(sh, sw) < 64 or min(min(w, h) for w, h in sizes) < 24:
        return sizes
    half = src_half if src_half is not None else _resize(src, sw // 2, sh // 2)
    scored = []
    for w, h in sizes:
        hw, hh = w // 2, h // 2
        r = _do_match(half, _resize(tpl.img, hw, hh), _resize(tpl.mask, hw, hh))
        scored.append((cv2.minMaxLoc(r)[1], (w, h)))
    scored.sort(key=lambda c: -c[0])
    return [wh for _, wh in scored[:_MASK_REFINE_TOP]]


def _multi(src, tpl, threshold, maxcnt, scale_range, src_half=None):
    """Matches are extracted at the best-scoring scale only (AScript semantics).

    Scales are ranked coarse-to-fine: a 1/4 pass rejects absent templates, a 1/2 pass
    picks the best few scales, and those are refined at full resolution only in windows
    around their 1/2 peaks.
    """
    sh, sw = src.shape[:2]
    sizes = []
    for s in _scales(scale_range):
        w, h = max(4, int(tpl.w * s)), max(4, int(tpl.h * s))
        if w < sw and h < sh:
            sizes.append((w, h))
    if not sizes:
        return []
    ranked = sizes
    best = None
    if tpl.mask is not None:
        ranked = _mask_rank(src, tpl, sizes, src_half)
    elif min(sh, sw) >= 64:
        if _quarter_rank(src, tpl, sizes, threshold, src_half) == []:
            return []
        half = src_half if src_half is not None else _resize(src, sw // 2, sh // 2)
        scored, small = [], []
        low = max(0.3, threshold - 0.15)
        for w, h in sizes:
            if min(w, h) < 16:  # too small to judge at half size
                small.append((w, h))
                continue
            r = _do_match(half, _resize(tpl.img, w // 2, h // 2), None)
            scored.append((cv2.minMaxLoc(r)[1], (w, h), r))
        scored.sort(key=lambda c: -c[0])
        for mv, (w, h), rh in scored[:_MULTI_REFINE_TOP]:
            if mv < low:
                continue
            r = _refine_windows(src, _resize(tpl.img, w, h), rh, low)
            fv = cv2.minMaxLoc(r)[1]
            if best is None or fv > best[0]:
                best = (fv, r, w, h)
        ranked = small
    for w, h in ranked:
        mask = _resize(tpl.mask, w, h) if tpl.mask is not None else None
        r = _do_match(src, _resize(tpl.img, w, h), mask)
        mv = cv2.minMaxLoc(r)[1]
        if best is None or mv > best[0]:
            best = (mv, r, w, h)
    if best is None or best[0] < threshold:
        return []
    return _extract(best[1], best[2], best[3], threshold, maxcnt)


def _match_prepared(src, tpl, threshold, maxcnt, scale_range, fast, src_half=None):
    multi = bool(scale_range) and len(scale_range) == 2 and float(scale_range[0]) != float(scale_range[1])
    if multi:
        if maxcnt == 1 and _cf_eligible(tpl, src):
            hits = _multi_cf(src, tpl, threshold, scale_range)
            if hits:
                return hits
        return _multi(src, tpl, threshold, maxcnt, scale_range, src_half)
    if fast and _cf_eligible(tpl, src):
        hits = _single_cf(src, tpl, threshold, maxcnt)
        if hits:
            return hits
    return _single(src, tpl, threshold, maxcnt, src_half)


def _to_dicts(hits, ox, oy, index):
    out = []
    for conf, x, y, w, h in hits:
        x, y = int(x + ox), int(y + oy)
        cx, cy = x + w / 2.0, y + h / 2.0
        out.append({
            "result": (cx, cy),
            "rectangle": ((x, y), (x, y + h), (x + w, y), (x + w, y + h)),
            "rect": [x, y, x + w, y + h],
            "center_x": int(cx),
            "center_y": int(cy),
            "confidence": conf,
            "index": index,
        })
    return out


def match_template(source, part, rect=None, confidence=0.9, rgb=False, maxcnt=0, scale_range=None, index=0,
                   offset=(0, 0), fast=True):
    """Template search on a BGR source. Returns AScript-shaped dicts in screen coordinates.

    `rect` crops `source`; `offset` is added when `source` is already a screen sub-region.
    """
    return _match_many(source, [part], rect, confidence, rgb, maxcnt, scale_range, offset, fast, first_index=index)


def _clamp_confidence(confidence):
    """Template scores are in (0, 1]: 0 or less means "anything" (clamped to the smallest positive score), above 1 is 1."""
    c = float(confidence)
    if c != c:  # NaN
        raise ValueError("confidence must be a number in (0, 1]")
    return min(1.0, max(_MIN_CONFIDENCE, c))


def _match_many(source, parts, rect, confidence, rgb, maxcnt, scale_range, offset, fast, first_index=0):
    if cv2 is None:
        raise RuntimeError("OpenCV (cv2) is not available in this runtime")
    confidence = _clamp_confidence(confidence)
    rect = _norm_rect(rect)
    ox, oy = int(offset[0]), int(offset[1])
    src = source
    if rect:
        l, t, r, b = rect
        src = source[t:b, l:r]
        ox, oy = ox + l, oy + t
    src_m = _to_match_space(src, rgb)
    tpls = [_load_template(p, rgb) for p in parts]
    multi = bool(scale_range) and len(scale_range) == 2
    src_half = None
    if (len(tpls) > 1 or multi) and min(src_m.shape[:2]) >= 48:
        src_half = _resize(src_m, src_m.shape[1] // 2, src_m.shape[0] // 2)

    def run(tpl):
        return _match_prepared(src_m, tpl, confidence, maxcnt, scale_range, fast, src_half)

    if len(tpls) > 1:
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=min(_MAX_WORKERS, len(tpls))) as ex:
            raw = list(ex.map(run, tpls))
    else:
        raw = [run(t) for t in tpls]
    out = []
    for i, hits in enumerate(raw):
        out.extend(_to_dicts(hits, ox, oy, first_index + i))
    return out


def sort_by_ori(items, ori):
    """AScript scan-direction ordering (1..8) of template/OCR dicts by center."""
    keys = {
        1: lambda r: (r["center_x"], r["center_y"]),
        2: lambda r: (r["center_y"], r["center_x"]),
        3: lambda r: (r["center_y"], -r["center_x"]),
        4: lambda r: (-r["center_x"], r["center_y"]),
        5: lambda r: (-r["center_x"], -r["center_y"]),
        6: lambda r: (-r["center_y"], -r["center_x"]),
        7: lambda r: (-r["center_y"], r["center_x"]),
        8: lambda r: (r["center_x"], -r["center_y"]),
    }
    k = keys.get(int(ori)) if ori else None
    return sorted(items, key=k) if k and len(items) > 1 else items


def find_templates(parts, rect=None, confidence=0.9, rgb=False, maxcnt=0, scale_range=None, image=None,
                   ori=None, fast=True):
    """parts: path or list of paths. Captures once and searches every template.

    `ori=None` (XScript): best confidence first, `maxcnt` caps the combined list.
    `ori=1..8` (AScript): `maxcnt` applies per template, results ordered by scan direction.
    """
    rect = _norm_rect(rect)
    offset = (0, 0)
    if image is None and rect:
        src = capture_bgr(rect)
        offset = (rect[0], rect[1])
        rect = None
    else:
        src = to_bgr(image)
    if src is None:
        return []
    items = list(parts) if isinstance(parts, (list, tuple)) else [parts]
    out = _match_many(src, items, rect, confidence, rgb, maxcnt, scale_range, offset, fast)
    if ori:
        return sort_by_ori(out, ori)
    if len(items) > 1:
        out.sort(key=lambda d: -d["confidence"])
        if maxcnt:
            out = out[:maxcnt]
    return out


# ---------------------------------------------------------------- OCR

class OcrRegion(object):
    __slots__ = ("left", "top", "right", "bottom")

    def __init__(self, rect):
        self.left, self.top, self.right, self.bottom = [int(v) for v in rect]

    def width(self):
        return self.right - self.left

    def height(self):
        return self.bottom - self.top

    def centerX(self):
        return (self.left + self.right) // 2

    def centerY(self):
        return (self.top + self.bottom) // 2

    def __repr__(self):
        return "Rect(%d, %d - %d, %d)" % (self.left, self.top, self.right, self.bottom)


class OcrResult(object):
    """One recognised line. Attribute access (AScript objects) and dict access both work."""

    def __init__(self, d):
        self.text = d.get("text", "")
        self.confidence = float(d.get("confidence") or 0.0)
        self.rect = list(d.get("rect") or [0, 0, 0, 0])
        self.center_x = int(d.get("center_x", (self.rect[0] + self.rect[2]) // 2))
        self.center_y = int(d.get("center_y", (self.rect[1] + self.rect[3]) // 2))
        self.region_position = OcrRegion(self.rect)
        self.x = self.center_x
        self.y = self.center_y
        self.elements = d.get("elements") or []

    def to_dict(self):
        return {
            "text": self.text,
            "confidence": self.confidence,
            "rect": list(self.rect),
            "center_x": self.center_x,
            "center_y": self.center_y,
        }

    def __getitem__(self, key):
        return self.to_dict()[key]

    def get(self, key, default=None):
        return self.to_dict().get(key, default)

    def keys(self):
        return self.to_dict().keys()

    def __repr__(self):
        return "OcrResult(%r, %s, conf=%.2f)" % (self.text, self.rect, self.confidence)


def ocr(rect=None, image=None, level="line"):
    """Run ML Kit OCR. Returns [OcrResult] in screen coordinates."""
    import json

    rect = _norm_rect(rect)
    ox, oy = (rect[0], rect[1]) if rect else (0, 0)
    if image is None:
        bmp = bridge.capture_bitmap(*(rect or (0, 0, 0, 0)))
    elif hasattr(image, "getPixel"):
        bmp = image
        if rect:
            from android.graphics import Bitmap

            l, t, r, b = rect
            r = min(r, bmp.getWidth())
            b = min(b, bmp.getHeight())
            bmp = Bitmap.createBitmap(bmp, l, t, r - l, b - t)
    else:
        img = to_bgr(image)
        if rect:
            l, t, r, b = rect
            img = img[t:b, l:r]
        bmp = bridge.raw_to_bitmap(bgr_to_raw(img))
    if bmp is None:
        return []
    raw = bridge.ocr(bmp, ox, oy, level)
    return [OcrResult(d) for d in json.loads(raw or "[]")]


def ocr_filter(results, pattern, confidence=0.0):
    """AScript semantics: keep lines where regex `pattern` matches; text becomes the joined matches."""
    out = []
    rx = re.compile(pattern) if pattern else None
    for r in results:
        if r.confidence and r.confidence < confidence:
            continue
        if rx is None:
            out.append(r)
            continue
        found = rx.findall(r.text)
        if found:
            if isinstance(found[0], tuple):
                found = ["".join(f) for f in found]
            r.text = "".join(found)
            out.append(r)
    return out
