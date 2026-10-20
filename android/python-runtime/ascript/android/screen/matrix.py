"""点阵字库 (dot-matrix font library) behind ``Ocr.matrix`` / ``Ocr.matrix_detail`` / ``OcrX``.

A font library is a small JSON text file, by convention ``res/font.t`` in the project::

    {"format": "xscript-matrix", "version": 1,
     "colors": ["FFFFFF-202020"],          # ink colour(s) "RRGGBB-DDDDDD" (colour - per-channel tolerance), or
     "threshold": 128, "invert": false,    # without colours: gray >= threshold is ink (invert: gray < threshold)
     "glyphs": [{"char": "1", "w": 5, "h": 7, "bits": "00100011000010000100001000010001110"}]}

Recognition binarises the area with the library's ink rule, then matches every glyph bitmap (largest first) with
``CvFontLib``, so lines and reading order behave the same as the image font library. ``region`` (0-1) is the match
similarity. AScript's own ``font.t`` files come from its picture-colour helper in an undocumented binary format and
cannot be read; build a library with :class:`MatrixFont` (``add`` glyphs cut from screenshots, then ``save``).
"""
from __future__ import annotations

import json
import os
import re

import cv2
import numpy as np

FORMAT = "xscript-matrix"
_COLOR = re.compile(r"^#?([0-9a-fA-F]{6})(?:-#?([0-9a-fA-F]{6}))?$")


def _parse_color(spec):
    m = _COLOR.match(str(spec).strip())
    if not m:
        raise ValueError("ink colour must look like 'RRGGBB' or 'RRGGBB-DDDDDD': %r" % (spec,))
    rgb = [int(m.group(1)[i:i + 2], 16) for i in (0, 2, 4)]
    tol = [int((m.group(2) or "000000")[i:i + 2], 16) for i in (0, 2, 4)]
    return rgb, tol


