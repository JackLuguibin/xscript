"""PP-OCRv6 packs (v6t / v6s): download layout, dictionary from inference.yml, engine selection."""
import os
import shutil
import tempfile
import unittest
from unittest import mock

try:
    import cv2  # noqa: F401
    import numpy as np
    from xscript.android import models, paddle, screen
    from xscript.runtime import vision
except ImportError:  # pragma: no cover
    paddle = None

YML = """Global:
  model_name: PP-OCRv6_tiny_rec
PostProcess:
  name: CTCLabelDecode
  character_dict:
  - '!'
  - ''''
  - '"'
  - '1'
  - 'y'
  - 中
  - 文
"""


@unittest.skipIf(paddle is None, "numpy/cv2 not installed")
class ModelsV6Test(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {"XSCRIPT_MODELS": self.dir})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.dir)

    def test_packs_pin_local_names_and_dict(self):
        for v in ("v6t", "v6s"):
            pack = models.PADDLE[v]
            self.assertEqual(set(pack), {"det", "rec", "dict"})
            self.assertEqual([pack[r][3] for r in ("det", "rec", "dict")], ["det.onnx", "rec.onnx", "rec.yml"])
            for spec in pack.values():
                self.assertEqual(len(spec[1]), 64)
            self.assertEqual(len(models.PADDLE_MIRRORS[v]), 2)

    def test_paddle_v6_urls_names_and_keys(self):
        calls = []

        def fake_fetch(url, name, sha256=None, mirrors=None, timeout=60, progress=None, urls=None):
            calls.append((name, urls, sha256))
            target = models.path(name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as f:
                f.write(YML if name.endswith(".yml") else "onnx")
            return target

        with mock.patch.object(models, "fetch", side_effect=fake_fetch):
            files = models.paddle("v6t")
        self.assertEqual(sorted(files), ["det", "keys", "rec"])
        self.assertTrue(files["det"].endswith(os.path.join("paddle", "v6t", "det.onnx")))
        self.assertTrue(files["rec"].endswith(os.path.join("paddle", "v6t", "rec.onnx")))
        names = [c[0] for c in calls]
        self.assertEqual(sorted(names), sorted(os.path.join("paddle", "v6t", n) for n in ("det.onnx", "rec.onnx", "rec.yml")))
        det_urls = [c[1] for c in calls if c[0].endswith("det.onnx")][0]
        self.assertEqual(det_urls, [
            "https://www.modelscope.cn/models/PaddlePaddle/PP-OCRv6_tiny_det_onnx/resolve/master/inference.onnx",
            "https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx/resolve/main/inference.onnx"])
        with open(files["keys"], encoding="utf-8") as f:
            self.assertEqual(f.read().split("\n")[:-1], ["!", "'", '"', "1", "y", "中", "文"])
        chars = paddle.load_chars(files["keys"])
        self.assertEqual(chars[0], "blank")
        self.assertEqual(chars[-1], " ")
        self.assertEqual(len(chars), 7 + 2)  # = rec output classes (dict + blank + space)

    def test_v5_still_uses_rapidocr_mirrors(self):
        seen = []
        with mock.patch.object(models, "fetch", side_effect=lambda *a, **k: seen.append(k.get("urls")) or "x"):
            files = models.paddle("v5", with_cls=False)
        self.assertEqual(sorted(files), ["det", "rec"])
        self.assertEqual(seen, [None, None])

    def test_keys_from_yml_cached_and_validated(self):
        yml = os.path.join(self.dir, "rec.yml")
        with open(yml, "w", encoding="utf-8") as f:
            f.write(YML)
        keys = models.keys_from_yml(yml)
        st = os.stat(keys).st_mtime_ns
        with mock.patch("yaml.safe_load", side_effect=AssertionError("re-parsed")):
            self.assertEqual(models.keys_from_yml(yml), keys)
        self.assertEqual(os.stat(keys).st_mtime_ns, st)
        bad = os.path.join(self.dir, "bad.yml")
        with open(bad, "w") as f:
            f.write("PostProcess:\n  name: CTCLabelDecode\n")
        with self.assertRaises(ValueError):
            models.keys_from_yml(bad, os.path.join(self.dir, "bad.txt"))

    def test_fetch_tries_explicit_urls_in_order(self):
        tried = []

        def fake_download(url, target, sha, timeout, progress):
            tried.append(url)
            if "first" in url:
                raise IOError("boom")
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w") as f:
                f.write("ok")

        with mock.patch.object(models, "_download", side_effect=fake_download), mock.patch("builtins.print"):
            out = models.fetch("ignored", "x/y.bin", urls=["https://first/a", "https://second/a"])
        self.assertEqual(tried, ["https://first/a", "https://second/a"])
        self.assertTrue(os.path.isfile(out))


@unittest.skipIf(paddle is None, "numpy/cv2 not installed")
class EngineSelectionTest(unittest.TestCase):
    def setUp(self):
        paddle._default.update(engine=None, key=None)
        paddle._auto["failed"] = None
        self.built = []

        class FakeOcr(object):
            def __init__(inner, det, rec, keys=None, cls=None, **kw):
                inner.args = dict(det=det, rec=rec, keys=keys, cls=cls, **kw)
                self.built.append(inner.args)

            def ocr(inner, image, rect, confidence):
                return [("paddle", inner.args["det"], confidence)]

        self.p1 = mock.patch.object(paddle, "PaddleOcr", FakeOcr)
        self.p2 = mock.patch.object(models, "paddle", side_effect=lambda v: {"det": v + "/det", "rec": v + "/rec",
                                                                              "keys": v + "/keys"})
        self.p1.start()
        self.p2.start()

    def tearDown(self):
        self.p1.stop()
        self.p2.stop()
        paddle._default.update(engine=None, key=None)
        paddle._auto["failed"] = None
        screen.set_ocr_engine("mlkit")

    def test_v6_gets_its_postprocess_defaults_and_kwargs_win(self):
        paddle.engine("v6s")
        self.assertEqual((self.built[-1]["thresh"], self.built[-1]["box_thresh"], self.built[-1]["unclip_ratio"]),
                         (0.2, 0.4, 1.4))
        self.assertEqual(self.built[-1]["keys"], "v6s/keys")
        paddle.engine("v6s", thresh=0.5)
        self.assertEqual(self.built[-1]["thresh"], 0.5)
        paddle.engine("v5")
        self.assertNotIn("thresh", self.built[-1])

    def test_engine_names_map_to_versions(self):
        for name, version in (("paddle", "v5"), ("paddle_v4", "v4"), ("paddle_v6t", "v6t"), ("paddle_v6s", "v6s")):
            out = paddle._run_engine(name, "img", None, 0.5, lambda: self.fail("mlkit"))
            self.assertEqual(out, [("paddle", version + "/det", 0.5)])
        self.assertEqual(paddle._run_engine("mlkit", "img", None, 0.5, lambda: ["mk"]), ["mk"])
        with self.assertRaises(ValueError):
            paddle._run_engine("tesseract", "img", None, 0.5, lambda: [])

    def test_auto_uses_v6_tiny(self):
        out = paddle._run_engine("auto", "img", None, 0.5, lambda: self.fail("mlkit"))
        self.assertEqual(out, [("paddle", "v6t/det", 0.5)])

    def test_auto_falls_back_to_mlkit_once(self):
        models.paddle.side_effect = IOError("offline")
        with mock.patch("builtins.print") as pr:
            self.assertEqual(paddle._run_engine("auto", "img", None, 0.5, lambda: ["mk"]), ["mk"])
            self.assertEqual(paddle._run_engine("auto", "img", None, 0.5, lambda: ["mk2"]), ["mk2"])
        self.assertEqual(models.paddle.call_count, 1)
        self.assertEqual(pr.call_count, 1)
        self.assertIn("offline", paddle._auto["failed"])

    def test_screen_routes_engines(self):
        for name in screen.OCR_ENGINES:
            screen.set_ocr_engine(name)
        with self.assertRaises(ValueError):
            screen.set_ocr_engine("paddle_v7")
        out = screen.ocr(image="img", engine="paddle_v6t")
        self.assertEqual(out, [("paddle", "v6t/det", 0.5)])
        screen.set_ocr_engine("auto")
        self.assertEqual(screen.ocr(image="img", confidence=0.7), [("paddle", "v6t/det", 0.7)])

    def test_screen_auto_fallback_filters_mlkit_confidence(self):
        models.paddle.side_effect = IOError("offline")
        lines = [mock.Mock(confidence=0.9), mock.Mock(confidence=0.2)]
        with mock.patch.object(screen._img, "ocr", return_value=lines), mock.patch("builtins.print"):
            self.assertEqual(screen.ocr(image="img", engine="auto", confidence=0.5), lines[:1])

    def test_vision_ocr_engines(self):
        src = np.zeros((10, 10, 3), np.uint8)
        line = mock.Mock(text="HI", confidence=0.9)
        line.to_dict.return_value = {"text": "HI"}
        with mock.patch.object(paddle, "_run_engine", return_value=[line]) as run:
            self.assertEqual(vision._ocr(src, {"engine": "paddle_v6s"}, None), {"lines": [{"text": "HI"}]})
        self.assertEqual(run.call_args[0][0], "paddle_v6s")
        with mock.patch.object(vision._img, "ocr", return_value=[line]):
            models.paddle.side_effect = IOError("offline")
            with mock.patch("builtins.print"):
                self.assertEqual(vision._ocr(src, {"engine": "auto"}, None)["lines"], [{"text": "HI"}])


if __name__ == "__main__":
    unittest.main()
