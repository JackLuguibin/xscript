"""ascript.android.screen, screen.color_tools and xscript.android.screen against a fake device with a known screen."""

import base64
import contextlib
import io
import json
import os
import tempfile
import unittest

import cv2
import numpy as np

from fake_device import FakeBitmap, FakeDevice, make_screen, patch_bridge

RED = "#ff0000"
WHITE = "#ffffff"


class ScreenCase(unittest.TestCase):
    def setUp(self):
        self.screen = make_screen()
        self.dev = FakeDevice(self.screen)
        self.undo = patch_bridge(self.dev)
        from ascript.android import screen

        self.s = screen
        self.tmp = tempfile.mkdtemp(prefix="xs-screen-")

    def tearDown(self):
        self.s.cache(False)
        self.undo()
        for f in os.listdir(self.tmp):
            os.remove(os.path.join(self.tmp, f))
        os.rmdir(self.tmp)

    def path(self, name):
        return os.path.join(self.tmp, name)

    def patterned(self):
        """Put a unique noise patch at (10..30, 60..70) on the screen; returns the 14x24 template around it."""
        rng = np.random.RandomState(7)
        self.screen[60:70, 10:30] = rng.randint(0, 255, (10, 20, 3), dtype=np.uint8)
        self.dev.screen = self.screen
        return self.screen[58:72, 8:32].copy()  # center (20, 65)


class CaptureTest(ScreenCase):
    def test_capture_formats(self):
        s = self.s
        bmp = s.capture()
        self.assertIsInstance(bmp, FakeBitmap)
        self.assertEqual((bmp.getWidth(), bmp.getHeight()), (120, 80))
        cv = s.capture(pixel_format=s.FORMAT_CV_MAT)
        np.testing.assert_array_equal(cv, self.screen)
        rgba = s.capture(pixel_format=s.FORMAT_IMAGE_DATA)
        self.assertEqual(rgba.shape, (80, 120, 4))
        self.assertEqual(tuple(rgba[15, 25]), (255, 0, 0, 255))
        pil = s.capture(20, 10, 30, 20, pixel_format=s.FORMAT_PIL_IMAGE)
        self.assertEqual(pil.size, (10, 10))
        self.assertEqual(pil.getpixel((0, 0)), (255, 0, 0))

    def test_region_capture(self):
        s = self.s
        np.testing.assert_array_equal(s.capture_cv(60, 40, 70, 50), self.screen[40:50, 60:70])
        self.assertEqual(s.capture_bitmap(0, 0, 10, 5).getWidth(), 10)
        self.assertEqual(s.capture_pil().size, (120, 80))

    def test_capture_retries_then_gives_up(self):
        self.dev.fail_captures = 2
        self.assertIsNotNone(self.s.capture())
        self.dev.fail_captures = 3
        self.assertIsNone(self.s.capture())

    def test_cache_freezes_frame(self):
        s = self.s
        first = s.cache(True)
        self.assertIsInstance(first, FakeBitmap)
        calls = self.dev.capture_calls
        self.dev.screen = np.zeros_like(self.screen)  # the "phone" changes...
        self.assertIs(s.capture(), first)  # ...but the cached frame is returned as is
        np.testing.assert_array_equal(s.capture_cv(), self.screen)
        self.assertEqual(s.capture(20, 10, 30, 20).bgr[0, 0].tolist(), [0, 0, 255])  # regions come from the cache too
        self.assertEqual(self.dev.capture_calls, calls)
        s.reset_capture()
        self.assertFalse(s.is_cacheing)
        self.assertEqual(int(s.capture_cv().max()), 0)

    def test_cache_from_file_and_bitmap(self):
        s = self.s
        p = self.path("frame.png")
        img = np.full((8, 8, 3), 200, np.uint8)
        cv2.imwrite(p, img)
        s.cache(True, file=p)
        np.testing.assert_array_equal(s.capture_cv(), img)
        s.cache(True, bitmap=FakeBitmap(img[:4, :4]))
        self.assertEqual(s.capture_cv().shape, (4, 4, 3))
        cvf = s.cache(True, pixel_format=s.FORMAT_CV_MAT)
        self.assertIsInstance(cvf, np.ndarray)

    def test_bitmap_file_round_trip(self):
        s = self.s
        p = s.bitmap_to_file(self.path("a.png"))
        self.assertTrue(os.path.isfile(p))
        back = s.file_to_bitmap(p)
        np.testing.assert_array_equal(back.bgr, self.screen)
        q = s.bitmap_to_file(self.path("b.jpg"), self.screen[:10, :10], quality=90)
        self.assertTrue(os.path.getsize(q) > 0)
        self.dev.fail_captures = 3
        self.assertIsNone(s.bitmap_to_file(self.path("c.png")))

    def test_conversions(self):
        s = self.s
        bmp = s.capture()
        b64 = s.bitmap_base64(bmp)
        back = s.base64_bitmap(b64)
        np.testing.assert_array_equal(back.bgr, self.screen)
        self.assertTrue(base64.b64decode(s.bitmap_base64(bmp, mode=1)).startswith(b"\xff\xd8"))  # JPEG
        small = s.bitmap_maxside(bmp, 60)
        self.assertEqual((small.getWidth(), small.getHeight()), (60, 40))
        same = s.bitmap_maxside(bmp)
        self.assertEqual(same.getWidth(), 120)
        pil = s.bitmap_to_pilimage(bmp)
        self.assertEqual(pil.getpixel((25, 15)), (255, 0, 0))
        np.testing.assert_array_equal(s.bitmap_to_cvimage(bmp), self.screen)
        self.assertEqual(s.hex_to_bgr("#102030"), (0x30, 0x20, 0x10))
        self.assertIsNone(s._ensure_bitmap(None))
        self.assertIs(s._ensure_bitmap(bmp), bmp)
        self.assertIsInstance(s._ensure_bitmap(self.screen), FakeBitmap)

    def test_orientation_listener_and_rbuild(self):
        s = self.s
        seen = []
        s.set_ori_change_listener(lambda w, h: seen.append((w, h)))
        s.on_ori_change(1080, 2400)
        s.set_ori_change_listener(None)
        s.on_ori_change(1, 1)
        self.assertEqual(seen, [(1080, 2400)])
        self.assertIsNone(s.rbuild())