class MatrixFont:
    """A dot-matrix font: one bitmap per character plus the rule that turns screen pixels into ink."""

    def __init__(self, colors=None, threshold=128, invert=False):
        self.colors = [c.upper().lstrip("#") for c in (colors or [])]
        for c in self.colors:
            _parse_color(c)
        if not 0 <= int(threshold) <= 255:
            raise ValueError("threshold must be within 0-255")
        self.threshold, self.invert = int(threshold), bool(invert)
        self.glyphs = []  # [(char, uint8 mask 0/1)]

    # ---- ink -------------------------------------------------------------------------------------------------------

    def binarize(self, image):
        """uint8 mask (1 = ink) of a BGR / gray ndarray."""
        img = np.asarray(image)
        if img.ndim == 2:
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        img = img[:, :, :3]
        if self.colors:
            mask = np.zeros(img.shape[:2], np.uint8)
            for spec in self.colors:
                (r, g, b), (dr, dg, db) = _parse_color(spec)
                lo = np.array([max(0, b - db), max(0, g - dg), max(0, r - dr)], np.uint8)
                hi = np.array([min(255, b + db), min(255, g + dg), min(255, r + dr)], np.uint8)
                mask |= (cv2.inRange(img, lo, hi) > 0).astype(np.uint8)
            return mask
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        return ((gray < self.threshold) if self.invert else (gray >= self.threshold)).astype(np.uint8)

    # ---- glyphs ----------------------------------------------------------------------------------------------------

    def add(self, char, image, rect=None):
        """Cut a glyph for ``char`` from ``image`` (path / ndarray / Bitmap; ``rect`` = [l, t, r, b]); trimmed to its ink."""
        from xscript.android import image as _img

        if not isinstance(char, str) or not char:
            raise ValueError("char must be a non-empty string")
        img = _img.to_bgr(image)
        if img is None:
            raise ValueError("no image")
        if rect:
            l, t, r, b = [int(v) for v in rect[:4]]
            img = img[t:b, l:r]
        mask = self.binarize(img)
        ys, xs = np.nonzero(mask)
        if not len(xs):
            raise ValueError("no ink in the glyph area for %r (check colors / threshold)" % char)
        self.glyphs = [(c, m) for c, m in self.glyphs if c != char]
        self.glyphs.append((char, mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1].copy()))
        return self

    def chars(self):
        return [c for c, _ in self.glyphs]

    # ---- file ------------------------------------------------------------------------------------------------------

    def to_json(self):
        doc = {"format": FORMAT, "version": 1, "glyphs": [
            {"char": c, "w": int(m.shape[1]), "h": int(m.shape[0]), "bits": "".join("1" if v else "0" for v in m.flatten())}
            for c, m in self.glyphs]}
        if self.colors:
            doc["colors"] = list(self.colors)
        else:
            doc["threshold"], doc["invert"] = self.threshold, self.invert
        return doc

    def save(self, path):
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_json(), f, ensure_ascii=False)
        return path

    @staticmethod
    def from_json(doc):
        if not isinstance(doc, dict) or doc.get("format") != FORMAT:
            raise ValueError("not an XScript dot-matrix font library (AScript's binary font.t files are not supported; "
                             "build one with MatrixFont)")
        font = MatrixFont(doc.get("colors"), doc.get("threshold", 128), doc.get("invert", False))
        for g in doc.get("glyphs") or []:
            w, h, bits = int(g["w"]), int(g["h"]), str(g["bits"])
            if w <= 0 or h <= 0 or len(bits) != w * h or set(bits) - {"0", "1"}:
                raise ValueError("bad glyph %r: bits must be w*h characters of 0/1" % g.get("char"))
            font.glyphs.append((str(g["char"]), np.frombuffer(bits.encode(), np.uint8).reshape(h, w) - ord("0")))
        if not font.glyphs:
            raise ValueError("the font library has no glyphs")
        return font

    @staticmethod
    def load(path):
        if isinstance(path, MatrixFont):
            return path
        with open(path, encoding="utf-8") as f:
            try:
                doc = json.load(f)
            except ValueError as e:
                raise ValueError("not an XScript dot-matrix font library: %s (AScript's binary font.t files are not "
                                 "supported; build one with MatrixFont)" % path) from e
        return MatrixFont.from_json(doc)

    # ---- recognition -----------------------------------------------------------------------------------------------

    def templates(self):
        """(BGR templates white-on-black with a 1px background border, chars), largest glyph first."""
        order = sorted(self.glyphs, key=lambda g: -int(g[1].sum()))
        tpls = [cv2.cvtColor(cv2.copyMakeBorder(m * 255, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0), cv2.COLOR_GRAY2BGR)
                for _, m in order]
        return tpls, [c for c, _ in order]

    def recognize(self, image, rect=None, region=0.9, spacing=5):
        """CvFontLib result data ({"text", "words", "group"}) on the binarised area, or None."""
        from ascript.android.screen.gp_tasks import CvFontLib

        if not 0 < float(region) <= 1:
            raise ValueError("region must be within (0, 1]")
        h, w = image.shape[:2]
        l, t, r, b = [int(v) for v in rect[:4]] if rect else (0, 0, w, h)
        l, t, r, b = max(0, l), max(0, t), min(w, r), min(h, b)
        if r <= l or b <= t:
            raise ValueError("rect must be [left, top, right, bottom] inside the image")
        ink = cv2.cvtColor(self.binarize(image[t:b, l:r]) * 255, cv2.COLOR_GRAY2BGR)
        # 1px of background around the area so glyphs touching its edge still match their padded templates
        ink = cv2.copyMakeBorder(ink, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
        tpls, chars = self.templates()
        data = CvFontLib(tpls, chars, confidence=float(region), spacing=spacing).run(ink).data
        if not data:
            return None
        for matches in data["words"]:
            for m in matches:  # back to image coordinates: undo the border and the 1px template padding
                m["rectangle"] = [[x + l - 1, y + t - 1] for x, y in m["rectangle"]]
                if "result" in m:
                    m["result"] = [m["result"][0] + l - 1, m["result"][1] + t - 1]
        return data


def detail(font_lib, rect=None, region=0.9, image=None):
    """{"text", "chars": [{"text", "rect", "center_x", "center_y", "confidence"}], "lines": [...]} or None."""
    from xscript.android import image as _img

    font = MatrixFont.load(font_lib)
    img = _img.to_bgr(image)
    if img is None:
        return None
    data = font.recognize(img, rect, region)
    if not data:
        return None
    chars = []
    for matches in data["words"]:
        for m in matches:
            (x, y), (r, b) = m["rectangle"][0], m["rectangle"][3]
            chars.append({"text": m["font"], "rect": [x + 1, y + 1, r - 1, b - 1], "center_x": (x + r) // 2,
                          "center_y": (y + b) // 2, "confidence": round(float(m.get("confidence", 0)), 4)})
    groups = []
    for c in chars:  # same line grouping as CvFontLib.sort_group (centre y within 5px)
        for g in groups:
            if abs(g[0]["center_y"] - c["center_y"]) < 5:
                g.append(c)
                break
        else:
            groups.append([c])
    groups.sort(key=lambda g: g[0]["center_y"])
    for g in groups:
        g.sort(key=lambda c: c["rect"][0])
    return {"text": data["text"], "chars": [c for g in groups for c in g], "lines": data["group"]}


def text(font_lib, rect=None, region=0.9, image=None):
    d = detail(font_lib, rect, region, image)
    return d["text"] if d else None
