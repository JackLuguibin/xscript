"""Java bridge. On a PC this stays inert so unit tests can monkeypatch `bridge`."""

import json


class _MissingJava(object):
    """PC stand-in. Every call is a no-op returning an 'unavailable' value."""

    available = False

    def click(self, x, y, dur):
        return False

    def swipe(self, x1, y1, x2, y2, dur):
        return False

    def gesture(self, strokes):
        return False

    def touch(self, action, x, y, dur):
        return False

    def global_action(self, name):
        return False

    def click_node(self, path):
        return False

    def set_text(self, path, text):
        return False

    def node_action(self, path, action, arg=""):
        return False

    def input_text(self, text):
        return False

    def is_accessibility_on(self):
        return False

    def dump_tree(self, mode):
        return '{"mode":%d,"roots":[]}' % int(mode)

    def capture_to_file(self, path):
        return ""

    def capture_raw(self, l=0, t=0, r=0, b=0):
        return b""

    def capture_bitmap(self, l=0, t=0, r=0, b=0):
        return None

    def bitmap_to_raw(self, bitmap):
        return b""

    def raw_to_bitmap(self, raw):
        return None

    def load_bitmap(self, path, sample=1):
        return None

    def save_bitmap(self, bitmap, path, quality=100):
        return False

    def ocr(self, bitmap, dx=0, dy=0, level="line"):
        return "[]"

    def ocr_warmup(self):
        return None

    def onnx_load(self, path, opts_json="{}"):
        return '{"error": "ONNX Runtime is only available on the device"}'

    def onnx_run(self, handle, name, shape_json, data, reduce=""):
        return b""

    def onnx_close(self, handle):
        return None

    def ui(self, op, args=None):
        return ""

    def ui_poll(self, window_id, timeout_ms):
        return ""

    def system(self, op, arg=""):
        return ""

    def control(self, op, arg=""):
        return ""

    def poll_event(self, timeout_ms):
        return ""

    def append_log(self, stream, line):
        return None


class _JavaBridge(object):
    available = True

    def __init__(self):
        from com.xscript.app.runtime import Bridge as JavaBridge

        self._j = JavaBridge

    def click(self, x, y, dur):
        return bool(self._j.click(int(x), int(y), int(dur)))

    def swipe(self, x1, y1, x2, y2, dur):
        return bool(self._j.swipe(int(x1), int(y1), int(x2), int(y2), int(dur)))

    def gesture(self, strokes):
        return bool(self._j.gesture(json.dumps(strokes)))

    def touch(self, action, x, y, dur):
        return bool(self._j.touch(int(action), int(x), int(y), int(dur)))

    def global_action(self, name):
        return bool(self._j.globalAction(str(name)))

    def click_node(self, path):
        return bool(self._j.clickNode(str(path)))

    def set_text(self, path, text):
        return bool(self._j.setText(str(path), str(text)))

    def node_action(self, path, action, arg=""):
        return bool(self._j.nodeAction(str(path), str(action), "" if arg is None else str(arg)))

    def input_text(self, text):
        return bool(self._j.inputText(str(text)))

    def is_accessibility_on(self):
        return bool(self._j.isAccessibilityOn())

    def dump_tree(self, mode):
        return str(self._j.dumpTree(int(mode)))

    def capture_to_file(self, path):
        return self._j.captureToFile(str(path) if path else "")

    def capture_raw(self, l=0, t=0, r=0, b=0):
        data = self._j.captureRaw(int(l), int(t), int(r), int(b))
        return bytes(data) if data is not None else b""

    def capture_bitmap(self, l=0, t=0, r=0, b=0):
        return self._j.captureBitmap(int(l), int(t), int(r), int(b))

    def bitmap_to_raw(self, bitmap):
        return bytes(self._j.bitmapToRaw(bitmap))

    def raw_to_bitmap(self, raw):
        from java import jarray, jbyte

        return self._j.rawToBitmap(jarray(jbyte)(raw))

    def load_bitmap(self, path, sample=1):
        return self._j.loadBitmap(str(path), int(sample))

    def save_bitmap(self, bitmap, path, quality=100):
        return bool(self._j.saveBitmap(bitmap, str(path), int(quality)))

    def ocr(self, bitmap, dx=0, dy=0, level="line"):
        return str(self._j.ocr(bitmap, int(dx), int(dy), str(level)))

    def ocr_warmup(self):
        self._j.ocrWarmup()

    def onnx_load(self, path, opts_json="{}"):
        return str(self._j.onnxLoad(str(path), str(opts_json)))

    def onnx_run(self, handle, name, shape_json, data, reduce=""):
        from java import jarray, jbyte

        out = self._j.onnxRun(str(handle), str(name), str(shape_json), jarray(jbyte)(data), str(reduce))
        return bytes(out) if out is not None else b""

    def onnx_close(self, handle):
        self._j.onnxClose(str(handle))

    def ui(self, op, args=None):
        return str(self._j.ui(str(op), json.dumps(args or {}, ensure_ascii=False)))

    def ui_poll(self, window_id, timeout_ms):
        return str(self._j.uiPoll(str(window_id), int(timeout_ms)))

    def system(self, op, arg=""):
        if isinstance(arg, dict):
            arg = json.dumps(arg, ensure_ascii=False)
        return str(self._j.system(str(op), str(arg)))

    def control(self, op, arg=""):
        if isinstance(arg, dict):
            arg = json.dumps(arg, ensure_ascii=False)
        return str(self._j.control(str(op), str(arg)))

    def poll_event(self, timeout_ms):
        return str(self._j.pollEvent(int(timeout_ms)))

    def append_log(self, stream, line):
        self._j.appendLog(str(stream), str(line))


def _load():
    try:
        return _JavaBridge()
    except Exception:
        return _MissingJava()


bridge = _load()


def on_device():
    return bool(getattr(bridge, "available", False))
