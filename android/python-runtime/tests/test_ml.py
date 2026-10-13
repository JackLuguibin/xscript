"""YOLO decoding, PaddleOCR post-processing, the ONNX bridge framing and AScript plugin shims.

The synthetic tests always run. Real-model tests run when XSCRIPT_TEST_MODELS points at a
folder with yolo11n.onnx / ch_PP-OCRv5_*.onnx (and bus.jpg) and onnxruntime is installed.
"""

import json
import os
import struct
import sys
import tempfile
import unittest

try:
    import cv2
    import numpy as np
except Exception:  # pragma: no cover
    np = None

MODELS = os.environ.get("XSCRIPT_TEST_MODELS", "")


def _has_ort():
    try:
        import onnxruntime  # noqa: F401
        return True
    except Exception:
        return False


@unittest.skipIf(np is None, "numpy/cv2 not installed")
class YoloDecodeTest(unittest.TestCase):
    def test_v8_layout(self):
        from xscript.android import yolo

        # [1, 4 + 2 classes, 3 anchors]: two overlapping class-0 boxes and one class-1 box.
        out = np.zeros((1, 6, 3), np.float32)
        out[0, :4, 0] = [100, 100, 40, 40]
        out[0, 4, 0] = 0.9
        out[0, :4, 1] = [102, 101, 40, 40]
        out[0, 4, 1] = 0.8
        out[0, :4, 2] = [300, 300, 20, 20]
        out[0, 5, 2] = 0.7
        boxes, scores, cls = yolo.decode(out, conf=0.25, iou=0.5, nc=2)
        self.assertEqual(list(cls), [0, 1])
        self.assertAlmostEqual(float(scores[0]), 0.9, places=5)
        np.testing.assert_allclose(boxes[0], [80, 80, 120, 120])

    def test_v5_layout_uses_objectness(self):
        from xscript.android import yolo

        out = np.zeros((1, 4, 7), np.float32)  # [N, 5 + 2]
        out[0, 0] = [50, 50, 10, 10, 0.5, 0.9, 0.1]   # 0.45
        out[0, 1] = [80, 80, 10, 10, 0.1, 0.9, 0.1]   # 0.09 < conf
        boxes, scores, cls = yolo.decode(out, conf=0.25, nc=2)
        self.assertEqual(len(scores), 1)
        self.assertAlmostEqual(float(scores[0]), 0.45, places=5)

    def test_end_to_end_layout(self):
        from xscript.android import yolo

        out = np.zeros((1, 300, 6), np.float32)
        out[0, 0] = [10, 20, 30, 40, 0.8, 3]
        out[0, 1] = [0, 0, 5, 5, 0.1, 1]
        boxes, scores, cls = yolo.decode(out, conf=0.25)
        self.assertEqual(list(cls), [3])
        np.testing.assert_allclose(boxes[0], [10, 20, 30, 40])

    def test_class_filter(self):
        from xscript.android import yolo

        out = np.zeros((1, 6, 2), np.float32)
        out[0, :4, 0] = [10, 10, 4, 4]
        out[0, 4, 0] = 0.9
        out[0, :4, 1] = [50, 50, 4, 4]
        out[0, 5, 1] = 0.9
        _, _, cls = yolo.decode(out, conf=0.25, classes=[1], nc=2)
        self.assertEqual(list(cls), [1])

    def test_letterbox_maps_back(self):
        from xscript.android import yolo

        img = np.zeros((200, 400, 3), np.uint8)
        padded, s, (px, py) = yolo.letterbox(img, (640, 640))
        self.assertEqual(padded.shape[:2], (640, 640))
        self.assertAlmostEqual(s, 1.6)
        self.assertEqual((px, py), (0, 160))

    def test_names_parsing(self):
        from xscript.android import yolo

        self.assertEqual(yolo._parse_names("{0: 'a', 1: 'b'}"), ["a", "b"])
        self.assertEqual(yolo._parse_names(["x", "y"]), ["x", "y"])
        self.assertEqual(yolo._parse_names({1: "b", 0: "a"}), ["a", "b"])
        self.assertEqual(yolo._parse_imgsz("[480, 640]"), (480, 640))