class ColorTest(ScreenCase):
    def test_color_object(self):
        C = self.s.Color
        c = C.from_hex("#ff8000")
        self.assertEqual((c.a, c.r, c.g, c.b, c.rgb, c.argb), (255, 255, 128, 0, "#ff8000", "#ffff8000"))
        self.assertEqual(json.loads(str(c))["rgb"], "#ff8000")
        self.assertEqual(C.from_hex("80112233").a, 0x80)
        self.assertEqual(C.from_hex("bad").color, 0)
        self.assertEqual(C.make(1, 2, 3).argb, "#ff010203")
        self.assertAlmostEqual(C.distance(C.make(0, 0, 0), C.make(3, 4, 0)), 5.0)
        self.assertTrue(C.similar(C.make(0, 0, 0), C.make(3, 4, 0), 5))
        self.assertFalse(C.similar(C.make(0, 0, 0), C.make(30, 40, 0)))
        self.assertEqual(C(-1).argb, "#ffffffff")  # Java ints are signed

    def test_get_color(self):
        s = self.s
        self.assertEqual(s.get_color(25, 15).rgb, RED)
        self.assertEqual(s.get_color(0, 0, self.screen).rgb, "#1e1e1e")
        self.assertIsNone(s.get_color(500, 500))
        self.assertIs(s.get_colors(self.screen), self.screen)

    def test_count(self):
        s = self.s
        self.assertEqual(s.get_color_num(RED), 100)
        self.assertEqual(s.Colors.count("0,0,%s|0,0,%s" % (RED, WHITE)), 200)
        self.assertEqual(s.Colors.count(RED, rect=[0, 0, 25, 80], image=self.screen), 50)
        res = s.Colors(WHITE).run(self.screen)
        self.assertEqual(res.data, 100)

    def test_find_colors(self):
        F = self.s.FindColors
        p = F.find("20,10,%s|29,19,%s" % (RED, RED))
        self.assertEqual((p.x, p.y), (20, 10))
        self.assertIsNone(F.find("0,0,#123456", image=self.screen))
        pts = F.find_all("0,0,#00ff00", space=1)
        self.assertEqual(sorted((q.x, q.y) for q in pts), [(100, 5), (105, 5)])
        self.assertEqual(len(F.find_all("0,0,#00ff00", space=10)), 1)  # space merges close hits
        self.assertEqual(F.find_color(WHITE, rect=[50, 30, 120, 80]), {"x": 60, "y": 40})
        self.assertIsNone(F.find_color("#123456"))
        self.assertEqual(len(F.find_all_color("#00ff00", diff=0.98)), 1)  # default space=5 merges the pair
        self.assertIsNone(F.find_all_color("#123456"))
        r = F("0,0," + WHITE).run(self.screen)
        self.assertEqual(r.data[0], {"x": 60, "y": 40})

    def test_find_colors_until_polls_the_screen(self):
        F = self.s.FindColors
        self.dev.screen = np.zeros_like(self.screen)
        calls = {"n": 0}
        orig = self.dev.capture_raw

        def appearing(*a):
            calls["n"] += 1
            if calls["n"] == 3:
                self.dev.screen = self.screen
            return orig(*a)
        self.dev.capture_raw = appearing
        p = F.find("0,0," + RED, until=2000)
        self.assertEqual((p.x, p.y), (20, 10))
        self.assertGreaterEqual(calls["n"], 3)

    def test_find_colors_bad_input_prints_and_returns_none(self):
        F = self.s.FindColors
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertIsNone(F.find("not a color"))
            self.assertIsNone(F.find_all("not a color"))
        self.assertTrue(out.getvalue().strip())

    def test_compare_colors(self):
        C = self.s.CompareColors
        good = "25,15,%s|65,45,%s" % (RED, WHITE)
        bad = "25,15,%s|65,45,%s" % (WHITE, RED)
        self.assertTrue(C.compare(good))
        self.assertFalse(C.compare(bad, image=self.screen))
        self.assertEqual(C.compare_multi([bad, good]), 1)
        self.assertEqual(C.compare_multi([bad]), -1)
        self.assertTrue(C(good).run(self.screen).data)

    def test_find_block(self):
        B = self.s.FindBlock
        hit = B.find(RED, width=10, height=10, count=100)
        self.assertEqual(hit["rect"], [20, 10, 30, 20])
        self.assertEqual((hit["x"], hit["y"], hit["count"]), (25, 15, 100))
        both = B.find_all("0,0,%s|0,0,%s" % (RED, WHITE), 10, 10, 100)
        self.assertEqual(sorted(h["rect"][0] for h in both), [20, 60])
        self.assertEqual(B.find_all(WHITE, 10, 10, 100, rect=[0, 0, 50, 80]), [])
        self.assertIsNone(B.find("#123456", 5, 5, 1))
        self.assertEqual(B.find_all("", 5, 5, 1), [])
        self.assertEqual(B.count_block("0,0,%s|0,0,#00ff00" % RED, min_area=1), 3)
        self.assertEqual(B.count_block("0,0,%s|0,0,#00ff00" % RED, min_area=10), 1)
        self.assertEqual(B.count_block(""), 0)
        self.assertEqual(B.get_range(WHITE), [60, 40, 70, 50])
        self.assertEqual(B.get_range(WHITE, rect=[55, 35, 120, 80]), [60, 40, 70, 50])
        self.assertIsNone(B.get_range("#123456"))
        self.assertEqual(B(RED, 10, 10, 100).run(self.screen).data[0]["count"], 100)


