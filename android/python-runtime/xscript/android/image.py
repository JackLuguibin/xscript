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
    """'x,y,#RRGGBB[-#DDDDDD]|x2,y2,#RRGGBB|...' -> [(x, y, (r,g,b), (dr,dg,db)|None)]. A bare '#RRGGBB' is 0,0."""
    out = []
    for part in str(colors).split("|"):
        part = part.strip()
        if not part:
            continue
        fields = [f.strip() for f in part.split(",")]
        if len(fields) == 1 and fields[0].startswith("#"):
            fields = ["0", "0", fields[0]]  # a bare "#rrggbb" is a point at offset 0,0 (docs/API.md)
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


COLOR_SPACES = ("rgb", "hsv", "lab")


def color_tolerance(color_space="rgb", sim=0.9, tolerance=None):
    """Tolerance for a colour space, from an explicit `tolerance` or derived from AScript's `sim` (0..1).

    rgb: (dr, dg, db) per channel, 0..255 (an int applies to all three); sim 0.9 -> 25.
    hsv: (dh, ds, dv): hue in degrees (0..180, wraps around), saturation / value 0..255; sim 0.9 -> (10, 60, 80).
         Brightness changes move V and keep H, so HSV survives night mode and dimming.
    lab: CIE76 delta E (perceptual distance; ~2.3 = just noticeable); sim 0.9 -> 12.
    """
    if color_space not in COLOR_SPACES:
        raise ValueError("color_space must be one of %s, got %r" % (", ".join(COLOR_SPACES), color_space))
    if tolerance is not None:
        if color_space == "lab":
            return float(tolerance)
        if isinstance(tolerance, (int, float)):
            return (tolerance,) * 3
        t = tuple(tolerance)
        if len(t) != 3:
            raise ValueError("%s tolerance needs 3 values, got %r" % (color_space, tolerance))
        return t
    if color_space == "rgb":
        return diff_from_similarity(sim)
    t = 1.0 - min(1.0, max(0.0, float(sim)))
    if color_space == "hsv":
        return (max(2.0, round(t * 100, 1)), min(255, int(round(t * 600))), min(255, int(round(t * 800))))
    return max(1.0, round(t * 120, 1))


_HSV_GRAY_SAT = 30  # below this saturation the hue of a target is noise: match any hue


def _target(rgb, color_space):
    """The target colour converted like the image (OpenCV 8-bit HSV / Lab)."""
    px = np.uint8([[[rgb[2], rgb[1], rgb[0]]]])
    code = cv2.COLOR_BGR2HSV if color_space == "hsv" else cv2.COLOR_BGR2LAB
    return [int(v) for v in cv2.cvtColor(px, code)[0, 0]]


def _convert(region, color_space):
    if color_space == "rgb":
        return np.ascontiguousarray(region[:, :, :3])
    if cv2 is None:
        raise RuntimeError("OpenCV (cv2) is needed for color_space=%r" % color_space)
    code = cv2.COLOR_BGR2HSV if color_space == "hsv" else cv2.COLOR_BGR2LAB
    return cv2.cvtColor(np.ascontiguousarray(region[:, :, :3]), code)


