"""Apps, device info, clipboard, key-value storage, shell and project resources."""

import json
import os
import sys
import time

from xscript.runtime import runner
from xscript.runtime.bridge import bridge


def _call(op, arg=""):
    return bridge.system(op, arg)


def _json(op, arg=""):
    raw = _call(op, arg)
    return json.loads(raw) if raw else {}


# ---------------------------------------------------------------- apps

def open(name_or_package):  # noqa: A001 - AScript-compatible name
    """Launch an app by package name or label."""
    return _call("open", str(name_or_package)) == "true"


def browser(url):
    return _call("browser", str(url)) == "true"


def app_name(package):
    return _call("app_name", str(package)) or None


def open_app_setting(package):
    return _call("open_setting", str(package)) == "true"


def stop_app(package):
    """force-stop (needs root)."""
    return _call("stop_app", str(package)) == "true"


def apps():
    raw = _call("apps")
    return json.loads(raw) if raw else []


def current_app():
    """{"packageName": ..., "activity": ...} of the foreground app."""
    return _json("current_app")


def wait_for_package(package, timeout=30):
    deadline = time.time() + float(timeout)
    while time.time() < deadline:
        if current_app().get("packageName") == package:
            return True
        time.sleep(0.5)
    return False


# ---------------------------------------------------------------- device

def device():
    return _json("device")


def battery():
    return _json("battery")


def memory():
    return _json("memory")


def status():
    """App status: channel, accessibility, root, capture source, resolution..."""
    return _json("status")


def is_screen_on():
    return _call("screen_on") == "true"


def wake_up():
    return _call("wake_up") == "true"


# ---------------------------------------------------------------- clipboard / kv / shell

def clipboard_set(text):
    _call("clip_put", "" if text is None else str(text))


def clipboard_get():
    return _call("clip_get")


class KeyValue(object):
    """Persistent key-value store shared across runs. Values are JSON-encoded."""

    @staticmethod
    def save(key, value):
        _call("kv_put", {"key": str(key), "value": json.dumps(value, ensure_ascii=False)})

    set = save

    @staticmethod
    def get(key, default=None):
        raw = _call("kv_get", {"key": str(key)})
        if raw == "\u0000" or raw == "":
            return default
        try:
            return json.loads(raw)
        except ValueError:
            return raw

    @staticmethod
    def remove(key):
        _call("kv_remove", {"key": str(key)})


class ShellResult(object):
    def __init__(self, d):
        self.code = int(d.get("code", -1))
        self.out = d.get("out", "")
        self.err = d.get("err", "")
        # AScript names
        self.res = self.out
        self.error = self.err

    @property
    def ok(self):
        return self.code == 0

    def __repr__(self):
        return "ShellResult(code=%d, out=%r, err=%r)" % (self.code, self.out[:200], self.err[:200])


def shell(cmd, root=True, timeout=30):
    """Run a shell command (via su when available and root=True)."""
    return ShellResult(_json("shell", {"cmd": str(cmd), "root": bool(root), "timeout": int(timeout * 1000)}))


def has_root():
    return _call("root") == "true"


# ---------------------------------------------------------------- media

def vibrate(ms=200):
    _call("vibrate", {"v": int(ms)})


def speak(text):
    return _call("tts", str(text)) == "true"


def toast(msg, dur=2000):
    bridge.ui("toast", {"msg": str(msg), "dur": int(dur)})


# ---------------------------------------------------------------- project resources

def project_dir():
    d = runner.project_dir()
    if d:
        return d
    main = sys.modules.get("__main__")
    f = getattr(main, "__file__", "") or ""
    return os.path.dirname(os.path.abspath(f)) if f else os.getcwd()


class R(object):
    """Paths inside the running project (res/, res/img/, res/ui/)."""

    @staticmethod
    def root(*parts):
        return _join(project_dir(), parts)

    @staticmethod
    def res(*parts):
        return _join(os.path.join(project_dir(), "res"), parts)

    @staticmethod
    def img(*parts):
        return _join(os.path.join(project_dir(), "res", "img"), parts)

    @staticmethod
    def ui(*parts):
        return _join(os.path.join(project_dir(), "res", "ui"), parts)

    @staticmethod
    def sd(*parts):
        return _join("/sdcard", parts)


def _join(base, parts):
    if not parts:
        return base
    out = [os.path.join(base, str(p).lstrip("/")) for p in parts]
    return out[0] if len(out) == 1 else out


def exit(code=0):  # noqa: A001
    """Stop the running script."""
    raise SystemExit(code)