class ColorToolsTest(ScreenCase):
    def test_parse_and_relative(self):
        from ascript.android.screen import color_tools as ct

        self.assertEqual(ct.hex_to_rgb("#0a0b0c"), [10, 11, 12])
        pts = ct.ana_colors("10,20,#ff0000|15,25,#00ff00-101010")
        self.assertEqual([(p.x, p.y, p.rgb) for p in pts], [(10, 20, [255, 0, 0]), (15, 25, [0, 255, 0])])
        self.assertIsNone(pts[0].diff)
        self.assertEqual(pts[1].diff, [16, 16, 16])
        self.assertEqual(json.loads(repr(pts[0])), {"x": 10, "y": 20, "rgb": [255, 0, 0]})
        rel = ct.ana_colors_r("10,20,#ff0000|15,25,#00ff00|8,20,#0000ff")
        self.assertEqual([(p.x, p.y) for p in rel], [(10, 20), (5, 5), (-2, 0)])

    def test_find_colors_screen_and_pil(self):
        from PIL import Image

        from ascript.android.screen import color_tools as ct

        hits = ct.find_colors("0,0," + RED)
        self.assertEqual((hits[0].x, hits[0].y), (20, 10))
        self.assertEqual(len(hits), 4)  # space=5 keeps one hit per 5px in the 10x10 block
        self.assertEqual(len(ct.find_colors("0,0," + RED, space=10)), 1)
        pil = Image.fromarray(self.screen[:, :, ::-1].copy())
        self.assertEqual(len(ct.find_colors("0,0,#00ff00", image=pil, space=1, num=1)), 1)
        self.assertEqual(len(ct.find_colors("0,0,#00ff00", image=pil, space=1)), 2)
        self.assertEqual(ct.find_colors("0,0,#123456", diff=(0, 0, 0)), [])


