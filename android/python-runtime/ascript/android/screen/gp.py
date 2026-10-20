"""Local GP pipelines reconstructed from the packaged task/UI interface.

JSON entries use ``id`` and ``data.params`` (Python argument literals), or
structured ``args``/``kwargs``. A package with a data.gp member is interpreted
declaratively (its Python is never executed). Legacy packages without data.gp
are AScript code exports (``as_gp_<name>/__init__.py`` defining ``gp(cv_img)``);
like AScript they are extracted and imported, unless ``allow_python=False``.

Project 图色插件: an id starting with "." (``.MyPlug``, ``.user.MyPlug``) names a
GPTask class in the running project, and must be declared in the project's
build.as ``gp`` array, as in AScript. Only the project's own modules are imported.

``data.params`` may call ``R.img / R.res / R.ui / R.root / R.sd`` with literal
arguments (what the GP UI exports for template images); nothing else is evaluated.

Cloud entries (``type`` containing 云端, ``nv`` = plugin spec) first run
``plug.load(nv)``; the task id then resolves through :func:`register_task`, or
a module importable once the plugin is loaded. There is no plugin server.
"""

import ast
import importlib
import json

import re
import sys
import tempfile
from abc import ABC, abstractmethod
from pathlib import Path
import zipfile


class Result:
    def __init__(self, image, offset_x=0, offset_y=0, data=None):
        self.image, self.offset_x, self.offset_y, self.data = image, offset_x, offset_y, data


class GPTask(ABC):
    name = "插件名称"
    ui_path = "插件UI地址"

    @abstractmethod
    def run(self, cv_image, offset_x=0, offset_y=0, data=None) -> Result:
        pass


_registered = {}


def register_task(task_id, task_class):
    """Map a GP task id (e.g. a cloud plugin's ``module.Class``) to a local class."""
    if not isinstance(task_id, str) or not task_id or not callable(task_class):
        raise TypeError("register_task(task_id: str, task_class: callable)")
    _registered[task_id] = task_class
    return task_class


def unregister_task(task_id):
    return _registered.pop(task_id, None) is not None


def _cloud_task(task_id, nv):
    from ascript.android import plug
    plug.load(nv)  # NotImplementedError for plugins XScript does not ship
    if task_id in _registered:
        return _registered[task_id]
    if not isinstance(task_id, str) or "." not in task_id:
        raise NotImplementedError("Unsupported cloud GP task: %r" % task_id)
    module_name, class_name = task_id.rsplit(".", 1)
    try:
        task_class = getattr(importlib.import_module(module_name), class_name)
    except (ImportError, AttributeError) as exc:
        raise NotImplementedError("Cloud GP task %r is not available locally; use gp.register_task" % task_id) from exc
    if not callable(task_class):
        raise NotImplementedError("Cloud GP task %r is not a class" % task_id)
    return task_class


def _task_types():
    from ascript.android import screen
    from . import gp_tasks

    tasks = {"ascript.android.screen.gp_tasks." + c.__name__: c for c in gp_tasks.gp_list()}
    for name in ("Colors", "FindColors", "CompareColors", "FindBlock", "FindImages", "Ocr", "CodeScanner", "Eraser"):
        tasks["ascript.android.screen." + name] = getattr(screen, name)
    tasks.update(_registered)
    return tasks


_R_PATHS = ("img", "res", "ui", "root", "sd")
_PROJECT_ID = re.compile(r"^\.(?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*$")


def _safe_value(node, task_class):
    """Literal values, the task's UPPERCASE constants and R path helpers; nothing executable."""
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, int, float, bool, type(None))):
        return node.value
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        items = [_safe_value(n, task_class) for n in node.elts]
        return items if isinstance(node, ast.List) else tuple(items) if isinstance(node, ast.Tuple) else set(items)
    if isinstance(node, ast.Dict):
        if any(k is None for k in node.keys):
            raise ValueError("Dict unpacking is not supported")
        return {_safe_value(k, task_class): _safe_value(v, task_class) for k, v in zip(node.keys, node.values)}
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        value = _safe_value(node.operand, task_class)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("Unary sign needs a number")
        return -value if isinstance(node.op, ast.USub) else value
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
        # UI exports constants such as Canny.RETR_TREE. Never resolve arbitrary attributes.
        if node.value.id == task_class.__name__ and node.attr.isupper() and hasattr(task_class, node.attr):
            value = getattr(task_class, node.attr)
            if isinstance(value, (str, int, float, bool)):
                return value
        raise ValueError("Unsupported attribute in GP params")
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name) and node.func.value.id == "R"
            and node.func.attr in _R_PATHS and not node.keywords):
        # R.img("btn.png") / R.res("img", "a.png"): project-relative path strings only.
        parts = [_safe_value(n, task_class) for n in node.args]
        if not all(isinstance(p, str) for p in parts):
            raise ValueError("R.%s takes string path parts" % node.func.attr)
        from ascript.android.system import R
        return getattr(R, node.func.attr)(*parts)
    raise ValueError("Unsupported expression in GP params")


