"""插件 (AScript `plug`).

AScript downloads plugins from its own server. XScript has no plugin server, but the
plugins scripts actually rely on for vision are built in, so the usual code runs unchanged:

    from ascript.android import plug
    plug.load("Yolov8Ncnn:1.3")      # also "yolov5", "yolov8", "yolov11", "Yolov11Ncnn", ...
    import Yolov8Ncnn as yolo
    yolo.load(R.res("best.onnx"), None, 5)    # ONNX instead of NCNN .param/.bin
    yolo.detect()

Other plugin names raise NotImplementedError. Third-party Python packages are installed
with `xscript.android.pip` instead.
"""

import sys
import types

from ascript._compat import unsupported

# Plugin name (lower case, without version) → module factory.
_YOLO_V5_STYLE = ("yolov5",)
_YOLO_NCNN_STYLE = ("yolov8ncnn", "yolov11ncnn", "yolov8", "yolov11", "yolo11", "yolo", "yolov5ncnn")


def _split(spec):
    name = str(spec).strip()
    return name.split(":", 1)[0].strip()


def load(plug_and_version):
    """Register a built-in plugin module so `import <name>` works. Returns the module."""
    name = _split(plug_and_version)
    key = name.lower()
    if name in sys.modules:
        return sys.modules[name]
    if key in _YOLO_V5_STYLE:
        mod = _yolov5_module(name)
    elif key in _YOLO_NCNN_STYLE:
        mod = _ncnn_style_module(name)
    else:
        unsupported("plug.load(%r) (only the built-in YOLO plugins are available; "
                    "use xscript.android.pip for PyPI packages)" % name)
    sys.modules[name] = mod
    return mod


def _yolov5_module(name):
    """AScript's `yolov5` plugin: load(model) -> bool, find_all(bitmap, use_gpu, size) -> [dict]."""
    from ascript.android.screen import YoLov5

    mod = types.ModuleType(name)
    state = {"model": None}

    def load_model(model):
        try:
            state["model"] = YoLov5(path=model)
            return True
        except Exception as e:
            print("yolov5.load: %s" % e)
            return False

    def find_all(bitmap=None, use_gpu=False, size=640, confidence=0.25):
        if state["model"] is None:
            raise RuntimeError("call %s.load(model) first" % name)
        return state["model"].find_all(bitmap, use_gpu, size, confidence)

    mod.load = load_model
    mod.find_all = find_all
    mod.__doc__ = "XScript built-in replacement for AScript's yolov5 plugin (ONNX models)."
    return mod


def _ncnn_style_module(name):
    """AScript's Yolov8Ncnn / Yolov11Ncnn plugins: load / detect / draw / free."""
    mod = types.ModuleType(name)
    state = {"model": None, "draw": False, "draw_ms": 1000}

    def load_model(param_path, bin_path=None, nc=None, use_gpu=False, names=None):
        """`param_path` may be the .onnx model (bin_path ignored). NCNN files need an ONNX twin."""
        from ascript.android.screen import _yolo_names, _yolo_path
        from xscript.android import yolo

        try:
            path = _yolo_path(param_path)
            labels = names or _yolo_names(path)
            if labels is None and nc:
                labels = [str(i) for i in range(int(nc))]
            state["model"] = yolo.load(path, names=labels)
            return True
        except Exception as e:
            print("%s.load: %s" % (name, e))
            return False

    def detect(bitmap=None, target_size=640, threshold=0.4, nms_threshold=0.5):
        m = state["model"]
        if m is None:
            raise RuntimeError("call %s.load(...) first" % name)
        hits = m.detect(image=bitmap, conf=threshold, iou=nms_threshold)
        if state["draw"] and hits:
            _draw(hits, state["draw_ms"])
        return [{"class_id": d.class_id, "label": d.label, "confidence": d.confidence, "rect": list(d.rect)}
                for d in hits]

    def draw(is_draw=True, draw_time=1000):
        state["draw"] = bool(is_draw)
        state["draw_ms"] = int(draw_time)

    def free():
        state["model"] = None

    mod.load = load_model
    mod.detect = detect
    mod.draw = draw
    mod.free = free
    mod.__doc__ = "XScript built-in replacement for AScript's %s plugin (ONNX models)." % name
    return mod


def _draw(hits, ms):
    """Outline detections on the overlay canvas (needs the 悬浮窗 grant)."""
    try:
        from xscript.android import ui

        c = ui.Canvas()
        c.show()
        for d in hits:
            l, t, r, b = d.rect
            c.rect(l, t, r, b, color="#00e676", duration=ms, label="%s %.2f" % (d.label, d.confidence))
    except Exception:
        pass


def load_module_dynamically(*args, **kwargs):
    unsupported('plug.load_module_dynamically')


def load_apk(*args, **kwargs):
    unsupported('plug.load_apk')


def inject(*args, **kwargs):
    unsupported('plug.inject')


def load_apk_dir(*args, **kwargs):
    unsupported('plug.load_apk_dir')
