import importlib
import os
import sys
import threading
import traceback

from xscript.runtime.bridge import bridge


class _Stream(object):
    """Line-buffered stdout/stderr → device run log. Safe to share across threads."""

    def __init__(self, name):
        self.name = name
        self._buf = ""
        self._lock = threading.Lock()
        self.encoding = "utf-8"
        self.errors = "replace"

    def write(self, data):
        if not data:
            return 0
        text = data if isinstance(data, str) else str(data)
        with self._lock:
            self._buf += text
            if "\n" not in self._buf:
                if len(self._buf) < 4096:
                    return len(text)
                lines, self._buf = [self._buf], ""
            else:
                parts = self._buf.split("\n")
                self._buf = parts.pop()
                lines = parts
        for line in lines:
            bridge.append_log(self.name, line + "\n")
        return len(text)

    def flush(self):
        with self._lock:
            pending, self._buf = self._buf, ""
        if pending:
            bridge.append_log(self.name, pending + "\n")

    def isatty(self):
        return False

    def writable(self):
        return True


_context = {"project_dir": "", "name": ""}


def project_dir():
    """Absolute directory of the running project ('' outside a project run)."""
    return _context["project_dir"]


def project_name():
    return _context["name"]


def run_project(project_dir):
    """Import `<parent>/<name>` so __init__.py runs as a package."""
    project_dir = os.path.abspath(project_dir)
    name = os.path.basename(project_dir)
    parent = os.path.dirname(project_dir)
    entry = os.path.join(project_dir, "__init__.py")
    if not os.path.isfile(entry):
        raise RuntimeError("missing __init__.py in %s" % project_dir)

    _context["project_dir"] = project_dir
    _context["name"] = name
    sys.stdout = _Stream("stdout")
    sys.stderr = _Stream("stderr")
    # AScript projects often import their own sub-packages absolutely ("from framework import x").
    for path in (project_dir, parent):
        if path not in sys.path:
            sys.path.insert(0, path)
    try:
        os.chdir(project_dir)
    except Exception:
        pass

    for key in list(sys.modules):
        if key == name or key.startswith(name + "."):
            del sys.modules[key]

    print("xscript: starting %s" % name)
    code = 0
    try:
        importlib.import_module(name)
        _wait_for_threads()
        print("xscript: finished %s" % name)
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else 0
        print("xscript: exit %s" % code)
    except KeyboardInterrupt:
        print("xscript: interrupted")
        code = 130
    except BaseException:
        traceback.print_exc()
        code = 1
    finally:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
    return code


def _wait_for_threads():
    """Keep the process alive while the script's non-daemon threads run (like CPython's exit)."""
    # Under Chaquopy the interpreter's "main thread" is the Android UI looper (never ends) and
    # this runner executes on a Java-created thread (a _DummyThread). Only join real threads
    # the script itself started.
    skip = {threading.current_thread(), threading.main_thread()}
    dummy = getattr(threading, "_DummyThread", ())
    for t in threading.enumerate():
        if t in skip or t.daemon or not t.is_alive() or (dummy and isinstance(t, dummy)):
            continue
        print("xscript: waiting for thread %s" % t.name)
        t.join()
