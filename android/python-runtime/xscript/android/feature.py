"""Scale- and rotation-invariant image search with local features (ORB / SIFT / AKAZE) and a MAGSAC homography.

Template matching (`image._match_many`) is exact and fast but only finds the template at the scale(s) it scans
and never rotated. Here keypoints of the template are matched to keypoints of the screen, a homography is fitted
with MAGSAC++, and the screen region is warped back into the template's frame and compared with
TM_CCOEFF_NORMED. That score is the hit's ``confidence``, so it means the same thing as a template match score
(and rejects geometrically consistent but visually different look-alikes).

Needs texture: small flat icons give too few keypoints (`keypoint_count` tells), which is why
``method="auto"`` tries template matching first. All detectors are in OpenCV's main module (SIFT since 4.4).
"""

import math

try:
    import numpy as np
except Exception:  # pragma: no cover - numpy is bundled on device
    np = None

try:
    import cv2
except Exception:  # pragma: no cover
    cv2 = None

DETECTORS = ("orb", "sift", "akaze")
MIN_KEYPOINTS = 12        # templates with fewer keypoints are not searched with features
MIN_INLIERS = 8
RATIO = 0.75              # Lowe ratio test
_PAD = 16                 # ORB/AKAZE skip a border of ~patch size; padding lets keypoints sit near the edge
_DOWNSCALE_MIN_TPL = 96   # templates at least this big (short side) are matched on a half-size screen
_DOWNSCALE_MIN_SRC = 1200
_SCALE_LIMITS = (0.2, 5.0)
_cache = {}
_CACHE_MAX = 32


def _create(kind):
    if kind == "orb":
        return cv2.ORB_create(nfeatures=3000)
    if kind == "sift":
        return cv2.SIFT_create(nfeatures=2000)
    if kind == "akaze":
        return cv2.AKAZE_create()
    raise ValueError("detector must be one of %s, got %r" % (", ".join(DETECTORS), kind))


def _norm(kind):
    return cv2.NORM_L2 if kind == "sift" else cv2.NORM_HAMMING


def _gray(img):
    if img.ndim == 2:
        return img
    if img.shape[2] == 4:
        img = img[:, :, :3]
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def _detect(gray, kind, pad=0):
    det = _create(kind)
    if pad:
        gray = cv2.copyMakeBorder(gray, pad, pad, pad, pad, cv2.BORDER_REPLICATE)
    kp, des = det.detectAndCompute(gray, None)
    pts = np.float32([k.pt for k in kp]).reshape(-1, 2) - pad if kp else np.zeros((0, 2), np.float32)
    return pts, des


