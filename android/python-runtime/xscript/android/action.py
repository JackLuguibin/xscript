"""Gestures, keys and text input. Coordinates are screen pixels."""

import time

from xscript.runtime.bridge import bridge


def click(x, y=None, dur=20):
    """Tap (x, y). `x` may also be a point-like object with .x/.y or a (x, y) tuple."""
    if y is None:
        x, y = _xy(x)
    return bool(bridge.click(int(x), int(y), int(dur)))


def long_click(x, y=None, dur=800):
    return click(x, y, dur)


def swipe(x1, y1, x2, y2, dur=300):
    return bool(bridge.swipe(int(x1), int(y1), int(x2), int(y2), int(dur)))


def gesture(strokes):
    """Multi-finger gesture.

    strokes: list of {"points": [(x, y), ...], "start": ms, "duration": ms}.
    Strokes run in parallel; each follows its points as a polyline.
    """
    payload = []
    for s in strokes:
        payload.append({
            "points": [[float(p[0]), float(p[1])] for p in s["points"]],
            "start": int(s.get("start", 0)),
            "duration": int(s.get("duration", 300)),
        })
    return bool(bridge.gesture(payload))


def path(points, dur=300):
    """Single-finger polyline through `points` over `dur` ms."""
    return gesture([{"points": list(points), "duration": dur}])


def input(text):
    """Set text on the focused (or first editable) field."""
    return bool(bridge.input_text("" if text is None else str(text)))


class Touch(object):
    """Low-level touch stream: down → move* → up (one finger)."""

    @staticmethod
    def down(x, y, dur=20):
        return bool(bridge.touch(0, int(x), int(y), int(dur)))

    @staticmethod
    def move(x, y, dur=20):
        return bool(bridge.touch(1, int(x), int(y), int(dur)))

    @staticmethod
    def up(x, y, dur=20):
        return bool(bridge.touch(2, int(x), int(y), int(dur)))


class Key(object):
    """System keys. `code(n)` sends a raw keyevent and needs root."""

    @staticmethod
    def back():
        return bridge.global_action("back")

    @staticmethod
    def home():
        return bridge.global_action("home")

    @staticmethod
    def recents():
        return bridge.global_action("recents")

    @staticmethod
    def notifications():
        return bridge.global_action("notifications")

    @staticmethod
    def quick_settings():
        return bridge.global_action("quick_settings")

    @staticmethod
    def lock_screen():
        return bridge.global_action("lock_screen")

    @staticmethod
    def screenshot():
        return bridge.global_action("screenshot")

    @staticmethod
    def power_dialog():
        return bridge.global_action("power_dialog")

    @staticmethod
    def code(keycode):
        return bridge.global_action("key:%d" % int(keycode))


def back():
    return Key.back()


def home():
    return Key.home()


def recents():
    return Key.recents()


def sleep(seconds):
    time.sleep(seconds)


def _xy(p):
    if hasattr(p, "x") and hasattr(p, "y"):
        x, y = p.x, p.y
        return (x() if callable(x) else x), (y() if callable(y) else y)
    if isinstance(p, dict):
        return p.get("center_x", p.get("x")), p.get("center_y", p.get("y"))
    return p[0], p[1]
