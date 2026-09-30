"""User site-packages for packages installed at runtime (`xscript.android.pip`).

`activate()` runs at the start of every script / eval process. It puts the install directory
on `sys.path` (after the bundled packages, so the app's numpy / opencv always win), and
pre-loads the shared libraries native wheels keep in `chaquopy/lib/` so their extension
modules find them on import (Chaquopy does the same for packages built into the APK).
"""

import contextlib
import json
import os
import sys
import threading

from xscript.runtime.bridge import bridge

_state = {"active": False, "libs": {}}
_lock = threading.RLock()


def on_device():
    return bool(getattr(bridge, "available", False))


def pip_home():
    """Private app storage on the device (`files/pip`), ~/.xscript/pip on a PC."""
    if on_device():
        raw = bridge.system("pip_home", "")
        if raw:
            return raw
    return os.environ.get("XSCRIPT_PIP_HOME") or os.path.join(os.path.expanduser("~"), ".xscript", "pip")


def site_dir():
    return os.path.join(pip_home(), "site-packages")


def device():
    if not on_device():
        return {}
    raw = bridge.system("device", "")
    return json.loads(raw) if raw else {}


@contextlib.contextmanager
def lock():
    """Cross-process install lock (script and eval processes may install at the same time)."""
    import fcntl

    os.makedirs(pip_home(), exist_ok=True)
    with _lock, open(os.path.join(pip_home(), ".lock"), "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def activate(refresh=False):
    """Make runtime-installed packages importable in this process. Safe to call repeatedly."""
    with _lock:
        site = site_dir()
        if not os.path.isdir(site):
            if not refresh:
                return False
            os.makedirs(site, exist_ok=True)
        if site not in sys.path:
            sys.path.append(site)  # after the APK's packages: bundled versions take priority
        _load_libs(os.path.join(site, "chaquopy", "lib"))
        if refresh:
            import importlib

            importlib.invalidate_caches()
        _state["active"] = True
        return True


def _load_libs(libdir):
    """dlopen each library once, dependencies first (retry until no progress)."""
    if not on_device() or not os.path.isdir(libdir):
        return
    import ctypes

    pending = [f for f in sorted(os.listdir(libdir)) if ".so" in f and f not in _state["libs"]]
    while pending:
        progress = False
        for name in list(pending):
            try:
                _state["libs"][name] = ctypes.CDLL(os.path.join(libdir, name))
                pending.remove(name)
                progress = True
            except OSError:
                continue
        if not progress:
            break
