"""A fake phone for PC tests: an in-memory screen, Bitmap stand-ins, scripted OCR and a recording UI channel.

`patch_bridge(fake)` swaps it into every module that imported `bridge` by name and returns an undo function.
"""

import json
import queue
import time

import numpy as np

from xscript.android import image as _img
from xscript.runtime import bridge as bridge_mod

BRIDGE_USERS = (
    "xscript.android.image",
    "xscript.android.screen",
    "xscript.android.ui",
    "xscript.android.event",
    "ascript.android.screen",
)


class FakeBitmap(object):
    """Duck-types android.graphics.Bitmap (getPixel / getWidth / getHeight) over a BGR ndarray."""

    def __init__(self, bgr):
        self.bgr = np.ascontiguousarray(bgr)

    def getWidth(self):
        return int(self.bgr.shape[1])

    def getHeight(self):
        return int(self.bgr.shape[0])

    def getPixel(self, x, y):
        b, g, r = (int(v) for v in self.bgr[y, x])
        return (0xFF << 24) | (r << 16) | (g << 8) | b


class FakeDevice(bridge_mod._MissingJava):
    available = True

    def __init__(self, screen):
        self.screen = np.ascontiguousarray(screen)
        self.capture_calls = 0
        self.fail_captures = 0
        self.ocr_lines = []
        self.ocr_images = []
        self.ui_calls = []
        self.ui_replies = {}
        self.events = queue.Queue()
        self.controls = []
        self.status = {"width": self.screen.shape[1], "height": self.screen.shape[0]}

    # ---- screen
    def _region(self, l, t, r, b):
        if r > l and b > t:
            return self.screen[t:b, l:r]
        return self.screen

    def capture_raw(self, l=0, t=0, r=0, b=0):
        self.capture_calls += 1
        if self.fail_captures:
            self.fail_captures -= 1
            return b""
        return _img.bgr_to_raw(self._region(l, t, r, b))

    def capture_bitmap(self, l=0, t=0, r=0, b=0):
        self.capture_calls += 1
        if self.fail_captures:
            self.fail_captures -= 1
            return None
        return FakeBitmap(self._region(l, t, r, b).copy())

    def capture_to_file(self, path):
        import cv2

        path = path or "/tmp/xscript-fake-capture.png"
        cv2.imwrite(path, self.screen)
        return path

    def bitmap_to_raw(self, bitmap):
        return _img.bgr_to_raw(bitmap.bgr)

    def raw_to_bitmap(self, raw):
        return FakeBitmap(_img.rgba_to_bgr(_img.raw_to_rgba(bytes(raw))))

    def load_bitmap(self, path, sample=1):
        img = _img.imread(path)
        return None if img is None else FakeBitmap(img[::sample, ::sample])

    def save_bitmap(self, bitmap, path, quality=100):
        import cv2

        return bool(cv2.imwrite(path, bitmap.bgr))

    def ocr(self, bitmap, dx=0, dy=0, level="line"):
        self.ocr_images.append((bitmap, dx, dy))
        out = []
        for text, rect, conf in self.ocr_lines:
            l, t, r, b = rect
            out.append({"text": text, "rect": [l + dx, t + dy, r + dx, b + dy], "confidence": conf})
        return json.dumps(out)

    # ---- ui / control / events
    def ui(self, op, args=None):
        self.ui_calls.append((op, dict(args or {})))
        reply = self.ui_replies.get(op, "")
        return reply(args or {}) if callable(reply) else reply

    def ui_poll(self, window_id, timeout_ms):
        try:
            ev = self.events.get(timeout=timeout_ms / 1000.0)
        except queue.Empty:
            return ""
        return json.dumps(ev)

    def control(self, op, arg=""):
        self.controls.append((op, arg))
        if op == "status":
            return json.dumps(self.status)
        return ""

    def poll_event(self, timeout_ms):
        time.sleep(0.01)
        return ""

    def ops(self, name):
        return [a for op, a in self.ui_calls if op == name]


def patch_bridge(fake):
    saved = []
    for name in BRIDGE_USERS:
        mod = __import__(name, fromlist=["bridge"])
        saved.append((mod, mod.bridge))
        mod.bridge = fake

    def undo():
        for mod, old in saved:
            mod.bridge = old
        _img._cached_frame["rgba"] = None
    return undo


def make_screen(w=120, h=80):
    """Dark-grey screen with a red 10x10 block at (20,10), a white one at (60,40) and a green pixel pair."""
    s = np.full((h, w, 3), 30, np.uint8)
    s[10:20, 20:30] = (0, 0, 255)
    s[40:50, 60:70] = (255, 255, 255)
    s[5, 100] = (0, 255, 0)
    s[5, 105] = (0, 255, 0)
    return s
