import json
import os
import sys
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import cv2  # noqa: F401
    import numpy as np
    from xscript.android import paddle
except ImportError:  # pragma: no cover
    paddle = None


class _FakeRec(object):
    """Deterministic recogniser: class per time step derived from the column means."""

    def __init__(self):
        self.calls = []
        self.threads = set()
        self.lock = threading.Lock()

    def run_argmax(self, batch):
        with self.lock:
            self.calls.append(batch.shape)
            self.threads.add(threading.current_thread().name)
        n, _, _, w = batch.shape
        steps = w // 8
        cols = batch[:, 0, :, :steps * 8].mean(axis=1).reshape(n, steps, 8).mean(axis=2)
        idx = (np.abs(cols) * 9).astype(np.int64) % 5
        return idx, np.full(idx.shape, 0.9, np.float32)


def _engine(workers, batch=6):
    e = paddle.PaddleOcr.__new__(paddle.PaddleOcr)
    e.rec = _FakeRec()
    e.chars = ["blank", "a", "b", "c", "d"]
    e.rec_h = 48
    e.rec_batch = batch
    e.rec_workers = workers
    return e


@unittest.skipIf(paddle is None, "numpy/cv2 not available")
class ParallelRecognizeTest(unittest.TestCase):
    def _crops(self):
        rng = np.random.default_rng(5)
        out = []
        for _ in range(13):
            h = int(rng.integers(30, 80))
            w = int(rng.integers(20, 600))
            out.append(rng.integers(0, 255, (h, w, 3), dtype=np.uint8))
        return out

    def test_results_keep_input_order_and_match_per_line(self):
        crops = self._crops()
        par = _engine(4, batch=1)
        seq = _engine(1, batch=1)
        self.assertEqual(par.recognize(crops), seq.recognize(crops))
        self.assertGreater(len(par.rec.threads), 1)

    def test_batches_split_across_workers(self):
        e = _engine(4)
        e.recognize(self._crops())
        self.assertEqual(sum(s[0] for s in e.rec.calls), 13)
        self.assertEqual(len(e.rec.calls), 4)  # ceil(13 / 4) = 4 per batch

    def test_single_worker_keeps_batch_size(self):
        e = _engine(1)
        e.recognize(self._crops())
        self.assertEqual([s[0] for s in e.rec.calls], [6, 6, 1])

    def test_no_worker_threads_left_behind(self):
        before = {t.ident for t in threading.enumerate()}
        _engine(4).recognize(self._crops())
        after = [t for t in threading.enumerate() if t.ident not in before]
        self.assertEqual([t for t in after if t.is_alive()], [])

    def test_classify_split_matches_single_batch(self):
        class Cls(object):
            inputs = [{"shape": [-1, 3, 80, 160]}]

            def __init__(self):
                self.sizes = []

            def run_first(self, batch):
                self.sizes.append(batch.shape[0])
                m = batch.reshape(batch.shape[0], -1).mean(axis=1)
                return np.stack([m, -m], axis=1)  # class 0 when mean > 0, else 180 degrees

        crops = self._crops()
        outs = []
        for workers in (1, 4):
            e = _engine(workers)
            e.cls = Cls()
            outs.append(e.classify(crops, threshold=-1e9))
            self.assertEqual(sum(e.cls.sizes), len(crops))
            self.assertEqual(len(e.cls.sizes), workers)
        for a, b in zip(*outs):
            self.assertTrue(np.array_equal(a, b))

    def test_empty(self):
        self.assertEqual(_engine(4).recognize([]), [])

    def test_worker_count(self):
        self.assertEqual(paddle._rec_workers(4, 2), 2)
        self.assertEqual(paddle._rec_workers(0, None), 1)
        self.assertGreaterEqual(paddle._rec_workers(4, None), 1)
        self.assertLessEqual(paddle._rec_workers(16, None), 4)


def _models_present():
    try:
        import onnxruntime  # noqa: F401
        from xscript.android import models
    except Exception:
        return False
    return all(os.path.isfile(models.path(os.path.join("paddle", "v5", os.path.basename(rel))))
               for rel, _d, _s in models.PADDLE["v5"].values())


@unittest.skipUnless(paddle is not None and _models_present(), "PP-OCRv5 models / onnxruntime not installed")
class PaddleGoldenTest(unittest.TestCase):
    """Recognised text and boxes must match the outputs recorded before the rec changes."""

    def test_golden(self):
        from paddle_golden_images import images
        with open(os.path.join(HERE, "data", "paddle_v5_golden.json"), encoding="utf-8") as f:
            golden = json.load(f)
        eng = paddle.engine("v5")
        for name, img in images().items():
            got = eng.ocr(img, None, 0.5)
            want = golden[name]
            self.assertEqual([r["text"] for r in got], [w["text"] for w in want], name)
            for r, w in zip(got, want):
                for a, b in zip(r["rect"], w["rect"]):
                    self.assertLessEqual(abs(a - b), 2, (name, w["text"]))
                self.assertAlmostEqual(float(r["confidence"]), w["confidence"], delta=0.02)


if __name__ == "__main__":
    unittest.main()
