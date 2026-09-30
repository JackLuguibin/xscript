"""ascript.android.system on XScript."""

import json
import os
import sys
from abc import ABC

from ascript._compat import warn_once
from xscript.android import system as _xs
from xscript.runtime import runner
from xscript.runtime.bridge import bridge


def _project_root():
    """Root of the running project; plugin-style callers resolve to their own package root."""
    root = runner.project_dir()
    try:
        frame = sys._getframe(3)
    except ValueError:
        frame = None
    while frame is not None:
        name = frame.f_globals.get("__name__", "")
        if not name.startswith("ascript") and not name.startswith("xscript"):
            break
        frame = frame.f_back
    if frame is not None and root:
        f = frame.f_globals.get("__file__") or ""
        if f and not os.path.abspath(f).startswith(os.path.abspath(root) + os.sep):
            # Code from another project package (AScript "plugin") keeps its own res/.
            top = sys.modules.get((frame.f_globals.get("__name__") or "").split(".")[0])
            tf = getattr(top, "__file__", None)
            if tf:
                pkg_root = os.path.dirname(os.path.abspath(tf))
                if os.path.isdir(os.path.join(pkg_root, "res")):
                    return pkg_root
    return root or os.getcwd()


def _make(base, parts):
    if not parts:
        return base
    out = [os.path.join(base, str(p).lstrip("/")) for p in parts]
    return out[0] if len(out) == 1 else out


class _RMeta(type):
    @property
    def name(cls):
        return runner.project_name()

    @property
    def package_name(cls):
        return "com.xscript.app"

    @property
    def context(cls):
        try:
            from com.xscript.app import XscriptApp

            return XscriptApp.getInstance() if hasattr(XscriptApp, "getInstance") else XscriptApp.Companion.getInstance()
        except Exception:
            return None


class R(metaclass=_RMeta):
    id = 0
    version = 1
    mode = 0

    @staticmethod
    def res(*child_paths):
        return _make(os.path.join(_project_root(), "res"), child_paths)

    @staticmethod
    def img(*child_paths):
        return _make(os.path.join(_project_root(), "res", "img"), child_paths)

    @staticmethod
    def ui(*child_paths):
        return _make(os.path.join(_project_root(), "res", "ui"), child_paths)

    @staticmethod
    def root(*child_paths):
        return _make(_project_root(), child_paths)

    @staticmethod
    def sd(*child_paths):
        return _make("/sdcard", child_paths)

    @staticmethod
    def rel(*args):
        return _make(_project_root(), args)

    @staticmethod
    def get_card():
        """卡密 of a packaged app's license (None when unlicensed or not packaged)."""
        return _xs.license_status().get("card_full") or None


def exit():  # noqa: A001
    raise SystemExit(0)


def reboot(delay_time=0):
    """Restart the project in a fresh script process after `delay_time` ms (not a device reboot)."""
    _xs.reboot(max(0, delay_time) / 1000.0)


def open(name_or_package):  # noqa: A001
    return _xs.open(name_or_package)


def browser(url):
    return _xs.browser(url)


def get_app_name(package_name):
    return _xs.app_name(package_name)


def open_app_setting(package_name):
    return _xs.open_app_setting(package_name)


def wait_for_package(package_name, timeout=30000):
    return _xs.wait_for_package(package_name, timeout / 1000.0)


def get_foreground_app(active_time=60):
    return _xs.current_app().get("packageName")


def get_info():
    s = _xs.status()
    return {"version": s.get("version", ""), "name": "XScript", "sdk": s.get("sdk"), "mode": s.get("channel")}


def get_version():
    return get_info()["version"]


class Config:
    """Run options of the current project (the switches on its screen in the app)."""

    @staticmethod
    def set_stop_re_run(is_open):
        """停止后重新运行: re-run this project when it exits or crashes (not after a user stop)."""
        return _xs.Config.set_stop_re_run(bool(is_open))

    @staticmethod
    def set_auto_run(is_open):
        """开机自启: start this project after the device boots."""
        return _xs.Config.set_auto_run(bool(is_open))


def refresh_and_find_module(module_name):
    import importlib

    importlib.invalidate_caches()
    return importlib.util.find_spec(module_name)


def memory():
    return _Obj(_xs.memory())


def get_external_storage_info():
    st = os.statvfs("/sdcard")
    return {"total": st.f_blocks * st.f_frsize, "free": st.f_bavail * st.f_frsize}


def get_internal_storage_info():
    st = os.statvfs("/data")
    return {"total": st.f_blocks * st.f_frsize, "free": st.f_bavail * st.f_frsize}


def get_navigation_mode():
    r = _xs.shell("settings get secure navigation_mode", root=False)
    try:
        return int(r.out.strip())
    except ValueError:
        return -1


class ShellListener(ABC):
    def commandOutput(self, i, s):
        pass

    def commandTerminated(self, i, s):
        pass

    def commandCompleted(self, i, i1):
        pass


