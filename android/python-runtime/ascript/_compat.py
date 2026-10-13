"""Shared helpers for the AScript compatibility modules."""

import sys

_warned = set()


def warn_once(key, message):
    if key in _warned:
        return
    _warned.add(key)
    try:
        sys.stderr.write("[ascript-compat] %s\n" % message)
    except Exception:
        pass


def unsupported(name):
    raise NotImplementedError("%s is not supported by XScript's AScript compatibility layer" % name)


class Rect(object):
    """Stand-in for android.graphics.Rect (fields + helper methods)."""

    __slots__ = ("left", "top", "right", "bottom")

    def __init__(self, left=0, top=0, right=0, bottom=0):
        self.left = int(left)
        self.top = int(top)
        self.right = int(right)
        self.bottom = int(bottom)

    @classmethod
    def from_dump(cls, r):
        r = r or {}
        return cls(r.get("l", 0), r.get("t", 0), r.get("r", 0), r.get("b", 0))

    def width(self):
        return self.right - self.left

    def height(self):
        return self.bottom - self.top

    def centerX(self):
        return (self.left + self.right) // 2

    def centerY(self):
        return (self.top + self.bottom) // 2

    def contains(self, x, y):
        return self.left <= x < self.right and self.top <= y < self.bottom

    def toShortString(self):
        return "[%d,%d][%d,%d]" % (self.left, self.top, self.right, self.bottom)

    def __iter__(self):
        return iter((self.left, self.top, self.right, self.bottom))

    def __getitem__(self, i):
        return (self.left, self.top, self.right, self.bottom)[i]

    def __len__(self):
        return 4

    def __repr__(self):
        return "Rect(%d, %d - %d, %d)" % (self.left, self.top, self.right, self.bottom)