def _space_mask(conv, rgb, tol, color_space):
    """uint8 mask (non-zero = match) of an image already converted with `_convert`."""
    if color_space == "rgb":
        return _channel_mask(conv, rgb, tol)
    t = _target(rgb, color_space)
    if color_space == "hsv":
        dh = int(round(float(tol[0]) / 2.0))  # OpenCV hue is 0..179 (degrees / 2)
        s_lo, s_hi = max(0, t[1] - int(tol[1])), min(255, t[1] + int(tol[1]))
        v_lo, v_hi = max(0, t[2] - int(tol[2])), min(255, t[2] + int(tol[2]))
        if t[1] < _HSV_GRAY_SAT or dh >= 90:
            return cv2.inRange(conv, (0, s_lo, v_lo), (179, s_hi, v_hi))
        lo, hi = t[0] - dh, t[0] + dh
        mask = cv2.inRange(conv, (max(0, lo), s_lo, v_lo), (min(179, hi), s_hi, v_hi))
        if lo < 0:
            mask |= cv2.inRange(conv, (180 + lo, s_lo, v_lo), (179, s_hi, v_hi))
        if hi > 179:
            mask |= cv2.inRange(conv, (0, s_lo, v_lo), (hi - 180, s_hi, v_hi))
        return mask
    # lab: OpenCV 8-bit Lab stores L * 255 / 100 and a + 128, b + 128. A box test (cheap, inRange) first, the
    # exact delta E only on the pixels inside the box.
    de = float(tol)
    dl8 = int(math.ceil(de * 2.55))
    di = int(math.ceil(de))
    mask = cv2.inRange(conv, (max(0, t[0] - dl8), max(0, t[1] - di), max(0, t[2] - di)),
                       (min(255, t[0] + dl8), min(255, t[1] + di), min(255, t[2] + di)))
    ys, xs = np.nonzero(mask)
    if len(ys):
        px = conv[ys, xs].astype(np.float32)
        dl = (px[:, 0] - t[0]) * (100.0 / 255.0)
        da = px[:, 1] - t[1]
        db = px[:, 2] - t[2]
        far = dl * dl + da * da + db * db > de * de
        mask[ys[far], xs[far]] = 0
    return mask


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


def compare_colors(colors, sim=0.9, image=None, count_sim=1.0, color_space="rgb", tolerance=None):
    """True if the color points match at their absolute positions.

    `color_space` / `tolerance`: see `color_tolerance` (a point's own "-rrggbb" diff applies to rgb only).
    """
    img = to_bgr(image)
    if img is None:
        return False
    pts = parse_color_points(colors)
    tol = color_tolerance(color_space, sim, tolerance)
    h, w = img.shape[:2]
    hits = 0
    for x, y, rgb, pdiff in pts:
        if not (0 <= x < w and 0 <= y < h):
            continue
        if color_space == "rgb":
            ok = bool(_channel_ok(img[y, x], rgb, pdiff or tol))
        else:
            ok = bool(_space_mask(_convert(img[y:y + 1, x:x + 1], color_space), rgb, tol, color_space).any())
        if ok:
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


def find_colors(colors, rect=None, sim=0.9, space=5, ori=2, max_num=0, image=None, color_space="rgb",
                tolerance=None):
    """Multi-point color search. Returns Points of the first color point (screen coords).

    `space` is the minimum distance between results (AScript); the colour space is `color_space`
    ("rgb" default, "hsv", "lab") with `tolerance` (see `color_tolerance`; default derived from `sim`).
    """
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
    tol = color_tolerance(color_space, sim, tolerance)
    x0, y0 = pts[0][0], pts[0][1]
    rel = [(x - x0, y - y0, rgb, (d or tol) if color_space == "rgb" else tol) for x, y, rgb, d in pts]
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
    if color_space == "rgb":
        conv, cx0, cy0 = img, 0, 0
    else:  # convert the window every offset reads from once
        cx0, cy0 = ox0 + min_dx, oy0 + min_dy
        conv = _convert(img[cy0:oy1 + max_dy, cx0:ox1 + max_dx], color_space)
    mask = None
    for dx, dy, rgb, d in rel:
        ys, xs = oy0 + dy - cy0, ox0 + dx - cx0
        ok = _space_mask(conv[ys:ys + (oy1 - oy0), xs:xs + (ox1 - ox0)], rgb, d, color_space)
        mask = ok if mask is None else (cv2.bitwise_and(mask, ok) if cv2 is not None else mask & ok)
        if not mask.any():
            return []
    found = _greedy_points(mask, ori, max(0, int(space)), int(max_num or 0))
    return [Point(x + ox0 + offx, y + oy0 + offy) for x, y in found]


def _region(rect, image):
    """(bgr, ox, oy): the search region and its offset in screen coordinates."""
    rect = _norm_rect(rect)
    img = to_bgr(image) if image is not None else capture_bgr(rect)
    if img is None:
        return None, 0, 0
    if rect and image is not None:
        l, t, r, b = rect
        return img[t:b, l:r], l, t
    return img, (rect[0] if rect else 0), (rect[1] if rect else 0)


