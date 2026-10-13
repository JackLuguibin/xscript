"""Color-string helpers matching AScript's screen.color_tools."""

import json

from xscript.android import image as _img


class ColorPoint:
    def __init__(self, x, y, rgb=None, diff=None):
        self.x, self.y, self.rgb, self.diff = x, y, rgb, diff

    def __repr__(self):
        return json.dumps({"x": self.x, "y": self.y, "rgb": self.rgb})

    def __sub__(self, other):
        self.x -= other.x
        self.y -= other.y
        return self


class Point:
    def __init__(self, x, y):
        self.x, self.y = x, y


def hex_to_rgb(hex_color):
    return list(_img.hex_to_rgb(hex_color))


def ana_colors(colors_str):
    return [ColorPoint(x, y, list(rgb), list(d) if d else None) for x, y, rgb, d in _img.parse_color_points(colors_str)]


def ana_colors_r(colors_str):
    pts = ana_colors(colors_str)
    return [pts[0]] + [p - pts[0] for p in pts[1:]]


def find_colors(colors, rect=None, space=5, ori=2, diff=(5, 5, 5), num=-1, image=None):
    sim = 1.0 - (max(diff) / 255.0)
    src = None
    if image is not None:
        import numpy as np

        src = np.asarray(image.convert("RGB"))[:, :, ::-1]
    return [Point(p.x, p.y) for p in _img.find_colors(colors, rect, sim, space, ori, 0 if num == -1 else num, src)]