@unittest.skipIf(np is None, "numpy/cv2 not installed")
class PaddlePostTest(unittest.TestCase):
    def test_detect_boxes_finds_blocks(self):
        from xscript.android import paddle

        pred = np.zeros((100, 200), np.float32)
        pred[20:30, 20:120] = 0.95
        pred[60:72, 40:90] = 0.9
        boxes, scores = paddle.detect_boxes(pred, 200, 400)
        self.assertEqual(len(boxes), 2)
        ordered = paddle.sort_boxes(boxes)
        top = ordered[0]
        # Source is 2x the map; the unclipped box covers the block with some margin.
        self.assertLess(top[:, 1].min(), 40)
        self.assertGreater(top[:, 0].max(), 240)

    def test_ctc_decode_collapses_repeats_and_blanks(self):
        from xscript.android import paddle

        chars = ["blank", "a", "b", " "]
        seq = [1, 1, 0, 1, 2, 2, 0, 3]
        probs = np.zeros((len(seq), 4), np.float32)
        for t, c in enumerate(seq):
            probs[t, c] = 0.9
        text, conf = paddle.ctc_decode(probs, chars)
        self.assertEqual(text, "aab ")
        self.assertAlmostEqual(conf, 0.9, places=5)

    def test_load_chars_from_metadata(self):
        from xscript.android import paddle

        chars = paddle.load_chars(metadata={"character": "甲\n乙\n"})
        self.assertEqual(chars, ["blank", "甲", "乙", " "])

    def test_crop_rotates_vertical_text(self):
        from xscript.android import paddle

        img = np.zeros((100, 100, 3), np.uint8)
        box = np.array([[10, 10], [20, 10], [20, 60], [10, 60]], np.float32)
        crop = paddle.crop_box(img, box)
        self.assertGreater(crop.shape[1], crop.shape[0])


@unittest.skipIf(np is None, "numpy not installed")
class OnnxFramingTest(unittest.TestCase):
    def test_unpack(self):
        from xscript.android import onnx

        a = np.arange(6, dtype="<f4").reshape(2, 3)
        b = np.array([7, 8], dtype="<i8")
        header = json.dumps({"outputs": [
            {"name": "a", "shape": [2, 3], "dtype": "f32"},
            {"name": "b", "shape": [2], "dtype": "i64"},
        ]}).encode()
        raw = struct.pack("<I", len(header)) + header + a.tobytes() + b.tobytes()
        out = onnx._unpack(raw)
        np.testing.assert_array_equal(out["a"], a)
        np.testing.assert_array_equal(out["b"], b)

    def test_unpack_error(self):
        from xscript.android import onnx

        header = json.dumps({"error": "boom"}).encode()
        with self.assertRaises(onnx.OnnxError):
            onnx._unpack(struct.pack("<I", len(header)) + header)


class PlugShimTest(unittest.TestCase):
    def tearDown(self):
        for name in ("Yolov8Ncnn", "yolov5"):
            sys.modules.pop(name, None)

    def test_yolo_plugins_import(self):
        from ascript.android import plug

        plug.load("Yolov8Ncnn:1.3")
        import Yolov8Ncnn  # noqa: F401

        self.assertTrue(callable(Yolov8Ncnn.detect))
        plug.load("yolov5")
        import yolov5

        self.assertTrue(callable(yolov5.find_all))

    def test_unknown_plugin(self):
        from ascript.android import plug

        with self.assertRaises(NotImplementedError):
            plug.load("some_paid_plugin:2.0")

    def test_ncnn_files_need_onnx(self):
        from ascript.android.screen import _yolo_path

        d = tempfile.mkdtemp()
        p = os.path.join(d, "m.param")
        open(p, "w").close()
        with self.assertRaises(NotImplementedError):
            _yolo_path(p)
        open(os.path.join(d, "m.onnx"), "w").close()
        self.assertTrue(_yolo_path(p).endswith("m.onnx"))


@unittest.skipUnless(MODELS and np is not None and _has_ort(), "set XSCRIPT_TEST_MODELS and install onnxruntime")
class RealModelTest(unittest.TestCase):
    def test_yolo11_bus(self):
        from xscript.android import yolo

        m = yolo.load(os.path.join(MODELS, "yolo11n.onnx"))
        hits = m.detect(os.path.join(MODELS, "bus.jpg"), conf=0.4)
        labels = sorted(d.label for d in hits)
        self.assertEqual(labels, ["bus", "person", "person", "person"])

    def test_paddle_v5(self):
        from PIL import Image, ImageDraw, ImageFont
        from xscript.android.paddle import PaddleOcr

        font = None
        for f in ("/System/Library/Fonts/STHeiti Medium.ttc", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"):
            if os.path.isfile(f):
                font = ImageFont.truetype(f, 36)
                break
        if font is None:
            self.skipTest("no CJK font")
        img = Image.new("RGB", (800, 240), (250, 250, 250))
        d = ImageDraw.Draw(img)
        d.text((40, 40), "确定 取消", fill=(20, 20, 20), font=font)
        d.text((40, 140), "Hello 2026", fill=(20, 20, 20), font=font)
        bgr = np.asarray(img)[:, :, ::-1].copy()
        e = PaddleOcr(os.path.join(MODELS, "ch_PP-OCRv5_det_mobile.onnx"),
                      os.path.join(MODELS, "ch_PP-OCRv5_rec_mobile.onnx"))
        texts = [r.text for r in e.ocr(bgr)]
        self.assertEqual(texts, ["确定 取消", "Hello 2026"])


if __name__ == "__main__":
    unittest.main()
