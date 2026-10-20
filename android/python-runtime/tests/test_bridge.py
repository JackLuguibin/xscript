"""xscript.runtime.bridge: the PC stand-in and the argument conversion done before each Chaquopy call."""

import json
import sys
import types
import unittest

from xscript.runtime import bridge as bridge_mod


class RecordingJava(object):
    """Plays com.xscript.app.runtime.Bridge: records each call and returns a canned value."""

    def __init__(self):
        self.calls = []
        self.returns = {}

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        def call(*args):
            self.calls.append((name, args))
            return self.returns.get(name)
        return call


class FakeJarray(object):
    def __init__(self, kind):
        self.kind = kind

    def __call__(self, data):
        return ("jarray", self.kind, bytes(data))


class JavaBridgeTest(unittest.TestCase):
    def setUp(self):
        self.java = RecordingJava()
        pkg = types.ModuleType("com.xscript.app.runtime")
        pkg.Bridge = self.java
        jmod = types.ModuleType("java")
        jmod.jarray = FakeJarray
        jmod.jbyte = "jbyte"
        self.mods = {"com": types.ModuleType("com"), "com.xscript": types.ModuleType("com.xscript"),
                     "com.xscript.app": types.ModuleType("com.xscript.app"), "com.xscript.app.runtime": pkg,
                     "java": jmod}
        self.saved = {k: sys.modules.get(k) for k in self.mods}
        sys.modules.update(self.mods)
        self.b = bridge_mod._JavaBridge()

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    def last(self):
        return self.java.calls[-1]

    def test_load_picks_java_when_present(self):
        self.assertTrue(bridge_mod._load().available)

    def test_touch_calls_coerce_to_int_and_bool(self):
        self.java.returns.update(click=1, swipe=0, touch=1, globalAction=1, clickNode=1, setText=0, inputText=1,
                                 isAccessibilityOn=1)
        self.assertIs(self.b.click(10.7, "20", 50.0), True)
        self.assertEqual(self.last(), ("click", (10, 20, 50)))
        self.assertIs(self.b.swipe(1.9, 2, 3, 4, 300.2), False)
        self.assertEqual(self.last(), ("swipe", (1, 2, 3, 4, 300)))
        self.assertTrue(self.b.touch(0, 5.5, 6.5, 0))
        self.assertEqual(self.last(), ("touch", (0, 5, 6, 0)))
        self.assertTrue(self.b.global_action(u"back"))
        self.assertTrue(self.b.click_node(3))
        self.assertEqual(self.last(), ("clickNode", ("3",)))
        self.assertIs(self.b.set_text("0/1", 42), False)
        self.assertEqual(self.last(), ("setText", ("0/1", "42")))
        self.assertTrue(self.b.input_text("你好"))
        self.assertTrue(self.b.is_accessibility_on())

    def test_gesture_is_sent_as_json(self):
        strokes = [{"points": [[0, 0], [10, 10]], "start": 0, "duration": 100}]
        self.b.gesture(strokes)
        name, (payload,) = self.last()
        self.assertEqual(name, "gesture")
        self.assertEqual(json.loads(payload), strokes)

    def test_node_action_none_arg_becomes_empty(self):
        self.b.node_action("0/2", "scroll", None)
        self.assertEqual(self.last(), ("nodeAction", ("0/2", "scroll", "")))
        self.b.node_action("0/2", "set_progress", 0.5)
        self.assertEqual(self.last(), ("nodeAction", ("0/2", "set_progress", "0.5")))

    def test_capture_and_bitmap_conversion(self):
        self.java.returns["captureRaw"] = [1, 2, 3]
        self.assertEqual(self.b.capture_raw(0, 0, 10.0, 10.0), b"\x01\x02\x03")
        self.assertEqual(self.last(), ("captureRaw", (0, 0, 10, 10)))
        self.java.returns["captureRaw"] = None
        self.assertEqual(self.b.capture_raw(), b"")
        self.java.returns["captureToFile"] = "/sdcard/a.png"
        self.assertEqual(self.b.capture_to_file(None), "/sdcard/a.png")
        self.assertEqual(self.last(), ("captureToFile", ("",)))
        self.b.capture_bitmap(1, 2, 3, 4)
        self.assertEqual(self.last(), ("captureBitmap", (1, 2, 3, 4)))
        self.java.returns["bitmapToRaw"] = [9]
        self.assertEqual(self.b.bitmap_to_raw("bmp"), b"\x09")
        self.b.raw_to_bitmap(b"\x00\x01")
        self.assertEqual(self.last(), ("rawToBitmap", (("jarray", "jbyte", b"\x00\x01"),)))
        self.b.load_bitmap("/a.png", 2.0)
        self.assertEqual(self.last(), ("loadBitmap", ("/a.png", 2)))
        self.java.returns["saveBitmap"] = 1
        self.assertTrue(self.b.save_bitmap("bmp", "/b.jpg", 80.0))
        self.assertEqual(self.last(), ("saveBitmap", ("bmp", "/b.jpg", 80)))

    def test_ocr_and_onnx(self):
        self.java.returns["ocr"] = "[]"
        self.assertEqual(self.b.ocr("bmp", 5.0, 6.0, "word"), "[]")
        self.assertEqual(self.last(), ("ocr", ("bmp", 5, 6, "word")))
        self.b.ocr_warmup()
        self.assertEqual(self.last(), ("ocrWarmup", ()))
        self.java.returns["onnxLoad"] = "h1"
        self.assertEqual(self.b.onnx_load("/m.onnx"), "h1")
        self.java.returns["onnxRun"] = [7, 8]
        self.assertEqual(self.b.onnx_run("h1", "images", "[1,3]", b"\x01", "argmax"), b"\x07\x08")
        self.assertEqual(self.last(), ("onnxRun", ("h1", "images", "[1,3]", ("jarray", "jbyte", b"\x01"), "argmax")))
        self.java.returns["onnxRun"] = None
        self.assertEqual(self.b.onnx_run("h1", "images", "[1]", b""), b"")
        self.b.onnx_close("h1")
        self.assertEqual(self.last(), ("onnxClose", ("h1",)))

    def test_ui_system_control_events_log(self):
        self.java.returns.update(ui="w1", uiPoll="", system="ok", control="{}", pollEvent="", dumpTree="{}")
        self.assertEqual(self.b.ui("win_create", {"html": "<b>中</b>"}), "w1")
        name, (op, payload) = self.last()
        self.assertEqual(json.loads(payload), {"html": "<b>中</b>"})
        self.assertIn("中", payload)  # ensure_ascii=False: the Java side gets real characters
        self.b.ui("canvas_clear")
        self.assertEqual(self.last(), ("ui", ("canvas_clear", "{}")))
        self.b.ui_poll(1, 250.0)
        self.assertEqual(self.last(), ("uiPoll", ("1", 250)))
        self.b.system("vibrate", {"ms": 100})
        self.assertEqual(json.loads(self.last()[1][1]), {"ms": 100})
        self.b.system("clipboard_get")
        self.assertEqual(self.last(), ("system", ("clipboard_get", "")))
        self.b.control("float_show", {"x": 0.5})
        self.assertEqual(json.loads(self.last()[1][1]), {"x": 0.5})
        self.b.control("status", "")
        self.assertEqual(self.last(), ("control", ("status", "")))
        self.b.poll_event(100.0)
        self.assertEqual(self.last(), ("pollEvent", (100,)))
        self.b.dump_tree(True)
        self.assertEqual(self.last(), ("dumpTree", (1,)))
        self.b.append_log("stderr", 5)
        self.assertEqual(self.last(), ("appendLog", ("stderr", "5")))