def _arguments(params, task_class):
    if not isinstance(params, str):
        raise ValueError("data.params must be an argument string; use args/kwargs for structured input")
    try:
        call = ast.parse("task(" + params + ")", mode="eval").body
        if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.func.id != "task":
            raise ValueError("Expected a task argument list")
        args = []
        for node in call.args:
            if isinstance(node, ast.Starred):
                raise ValueError("Expanded arguments are not supported")
            args.append(_safe_value(node, task_class))
        kwargs = {}
        for keyword in call.keywords:
            if keyword.arg is None or keyword.arg in kwargs:
                raise ValueError("Expanded or duplicate keyword arguments are not supported")
            kwargs[keyword.arg] = _safe_value(keyword.value, task_class)
        return args, kwargs
    except (SyntaxError, ValueError, TypeError, RecursionError) as exc:
        raise ValueError("GP params must contain literals, supported task constants or R paths") from exc


def _declared_project_tasks(root):
    """Ids in the project's build.as "gp" array (AScript 图色插件 registration)."""
    path = Path(root) / "build.as"
    try:
        config = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return set()
    entries = config.get("gp") if isinstance(config, dict) else None
    out = set()
    for entry in entries if isinstance(entries, list) else []:
        task_id = entry.get("id") if isinstance(entry, dict) else entry
        if isinstance(task_id, str):
            out.add(task_id.strip())
    return out


def _project_task(task_id):
    """Resolve ``.module.Class`` inside the running project; only declared tasks, only project modules."""
    from xscript.runtime import runner
    root, name = runner.project_dir(), runner.project_name()
    if not root or not name:
        raise NotImplementedError("Project GP task %r needs a running project" % task_id)
    if not _PROJECT_ID.match(task_id):
        raise ValueError("Project GP task id must look like .module.Class: %r" % task_id)
    if task_id not in _declared_project_tasks(root):
        raise NotImplementedError("Project GP task %r is not declared in build.as \"gp\"" % task_id)
    module_path, _, cls_name = task_id[1:].rpartition(".")
    try:
        module = importlib.import_module(name + ("." + module_path if module_path else ""))
    except ImportError as exc:
        raise NotImplementedError("Project GP task %r: cannot import its module (%s)" % (task_id, exc)) from exc
    origin = Path(getattr(module, "__file__", "") or "").resolve()
    if Path(root).resolve() not in origin.parents:
        raise ValueError("Project GP task %r does not resolve inside the project" % task_id)
    task_class = getattr(module, cls_name, None)
    if not isinstance(task_class, type) or not callable(getattr(task_class, "run", None)):
        raise NotImplementedError("Project GP task %r is not a GPTask class" % task_id)
    return task_class


class GPStack:
    @staticmethod
    def run_json(json_param, cv_img=None):
        """Execute a JSON task array against an image (or the current screenshot).

        Unknown tasks, executable expressions, cloud plugins and malformed
        arguments raise an explicit error rather than yielding a partial result.
        """
        jobs = json.loads(json_param) if isinstance(json_param, (str, bytes, bytearray)) else json_param
        if not isinstance(jobs, list):
            raise ValueError("GP JSON must be a task array")
        stack = GPStack(cv_img)
        types = _task_types()
        for index, job in enumerate(jobs):
            if not isinstance(job, dict):
                raise ValueError("GP task %d must be an object" % index)
            task_id = job.get("id")
            if "云端" in str(job.get("type", "")) or job.get("nv"):
                if not job.get("nv"):
                    raise NotImplementedError("Cloud GP task %r has no plugin (nv)" % task_id)
                task_class = _cloud_task(task_id, str(job["nv"]))
            elif isinstance(task_id, str) and task_id in types:
                task_class = types[task_id]
            elif isinstance(task_id, str) and task_id.startswith("."):
                task_class = _project_task(task_id)
            else:
                raise NotImplementedError("Unsupported GP task: %r" % task_id)
            if "args" in job or "kwargs" in job:
                args, kwargs = job.get("args", []), job.get("kwargs", {})
                if not isinstance(args, list) or not isinstance(kwargs, dict):
                    raise ValueError("GP args must be a list and kwargs must be an object")
            else:
                config = job.get("data") or {}
                if not isinstance(config, dict):
                    raise ValueError("GP data must be an object")
                args, kwargs = _arguments(config.get("params", ""), task_class)
            try:
                stack.add(task_class(*args, **kwargs))
            except (TypeError, ValueError) as exc:
                raise ValueError("Invalid arguments for GP task %d (%s): %s" % (index, task_id, exc)) from exc
        return stack.run()

    def __init__(self, cv_image=None):
        self.gp_dao = []
        self.image, self.offset_x, self.offset_y = cv_image, 0, 0
        if self.image is None:
            from ascript.android import screen
            self.image = screen.bitmap_to_cvimage()

    def add(self, dao):
        if not callable(getattr(dao, "run", None)):
            raise TypeError("GP task must provide run(image, offset_x, offset_y, data)")
        self.gp_dao.append(dao)
        return self

    @staticmethod
    def change_img_channal(cv_image):
        import cv2
        if cv_image.ndim == 2 or (cv_image.ndim == 3 and cv_image.shape[2] == 1):
            return cv2.cvtColor(cv_image, cv2.COLOR_GRAY2BGR)
        if cv_image.ndim == 3 and cv_image.shape[2] == 4:
            return cv2.cvtColor(cv_image, cv2.COLOR_BGRA2BGR)
        if cv_image.ndim != 3 or cv_image.shape[2] != 3:
            raise ValueError("GP images must have 1, 3 or 4 channels")
        return cv_image

    def run(self):
        res = Result(self.image, self.offset_x, self.offset_y)
        for index, task in enumerate(self.gp_dao):
            img = self.change_img_channal(res.image)
            res = task.run(img, res.offset_x, res.offset_y, res.data)
            if not isinstance(res, Result):
                raise TypeError("GP task %d must return Result" % index)
        return res


