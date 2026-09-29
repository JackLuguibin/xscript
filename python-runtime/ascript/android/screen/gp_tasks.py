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
        k = int(ksize) | 1
        self.k, self.s = (k, k), sigmaX

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        return Result(cv2.GaussianBlur(cv_image, self.k, self.s), offset_x, offset_y, data)


class Resize(GPTask):
    name = "缩放"

    def __init__(self, width=0, height=0, scale=0):
        self.w, self.h, self.scale = int(width), int(height), float(scale)

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        if self.scale:
            out = cv2.resize(cv_image, None, fx=self.scale, fy=self.scale)
        else:
            out = cv2.resize(cv_image, (self.w or cv_image.shape[1], self.h or cv_image.shape[0]))
        return Result(out, offset_x, offset_y, data)


class Rotate(GPTask):
    name = "旋转"

    def __init__(self, angle=90, expand=True):
        self.angle, self.expand = float(angle), bool(expand)

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        a = self.angle % 360
        if a in (90, 180, 270):
            code = {90: cv2.ROTATE_90_COUNTERCLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_CLOCKWISE}[int(a)]
            return Result(cv2.rotate(cv_image, code), offset_x, offset_y, data)
        h, w = cv_image.shape[:2]
        m = cv2.getRotationMatrix2D((w / 2, h / 2), self.angle, 1.0)
        return Result(cv2.warpAffine(cv_image, m, (w, h)), offset_x, offset_y, data)


class Canny(GPTask):
    name = "边缘检测"

    def __init__(self, low_threshold=50, high_threshold=150, **kwargs):
        self.lo, self.hi = int(low_threshold), int(high_threshold)

    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        img = cv_image if cv_image.ndim == 2 else cv2.cvtColor(cv_image, cv2.COLOR_BGR2GRAY)
        return Result(cv2.Canny(img, self.lo, self.hi), offset_x, offset_y, data)


def gp_list():
    return [Crop, GrayImage, Threshold, Erode, Dilate, MorphClose, MorphOpen, GaussianBlur, Resize, Rotate, Canny]


def gp_list_json():
    import json

    return json.dumps([{"name": c.name, "class": c.__name__} for c in gp_list()], ensure_ascii=False)


def gp_line_plug_list():
    return []