class MissingJavaTest(unittest.TestCase):
    """On a PC (or when the Java class can't load) every call is a harmless 'unavailable' answer."""

    def test_load_falls_back_without_java(self):
        """Any failure to reach the Java class (no Chaquopy, class missing) gives the inert stand-in."""
        def no_java():
            raise ImportError("No module named 'com.xscript'")
        saved = bridge_mod._JavaBridge
        bridge_mod._JavaBridge = no_java
        try:
            self.assertIsInstance(bridge_mod._load(), bridge_mod._MissingJava)
        finally:
            bridge_mod._JavaBridge = saved

    def test_every_call_is_inert(self):
        m = bridge_mod._MissingJava()
        self.assertFalse(m.available)
        for call in (lambda: m.click(1, 2, 3), lambda: m.swipe(1, 2, 3, 4, 5), lambda: m.gesture([]),
                     lambda: m.touch(0, 1, 2, 3), lambda: m.global_action("home"), lambda: m.click_node("0"),
                     lambda: m.set_text("0", "x"), lambda: m.node_action("0", "click"), lambda: m.input_text("x"),
                     lambda: m.is_accessibility_on(), lambda: m.save_bitmap(None, "/x")):
            self.assertIs(call(), False)
        self.assertEqual(json.loads(m.dump_tree(2)), {"mode": 2, "roots": []})
        self.assertEqual(m.capture_to_file("/x"), "")
        self.assertEqual(m.capture_raw(), b"")
        self.assertEqual(m.bitmap_to_raw(None), b"")
        self.assertEqual(m.onnx_run("h", "n", "[]", b""), b"")
        for v in (m.capture_bitmap(), m.raw_to_bitmap(b""), m.load_bitmap("/x"), m.ocr_warmup(), m.onnx_close("h"),
                  m.append_log("stdout", "x")):
            self.assertIsNone(v)
        self.assertEqual(m.ocr(None), "[]")
        self.assertIn("error", json.loads(m.onnx_load("/m.onnx")))
        for v in (m.ui("toast"), m.ui_poll("1", 0), m.system("x"), m.control("x"), m.poll_event(0)):
            self.assertEqual(v, "")

    def test_on_device_reflects_module_bridge(self):
        saved = bridge_mod.bridge
        try:
            bridge_mod.bridge = bridge_mod._MissingJava()
            self.assertFalse(bridge_mod.on_device())
            bridge_mod.bridge = types.SimpleNamespace(available=True)
            self.assertTrue(bridge_mod.on_device())
        finally:
            bridge_mod.bridge = saved


if __name__ == "__main__":
    unittest.main()
