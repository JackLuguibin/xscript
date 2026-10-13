"""Shizuku API mapped onto XScript's root shell / gestures."""

from xscript.android import action as _xa
from xscript.android import system as _xs


def shell(command):
    if isinstance(command, (list, tuple)):
        command = " ".join(str(c) for c in command)
    r = _xs.shell(command)
    return r.out


def click(x, y):
    return _xa.click(x, y)


def swipe(x1, y1, x2, y2, dur=200):
    return _xa.swipe(x1, y1, x2, y2, dur)