def _colors_mask(color, img, sim, color_space, tolerance):
    """Mask of pixels matching any of '#rrggbb|#rrggbb-101010|...' (a colour's own diff applies to rgb only)."""
    conv = _convert(img, color_space)
    mask = None
    for part in str(color).split("|"):
        part = part.strip()
        if not part:
            continue
        hexc, diff = (part.split("-", 1) + [None])[:2]
        rgb = hex_to_rgb(hexc)
        tol = color_tolerance(color_space, sim, tolerance)
        if color_space == "rgb" and diff and tolerance is None:
            tol = hex_to_rgb(diff)
        m = _space_mask(conv, rgb, tol, color_space)
        mask = m if mask is None else (mask | m)
    if mask is None:
        raise ValueError("empty color string")
    return mask


def count_color(color, rect=None, sim=0.9, image=None, color_space="rgb", tolerance=None):
    """Number of pixels in `rect` matching `color` ('#rrggbb', or several joined by '|')."""
    _need_numpy()
    img, _, _ = _region(rect, image)
    if img is None:
        return 0
    if color_space == "rgb" and cv2 is None:
        rgb = hex_to_rgb(str(color).split("|")[0].split("-")[0])
        return int(_channel_ok(img, rgb, color_tolerance("rgb", sim, tolerance)).sum())
    return int(np.count_nonzero(_colors_mask(color, img, sim, color_space, tolerance)))


def find_color_blobs(color, rect=None, sim=0.9, color_space="hsv", tolerance=None, min_area=50, max_num=0,
                     image=None):
    """Connected regions of `color` → [{rect, center_x, center_y, area, fill, ...}], largest first.

    `fill` is area / bounding-box area (1.0 = solid rectangle). Default color space is HSV so a button
    is found whole even with a gradient or a dimmed screen.
    """
    _need_numpy()
    if cv2 is None:
        raise RuntimeError("OpenCV (cv2) is not available in this runtime")
    img, ox, oy = _region(rect, image)
    if img is None:
        return []
    mask = _colors_mask(color, img, sim, color_space, tolerance)
    n, _, stats, cents = cv2.connectedComponentsWithStats(mask, connectivity=8)
    out = []
    for i in range(1, n):
        x, y, w, h, area = [int(v) for v in stats[i]]
        if area < max(1, int(min_area)):
            continue
        cx, cy = float(cents[i][0]) + ox, float(cents[i][1]) + oy
        out.append({
            "rect": [x + ox, y + oy, x + ox + w, y + oy + h],
            "center_x": int(round(cx)),
            "center_y": int(round(cy)),
            "result": (cx, cy),
            "area": area,
            "fill": round(area / float(w * h), 4),
        })
    out.sort(key=lambda d: -d["area"])
    return out[:max_num] if max_num else out


_DOMINANT_MAX_PIXELS = 20000


