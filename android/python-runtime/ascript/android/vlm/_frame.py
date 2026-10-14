"""Encode a cropped frame and map service pixel boxes into source coordinates."""
import base64
import math

from ._errors import ProtocolError


class Frame:
    def __init__(self, image, offset, source_size):
        self.image = image
        self.off_x, self.off_y = offset
        self.src_w, self.src_h = source_size
        self.net_h, self.net_w = image.shape[:2]

    @property
    def scale_x(self):
        return self.src_w / self.net_w

    @property
    def scale_y(self):
        return self.src_h / self.net_h

    def to_screen(self, x, y):
        return round(x * self.scale_x) + self.off_x, round(y * self.scale_y) + self.off_y

    def remap(self, item):
        try:
            box = item["rect"]
            if len(box) != 4 or not all(math.isfinite(float(v)) for v in box):
                raise ValueError()
            x1, y1 = self.to_screen(float(box[0]), float(box[1]))
            x2, y2 = self.to_screen(float(box[2]), float(box[3]))
            conf = float(item.get("confidence", 1.0))
            if not math.isfinite(conf):
                raise ValueError()
        except (KeyError, TypeError, ValueError, OverflowError):
            raise ProtocolError("Each vision result needs a finite four-number rect and confidence") from None
        xs = sorted(max(self.off_x, min(v, self.off_x + self.src_w)) for v in (x1, x2))
        ys = sorted(max(self.off_y, min(v, self.off_y + self.src_h)) for v in (y1, y2))
        return dict(text=item.get("text", ""), rect=[xs[0], ys[0], xs[1], ys[1]],
                    center_x=sum(xs) // 2, center_y=sum(ys) // 2, confidence=conf)

    def data_url(self, quality=85):
        import cv2
        ok, encoded = cv2.imencode(".jpg", self.image, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
        if not ok:
            raise ValueError("Cannot encode vision image")
        return "data:image/jpeg;base64," + base64.b64encode(encoded).decode("ascii")


def _fit_tokens(w, h, image_tokens):
    if isinstance(image_tokens, bool) or int(image_tokens) != image_tokens or image_tokens <= 0:
        raise ValueError("image_tokens must be a positive integer")
    scale = min(1.0, math.sqrt(image_tokens * 1024 / (w * h)))
    scale = max(scale, 32 / min(w, h))
    return tuple(max(32, round(side * scale / 32) * 32) for side in (w, h))


def prepare(image=None, rect=None, image_tokens=None):
    import cv2
    import numpy as np
    from xscript.android import image as imaging
    src = imaging.to_bgr(image)
    if src is None:
        raise RuntimeError("Screen capture unavailable; grant capture permission first")
    if not isinstance(src, np.ndarray) or src.size == 0 or src.ndim not in (2, 3):
        raise ValueError("image must contain pixels")
    if src.ndim == 2:
        src = cv2.cvtColor(src, cv2.COLOR_GRAY2BGR)
    elif src.shape[2] == 4:
        src = cv2.cvtColor(src, cv2.COLOR_BGRA2BGR)
    elif src.shape[2] != 3:
        raise ValueError("image must have one, three or four channels")
    h, w = src.shape[:2]
    x = y = 0
    if rect is not None:
        if len(rect) != 4:
            raise ValueError("rect must be [left, top, right, bottom]")
        x, y, right, bottom = map(int, rect)
        x, right = max(0, min(w, x)), max(0, min(w, right))
        y, bottom = max(0, min(h, y)), max(0, min(h, bottom))
        if right <= x or bottom <= y:
            raise ValueError("rect has no pixels inside the image")
        src = src[y:bottom, x:right]
    h, w = src.shape[:2]
    if max(w, h) / min(w, h) > 200:
        raise ValueError("image aspect ratio exceeds 200")
    nw, nh = _fit_tokens(w, h, 1024 if image_tokens is None else image_tokens)
    net = cv2.resize(src, (nw, nh), interpolation=cv2.INTER_AREA) if (nw, nh) != (w, h) else src.copy()
    return Frame(net, (x, y), (w, h))
