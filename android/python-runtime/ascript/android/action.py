"""ascript.android.action on top of xscript.android.action."""

import math
import threading
import time

from ascript._compat import warn_once
from xscript.android import action as _xa
from xscript.android.image import Point as _Point
from xscript.runtime.bridge import bridge


def _xy(x, y):
    if y is None:
        if hasattr(x, "x") and hasattr(x, "y"):
            return int(x.x), int(x.y)
        return int(x[0]), int(x[1])
    return int(x), int(y)


def click(x, y=None, dur=20):
    """Tap (x, y) or a Point."""
    if x is None:
        raise Exception("click 参数不能为 None")
    px, py = _xy(x, y)
    return _xa.click(px, py, int(dur))


def swipe(x, y, x1, y1, dur=20):
    return _xa.swipe(int(x), int(y), int(x1), int(y1), max(int(dur), 10))


def _bezier(p0, controls, p1, steps):
    pts = [p0] + list(controls) + [p1]
    n = len(pts) - 1
    out = []
    for i in range(steps + 1):
        t = i / float(steps)
        x = y = 0.0
        for k, (px, py) in enumerate(pts):
            c = math.comb(n, k) * (t ** k) * ((1 - t) ** (n - k))
            x += c * px
            y += c * py
        out.append((x, y))
    return out


def _random_controls(x, y, x1, y1, count):
    import random

    dist = math.hypot(x1 - x, y1 - y) or 1.0
    out = []
    for i in range(count):
        t = (i + 1) / float(count + 1)
        off = (random.random() - 0.5) * dist * 0.3
        nx, ny = -(y1 - y) / dist, (x1 - x) / dist
        out.append((x + (x1 - x) * t + nx * off, y + (y1 - y) * t + ny * off))
    return out


