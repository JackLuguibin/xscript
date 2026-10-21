import importlib
import os
import re
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


_context = {"project_dir": "", "name": "", "params": {}}


def project_dir():
    """Absolute directory of the running project ('' outside a project run)."""
    return _context["project_dir"]


def project_name():
    return _context["name"]


def params():
    """Launch parameters of this run (云控 app_run "param"), as a dict."""
    return dict(_context.get("params") or {})


def _apply_params(raw):
    import json

    try:
        data = json.loads(raw) if raw else {}
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    _context["params"] = data
    # AScript: `if hasattr(builtins, 'name'): print(name)` reads launch parameters.
    import builtins

    for k, v in data.items():
        if isinstance(k, str) and k.isidentifier() and not hasattr(builtins, k):
            setattr(builtins, k, v)


def _run_options(name):
    """The project's run options from the app (项目详情 → 运行选项); {} off-device or on any error."""
    import json

    try:
        data = json.loads(bridge.control("config_get", name) or "{}")
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _apply_run_options(name):
    """运行选项「截图失败时停止脚本」 = screen.strict_capture(True) for this run, without changing the code."""
    if _run_options(name).get("strict_capture") is True:
        from xscript.android import image

        image._strict["on"] = True
        print("xscript: 截图失败时停止脚本（运行选项已开启）")


def run_project(project_dir, launch_params="{}", debug=False):
    """Import `<parent>/<name>` so __init__.py runs as a package."""
    _apply_params(launch_params)
    project_dir = os.path.abspath(project_dir)
    name = os.path.basename(project_dir)
    parent = os.path.dirname(project_dir)
    # __init__.pyc alone is a 代码保护 build (sources compiled away); import handles both.
    if not any(os.path.isfile(os.path.join(project_dir, e)) for e in ("__init__.py", "__init__.pyc")):
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

    image_mod = sys.modules.get("xscript.android.image")
    if image_mod is not None:  # the interpreter is reused between runs: strict_capture() must not leak into the next one
        image_mod._reset_run_state()
    print("xscript: starting %s" % name)
    _apply_run_options(name)
    code = 0
    try:
        _prepare_packages(project_dir)
        if debug:
            from xscript.runtime import debugger
            debugger.start()
        # The import system caches directory listings keyed on mtime; a project pushed a moment ago
        # (or one created within the same timestamp tick) would otherwise be reported as missing.
        importlib.invalidate_caches()
        _warm_ocr(project_dir)
        importlib.import_module(name)
        _wait_for_threads()
        print("xscript: finished %s" % name)
    except SystemExit as exc:
        # CPython semantics: None -> 0, int -> itself, anything else is printed and exits with 1.
        if exc.code is None or isinstance(exc.code, int):
            code = exc.code or 0
        else:
            print(exc.code, file=sys.stderr)
            code = 1
        print("xscript: exit %s" % code)
    except KeyboardInterrupt:
        print("xscript: interrupted")
        code = 130
    except BaseException:
        traceback.print_exc()
        code = 1
    finally:
        from xscript.runtime.resources import cleanup
        cleanup()
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
    return code


_OCR_CALL = re.compile(r"(?<!paddle\.)\bocr\w*\s*\(")


def _uses_ocr(project_dir, max_files=300, max_bytes=4 << 20):
    """True when the project's .py sources call ML Kit OCR (`ocr(`, `ocr_find(`, ...).

    PaddleOCR calls (`paddle.ocr(`) do not count; compiled-only projects are not scanned.
    """
    seen = size = 0
    for root, dirs, files in os.walk(project_dir):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d != "__pycache__"]
        for f in files:
            if not f.endswith(".py"):
                continue
            seen += 1
            if seen > max_files or size > max_bytes:
                return False
            try:
                with open(os.path.join(root, f), "r", encoding="utf-8", errors="ignore") as fh:
                    text = fh.read(1 << 20)
            except OSError:
                continue
            size += len(text)
            if _OCR_CALL.search(text):
                return True
    return False


def _warm_ocr(project_dir):
    """Start loading the ML Kit recogniser in the background when the project will need it."""
    try:
        if _uses_ocr(project_dir):
            warm = getattr(bridge, "ocr_warmup", None)
            if warm:
                warm()
    except Exception:
        pass


def _prepare_packages(project_dir):
    """Runtime pip packages on sys.path, then install whatever requirements.txt still lacks."""
    from xscript.runtime import sitepkgs

    sitepkgs.activate()
    from xscript.runtime import pil_compat

    pil_compat.install()  # AScript-era Pillow names (Image.ANTIALIAS, textsize, getsize) on Pillow 10+
    if os.path.isfile(os.path.join(project_dir, "requirements.txt")):
        from xscript.android import pip

        pip.ensure_project(project_dir)


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
