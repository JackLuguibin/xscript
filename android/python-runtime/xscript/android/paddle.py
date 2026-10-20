"""PaddleOCR (PP-OCRv5 / v4) text detection + recognition on ONNX.

    from xscript.android import paddle
    for line in paddle.ocr():                         # current screen
        print(line.text, line.confidence, line.rect)
    paddle.ocr_find("确定")                            # first line matching a regex

Models are downloaded on first use into the app's model directory (see
`xscript.android.models`), or pass your own files to `PaddleOcr(det=..., rec=..., keys=...)`.

Pipeline (same as PaddleOCR / RapidOCR):
  det: DBNet probability map → binarise → contours → min-area boxes → unclip
  cls: optional 0°/180° text-line orientation (off by default; screens are rarely upside down)
  rec: SVTR/CRNN at height 48, CTC greedy decode with the model's character list
"""

import math
import os

from xscript.android import image as _img
from xscript.android import onnx as _onnx
from xscript.android.image import OcrResult

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None
try:
    import cv2
except Exception:  # pragma: no cover
    cv2 = None

_MEAN = (0.485, 0.456, 0.406)
_STD = (0.229, 0.224, 0.225)


def _det_resize(img, limit_side_len, limit_type):
    """Resize for DBNet: sides become multiples of 32 within the side limit."""
    h, w = img.shape[:2]
    if limit_type == "max":
        ratio = float(limit_side_len) / max(h, w) if max(h, w) > limit_side_len else 1.0
    else:  # "min": upscale small images so the short side reaches the limit
        ratio = float(limit_side_len) / min(h, w) if min(h, w) < limit_side_len else 1.0
    # Keep very tall screenshots (e.g. 1080x2400) inside a sane budget.
    if max(h, w) * ratio > 2400:
        ratio = 2400.0 / max(h, w)
    rh = max(32, int(round(h * ratio / 32.0)) * 32)
    rw = max(32, int(round(w * ratio / 32.0)) * 32)
    return cv2.resize(img, (rw, rh)), rh / float(h), rw / float(w)


def _normalize(img, mean, std):
    x = img.astype(np.float32) / 255.0
    x -= np.asarray(mean, np.float32)
    x /= np.asarray(std, np.float32)
    return x.transpose(2, 0, 1)[None]


def _box_score(pred, box):
    """Mean probability inside the (rotated) box, like PaddleOCR's box_score_fast/slow."""
    h, w = pred.shape
    pts = box.copy()
    xmin = int(np.clip(np.floor(pts[:, 0].min()), 0, w - 1))
    xmax = int(np.clip(np.ceil(pts[:, 0].max()), 0, w - 1))
    ymin = int(np.clip(np.floor(pts[:, 1].min()), 0, h - 1))
    ymax = int(np.clip(np.ceil(pts[:, 1].max()), 0, h - 1))
    mask = np.zeros((ymax - ymin + 1, xmax - xmin + 1), np.uint8)
    pts[:, 0] -= xmin
    pts[:, 1] -= ymin
    cv2.fillPoly(mask, [pts.astype(np.int32)], 1)
    return float(cv2.mean(pred[ymin:ymax + 1, xmin:xmax + 1], mask)[0])


def _order_points(pts):
    """4 points → clockwise from top-left."""
    pts = pts[np.argsort(pts[:, 0])]
    left, right = pts[:2], pts[2:]
    tl, bl = left[np.argsort(left[:, 1])]
    tr, br = right[np.argsort(right[:, 1])]
    return np.array([tl, tr, br, bl], np.float32)


def _unclip(box, ratio):
    """Grow a rotated rectangle by area*ratio/perimeter on every side.

    PaddleOCR offsets the polygon with pyclipper; for the rectangles DBNet produces this is
    the same outward offset, without the rounded corners.
    """
    rect = cv2.minAreaRect(box.astype(np.float32))
    (cx, cy), (w, h), angle = rect
    area = w * h
    peri = 2 * (w + h)
    if peri <= 0:
        return None
    d = area * ratio / peri
    return (cx, cy), (w + 2 * d, h + 2 * d), angle