def slide(x, y, x1, y1, dur=20, interpolator=None, control_points=None):
    """Swipe with optional speed curve (android Interpolator) and Bezier control points.

    control_points: flat list [cx1, cy1, cx2, cy2, ...] or an int (random control point count).
    """
    x, y, x1, y1 = int(x), int(y), int(x1), int(y1)
    dur = max(int(dur), 10)
    if interpolator is None and control_points is None:
        return _xa.swipe(x, y, x1, y1, dur)
    if isinstance(control_points, int):
        controls = _random_controls(x, y, x1, y1, control_points)
    elif control_points:
        flat = list(control_points)
        controls = [(flat[i], flat[i + 1]) for i in range(0, len(flat) - 1, 2)]
    else:
        controls = []
    steps = max(8, min(120, dur // 12))
    curve = _bezier((x, y), controls, (x1, y1), steps)
    if interpolator is None:
        return _xa.path(curve, dur)
    # Interpolator changes speed along the curve: replay as a timed touch stream.
    Touch.down(x, y)
    elapsed = 0
    for i in range(1, steps + 1):
        t = i / float(steps)
        try:
            f = float(interpolator.getInterpolation(t))
        except AttributeError:
            f = float(interpolator.get_interpolation(t))
        f = max(0.0, min(1.0, f))
        idx = f * steps
        lo = int(math.floor(idx))
        hi = min(steps, lo + 1)
        frac = idx - lo
        px = curve[lo][0] + (curve[hi][0] - curve[lo][0]) * frac
        py = curve[lo][1] + (curve[hi][1] - curve[lo][1]) * frac
        target = int(round(t * dur))
        Touch.move(px, py, max(1, target - elapsed))
        elapsed = target
    Touch.up(x1, y1)
    return True


def input(msg="", selector=None):  # noqa: A001
    if selector is not None:
        node = selector.find()
        if node is None:
            return False
        node.input(msg)
        return True
    return _xa.input(msg)


class Touch:
    _x = 0.0
    _y = 0.0

    @staticmethod
    def down(x, y, dur=20):
        Touch._x, Touch._y = float(x), float(y)
        return _xa.Touch.down(x, y, dur)

    @staticmethod
    def move(x, y, dur=20):
        Touch._x, Touch._y = float(x), float(y)
        return _xa.Touch.move(x, y, dur)

    @staticmethod
    def up(x, y, dur=20):
        Touch._x, Touch._y = float(x), float(y)
        return _xa.Touch.up(x, y, dur)

    @staticmethod
    def get_current_x():
        return Touch._x

    @staticmethod
    def get_current_y():
        return Touch._y


class Key:
    @staticmethod
    def home():
        return _xa.Key.home()

    @staticmethod
    def back():
        return _xa.Key.back()

    @staticmethod
    def notifactions():
        return _xa.Key.notifications()

    notifications = notifactions

    @staticmethod
    def lockscreen():
        return _xa.Key.lock_screen()

    @staticmethod
    def screenshot():
        return _xa.Key.screenshot()

    @staticmethod
    def recents():
        return _xa.Key.recents()


class Hid:
    """AScript's ESP32 HID peripheral isn't available; falls back to normal gestures."""

    @staticmethod
    def _warn():
        warn_once("hid", "Hid.* uses accessibility/root gestures (no HID hardware support)")

    @staticmethod
    def click(x, y, dur=20):
        Hid._warn()
        return click(x, y, dur)

    @staticmethod
    def swipe(x, y, x1, y1, dur=20):
        Hid._warn()
        return swipe(x, y, x1, y1, dur)

    @staticmethod
    def slide(x, y, x1, y1, dur=20):
        Hid._warn()
        return swipe(x, y, x1, y1, dur)

    @staticmethod
    def key(*keycode):
        Hid._warn()
        for k in keycode:
            _xa.Key.code(int(k))


class Path:
    """android.graphics.Path-like builder; curves are sampled into polylines."""

    CW = 0
    CCW = 1

    def __init__(self, start_time=0, duration=20, will_continue=False):
        self.start_time = int(start_time)
        self.duration = int(duration)
        self.will_continue = bool(will_continue)
        self.reset()

    # contours: list of point lists
    def reset(self):
        self._contours = []
        self._cur = None
        self._start = None

    rewind = reset

    def _pt(self):
        if self._cur is None:
            self.moveTo(0, 0)
        return self._cur[-1]

    def moveTo(self, x, y):
        self._cur = [(float(x), float(y))]
        self._start = self._cur[0]
        self._contours.append(self._cur)

    def rMoveTo(self, dx, dy):
        px, py = self._pt() if self._cur else (0.0, 0.0)
        self.moveTo(px + dx, py + dy)

    def lineTo(self, x, y):
        self._pt()
        self._cur.append((float(x), float(y)))

    def rLineTo(self, dx, dy):
        px, py = self._pt()
        self.lineTo(px + dx, py + dy)

    def quadTo(self, x1, y1, x2, y2):
        p0 = self._pt()
        self._cur.extend(_bezier(p0, [(x1, y1)], (x2, y2), 16)[1:])

    def rQuadTo(self, dx1, dy1, dx2, dy2):
        px, py = self._pt()
        self.quadTo(px + dx1, py + dy1, px + dx2, py + dy2)

    def cubicTo(self, x1, y1, x2, y2, x3, y3):
        p0 = self._pt()
        self._cur.extend(_bezier(p0, [(x1, y1), (x2, y2)], (x3, y3), 24)[1:])

    def rCubicTo(self, x1, y1, x2, y2, x3, y3):
        px, py = self._pt()
        self.cubicTo(px + x1, py + y1, px + x2, py + y2, px + x3, py + y3)

    def setLastPoint(self, dx, dy):
        self._pt()
        self._cur[-1] = (float(dx), float(dy))

    def close(self):
        if self._cur and self._start and self._cur[-1] != self._start:
            self._cur.append(self._start)

    def _arc_points(self, left, top, right, bottom, start, sweep):
        cx, cy = (left + right) / 2.0, (top + bottom) / 2.0
        rx, ry = (right - left) / 2.0, (bottom - top) / 2.0
        n = max(8, int(abs(sweep) / 6))
        out = []
        for i in range(n + 1):
            a = math.radians(start + sweep * i / float(n))
            out.append((cx + rx * math.cos(a), cy + ry * math.sin(a)))
        return out

    def arcTo(self, left, top, right, bottom, startAngle, sweepAngle, forceMoveTo=False):
        pts = self._arc_points(left, top, right, bottom, startAngle, sweepAngle)
        if forceMoveTo or self._cur is None:
            self.moveTo(*pts[0])
        else:
            self._cur.append(pts[0])
        self._cur.extend(pts[1:])

    def addArc(self, left, top, right, bottom, startAngle, sweepAngle):
        pts = self._arc_points(left, top, right, bottom, startAngle, sweepAngle)
        self.moveTo(*pts[0])
        self._cur.extend(pts[1:])

    def addOval(self, left, top, right, bottom, dir=0):
        sweep = 360 if dir == Path.CW else -360
        self.addArc(left, top, right, bottom, 0, sweep)

    def addCircle(self, x, y, radius, dir=0):
        self.addOval(x - radius, y - radius, x + radius, y + radius, dir)

    def addRect(self, left, top, right, bottom, dir=0):
        pts = [(left, top), (right, top), (right, bottom), (left, bottom), (left, top)]
        if dir == Path.CCW:
            pts = [(left, top), (left, bottom), (right, bottom), (right, top), (left, top)]
        self.moveTo(*pts[0])
        for p in pts[1:]:
            self.lineTo(*p)

    def addRoundRect(self, left, top, right, bottom, rx, ry, dir=0):
        self.addRect(left, top, right, bottom, dir)

    def strokes(self):
        return [
            {"points": c, "start": self.start_time, "duration": max(1, self.duration)}
            for c in self._contours if c
        ]


def gesture(paths, listener=None):
    """Run one or more Paths as a (multi-finger) gesture."""
    if isinstance(paths, Path):
        paths = [paths]
    strokes = []
    for p in paths:
        strokes.extend(p.strokes())
    ok = _xa.gesture(strokes) if strokes else False
    if listener is not None:
        try:
            (listener.onCompleted if ok else listener.onCancelled)(None)
        except Exception:
            pass
    return ok


def catch_click(msg=None, shine=True):
    """Show a full-screen overlay and return the Point the user taps (blocking)."""
    from xscript.android.ui import Window

    label = msg or "点击屏幕任意位置获取坐标"
    html = (
        "<html><body style='margin:0;background:rgba(0,0,0,0.25);height:100vh'>"
        "<div style='position:fixed;top:40%;width:100%;text-align:center;color:#fff;font:16px sans-serif'>"
        + label.replace("<", "&lt;") +
        "</div><script>document.addEventListener('touchstart',function(e){var t=e.touches[0];"
        "xscript.call('catch',JSON.stringify([t.screenX*devicePixelRatio,t.screenY*devicePixelRatio,"
        "t.clientX*devicePixelRatio,t.clientY*devicePixelRatio]));},{passive:true});</script></body></html>"
    )
    result = {}
    done = threading.Event()
    win = Window(html, fullscreen=True)

    @win.on("catch")
    def _got(value):
        import json

        vals = json.loads(value)
        result["p"] = _Point(vals[2], vals[3])
        done.set()

    win.show()
    done.wait()
    win.close()
    return result.get("p")


class Ime:
    """AScript action.Ime on XScript 输入法 (xscript.android.ime). When it is not the active IME, input falls back to
    accessibility SET_TEXT / root, keys to key events, as before."""

    @staticmethod
    def is_active():
        from xscript.android import ime

        return ime.is_active()

    @staticmethod
    def switch():
        from xscript.android import ime

        return ime.switch()

    @staticmethod
    def restore():
        from xscript.android import ime

        return ime.restore()

    @staticmethod
    def _try(fn, *args):
        from xscript.android import ime

        if not ime.is_active():
            return None
        try:
            return bool(getattr(ime, fn)(*args))
        except ime.ImeNotActive:
            return None

    @staticmethod
    def input(info):
        """Insert text at the cursor (IME), or set the field's text through accessibility."""
        r = Ime._try("commit", info)
        return _xa.input(info) if r is None else r

    @staticmethod
    def input_clear():
        r = Ime._try("clear")
        return _xa.input("") if r is None else r

    @staticmethod
    def delete(count=1):
        r = Ime._try("delete", int(count), 0)
        if r is None:
            Ime.keys([67] * int(count))
            return True
        return r

    @staticmethod
    def keys(keys, duration=20):
        if isinstance(keys, int):
            keys = [keys]
        for k in keys:
            if Ime._try("key", int(k)) is None:
                _xa.Key.code(int(k))
            time.sleep(max(0, duration) / 1000.0)

    @staticmethod
    def enter():
        if Ime._try("enter") is None:
            _xa.Key.code(66)


def simulate_interpolated_swipe_smooth(start_x, start_y, end_x, end_y, total_duration_ms, interpolator=None):
    return slide(start_x, start_y, end_x, end_y, total_duration_ms, interpolator=interpolator or _Linear())


class _Linear(object):
    def getInterpolation(self, t):
        return t


# keep a module-level reference so `bridge` is importable from compat code
_bridge = bridge
