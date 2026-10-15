"""Common image-processing GP tasks (crop, gray, threshold, morphology, resize...)."""

import cv2
import numpy as np

from ascript.android.screen.gp import GPTask, Result


class Crop(GPTask):
    name = "裁剪"

    def __init__(self, left, top, right, bottom):
        self.rect = (int(left), int(top), int(right), int(bottom))

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        l, t, r, b = self.rect
        if not (0 <= l < r <= cv_image.shape[1] and 0 <= t < b <= cv_image.shape[0]):
            raise ValueError("Crop bounds must form a nonempty rectangle inside the image")
        return Result(cv_image[t:b, l:r], offset_x + l, offset_y + t, data)


class GrayImage(GPTask):
    name = "灰度化"

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        img = cv_image if cv_image.ndim == 2 else cv2.cvtColor(cv_image, cv2.COLOR_BGR2GRAY)
        return Result(img, offset_x, offset_y, data)


class Threshold(GPTask):
    name = "二值化"

    def __init__(self, threshold, inv=False):
        self.threshold, self.inv = int(threshold), bool(inv)

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        img = cv_image if cv_image.ndim == 2 else cv2.cvtColor(cv_image, cv2.COLOR_BGR2GRAY)
        _, out = cv2.threshold(img, self.threshold, 255, cv2.THRESH_BINARY_INV if self.inv else cv2.THRESH_BINARY)
        return Result(out, offset_x, offset_y, data)


class _Morph(GPTask):
    op = None

    def __init__(self, kernel_size=5, iterations=1):
        if int(kernel_size) < 1 or int(iterations) < 1:
            raise ValueError("Morphology kernel size and iterations must be positive")
        self.k = np.ones((int(kernel_size), int(kernel_size)), np.uint8)
        self.iterations = int(iterations)

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        return Result(cv2.morphologyEx(cv_image, self.op, self.k, iterations=self.iterations), offset_x, offset_y, data)


class Erode(_Morph):
    name = "腐蚀"
    op = cv2.MORPH_ERODE


class Dilate(_Morph):
    name = "膨胀"
    op = cv2.MORPH_DILATE


class MorphClose(_Morph):
    name = "闭运算"
    op = cv2.MORPH_CLOSE


class MorphOpen(_Morph):
    name = "开运算"
    op = cv2.MORPH_OPEN


class GaussianBlur(GPTask):
    name = "高斯模糊"

    def __init__(self, ksize=5, sigmaX=0):
        if int(ksize) < 1 or int(ksize) % 2 == 0:
            raise ValueError("GaussianBlur ksize must be a positive odd integer")
        k = int(ksize)
        self.k, self.s = (k, k), sigmaX

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        return Result(cv2.GaussianBlur(cv_image, self.k, self.s), offset_x, offset_y, data)


class Resize(GPTask):
    name = "缩放"

    def __init__(self, width=0, height=0, scale=0):
        self.w, self.h, self.scale = int(width), int(height), float(scale)

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        h, w = cv_image.shape[:2]
        if min(self.w, self.h, self.scale) < 0:
            raise ValueError("Resize dimensions and scale must be nonnegative")
        if self.scale > 0:
            target = (int(w * self.scale), int(h * self.scale))
        elif self.w and self.h:
            target = (self.w, self.h)
        elif self.w:
            target = (self.w, int(h * self.w / w))
        elif self.h:
            target = (int(w * self.h / h), self.h)
        else:
            return Result(cv_image, offset_x, offset_y, data)
        if min(target) < 1:
            raise ValueError("Resize produces an empty image")
        interpolation = cv2.INTER_AREA if target[0] < w else cv2.INTER_LINEAR
        return Result(cv2.resize(cv_image, target, interpolation=interpolation), offset_x, offset_y, data)


