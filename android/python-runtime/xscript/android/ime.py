"""XScript 输入法: type through XScript's own input method (an IME without a keyboard).

    from xscript.android import ime
    ime.switch()             # make it the current keyboard (silent with root; otherwise the system picker / settings)
    ime.commit("你好")        # insert at the cursor
    ime.delete(2); ime.clear(); ime.enter(); ime.key(67)
    ime.restore()            # back to the keyboard that was current before

Typing needs it to be the current IME with an input field focused (is_active()). action.input() uses it automatically
when it is active and falls back to accessibility / root input otherwise.
"""

import json

from xscript.runtime.bridge import bridge


class ImeNotActive(RuntimeError):
    pass


def _control(op, arg=""):
    raw = bridge.control("ime_" + op, arg)
    if raw is None or raw == "":
        raise ImeNotActive("XScript 输入法 is unavailable (no main-process connection)")
    raw = str(raw)
    if raw.startswith("{"):
        r = json.loads(raw)
        if r.get("error"):
            raise ImeNotActive(r["error"])
        return r
    return raw == "true"


def status():
    """{"id", "enabled", "selected", "active", "previous"}"""
    try:
        return _control("status")
    except ImeNotActive:
        return {"id": "", "enabled": False, "selected": False, "active": False, "previous": None}


def is_active():
    return bool(status().get("active"))


def switch():
    """Make XScript 输入法 the current IME. Returns True when it is current now (False: user action needed)."""
    return bool(_control("switch").get("switched"))


def restore():
    """Switch back to the IME that was current before switch(). True when switched back."""
    return bool(_control("restore").get("restored"))


def commit(text):
    return _control("commit", "" if text is None else str(text))


def set_text(text):
    """Replace the focused field's text."""
    return _control("set_text", "" if text is None else str(text))


def delete(before=1, after=0):
    return _control("delete", json.dumps({"before": int(before), "after": int(after)}))


def clear():
    return _control("clear")


def enter():
    """The editor's action (search / send / go) when it has one, otherwise Enter."""
    return _control("enter")


def key(code):
    return _control("key", str(int(code)))