class ShellResult:
    def __init__(self, res, error, code):
        self.res, self.error, self.code = res, error, code

    def __repr__(self):
        return "ShellResult(code=%s, res=%r, error=%r)" % (self.code, self.res, self.error)


def shell(command, callback=None):
    r = _xs.shell(command)
    if callback is not None:
        for i, line in enumerate(r.out.splitlines()):
            callback.commandOutput(0, line)
        callback.commandCompleted(0, r.code)
        return None
    return ShellResult(r.out, r.err, r.code)


def channel(fun):
    """fun(msg) for each 云控 server message (the connection is made in the app or with
    cloud_control.connect_to_ws). Keep the script alive yourself (a loop)."""
    from xscript.android import cloud

    return cloud.on_message(fun)


class _Obj(object):
    """dict with attribute access (AScript returns Java objects with fields)."""

    def __init__(self, d):
        self.__dict__.update(d or {})

    def __getitem__(self, k):
        return self.__dict__[k]

    def get(self, k, default=None):
        return self.__dict__.get(k, default)

    def __repr__(self):
        return json.dumps(self.__dict__, ensure_ascii=False, default=str)


class _AppInfo(_Obj):
    pass


class _Display(object):
    def __init__(self, d):
        self.widthPixels = int(d.get("width", 0))
        self.heightPixels = int(d.get("height", 0))
        self.density = float(d.get("density", 1.0))
        self.densityDpi = int(d.get("densityDpi", 160))

    def __repr__(self):
        return "Display(%dx%d, dpi=%d)" % (self.widthPixels, self.heightPixels, self.densityDpi)


class Device:
    @staticmethod
    def id():
        return _xs.device().get("id", "")

    @staticmethod
    def name():
        return _xs.device().get("name", "")

    @staticmethod
    def display():
        return _Display(_xs.device())

    @staticmethod
    def status_bar_height():
        return int(_xs.device().get("status_bar_height", 0))

    statue_bar_height = status_bar_height

    @staticmethod
    def brand():
        return _xs.device().get("brand", "")

    @staticmethod
    def model():
        return _xs.device().get("model", "")

    @staticmethod
    def sdk():
        return int(_xs.device().get("sdk", 0))

    @staticmethod
    def version():
        return _xs.device().get("version", "")

    @staticmethod
    def ip():
        return _xs.device().get("ip", "")

    @staticmethod
    def phone_numbers():
        return []

    @staticmethod
    def current_appinfo():
        cur = _xs.current_app()
        pkg = cur.get("packageName", "")
        return _AppInfo({
            "packageName": pkg,
            "activity": cur.get("activity", ""),
            "name": (_xs.app_name(pkg) or "") if pkg else "",
        })

    @staticmethod
    def apps():
        return [_AppInfo(a) for a in _xs.apps()]

    @staticmethod
    def battery():
        return _Obj(_xs.battery())

    @staticmethod
    def memory():
        return _Obj(_xs.memory())

    @staticmethod
    def memory_app():
        return _xs.memory().get("app_used", 0)

    @staticmethod
    def set_brightness(value):
        return bridge.system("brightness", {"v": int(value)}) == "true"

    @staticmethod
    def is_charging():
        return bool(_xs.battery().get("charging"))

    @staticmethod
    def is_screen_on():
        return _xs.is_screen_on()

    @staticmethod
    def wake_up():
        return _xs.wake_up()

    @staticmethod
    def keep_screen_on():
        warn_once("keep_screen_on", "Device.keep_screen_on: enable 保持亮屏 in the XScript app instead")

    @staticmethod
    def keep_screen_off():
        return None

    @staticmethod
    def abi():
        return _xs.device().get("abi", "")

    @staticmethod
    def abis():
        return list(_xs.device().get("abis", []))


class Clipboard:
    @staticmethod
    def put(msg):
        _xs.clipboard_set(msg)

    @staticmethod
    def get():
        return _xs.clipboard_get()


class KeyValue:
    @staticmethod
    def save(key, value):
        _xs.KeyValue.save(key, value)

    @staticmethod
    def get(key, default_value=None):
        return _xs.KeyValue.get(key, default_value)

    @staticmethod
    def remove(key):
        _xs.KeyValue.remove(key)


class Notification:
    @staticmethod
    def listen(call, package=None):
        """call(event) for each notification (event.package / title / text / time / send()).

        Needs 通知使用权 for full data; without it, accessibility notification events are used.
        Pass call=None to stop.
        """
        from xscript.android import event as _ev

        _ev.off(event_type=_ev.NOTIFICATION)
        if call is None:
            return None
        return _ev.on(_ev.NOTIFICATION, call, package=package)


class Control:
    @staticmethod
    def send(params):
        """Report data to the 云控 server (same as cloud_control.send)."""
        from xscript.android import cloud

        return cloud.send(params)