def detect_boxes(pred, src_h, src_w, thresh=0.3, box_thresh=0.6, unclip_ratio=1.5, max_candidates=1000,
                 min_size=3, dilate=False):
    """DB post-processing: probability map [H, W] → list of 4x2 boxes in source pixels."""
    bitmap = (pred > thresh).astype(np.uint8)
    if dilate:
        bitmap = cv2.dilate(bitmap, np.ones((2, 2), np.uint8))
    found = cv2.findContours(bitmap * 255, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    contours = found[0] if len(found) == 2 else found[1]
    ph, pw = pred.shape
    sx, sy = src_w / float(pw), src_h / float(ph)
    boxes, scores = [], []
    for c in contours[:max_candidates]:
        rect = cv2.minAreaRect(c)
        if min(rect[1]) < min_size:
            continue
        pts = cv2.boxPoints(rect)
        score = _box_score(pred, pts)
        if score < box_thresh:
            continue
        grown = _unclip(pts, unclip_ratio)
        if grown is None or min(grown[1]) < min_size + 2:
            continue
        pts = _order_points(cv2.boxPoints(grown))
        pts[:, 0] = np.clip(np.round(pts[:, 0] * sx), 0, src_w)
        pts[:, 1] = np.clip(np.round(pts[:, 1] * sy), 0, src_h)
        boxes.append(pts)
        scores.append(score)
    return boxes, scores


def sort_boxes(boxes):
    """Reading order: top to bottom, left to right within a line (10 px tolerance)."""
    items = sorted(boxes, key=lambda b: (b[0][1], b[0][0]))
    for i in range(len(items) - 1):
        for j in range(i, -1, -1):
            if abs(items[j + 1][0][1] - items[j][0][1]) < 10 and items[j + 1][0][0] < items[j][0][0]:
                items[j], items[j + 1] = items[j + 1], items[j]
            else:
                break
    return items


def crop_box(img, box):
    """Perspective-crop a text box; tall crops are rotated to horizontal."""
    w = int(max(np.linalg.norm(box[0] - box[1]), np.linalg.norm(box[2] - box[3])))
    h = int(max(np.linalg.norm(box[0] - box[3]), np.linalg.norm(box[1] - box[2])))
    w, h = max(w, 1), max(h, 1)
    dst = np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float32)
    m = cv2.getPerspectiveTransform(box.astype(np.float32), dst)
    crop = cv2.warpPerspective(img, m, (w, h), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)
    if h / float(w) >= 1.5:
        crop = np.rot90(crop)
    return np.ascontiguousarray(crop)


def ctc_decode(probs, chars):
    """[T, C] probabilities → (text, confidence). Index 0 is the CTC blank."""
    return ctc_decode_argmax(probs.argmax(axis=1), probs.max(axis=1), chars)


def ctc_decode_argmax(idx, conf, chars):
    """CTC greedy decode from per-step best class `idx` [T] and its probability `conf` [T]."""
    out, scores, prev = [], [], -1
    for i, c in enumerate(idx):
        if c != prev and c != 0 and c < len(chars):
            out.append(chars[c])
            scores.append(conf[i])
        prev = c
    return "".join(out), float(np.mean(scores)) if scores else 0.0


def load_chars(keys=None, metadata=None, use_space=True):
    """Character list: blank + keys file (or the model's `character` metadata) + space."""
    if keys:
        with open(keys, "r", encoding="utf-8") as f:
            lines = [ln.rstrip("\r\n") for ln in f]
    elif metadata and metadata.get("character"):
        lines = metadata["character"].split("\n")
    else:
        raise ValueError("recognition model has no character list; pass keys=<dict.txt>")
    while lines and lines[-1] == "":
        lines.pop()
    chars = ["blank"] + lines
    if use_space:
        chars.append(" ")
    return chars