def dominant_colors(rect=None, k=3, image=None, color_space="lab"):
    """Main colours of a region by k-means → [{color: '#rrggbb', rgb: (r, g, b), ratio}], most common first.

    Clusters in Lab by default (perceptual distances); the region is subsampled to ~20k pixels and the
    k-means seed is fixed, so the same image always gives the same answer.
    """
    _need_numpy()
    if cv2 is None:
        raise RuntimeError("OpenCV (cv2) is not available in this runtime")
    k = int(k)
    if k < 1:
        raise ValueError("k must be >= 1")
    img, _, _ = _region(rect, image)
    if img is None or img.size == 0:
        return []
    img = np.ascontiguousarray(img[:, :, :3])
    h, w = img.shape[:2]
    step = max(1, int(math.ceil(math.sqrt(h * w / float(_DOMINANT_MAX_PIXELS)))))
    sample = img[::step, ::step].reshape(-1, 3)
    uniq, inverse = np.unique(sample, axis=0, return_inverse=True)
    if len(uniq) <= k:
        # No more distinct colours than clusters: count them exactly (k-means++ can seed two centres on
        # the same colour when there are only a few distinct ones, and then merge two real colours).
        labels = inverse.reshape(-1)
        k = len(uniq)
    else:
        conv = sample if color_space == "rgb" else _convert(sample.reshape(-1, 1, 3), color_space).reshape(-1, 3)
        cv2.setRNGSeed(12345)
        crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 0.5)
        _, labels, _ = cv2.kmeans(conv.astype(np.float32), k, None, crit, 5, cv2.KMEANS_PP_CENTERS)
        labels = labels.reshape(-1)
    out = []
    for i in range(k):
        sel = labels == i
        n = int(sel.sum())
        if not n:
            continue
        b, g, r = [int(round(v)) for v in sample[sel].astype(np.float32).mean(axis=0)]
        out.append({"color": "#%02x%02x%02x" % (r, g, b), "rgb": (r, g, b), "ratio": round(n / float(len(labels)), 4)})
    out.sort(key=lambda d: -d["ratio"])
    return out


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
_CF_PEAKS_PER_SCALE = 2
_CF_REFINE_FLOOR = 0.2      # a candidate at the wrong scale can score far below its true score (0.3 -> 0.99)


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


_SCALE_REFINE_SPAN = 0.06     # half the ~1.12 coarse step: the true scale lies within +-6% of the best coarse one
_SCALE_REFINE_MIN = 0.004
_SCALE_REFINE_SLACK = 0.2     # coarse winners this far below the threshold are still refined


def _refine_scale(src, tpl, hit, span=_SCALE_REFINE_SPAN):
    """Local log-scale search around a coarse hit ``(score, x, y, w, h)``.

    Coarse scales are ~12% apart; for a 500px template a 3% scale error already misaligns the edges by
    ~15px and drops TM_CCOEFF_NORMED well below 0.9. Each round tries ``s*(1-d)`` and ``s*(1+d)`` in a
    small window around the current best centre and halves ``d`` until a step moves the template's
    long side by less than a pixel.
    """
    sh, sw = src.shape[:2]
    best = hit
    d = span
    while True:
        bs = best[3] / float(tpl.w)
        if d < max(_SCALE_REFINE_MIN, 1.0 / max(1.0, max(tpl.w, tpl.h) * bs)):
            return best
        cx, cy = best[1] + best[3] / 2.0, best[2] + best[4] / 2.0
        for s in (bs * (1 - d), bs * (1 + d)):
            w, h = max(4, int(round(tpl.w * s))), max(4, int(round(tpl.h * s)))
            if w >= sw or h >= sh or (w, h) == (best[3], best[4]):
                continue
            pad = max(6, int(max(w, h) * d) + 4)
            x0, y0 = max(0, int(cx - w / 2.0) - pad), max(0, int(cy - h / 2.0) - pad)
            x1, y1 = min(sw, int(cx + w / 2.0) + pad + 1), min(sh, int(cy + h / 2.0) + pad + 1)
            if x1 - x0 <= w or y1 - y0 <= h:
                continue
            mask = _resize(tpl.mask, w, h) if tpl.mask is not None else None
            r = _do_match(src[y0:y1, x0:x1], _resize(tpl.img, w, h), mask)
            _, mv, _, ml = cv2.minMaxLoc(r)
            if mv > best[0]:
                best = (float(mv), x0 + ml[0], y0 + ml[1], w, h)
        d /= 2.0


_POLISH_DONE = 0.995          # a coarse hit scoring this high is already at the right scale