class Rotate(GPTask):
    name = "旋转"

    def __init__(self, angle=90, expand=True):
        self.angle, self.expand = float(angle), bool(expand)

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        a = self.angle % 360
        if self.expand and a in (90, 180, 270):
            code = {90: cv2.ROTATE_90_COUNTERCLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_CLOCKWISE}[int(a)]
            return Result(cv2.rotate(cv_image, code), offset_x, offset_y, data)
        h, w = cv_image.shape[:2]
        m = cv2.getRotationMatrix2D((w / 2, h / 2), self.angle, 1.0)
        target_w, target_h = w, h
        if self.expand:
            cosine, sine = abs(m[0, 0]), abs(m[0, 1])
            target_w, target_h = int(w * cosine + h * sine), int(h * cosine + w * sine)
            m[:, 2] += ((target_w - w) / 2, (target_h - h) / 2)
        return Result(cv2.warpAffine(cv_image, m, (target_w, target_h)), offset_x, offset_y, data)


class Canny(GPTask):
    """Detect contours and return local-coordinate measurements in Result.data.

    Offsets remain in Result.offset_x/y, as in the packaged interface. Resize
    and rotation do not turn them into a screen-coordinate transformation.
    """
    name = "边缘检测"
    RETR_TREE, RETR_LIST, RETR_EXTERNAL = cv2.RETR_TREE, cv2.RETR_LIST, cv2.RETR_EXTERNAL
    DRAW_NONE, DRAW_ALL, DRAW_RECT, DRAW_RECT_FILL = range(4)

    def __init__(self, low_threshold=50, high_threshold=150, algo="canny", blur=3,
                 mode=RETR_EXTERNAL, draw=DRAW_ALL, area_range=None,
                 width_range=None, height_range=None, left_range=None, top_range=None,
                 approx=0, detect_shape=False, desc=False, sobel_ksize=3,
                 sobel_dir="xy", block_size=11, c_val=2):
        if algo not in ("canny", "sobel", "laplacian", "adaptive"):
            raise ValueError("Unsupported Canny algorithm: " + str(algo))
        if draw not in range(4):
            raise ValueError("Unknown contour drawing mode")
        self.lo, self.hi, self.algo = low_threshold, high_threshold, algo
        self.blur, self.mode, self.draw = int(blur), mode, draw
        self.ranges = (area_range, width_range, height_range, left_range, top_range)
        for limits in self.ranges:
            if limits is not None and (len(limits) != 2 or limits[0] < 0 or limits[1] < 0):
                raise ValueError("Contour filters must contain two nonnegative bounds")
        self.approx, self.detect_shape, self.desc = approx, detect_shape, desc
        if sobel_dir not in ("x", "y", "xy"):
            raise ValueError("sobel_dir must be x, y or xy")
        self.sobel_ksize, self.sobel_dir = sobel_ksize, sobel_dir
        self.block_size, self.c_val = max(3, int(block_size) | 1), c_val

    def _edges(self, gray):
        if self.blur > 0:
            k = self.blur | 1
            gray = cv2.GaussianBlur(gray, (k, k), 0)
        if self.algo == "canny":
            return cv2.Canny(gray, self.lo, self.hi)
        if self.algo == "adaptive":
            return cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                         cv2.THRESH_BINARY_INV, self.block_size, self.c_val)
        if self.algo == "laplacian":
            magnitude = cv2.convertScaleAbs(cv2.Laplacian(gray, cv2.CV_64F))
            cutoff = 30
        else:
            directions = {"x": (1, 0), "y": (0, 1)}
            components = [cv2.convertScaleAbs(cv2.Sobel(gray, cv2.CV_64F, *directions[d],
                                                        ksize=self.sobel_ksize)) for d in self.sobel_dir]
            magnitude = components[0] if len(components) == 1 else cv2.addWeighted(
                components[0], 0.5, components[1], 0.5, 0)
            cutoff = 50
        return cv2.threshold(magnitude, cutoff, 255, cv2.THRESH_BINARY)[1]

    @staticmethod
    def _shape(vertices, w, h, area, perimeter):
        if vertices == 4:
            return "square" if 0.85 <= w / h <= 1.15 else "rectangle"
        if vertices in (3, 5, 6):
            return {3: "triangle", 5: "pentagon", 6: "hexagon"}[vertices]
        if vertices > 6:
            return "circle" if perimeter and 4 * np.pi * area / perimeter ** 2 > 0.7 else "polygon"
        return ""

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        gray = cv_image if cv_image.ndim == 2 else cv2.cvtColor(cv_image, cv2.COLOR_BGR2GRAY)
        contours, _ = cv2.findContours(self._edges(gray), self.mode, cv2.CHAIN_APPROX_SIMPLE)
        out = cv_image.copy()
        found = []
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            area, perimeter = cv2.contourArea(contour), cv2.arcLength(contour, True)
            values = (area, w, h, x, y)
            if any(limits and (v < limits[0] or (limits[1] > 0 and v > limits[1]))
                   for v, limits in zip(values, self.ranges)):
                continue
            vertices = len(cv2.approxPolyDP(contour, self.approx * perimeter, True)) if self.approx > 0 else len(contour)
            shape = self._shape(vertices, w, h, area, perimeter) if self.detect_shape else ""
            moments = cv2.moments(contour)
            cx, cy = x + w // 2, y + h // 2
            if moments["m00"]:
                cx, cy = (int(moments[axis] / moments["m00"]) for axis in ("m10", "m01"))
            found.append(dict(x=x, y=y, w=w, h=h, area=int(area), perimeter=round(perimeter, 1),
                              cx=cx, cy=cy, vertices=vertices, shape=shape, aspect=round(w / h, 2)))
            color = (0, 255, 0)
            if self.draw == self.DRAW_ALL:
                cv2.drawContours(out, [contour], -1, color, 2)
            elif self.draw in (self.DRAW_RECT, self.DRAW_RECT_FILL):
                cv2.rectangle(out, (x, y), (x + w, y + h),
                              (255, 255, 255) if self.draw == self.DRAW_RECT_FILL else color,
                              -1 if self.draw == self.DRAW_RECT_FILL else 2)
            if self.desc:
                cv2.putText(out, (shape + " " if shape else "") + "%dx%d" % (w, h), (x, y - 4),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1, cv2.LINE_AA)
        found.sort(key=lambda item: (item["y"], item["x"]))
        return Result(out, offset_x, offset_y, found)


