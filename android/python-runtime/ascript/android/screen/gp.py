"""Local GP pipelines reconstructed from the packaged task/UI interface.

JSON entries use ``id`` and ``data.params`` (Python argument literals), or
structured ``args``/``kwargs``. Archives must contain one data.gp JSON member;
packaged Python and cloud plugins are deliberately not executed.
"""

import ast
import json
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


def _task_types():
    from ascript.android import screen
    from . import gp_tasks

    tasks = {"ascript.android.screen.gp_tasks." + c.__name__: c for c in gp_tasks.gp_list()}
    for name in ("Colors", "FindColors", "CompareColors", "FindBlock", "FindImages", "Ocr", "CodeScanner", "Eraser"):
        tasks["ascript.android.screen." + name] = getattr(screen, name)
    return tasks


def _arguments(params, task_class):
    if not isinstance(params, str):
        raise ValueError("data.params must be an argument string; use args/kwargs for structured input")
    try:
        call = ast.parse("task(" + params + ")", mode="eval").body
        if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.func.id != "task":
            raise ValueError("Expected a task argument list")

        def literal(node):
            # UI exports constants such as Canny.RETR_TREE. Never resolve arbitrary attributes.
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
                if node.value.id == task_class.__name__ and node.attr.isupper() and hasattr(task_class, node.attr):
                    value = getattr(task_class, node.attr)
                    if isinstance(value, (str, int, float, bool)):
                        return value
            return ast.literal_eval(node)

        args = [literal(node) for node in call.args]
        kwargs = {}
        for keyword in call.keywords:
            if keyword.arg is None or keyword.arg in kwargs:
                raise ValueError("Expanded or duplicate keyword arguments are not supported")
            kwargs[keyword.arg] = literal(keyword.value)
        return args, kwargs
    except (SyntaxError, ValueError, TypeError) as exc:
        raise ValueError("GP params must contain literals or supported task constants") from exc


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
                raise NotImplementedError("Cloud GP plugins are not supported")
            if not isinstance(task_id, str) or task_id not in types:
                raise NotImplementedError("Unsupported GP task: %r" % task_id)
            task_class = types[task_id]
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


def run(gp_file, cv_img=None):
    """Run a plain JSON .gp file, directory/data.gp, or ZIP containing data.gp.

    Legacy archives with only generated Python need conversion to data.gp.
    No archive extraction, Python imports or module-cache mutation occurs.
    """
    path = Path(gp_file)
    if path.is_dir():
        path = path / "data.gp"
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            members = [m for m in archive.infolist() if not m.is_dir() and Path(m.filename).name == "data.gp"]
            if len(members) != 1:
                raise ValueError("GP archive must contain exactly one data.gp JSON member; Python-only packages are unsupported")
            if members[0].file_size > 4 * 1024 * 1024:
                raise ValueError("GP task JSON exceeds the 4 MiB limit")
            content = archive.read(members[0]).decode("utf-8-sig")
    else:
        if path.stat().st_size > 4 * 1024 * 1024:
            raise ValueError("GP task JSON exceeds the 4 MiB limit")
        content = path.read_text(encoding="utf-8-sig")
    return GPStack.run_json(content, cv_img)