def _polish(src, tpl, hit):
    """Refine the scale of a hit that already passed the threshold.

    Coarse scales are ~12% apart, so a passing hit can still be up to ~6% off in scale (0.745 reported for a
    0.8 screen). The local search costs a few small window matches; the result is kept only when it scores
    higher, so it never loses a hit.
    """
    if hit[0] >= _POLISH_DONE:
        return hit
    fine = _refine_scale(src, tpl, hit)
    return fine if fine[0] > hit[0] else hit


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
    """Coarse scan over every scale, then a fine scale search around the best few candidates.

    Single best hit only. Each scale keeps its top ``_CF_PEAKS_PER_SCALE`` 1/4-resolution peaks: when the
    true scale falls between two coarse steps every coarse score is mediocre, and a look-alike elsewhere
    on screen (a repeated card) can out-score the real target there. Refining the top candidates at full
    resolution separates them.
    """
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
        rx, ry = max(1, tw // 2), max(1, th // 2)
        for _ in range(_CF_PEAKS_PER_SCALE):
            _, mv, _, ml = cv2.minMaxLoc(r)
            if mv <= 0:
                break
            cands.append((mv, ml, s))
            r[max(0, ml[1] - ry):ml[1] + ry + 1, max(0, ml[0] - rx):ml[0] + rx + 1] = -1.0
    cands.sort(key=lambda c: -c[0])
    best = None
    for _, (cx, cy), s in cands[:_CF_TOP_K]:
        ax, ay = cx * ds, cy * ds
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
        hit = (float(mv), x0 + ml[0], y0 + ml[1], w, h)
        if _CF_REFINE_FLOOR <= hit[0] < threshold:
            hit = _refine_scale(src, tpl, hit)
        if best is None or hit[0] > best[0]:
            best = hit
        if best[0] >= max(threshold, 0.98):
            break
    if best is None or best[0] < threshold:
        return []
    return [_polish(src, tpl, best)]


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


def _multi(src, tpl, threshold, maxcnt, scale_range, src_half=None, cf_tried=False):
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
    if best is None:
        return []
    if best[0] < threshold:
        # The true scale fell between two coarse steps: search scales finely around the best candidates,
        # then re-scan the whole frame at the refined size so find_all keeps every hit.
        fine = None
        if _cf_eligible(tpl, src):
            if not cf_tried:  # the caller already ran the candidate search and it found nothing
                hits = _multi_cf(src, tpl, threshold, scale_range)
                fine = hits[0] if hits else None
        elif best[0] >= threshold - _SCALE_REFINE_SLACK:
            _, mv, _, ml = cv2.minMaxLoc(best[1])
            fine = _refine_scale(src, tpl, (float(mv), ml[0], ml[1], best[2], best[3]))
        if fine is not None and fine[0] >= threshold:
            if maxcnt == 1:
                return [fine]
            w, h = fine[3], fine[4]
            mask = _resize(tpl.mask, w, h) if tpl.mask is not None else None
            best = (fine[0], _do_match(src, _resize(tpl.img, w, h), mask), w, h)
    if best[0] < threshold:
        return []
    _, mv, _, ml = cv2.minMaxLoc(best[1])
    top = (float(mv), ml[0], ml[1], best[2], best[3])
    fine = _polish(src, tpl, top)
    if fine is not top:
        if maxcnt == 1:
            return [fine]
        # Every hit is taken at the refined size: one more full-frame match.
        w, h = fine[3], fine[4]
        mask = _resize(tpl.mask, w, h) if tpl.mask is not None else None
        best = (fine[0], _do_match(src, _resize(tpl.img, w, h), mask), w, h)
    return _extract(best[1], best[2], best[3], threshold, maxcnt)


def _match_prepared(src, tpl, threshold, maxcnt, scale_range, fast, src_half=None):
    multi = bool(scale_range) and len(scale_range) == 2 and float(scale_range[0]) != float(scale_range[1])
    if multi:
        cf_tried = maxcnt == 1 and _cf_eligible(tpl, src)
        if cf_tried:
            hits = _multi_cf(src, tpl, threshold, scale_range)
            if hits:
                return hits
        return _multi(src, tpl, threshold, maxcnt, scale_range, src_half, cf_tried)
    if fast and _cf_eligible(tpl, src):
        hits = _single_cf(src, tpl, threshold, maxcnt)
        if hits:
            return hits
    return _single(src, tpl, threshold, maxcnt, src_half)


def _to_dicts(hits, ox, oy, index, tpl_w=None):
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
            # Same keys as feature hits (`feature.match`): corners clockwise from top-left, angle, scale.
            "quad": [[float(x), float(y)], [float(x + w), float(y)], [float(x + w), float(y + h)], [float(x), float(y + h)]],
            "angle": 0.0,
            "scale": round(w / float(tpl_w), 4) if tpl_w else 1.0,
            "method": "template",
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
    if rgb:
        raw = [_colour_filter(src, parts[i], hits, confidence) for i, hits in enumerate(raw)]
    out = []
    for i, hits in enumerate(raw):
        out.extend(_to_dicts(hits, ox, oy, first_index + i, tpls[i].w))
    return out


def _colour_tolerance(confidence):
    """Largest mean chroma difference (Lab a/b units) a rgb=True hit may have; 0.9 -> 15, 0.8 -> 30."""
    return max(8.0, (1.0 - confidence) * 150.0)


def chroma_difference(region, template):
    """Mean per-pixel distance in Lab a/b (colour, not brightness) between a BGR region and a BGR/BGRA template
    of the same picture. Transparent template pixels are ignored. 0 = same colours; a grey copy of a red
    icon scores ~50+."""
    mask = None
    if template.ndim == 3 and template.shape[2] == 4:
        if _significant_alpha(template[:, :, 3]):
            mask = template[:, :, 3] > 127
        template = template[:, :, :3]
    if template.ndim == 2:
        template = cv2.cvtColor(template, cv2.COLOR_GRAY2BGR)
    if region.ndim == 2:
        region = cv2.cvtColor(region, cv2.COLOR_GRAY2BGR)
    region = region[:, :, :3]
    h, w = region.shape[:2]
    if template.shape[:2] != (h, w):
        template = cv2.resize(template, (w, h), interpolation=cv2.INTER_AREA)
        if mask is not None:
            mask = cv2.resize(mask.view(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST) > 0
    a = cv2.cvtColor(np.ascontiguousarray(region), cv2.COLOR_BGR2LAB)[:, :, 1:].astype(np.float32)
    b = cv2.cvtColor(np.ascontiguousarray(template), cv2.COLOR_BGR2LAB)[:, :, 1:].astype(np.float32)
    d = np.sqrt(((a - b) ** 2).sum(axis=2))
    if mask is not None and mask.any():
        d = d[mask]
    return float(d.mean())


def _shape_score(region, template):
    """Grayscale TM_CCOEFF_NORMED of a template against an equally sized region (alpha used as mask).
    A flat template or region has no shape: they agree only if both are flat and of similar brightness."""
    mask = None
    if template.ndim == 3 and template.shape[2] == 4 and _significant_alpha(template[:, :, 3]):
        mask = template[:, :, 3]
    g_t = _to_match_space(template, False)
    g_r = _to_match_space(region, False)
    h, w = g_r.shape[:2]
    if g_t.shape[:2] != (h, w):
        g_t = cv2.resize(g_t, (w, h), interpolation=cv2.INTER_AREA)
        if mask is not None:
            mask = cv2.resize(mask, (w, h), interpolation=cv2.INTER_NEAREST)
    if g_t.std() < 1.0 or g_r.std() < 1.0:
        return 1.0 if g_t.std() < 1.0 and g_r.std() < 1.0 and abs(float(g_t.mean()) - float(g_r.mean())) < 16 else 0.0
    if mask is not None:
        r = cv2.matchTemplate(g_r, g_t, cv2.TM_CCORR_NORMED, mask=mask)
    else:
        r = cv2.matchTemplate(g_r, g_t, cv2.TM_CCOEFF_NORMED)
    v = float(r[0, 0])
    return v if np.isfinite(v) else 0.0


def _colour_filter(src, part, hits, confidence):
    """rgb=True verifies each H+S hit. H+S correlation sees neither shape nor colour when the template has no
    hue/saturation variance: a grey icon scores 1.0 on its coloured version and on any flat grey area. A hit is
    kept only if its grayscale shape also matches (same confidence) and its colours are close to the template's."""
    if not hits or src.ndim != 3:
        return hits
    tpl = _raw_template(part)
    tol = _colour_tolerance(confidence)
    keep = []
    for hit in hits:
        _, x, y, w, h = hit
        x, y, w, h = int(x), int(y), int(w), int(h)
        region = src[max(0, y):y + h, max(0, x):x + w]
        if region.size and region.shape[:2] == (h, w) and _shape_score(region, tpl) >= confidence \
                and chroma_difference(region, tpl) <= tol:
            keep.append(hit)
    return keep


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


FIND_METHODS = ("auto", "template", "multiscale", "feature", "hash")
DEFAULT_MULTISCALE = (0.5, 2.0)


def _raw_template(part):
    """Template as a BGR/BGRA ndarray (features need the original pixels, not the match-space image)."""
    if np is not None and isinstance(part, np.ndarray):
        return part
    path = str(part)
    if not os.path.isfile(path):
        raise FileNotFoundError("template not found: %s" % path)
    raw = imread(path)
    if raw is None:
        raise ValueError("cannot decode template %s" % path)
    return raw


def _feature_hits(src, items, confidence, offset, detectors, first_index=0):
    from xscript.android import feature

    out = []
    for i, part in enumerate(items):
        tpl = _raw_template(part)
        for det in detectors:
            hit = feature.match(src, tpl, det, confidence, offset)
            if hit is not None:
                hit["index"] = first_index + i
                out.append(hit)
                break
    return out


def _hash_hits(src, items, confidence, offset):
    """method="hash": does the whole search region look like the template? (dHash; rect picks the region)."""
    from xscript.android import feature

    h, w = src.shape[:2]
    ox, oy = offset
    out = []
    for i, part in enumerate(items):
        sim = feature.hash_similarity(src, _raw_template(part))
        if sim >= confidence:
            out.extend(_to_dicts([(sim, 0, 0, w, h)], ox, oy, i))
            out[-1]["method"] = "hash"
            out[-1]["scale"] = 1.0
    return out


def find_templates(parts, rect=None, confidence=0.9, rgb=False, maxcnt=0, scale_range=None, image=None,
                   ori=None, fast=True, method=None):
    """parts: path or list of paths. Captures once and searches every template.

    `ori=None` (XScript): best confidence first, `maxcnt` caps the combined list.
    `ori=1..8` (AScript): `maxcnt` applies per template, results ordered by scan direction.

    `method`: None / "template" (default: template matching, multi-scale when `scale_range` is given),
    "multiscale" (template matching over `scale_range`, default 0.5-2.0), "feature" (ORB then SIFT keypoints +
    homography: any scale and rotation, at most one hit per template), "auto" (template first, features for
    templates it did not find) or "hash" (is the `rect` region the same picture as the template, by dHash).
    """
    if method is not None and method not in FIND_METHODS:
        raise ValueError("method must be one of %s, got %r" % (", ".join(FIND_METHODS), method))
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
    if method in ("feature", "hash"):
        if cv2 is None:
            raise RuntimeError("OpenCV (cv2) is not available in this runtime")
        confidence = _clamp_confidence(confidence)
        if rect:
            l, t, r, b = rect
            src = src[t:b, l:r]
            offset = (offset[0] + l, offset[1] + t)
        if method == "hash":
            out = _hash_hits(src, items, confidence, offset)
        else:
            out = _feature_hits(src, items, confidence, offset, ("orb", "sift"))
    else:
        if method == "multiscale" and not scale_range:
            scale_range = DEFAULT_MULTISCALE
        out = _match_many(src, items, rect, confidence, rgb, maxcnt, scale_range, offset, fast)
        if method == "auto":
            found = set(d["index"] for d in out)
            missing = [i for i in range(len(items)) if i not in found]
            if missing:
                region, roff = src, offset
                if rect:
                    l, t, r, b = rect
                    region, roff = src[t:b, l:r], (offset[0] + l, offset[1] + t)
                for i in missing:
                    out.extend(_feature_hits(region, [items[i]], _clamp_confidence(confidence), roff, ("orb", "sift"), i))
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