class CvFontLib(GPTask):
    """图片字库: recognise text by matching one small image per character.

    ``part_img[i]`` (a path or BGR ndarray) is the glyph for ``font_lib[i]``. Glyphs are matched in list
    order and each match is blanked before the next glyph is searched, so put the larger or more
    specific glyphs first. Matches are grouped into lines by the vertical centre (``spacing`` pixels)
    and read left to right, lines top to bottom.

    ``Result.data`` is ``{"text": "12+3", "words": [[match, ...] per glyph], "group": ["12", "+3"]}`` or
    ``None`` when nothing matched. Match dicts are the usual template results plus ``"font"``; with
    ``rect`` the coordinates stay in the frame of the incoming image (like ``FindImages``).
    """

    name = "图片字库"
    ui_path = "/website/gpui/cvfontlib/"

    def __init__(self, part_img, font_lib, confidence=0.95, rect=None, spacing=5, rgb=False):
        part_img, font_lib = list(part_img), list(font_lib)
        if not part_img or len(part_img) != len(font_lib):
            raise ValueError("part_img and font_lib must be non-empty lists of the same length")
        if not all(isinstance(c, str) for c in font_lib):
            raise ValueError("font_lib entries must be strings")
        if not 0 < float(confidence) <= 1:
            raise ValueError("confidence must be within (0, 1]")
        if int(spacing) < 0:
            raise ValueError("spacing must not be negative")
        self.part_img, self.font_lib = part_img, font_lib
        self.confidence, self.spacing, self.rgb = float(confidence), int(spacing), bool(rgb)
        self.rect = tuple(int(v) for v in rect) if rect else None
        if self.rect and (len(self.rect) != 4 or self.rect[0] < 0 or self.rect[1] < 0
                          or self.rect[2] <= self.rect[0] or self.rect[3] <= self.rect[1]):
            raise ValueError("rect must be [left, top, right, bottom] with positive size")

    @staticmethod
    def _chars(data):
        """(left, centre_y, font) of every matched glyph; ``data`` is a list of per-glyph match lists."""
        return [(m["rectangle"][0][0], (m["rectangle"][0][1] + m["rectangle"][1][1]) / 2.0, m["font"])
                for matches in data for m in matches]

    @staticmethod
    def sort_and_concatenate_chars(data):
        """Text of ``words`` in reading order, using 10px vertical buckets (AScript helper)."""
        chars = sorted(CvFontLib._chars(data), key=lambda c: (c[1] // 10 * 10, c[0]))
        return "".join(c[2] for c in chars)

    @staticmethod
    def group_chars_by_distance(data, threshold=10):
        """Words split where the left edges of neighbouring glyphs are ``threshold`` or more apart (AScript helper)."""
        edges = sorted((c[0], c[2]) for c in CvFontLib._chars(data))
        words, word, start = [], "", None
        for left, char in edges:
            if not word or (start is not None and left - start < threshold):
                word += char
                start = left if start is None else start
            else:
                words.append((start, word))
                word, start = char, left
        if word:
            words.append((start, word))
        return words

    def sort_group(self, data):
        """(text, glyphs in reading order, per-line strings)."""
        groups = []
        for c in CvFontLib._chars(data):
            for g in groups:
                if abs(g[0][1] - c[1]) < self.spacing:
                    g.append(c)
                    break
            else:
                groups.append([c])
        groups.sort(key=lambda g: g[0][1])
        for g in groups:
            g.sort(key=lambda c: c[0])
        lines = ["".join(c[2] for c in g) for g in groups]
        ordered = [c for g in groups for c in g]
        return "".join(c[2] for c in ordered), ordered, lines

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        from ascript.android.screen import ascv

        base_x = base_y = 0
        if self.rect:
            left, top, right, bottom = self.rect
            h, w = cv_image.shape[:2]
            if right > w or bottom > h:
                raise ValueError("CvFontLib rect is outside the image")
            cv_image = cv_image[top:bottom, left:right]
            base_x, base_y = left, top
        work = cv_image.copy()
        words = []
        for glyph, font in zip(self.part_img, self.font_lib):
            found = ascv.find_all_template(work, glyph, rect=self.rect, threshold=self.confidence, rgb=self.rgb) or []
            for m in found:
                m["font"] = font
                (x, y), (r, b) = m["rectangle"][0], m["rectangle"][3]
                # Blank what this glyph claimed so later (smaller) glyphs cannot match inside it.
                cv2.rectangle(work, (x - base_x, y - base_y), (r - base_x - 1, b - base_y - 1), (0, 0, 0), -1)
            words.append(found)
        text, _, lines = self.sort_group(words)
        return Result(cv_image, offset_x, offset_y, {"text": text, "words": words, "group": lines} if text else None)

    @staticmethod
    def recognize(part_img, font_lib, confidence=0.95, rect=None, spacing=5, rgb=False, image=None):
        """Convenience: run on ``image`` (path / ndarray / Bitmap) or a fresh screenshot; returns the text ("" if none)."""
        from xscript.android import image as _img

        res = CvFontLib(part_img, font_lib, confidence, rect, spacing, rgb).run(_img.to_bgr(image)).data
        return res["text"] if res else ""


def gp_list():
    return [Crop, GrayImage, Threshold, Erode, Dilate, MorphClose, MorphOpen, GaussianBlur, Resize, Rotate, Canny, CvFontLib]


def gp_list_json():
    import json

    return json.dumps([{"name": c.name, "class": c.__name__} for c in gp_list()], ensure_ascii=False)


def gp_line_plug_list():
    return []