_MAX_JSON = 4 * 1024 * 1024
_MAX_PACKAGE = 64 * 1024 * 1024
_loaded_gp_modules = []
_MAX_GP_CACHE = 20


def _module_name(path):
    stem = re.sub(r"\W", "_", Path(path).stem) or "pkg"
    return stem if stem.startswith("as_gp_") else "as_gp_" + stem


def _cache_root():
    try:
        from ascript.android.system import R
        root = Path(R.sd("/airscript/gp"))
        root.mkdir(parents=True, exist_ok=True)
        return root
    except Exception:
        return Path(tempfile.gettempdir()) / "xscript_gp"


def _extract(archive, target):
    """Extract into target refusing absolute/escaping paths and oversize archives."""
    root = target.resolve()
    total = 0
    for member in archive.infolist():
        name = member.filename.replace("\\", "/")
        dest = (root / name).resolve()
        if name.startswith("/") or (dest != root and root not in dest.parents):
            raise ValueError("GP archive member escapes the package: %r" % member.filename)
        total += member.file_size
        if total > _MAX_PACKAGE:
            raise ValueError("GP package exceeds the 64 MiB limit")
        if member.is_dir():
            dest.mkdir(parents=True, exist_ok=True)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(archive.read(member))


def _package_init(base, name):
    """Find the package dir: <base>/<name>, or a single as_gp_* / package dir."""
    if (base / name / "__init__.py").is_file():
        return base / name
    if (base / "__init__.py").is_file():
        return base
    found = [d for d in base.iterdir() if d.is_dir() and (d / "__init__.py").is_file()]
    if len(found) == 1:
        return found[0]
    raise ValueError("GP package has no data.gp and no single Python package")


def _import_package(pkg_dir, name):
    import importlib.util
    cached = sys.modules.get(name)
    if cached is not None and Path(getattr(cached, "__file__", "") or "").parent == pkg_dir:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(pkg_dir / "__init__.py"),
                                                  submodule_search_locations=[str(pkg_dir)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    if name not in _loaded_gp_modules:
        _loaded_gp_modules.append(name)
    while len(_loaded_gp_modules) > _MAX_GP_CACHE:
        old = _loaded_gp_modules.pop(0)
        for key in [k for k in sys.modules if k == old or k.startswith(old + ".")]:
            sys.modules.pop(key, None)
    return module


def _run_python(path, cv_img, is_zip):
    name = _module_name(path)
    if is_zip:
        target = _cache_root() / name
        if target.exists():
            import shutil
            shutil.rmtree(target)
        target.mkdir(parents=True)
        with zipfile.ZipFile(path) as archive:
            _extract(archive, target)
        base = target
    else:
        base = Path(path)
    pkg_dir = _package_init(base, name).resolve()
    module = _import_package(pkg_dir, name)
    entry = getattr(module, "gp", None)
    if not callable(entry):
        raise ValueError("Legacy GP package %s has no gp(cv_img) function" % name)
    return entry(cv_img)


def run(gp_file, cv_img=None, allow_python=True):
    """Run a .gp: plain JSON, directory, or ZIP package.

    data.gp (JSON) is preferred and never executes package code. Without it a
    legacy Python export is imported and its ``gp(cv_img)`` called (AScript
    behaviour); pass ``allow_python=False`` to refuse that.
    """
    path = Path(gp_file)
    if path.is_dir():
        if not (path / "data.gp").is_file():
            if not allow_python:
                raise ValueError("GP directory has no data.gp and Python packages are disabled")
            return _run_python(path, cv_img, False)
        path = path / "data.gp"
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            members = [m for m in archive.infolist() if not m.is_dir() and Path(m.filename).name == "data.gp"]
            if len(members) > 1:
                raise ValueError("GP archive must contain at most one data.gp JSON member")
            if not members:
                if not allow_python:
                    raise ValueError("GP archive has no data.gp and Python packages are disabled")
                content = None
            else:
                if members[0].file_size > _MAX_JSON:
                    raise ValueError("GP task JSON exceeds the 4 MiB limit")
                content = archive.read(members[0]).decode("utf-8-sig")
        if content is None:
            return _run_python(path, cv_img, True)
    else:
        if path.stat().st_size > _MAX_JSON:
            raise ValueError("GP task JSON exceeds the 4 MiB limit")
        content = path.read_text(encoding="utf-8-sig")
    return GPStack.run_json(content, cv_img)