class PaddleOcr(object):
    """det / rec / cls: .onnx paths (cls optional). keys: dictionary .txt (optional when the
    rec model embeds its `character` list, as the RapidOCR exports do).
    """

    def __init__(self, det, rec, keys=None, cls=None, threads=4, limit_side_len=960, limit_type="max",
                 thresh=0.3, box_thresh=0.6, unclip_ratio=1.5, rec_batch=6, accel="", rec_workers=None):
        if cv2 is None or np is None:
            raise RuntimeError("PaddleOCR needs numpy and OpenCV")
        self.det = _onnx.load(det, threads, accel)
        # Recognition runs line batches concurrently: ONNX Runtime scales poorly past ~2 intra-op
        # threads on these small inputs, while independent single-thread runs keep every core busy
        # (measured ~1.7x on a 4-core emulator). The rec session gets threads // workers each.
        self.rec_workers = _rec_workers(threads, rec_workers)
        self.rec = _onnx.load(rec, self._worker_threads(threads), accel)
        # The orientation classifier is batched the same way (one split per worker).
        self.cls = _onnx.load(cls, self._worker_threads(threads), accel) if cls else None
        self.chars = load_chars(keys, self.rec.metadata)
        self.limit_side_len = int(limit_side_len)
        self.limit_type = limit_type
        self.thresh, self.box_thresh, self.unclip_ratio = thresh, box_thresh, unclip_ratio
        self.rec_batch = max(1, int(rec_batch))
        shape = self.rec.inputs[0]["shape"] if self.rec.inputs else [-1, 3, 48, -1]
        self.rec_h = shape[2] if len(shape) == 4 and shape[2] > 0 else 48

    # ---- stages

    def detect(self, img):
        resized, _, _ = _det_resize(img, self.limit_side_len, self.limit_type)
        pred = self.det.run_first(_normalize(resized, _MEAN, _STD))
        pred = pred.reshape(pred.shape[-2:])
        boxes, _ = detect_boxes(pred, img.shape[0], img.shape[1], self.thresh, self.box_thresh, self.unclip_ratio)
        return sort_boxes(boxes)

    def classify(self, crops, threshold=0.9):
        """Flip crops the orientation model calls 180° (with confidence > threshold)."""
        if self.cls is None or not crops:
            return crops
        shape = self.cls.inputs[0]["shape"]
        ch, cw = (shape[2], shape[3]) if len(shape) == 4 and shape[2] > 0 else (80, 160)
        batch = np.concatenate([_normalize(cv2.resize(c, (cw, ch)), _MEAN, _STD) for c in crops])
        parts = np.array_split(batch, min(len(crops), getattr(self, "rec_workers", 1)))
        probs = np.concatenate(self._map(self.cls.run_first, parts))
        out = []
        for c, p in zip(crops, probs):
            out.append(cv2.rotate(c, cv2.ROTATE_180) if p.argmax() == 1 and p.max() > threshold else c)
        return out

    def recognize(self, crops):
        """[(text, confidence)] for BGR line crops."""
        if not crops:
            return []
        ratios = [c.shape[1] / float(max(c.shape[0], 1)) for c in crops]
        order = np.argsort(ratios)
        size = self.rec_batch
        if self.rec_workers > 1:
            # Enough batches for every worker; similar widths stay together (less padding).
            size = max(1, min(size, int(math.ceil(len(crops) / float(self.rec_workers)))))
        groups = [order[s:s + size] for s in range(0, len(crops), size)]
        results = [None] * len(crops)

        def work(idx):
            best, conf = self.rec.run_argmax(self._rec_batch(crops, ratios, idx))
            for k, i in enumerate(idx):
                results[i] = ctc_decode_argmax(best[k], conf[k], self.chars)

        self._map(work, groups)
        return results

    def _worker_threads(self, threads):
        """Intra-op threads per session when `rec_workers` runs share the cores."""
        return max(1, int(threads) // self.rec_workers) if threads else 0

    def _map(self, fn, items):
        """[fn(item)] in order; concurrent when there are several items and workers."""
        workers = min(getattr(self, "rec_workers", 1), len(items))
        if workers <= 1:
            return [fn(i) for i in items]
        # A pool per call: idle worker threads must not outlive the call, because the
        # script runner waits for non-daemon threads before it reports a script finished.
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(workers, thread_name_prefix="xs-paddle") as ex:
            return list(ex.map(fn, items))

    def _rec_batch(self, crops, ratios, idx):
        h = self.rec_h
        max_ratio = max(max(ratios[i] for i in idx), 320.0 / h)
        width = int(math.ceil(h * max_ratio))
        batch = np.zeros((len(idx), 3, h, width), np.float32)
        for k, i in enumerate(idx):
            rw = min(width, max(1, int(math.ceil(h * ratios[i]))))
            r = cv2.resize(crops[i], (rw, h)).astype(np.float32) / 255.0
            batch[k, :, :, :rw] = ((r - 0.5) / 0.5).transpose(2, 0, 1)
        return batch

    # ---- full pipeline

    def ocr(self, image=None, rect=None, confidence=0.5, use_cls=None):
        """Text lines as [OcrResult] (same type ML Kit OCR returns), in screen coordinates."""
        src = _img.to_bgr(image) if image is not None else _img.capture_bgr()
        if src is None:
            return []
        if src.ndim == 2:
            src = cv2.cvtColor(src, cv2.COLOR_GRAY2BGR)
        elif src.shape[2] == 4:
            src = src[:, :, :3]
        ox = oy = 0
        rect = _img._norm_rect(rect)
        if rect:
            l, t, r, b = rect
            src = src[t:b, l:r]
            ox, oy = l, t
        if src.size == 0:
            return []
        boxes = self.detect(src)
        crops = [crop_box(src, b) for b in boxes]
        if use_cls or (use_cls is None and self.cls is not None):
            crops = self.classify(crops)
        texts = self.recognize(crops)
        out = []
        for box, (text, conf) in zip(boxes, texts):
            if not text or conf < confidence:
                continue
            xs, ys = box[:, 0] + ox, box[:, 1] + oy
            out.append(OcrResult({
                "text": text,
                "confidence": conf,
                "rect": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
                "points": [[int(x), int(y)] for x, y in zip(xs, ys)],
            }))
        return out


def _rec_workers(threads, requested):
    """Concurrent recognition batches: explicit value, else one per thread (at most 4 and cores)."""
    if requested is not None:
        return max(1, int(requested))
    if not threads:
        return 1
    return max(1, min(int(threads), 4, os.cpu_count() or 1))


_default = {"engine": None, "key": None}

# Detection post-processing that each model family was tuned with (PaddleOCR inference.yml).
VERSION_DEFAULTS = {
    "v6t": {"thresh": 0.2, "box_thresh": 0.4, "unclip_ratio": 1.4},
    "v6s": {"thresh": 0.2, "box_thresh": 0.4, "unclip_ratio": 1.4},
}

# OCR engine name (screen.ocr / set_ocr_engine) -> model version.
ENGINES = {"paddle": "v5", "paddle_v4": "v4", "paddle_v6t": "v6t", "paddle_v6s": "v6s"}
AUTO = "auto"
AUTO_VERSION = "v6t"
_auto = {"failed": None}


def engine(version="v5", **kwargs):
    """The default PaddleOcr, built from the managed models (downloaded on first use)."""
    from xscript.android import models

    key = (version, tuple(sorted(kwargs.items())))
    if _default["engine"] is None or _default["key"] != key:
        files = models.paddle(version)
        opts = dict(VERSION_DEFAULTS.get(version, {}))
        opts.update(kwargs)
        _default["engine"] = PaddleOcr(files["det"], files["rec"], keys=files.get("keys"), cls=files.get("cls"),
                                       **opts)
        _default["key"] = key
    return _default["engine"]


def _run_engine(name, image, rect, confidence, mlkit):
    """OCR with engine `name` ("mlkit", "auto" or a key of ENGINES); `mlkit()` runs ML Kit.

    "auto" uses PP-OCRv6 tiny and falls back to ML Kit (with one warning) when its models
    cannot be downloaded or loaded.
    """
    if name == "mlkit":
        return mlkit()
    if name == AUTO:
        if _auto["failed"] is None:
            try:
                eng = engine(AUTO_VERSION)
            except Exception as e:  # offline, no onnxruntime, ...
                _auto["failed"] = str(e)
                print("xscript: ocr engine auto: PP-OCRv6 unavailable (%s), using ML Kit" % e)
            else:
                return eng.ocr(image, rect, confidence)
        return mlkit()
    version = ENGINES.get(name)
    if version is None:
        raise ValueError("unknown OCR engine %r (use mlkit, auto, %s)" % (name, ", ".join(sorted(ENGINES))))
    return engine(version).ocr(image, rect, confidence)


def ocr(rect=None, image=None, confidence=0.5, version="v5"):
    return engine(version).ocr(image, rect, confidence)


def ocr_find(pattern, rect=None, image=None, confidence=0.5):
    hits = _img.ocr_filter(ocr(rect, image, confidence), pattern)
    return hits[0] if hits else None


def ocr_find_all(pattern, rect=None, image=None, confidence=0.5):
    return _img.ocr_filter(ocr(rect, image, confidence), pattern)
