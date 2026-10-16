"""插件 (AScript `plug`).

AScript downloads plugins from its own server. XScript has no plugin server, but the
plugins scripts actually rely on for vision are built in, so the usual code runs unchanged:

    from ascript.android import plug
    plug.load("Yolov8Ncnn:1.3")      # also "yolov5", "yolov8", "yolov11", "Yolov11Ncnn", ...
    import Yolov8Ncnn as yolo
    yolo.load(R.res("best.onnx"), None, 5)    # ONNX instead of NCNN .param/.bin
    yolo.detect()

Other plugin names raise NotImplementedError. Third-party Python packages are installed
with `xscript.android.pip` instead. External Java code (APK/JAR/DEX inside the app's storage) is loaded with
`plug.load_apk(path)` and called through reflection (see below).
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


# ---- external APK / JAR / DEX (plug.load_apk) ------------------------------------------------------------------------------
#
#     lib = plug.load_apk(R.res("libs/sdk.jar"))          # only files inside the app's own storage (e.g. a project folder)
#     Sdk = lib.load_class("com.example.Sdk")
#     sdk = Sdk.new("key", 3)                              # constructor overload chosen from the arguments
#     print(sdk.call("version"), Sdk.call_static("hello", "x"), Sdk.get_static("VERSION"))
#     raw = sdk.java                                        # the underlying Java object (Chaquopy proxy)


def _plugins():
    from com.xscript.app.plugin import Plugins  # Chaquopy: Kotlin object with @JvmStatic methods

    return Plugins


def _jargs(args):
    from java import jarray, jclass

    return jarray(jclass("java.lang.Object"))([_unwrap(a) for a in args])


def _unwrap(v):
    return v.java if isinstance(v, (JavaObject, JavaClass)) else v


def _wrap(v):
    """Java results: plain values stay Python (Chaquopy converts String/numbers/bool); other objects get a JavaObject."""
    if v is None or isinstance(v, (str, int, float, bool, bytes)):
        return v
    try:
        cls = v.getClass()
    except Exception:
        return v
    return JavaObject(cls, v)


class JavaClass(object):
    """A class from a loaded plugin: new(), call_static(), get_static()/set_static()."""

    def __init__(self, cls):
        self.java = cls
        self.name = str(cls.getName())

    def new(self, *args):
        return JavaObject(self.java, _plugins().newInstance(self.java, _jargs(args)))

    def call_static(self, method, *args):
        return _wrap(_plugins().invoke(self.java, None, str(method), _jargs(args)))

    def get_static(self, field):
        return _wrap(_plugins().getField(self.java, None, str(field)))

    def set_static(self, field, value):
        _plugins().setField(self.java, None, str(field), _unwrap(value))

    def __repr__(self):
        return "<JavaClass %s>" % self.name


class JavaObject(object):
    """An instance: call(), get()/set(). `.java` is the raw Java object for APIs that take it."""

    def __init__(self, cls, obj):
        self._cls = cls
        self.java = obj

    def call(self, method, *args):
        return _wrap(_plugins().invoke(self._cls, self.java, str(method), _jargs(args)))

    def get(self, field):
        return _wrap(_plugins().getField(self._cls, self.java, str(field)))

    def set(self, field, value):
        _plugins().setField(self._cls, self.java, str(field), _unwrap(value))

    def __str__(self):
        return str(self.java.toString())


class Plugin(object):
    """A loaded APK/JAR/DEX."""

    def __init__(self, path, handle):
        self.path = path
        self.id = handle
        self._classes = {}

    def load_class(self, name):
        name = str(name)
        if name not in self._classes:
            self._classes[name] = JavaClass(_plugins().loadClass(self.id, name))
        return self._classes[name]

    __getitem__ = load_class


def load_apk(path):
    """Load an .apk/.jar/.dex/.zip with DexClassLoader. The file must be inside the app's own storage (projects, files,
    cache); anything else raises ValueError. Returns a Plugin; the same file loaded twice shares one class loader."""
    import os

    path = os.path.abspath(str(path))
    try:
        handle = _plugins().load(path)
    except Exception as e:  # Chaquopy re-raises java.lang.IllegalArgumentException (path policy) under its Java name
        if type(e).__name__ == "IllegalArgumentException":
            msg = e.getMessage() if hasattr(e, "getMessage") else str(e)
            raise ValueError(str(msg)) from None
        raise
    return Plugin(path, str(handle))


def load_apk_dir(directory):
    """Load every plugin file in `directory` (non-recursive, sorted). Returns {file name: Plugin}."""
    import os

    out = {}
    for name in sorted(os.listdir(str(directory))):
        if name.rsplit(".", 1)[-1].lower() in ("apk", "jar", "dex", "zip"):
            out[name] = load_apk(os.path.join(str(directory), name))
    return out


def inject(*args, **kwargs):
    unsupported('plug.inject')


