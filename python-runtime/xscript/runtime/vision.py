"""Image checks for the web 图色工具 and the MCP `vision_test` tool.

Runs in the `:eval` process against a saved snapshot, so results match what a script
would get on the same frame. The device passes a JSON request:

    {"op": "find_colors", "image": "/abs/snapshot.png", "colors": "x,y,#RRGGBB|...",
     "rect": [l, t, r, b], "sim": 0.9}

Ops: pixel, find_colors, compare_colors (count_sim), find_image (ori), ocr (pattern,
binary, confidence). All coordinates are screen pixels of the snapshot.
"""

import base64
import json
import os
import time

from xscript.android import image as _img

# find_colors can match thousands of pixels on flat backgrounds; the UI only needs a few.
MAX_POINTS = 100


def run_b64(payload):
    """Entry point from Kotlin: base64(JSON) in, dict out (JSON-serialisable)."""
    return run(json.loads(base64.b64decode(payload).decode("utf-8")))


def run(req):
    started = time.time()
    op = req.get("op")
    src = _load(req.get("image"))
    rect = _rect(req.get("rect"))
    if op == "pixel":
        out = _pixel(src, req)
    elif op == "find_colors":
        out = _find_colors(src, req, rect)
    elif op == "compare_colors":
        out = _compare_colors(src, req)
    elif op == "find_image":
        out = _find_image(src, req, rect)
    elif op == "ocr":
        out = _ocr(src, req, rect)
    else:
        raise ValueError("unknown op %r" % op)
    out["op"] = op
    out["ms"] = int((time.time() - started) * 1000)
    return out


def _load(path):
    if not path:
        raise ValueError("missing image")
    if not os.path.isfile(path):
        raise ValueError("snapshot not found: %s" % os.path.basename(path))
    img = _img.imread(path)
    if img is None:
        raise ValueError("cannot read image %s" % path)
    if img.ndim == 3 and img.shape[2] == 4:
        img = img[:, :, :3].copy()
    return img


def _rect(value):
    if not value:
        return None
    r = [int(v) for v in value[:4]]
    return r if r[2] > r[0] and r[3] > r[1] else None


def _hex(rgb):
    return "#%02x%02x%02x" % tuple(rgb)


def _pixel(src, req):
    """One point (x, y) → {"color"}; or "points": [[x, y], ...] → {"colors": [...]}."""
    if req.get("points") is not None:
        colors = []
        for p in req["points"][:MAX_POINTS]:
            px = _img.get_pixel(p[0], p[1], src)
            colors.append(None if px is None else _hex(px))
        return {"colors": colors}
    px = _img.get_pixel(req.get("x", 0), req.get("y", 0), src)
    return {"color": None if px is None else _hex(px)}


def _find_colors(src, req, rect):
    limit = int(req.get("max_num") or MAX_POINTS)
    pts = _img.find_colors(
        req["colors"], rect, float(req.get("sim", 0.9)), int(req.get("space", 5)),
        int(req.get("ori", 2)), limit + 1, image=src,
    )
    return {"points": [[p.x, p.y] for p in pts[:limit]], "truncated": len(pts) > limit}


def _ocr(src, req, rect):
    """ML Kit lines; optional `binary` threshold (0-255) and AScript-style regex `pattern`."""
    binary = req.get("binary")
    if binary is not None and int(binary) >= 0:
        import cv2
        gray = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY)
        _, bw = cv2.threshold(gray, int(binary), 255, cv2.THRESH_BINARY)
        src = cv2.cvtColor(bw, cv2.COLOR_GRAY2BGR)
    lines = _img.ocr(rect, image=src)
    pattern = req.get("pattern") or None
    lines = _img.ocr_filter(lines, pattern, float(req.get("confidence") or 0.0))
    return {"lines": [line.to_dict() for line in lines]}


def _compare_colors(src, req):
    """Per-point detail so the tool can show which point failed and by how much.

    `count_sim` (0..1) is AScript's 数量相似度: the share of points that must match.
    """
    tol = _img.diff_from_similarity(float(req.get("sim", 0.9)))
    h, w = src.shape[:2]
    details = []
    for x, y, rgb, pdiff in _img.parse_color_points(req["colors"]):
        inside = 0 <= x < w and 0 <= y < h
        actual = None
        ok = False
        if inside:
            b, g, r = [int(v) for v in src[y, x][:3]]
            actual = _hex((r, g, b))
            t = pdiff or tol
            ok = abs(r - rgb[0]) <= t[0] and abs(g - rgb[1]) <= t[1] and abs(b - rgb[2]) <= t[2]
        details.append({"x": x, "y": y, "expected": _hex(rgb), "actual": actual, "ok": ok})
    need = max(1, int(round(len(details) * float(req.get("count_sim", 1.0)))))
    hits = sum(1 for d in details if d["ok"])
    return {"match": bool(details) and hits >= need, "hits": hits, "need": need, "details": details}


def _find_image(src, req, rect):
    """Template from a project file (`template_path`) or a region of this snapshot (`template_rect`)."""
    if req.get("template_path") and req.get("template_rect"):
        # A region of another snapshot.
        tr = _rect(req.get("template_rect"))
        if not tr:
            raise ValueError("bad template_rect")
        other = _load(req["template_path"])
        tpl = other[tr[1]:tr[3], tr[0]:tr[2]].copy()
        if tpl.size == 0:
            raise ValueError("template_rect is outside the template image")
    elif req.get("template_path"):
        tpl = req["template_path"]
    else:
        tr = _rect(req.get("template_rect"))
        if not tr:
            raise ValueError("find_image needs template_path or template_rect")
        tpl = src[tr[1]:tr[3], tr[0]:tr[2]].copy()
    scale = req.get("scale_range")
    ori = req.get("ori")
    hits = _img.find_templates(
        tpl, rect, float(req.get("confidence", 0.8)), bool(req.get("rgb", False)),
        int(req.get("maxcnt", 10)), scale if scale else None, image=src,
        ori=int(ori) if ori else None,
    )
    out = []
    for h in hits:
        out.append({
            "rect": [int(v) for v in h["rect"]],
            "center_x": int(h["center_x"]),
            "center_y": int(h["center_y"]),
            "confidence": round(float(h["confidence"]), 4),
        })
    return {"hits": out}