def _template_features(gray, kind):
    key = (kind, gray.shape, gray[:: max(1, gray.shape[0] // 16), :: max(1, gray.shape[1] // 16)].tobytes())
    hit = _cache.get(key)
    if hit is not None and np.array_equal(hit[0], gray):
        return hit[1]
    feats = _detect(gray, kind, _PAD)
    if len(_cache) >= _CACHE_MAX:
        _cache.pop(next(iter(_cache)))
    _cache[key] = (gray.copy(), feats)
    return feats


def keypoint_count(template, kind="orb"):
    """Keypoints the detector finds on a template (BGR/BGRA/gray ndarray); < MIN_KEYPOINTS means "use templates"."""
    pts, _ = _template_features(_gray(template), kind)
    return len(pts)


def _quad_ok(quad, tw, th):
    """Convex, not folded, plausible scale and aspect: rejects degenerate homographies."""
    q = quad.reshape(4, 2).astype(np.float64)
    cross = []
    for i in range(4):
        a, b, c = q[i], q[(i + 1) % 4], q[(i + 2) % 4]
        cross.append((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]))
    if not (all(v > 0 for v in cross) or all(v < 0 for v in cross)):
        return False
    area = abs(cv2.contourArea(q.astype(np.float32)))
    s = math.sqrt(area / float(tw * th)) if tw * th else 0
    if not (_SCALE_LIMITS[0] <= s <= _SCALE_LIMITS[1]):
        return False
    top, left = np.linalg.norm(q[1] - q[0]), np.linalg.norm(q[3] - q[0])
    ratio = (top / max(left, 1e-6)) / (tw / float(th))
    return 0.5 <= ratio <= 2.0


def _verify(src_gray, tpl_gray, h_full, mask=None):
    """Warp the found region back to the template frame and score it like a template match."""
    th, tw = tpl_gray.shape[:2]
    try:
        inv = np.linalg.inv(h_full)
    except np.linalg.LinAlgError:
        return 0.0
    back = cv2.warpPerspective(src_gray, inv, (tw, th), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    if mask is not None:
        valid = mask > 128
        if np.count_nonzero(valid) < 16:
            return 0.0
        a = back[valid].astype(np.float32)
        b = tpl_gray[valid].astype(np.float32)
        a -= a.mean()
        b -= b.mean()
        d = math.sqrt(float((a * a).sum()) * float((b * b).sum()))
        return float((a * b).sum() / d) if d > 0 else 0.0
    r = cv2.matchTemplate(back, tpl_gray, cv2.TM_CCOEFF_NORMED)
    v = float(r[0, 0])
    return 0.0 if v != v else v


def match(source, template, detector="orb", confidence=0.8, rect_offset=(0, 0), ratio=RATIO,
          min_inliers=MIN_INLIERS):
    """Find one instance of `template` in `source` (BGR/BGRA/gray ndarrays) → hit dict or None.

    The dict has the template-match keys (``result``, ``rectangle``, ``rect``, ``center_x``, ``center_y``,
    ``confidence``) plus ``quad`` (template corners on screen: top-left, top-right, bottom-right,
    bottom-left), ``angle`` (degrees, counter-clockwise like cv2.getRotationMatrix2D), ``scale``,
    ``inliers`` and ``method`` = "feature:<detector>".
    """
    if cv2 is None or np is None:
        raise RuntimeError("OpenCV (cv2) and numpy are required for feature matching")
    mask = None
    if template.ndim == 3 and template.shape[2] == 4 and (template[:, :, 3] < 255).any() and template[:, :, 3].any():
        mask = template[:, :, 3]
    tpl = _gray(template)
    src = _gray(source)
    th, tw = tpl.shape[:2]
    sh, sw = src.shape[:2]
    if th < 8 or tw < 8 or sh < 8 or sw < 8:
        return None
    # Large templates on a large screen: detect on both at half size (4x fewer pixels). Both sides are scaled
    # by the same factor so an unscaled target is still matched at equal scale.
    ds = 0.5 if min(th, tw) >= _DOWNSCALE_MIN_TPL and max(sh, sw) >= _DOWNSCALE_MIN_SRC else 1.0
    tpl_d = tpl if ds == 1.0 else cv2.resize(tpl, (int(tw * ds), int(th * ds)), interpolation=cv2.INTER_AREA)
    pts1, des1 = _template_features(tpl_d, detector)
    if des1 is None or len(pts1) < MIN_KEYPOINTS:
        return None
    pts1 = pts1 / ds
    small = cv2.resize(src, (int(sw * ds), int(sh * ds)), interpolation=cv2.INTER_AREA) if ds != 1.0 else src
    pts2, des2 = _detect(small, detector)
    if des2 is None or len(pts2) < min_inliers:
        return None
    pairs = cv2.BFMatcher(_norm(detector)).knnMatch(des1, des2, k=2)
    good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < ratio * p[1].distance]
    if len(good) < min_inliers:
        return None
    sp = pts1[[m.queryIdx for m in good]].reshape(-1, 1, 2)
    dp = (pts2[[m.trainIdx for m in good]] / ds).reshape(-1, 1, 2)
    method = getattr(cv2, "USAC_MAGSAC", cv2.RANSAC)
    hm, inl = cv2.findHomography(sp, dp, method, 5.0)
    if hm is None or inl is None or int(inl.sum()) < min_inliers:
        return None
    corners = np.float32([[0, 0], [tw, 0], [tw, th], [0, th]]).reshape(-1, 1, 2)
    quad = cv2.perspectiveTransform(corners, hm).reshape(4, 2)
    if not _quad_ok(quad, tw, th):
        return None
    conf = _verify(src, tpl, hm, mask)
    if conf < confidence:
        return None
    ox, oy = rect_offset
    quad = quad + np.float32([ox, oy])
    c = cv2.perspectiveTransform(np.float32([[[tw / 2.0, th / 2.0]]]), hm)[0][0] + np.float32([ox, oy])
    x0, y0 = [int(math.floor(v)) for v in quad.min(axis=0)]
    x1, y1 = [int(math.ceil(v)) for v in quad.max(axis=0)]
    top = quad[1] - quad[0]
    angle = -math.degrees(math.atan2(float(top[1]), float(top[0])))
    scale = (float(np.linalg.norm(top)) / tw + float(np.linalg.norm(quad[3] - quad[0])) / th) / 2.0
    cx, cy = float(c[0]), float(c[1])
    return {
        "result": (cx, cy),
        "rectangle": ((x0, y0), (x0, y1), (x1, y0), (x1, y1)),
        "rect": [x0, y0, x1, y1],
        "center_x": int(round(cx)),
        "center_y": int(round(cy)),
        "confidence": conf,
        "quad": [[float(px), float(py)] for px, py in quad],
        "angle": round(angle, 2),
        "scale": round(scale, 4),
        "inliers": int(inl.sum()),
        "method": "feature:" + detector,
    }


def dhash(img, size=8):
    """64-bit difference hash of a BGR/gray image (as a Python int)."""
    g = cv2.resize(_gray(img), (size + 1, size), interpolation=cv2.INTER_AREA)
    bits = (g[:, 1:] > g[:, :-1]).flatten()
    return int("".join("1" if b else "0" for b in bits), 2)


def hash_similarity(a, b, size=8):
    """1.0 for identical-looking images, ~0.5 for unrelated ones (dHash Hamming similarity)."""
    d = bin(dhash(a, size) ^ dhash(b, size)).count("1")
    return 1.0 - d / float(size * size)