class FindImagesAndCodeTest(ScreenCase):
    def test_template(self):
        F = self.s.FindImages
        tpl = self.patterned()
        hit = F.find(tpl)
        self.assertEqual((hit["center_x"], hit["center_y"]), (20, 65))
        self.assertGreater(hit["confidence"], 0.99)
        p = self.path("tpl.png")
        cv2.imwrite(p, tpl)
        self.assertEqual(F.find_template(p, source_img=self.screen)["center_x"], 20)
        self.assertEqual(len(F.find_all(tpl)), 1)
        self.assertEqual(F.find_sift(tpl)["center_y"], 65)
        self.assertEqual(len(F.find_all_sift(tpl)), 1)
        self.assertIsNone(F.find(tpl, rect=[0, 0, 40, 40]))
        np.testing.assert_array_equal(F.search_image(p), tpl)
        self.assertEqual(F(tpl).run(self.screen).data[0]["center_x"], 20)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(F.find(tpl, method="smart")["center_x"], 20)

    def test_template_error_is_none(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertIsNone(self.s.FindImages.find_all_template(self.path("missing.png")))

    def test_code_scanner(self):
        S = self.s.CodeScanner
        self.assertIsNone(S.scan())
        # A pre-made QR code: the phone's OpenCV 4.5 can read QR codes but has no encoder to make one here.
        img = cv2.imread(os.path.join(os.path.dirname(__file__), "data", "qr_xscript.png"))
        self.assertEqual(S.scan(image=img), ["xscript"])
        self.assertIsNone(S.scan(rect=[0, 0, 30, 30], image=img))
        self.assertEqual(S().run(img).data, ["xscript"])

    def test_eraser(self):
        E = self.s.Eraser
        out = E.wipe([20, 10, 30, 20], cv_img=self.screen, new_color=WHITE)
        self.assertEqual(out[15, 25].tolist(), [255, 255, 255])
        self.assertEqual(self.screen[15, 25].tolist(), [0, 0, 255])  # input untouched
        p = self.path("e.png")
        cv2.imwrite(p, self.screen)
        self.assertEqual(E.wipe([0, 0, 5, 5], img_file=p)[0, 0].tolist(), [0, 0, 0])
        self.assertEqual(E([60, 40, 70, 50]).run(self.screen).image[45, 65].tolist(), [0, 0, 0])

    def test_yolo_paths(self):
        s = self.s
        with self.assertRaises(ValueError):
            s._yolo_path("")
        d = self.tmp
        with self.assertRaises(FileNotFoundError):
            s._yolo_path(d)
        open(self.path("b.onnx"), "w").close()
        open(self.path("a.onnx"), "w").close()
        self.assertEqual(s._yolo_path(d), self.path("a.onnx"))
        self.assertEqual(s._yolo_path(self.path("a.param")), self.path("a.onnx"))
        with self.assertRaises(NotImplementedError):
            s._yolo_path(self.path("z.bin"))
        self.assertEqual(s._yolo_path("/m/best.onnx"), "/m/best.onnx")
        self.assertIsNone(s._yolo_names(""))
        self.assertIsNone(s._yolo_names(d))
        with open(self.path("classes.txt"), "w", encoding="utf-8") as f:
            f.write("cat\n\n狗\n")
        self.assertEqual(s._yolo_names(self.path("a.onnx")), ["cat", "狗"])
        open(self.path("data.yaml"), "w").close()
        self.assertEqual(s._yolo_names(d), self.path("data.yaml"))

    def test_yolo_dict(self):
        from types import SimpleNamespace

        d = SimpleNamespace(rect=[10, 20, 50, 60], label="cat", class_id=0, confidence=0.8, center_x=30, center_y=40)
        self.assertEqual(self.s._yolo_dict(d), {"label": "cat", "class_id": 0, "prob": 0.8, "confidence": 0.8,
                                                "x": 10, "y": 20, "w": 40, "h": 40, "rect": [10, 20, 50, 60],
                                                "center_x": 30, "center_y": 40})

    def test_unknown_attribute(self):
        self.assertTrue(hasattr(self.s, "MatrixFont"))
        with self.assertRaises(AttributeError):
            self.s.NoSuchThing  # noqa: B018


class OcrTest(ScreenCase):
    def setUp(self):
        super().setUp()
        self.dev.ocr_lines = [("确定 OK", [10, 10, 50, 20], 0.95), ("取消", [60, 10, 90, 20], 0.4),
                              ("价格 12 元", [10, 40, 80, 50], 0.9)]
        self.s.Ocr.set_engine(self.s.Ocr.MODE_MLK)

    def test_find_and_find_all(self):
        O = self.s.Ocr
        self.assertEqual(O.find("确定")["center_x"], 30)
        self.assertEqual(O.find(r"\d+")["text"], "12")  # AScript: text becomes the regex match
        self.assertEqual(len(O.find_all()), 3)
        self.assertIsNone(O.find("nothing"))
        self.assertIsNone(O.find_all("nothing"))
        self.assertTrue(O.exists("取消"))
        self.assertEqual(O.mlkitocr_v2(pattern="OK")[0].text, "OK")

    def test_rect_offsets_are_screen_coordinates(self):
        O = self.s.Ocr
        hit = O.find("确定", rect=[100, 30, 120, 60])
        self.assertEqual(hit["rect"], [110, 40, 150, 50])  # fake OCR returns rect-relative boxes, shifted by dx/dy
        _, dx, dy = self.dev.ocr_images[-1]
        self.assertEqual((dx, dy), (100, 30))

    def test_image_sources(self):
        O = self.s.Ocr
        O.find("确定", image=self.screen)
        self.assertIsInstance(self.dev.ocr_images[-1][0], FakeBitmap)
        O.find("确定", image=self.screen, binary=100)
        bw = self.dev.ocr_images[-1][0].bgr
        self.assertEqual(set(np.unique(bw)), {0, 255})

    def test_wait_click_and_wait_click_alias(self):
        from xscript.android import action

        O = self.s.Ocr
        clicks = []
        orig = action.bridge
        action.bridge = self.dev
        self.dev.click = lambda x, y, dur: clicks.append((x, y)) or True
        try:
            self.assertTrue(O.click("确定"))
            self.assertTrue(O.wait_click("取消", timeout=1))
            self.assertFalse(O.click("nothing"))
            self.assertFalse(O.click("nothing", timeout=0.05))
        finally:
            action.bridge = orig
        self.assertEqual(clicks, [(30, 15), (75, 15)])

    def test_tess_and_dict_helpers(self):
        O = self.s.Ocr
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(len(O.tess()), 3)
        rows = O.octtext_to_dict(O._raw())
        self.assertEqual((rows[0]["x"], rows[0]["y"]), (30, 15))
        self.assertEqual(O.octtext_to_dict([{"center_x": 1, "center_y": 2}])[0]["x"], 1)
        self.assertEqual(O.octtext_to_dict(None), [])
        self.assertEqual(O._result_to_dict(O._raw()[0])["text"], "确定 OK")
        self.assertEqual(len(O(pattern="确定").run(self.screen).data), 1)

    def test_paddle_mode_routes_to_paddle_engine(self):
        from xscript.android import paddle

        seen = []

        class FakeEngine(object):
            def ocr(self, image, rect, conf):
                seen.append((rect, conf))
                return []
        orig = paddle.engine
        paddle.engine = lambda ver: FakeEngine()
        try:
            self.assertIsNone(self.s.Ocr.paddleocr(rect=[0, 0, 10, 10], confidence=0.7))
            self.s.Ocr.set_engine(self.s.Ocr.MODE_PADDLE_V5)
            self.assertIsNone(self.s.Ocr.find("x"))
        finally:
            paddle.engine = orig
        self.assertEqual(seen, [([0, 0, 10, 10], 0.7), (None, 0.0)])


class XScriptScreenTest(ScreenCase):
    def setUp(self):
        super().setUp()
        from xscript.android import screen as xs

        self.x = xs
        self.dev.ocr_lines = [("确定", [10, 10, 50, 20], 0.95), ("low", [0, 30, 20, 40], 0.2)]

    def tearDown(self):
        self.x.set_ocr_engine(self.x.OCR_MLKIT)
        super().tearDown()

    def test_capture_helpers(self):
        x = self.x
        p = x.capture(self.path("c.png"))
        self.assertTrue(os.path.isfile(p))
        self.assertEqual(x.capture_cv([20, 10, 30, 20])[0, 0].tolist(), [0, 0, 255])
        self.assertEqual(x.capture_bitmap([0, 0, 5, 5]).getWidth(), 5)
        self.assertEqual(x.capture_bitmap().getWidth(), 120)
        self.assertEqual(x.capture_pil().getpixel((25, 15)), (255, 0, 0))
        self.assertEqual(x.size(), (120, 80))
        self.assertEqual(x.get_color(25, 15), RED)
        self.assertIsNone(x.get_color(999, 999))
        np.testing.assert_array_equal(x.imread(p), self.screen)

    def test_capture_unavailable(self):
        from xscript.runtime import bridge as bridge_mod

        undo = patch_bridge(bridge_mod._MissingJava())
        try:
            self.assertIsNone(self.x.capture())
            self.assertIsNone(self.x.capture_pil())
            self.assertEqual(self.x.size(), (0, 0))
        finally:
            undo()

    def test_cache(self):
        x = self.x
        self.assertTrue(x.cache(True))
        self.dev.screen = np.zeros_like(self.screen)
        self.assertEqual(x.get_color(25, 15), RED)
        self.assertIsNone(x.cache(False))
        self.assertEqual(x.get_color(25, 15), "#000000")

    def test_colors_and_images(self):
        x = self.x
        self.assertTrue(x.compare_colors("25,15," + RED))
        self.assertEqual(x.find_colors("0,0," + WHITE).x, 60)
        self.assertIsNone(x.find_colors("0,0,#123456"))
        self.assertEqual(len(x.find_all_colors("0,0,#00ff00", space=1)), 2)
        tpl = self.patterned()
        self.assertEqual(x.find_image(tpl)["center_x"], 20)
        other = np.random.RandomState(99).randint(0, 255, (8, 8, 3), dtype=np.uint8)
        self.assertIsNone(x.find_image(other))
        self.assertEqual(len(x.find_all_images(tpl)), 1)

    def test_ocr_engine_choice_and_confidence(self):
        x = self.x
        self.assertEqual(len(x.ocr()), 2)
        self.assertEqual([r.text for r in x.ocr(confidence=0.5)], ["确定"])
        with self.assertRaises(ValueError):
            x.set_ocr_engine("tesseract")
        from xscript.android import paddle

        seen = []
        orig = paddle.engine
        paddle.engine = lambda ver: type("E", (), {"ocr": lambda self, img, rect, conf: seen.append((ver, conf)) or []})()
        try:
            x.set_ocr_engine(x.OCR_PADDLE)
            x.ocr()
            x.ocr(engine=x.OCR_PADDLE_V4, confidence=0.1)
        finally:
            paddle.engine = orig
        self.assertEqual(seen, [("v5", 0.5), ("v4", 0.1)])

    def test_ocr_find_wait_click(self):
        from xscript.android import action

        x = self.x
        self.assertEqual(x.ocr_find("确定").center_x, 30)
        self.assertIsNone(x.ocr_find("nope"))
        self.assertEqual(len(x.ocr_find_all(".")), 2)
        self.assertIsNone(x.ocr_wait("nope", timeout=0.05, interval=0.01))
        clicks = []
        orig = action.bridge
        action.bridge = self.dev
        self.dev.click = lambda px, py, dur: clicks.append((px, py)) or True
        try:
            self.assertTrue(x.ocr_click("确定"))
            self.assertTrue(x.ocr_click("确定", timeout=1))
            self.assertFalse(x.ocr_click("nope"))
        finally:
            action.bridge = orig
        self.assertEqual(clicks, [(30, 15), (30, 15)])


if __name__ == "__main__":
    unittest.main()
