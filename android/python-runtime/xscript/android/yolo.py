"""YOLO object detection (Ultralytics YOLOv5 / v8 / v11 and end-to-end exports) on ONNX.

    from xscript.android import yolo
    model = yolo.load(R.res("best.onnx"))          # class names come from the model metadata
    for d in model.detect(conf=0.5):               # current screen
        print(d.label, d.confidence, d.rect, d.center_x, d.center_y)

Train with Ultralytics on the dataset exported by the 标注工具, then export ONNX:

    yolo detect train data=data.yaml model=yolo11n.pt imgsz=640
    yolo export model=runs/detect/train/weights/best.pt format=onnx imgsz=640

Supported output layouts (detected from the output shape):
  * v8 / v11 / v12:  [1, 4 + nc, N]  (cx, cy, w, h, class scores)
  * v5:              [1, N, 5 + nc]  (cx, cy, w, h, objectness, class scores)
  * end-to-end:      [1, N, 6]       (x1, y1, x2, y2, score, class) - v10, yolo26, nms=True exports
"""

import ast
import os

from xscript.android import image as _img
from xscript.android import onnx as _onnx

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None
try:
    import cv2
except Exception:  # pragma: no cover
    cv2 = None


class Detection(object):
    """One detected object. Attribute and dict access (`d.label`, `d["label"]`)."""

    __slots__ = ("class_id", "label", "confidence", "rect", "center_x", "center_y")

    def __init__(self, class_id, label, confidence, rect):
        self.class_id = int(class_id)
        self.label = label
        self.confidence = float(confidence)
        self.rect = [int(round(v)) for v in rect]
        self.center_x = (self.rect[0] + self.rect[2]) // 2
        self.center_y = (self.rect[1] + self.rect[3]) // 2

    @property
    def width(self):
        return self.rect[2] - self.rect[0]

    @property
    def height(self):
        return self.rect[3] - self.rect[1]

    def to_dict(self):
        return {
            "class_id": self.class_id,
            "label": self.label,
            "confidence": round(self.confidence, 4),
            "rect": list(self.rect),
            "center_x": self.center_x,
            "center_y": self.center_y,
        }

    def __getitem__(self, key):
        return self.to_dict()[key]

    def get(self, key, default=None):
        return self.to_dict().get(key, default)

    def click(self):
        from xscript.android import action

        return action.click(self.center_x, self.center_y)

    def __repr__(self):
        return "Detection(%r, %.2f, %s)" % (self.label, self.confidence, self.rect)


def _parse_names(value):
    """Ultralytics metadata `names` ("{0: 'a', 1: 'b'}"), a list, a dict, or a data.yaml path."""
    if value is None:
        return None
    if isinstance(value, str) and os.path.isfile(value):
        import yaml

        with open(value, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return _parse_names(data.get("names"))
    if isinstance(value, str):
        try:
            value = ast.literal_eval(value)
        except Exception:
            return [s.strip() for s in value.split(",") if s.strip()]
    if isinstance(value, dict):
        n = max(int(k) for k in value) + 1 if value else 0
        return [str(value.get(i, value.get(str(i), i))) for i in range(n)]
    return [str(v) for v in value]


def _parse_imgsz(value):
    if not value:
        return None
    if isinstance(value, str):
        try:
            value = ast.literal_eval(value)
        except Exception:
            return None
    if isinstance(value, int):
        return value, value
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return int(value[0]), int(value[1])
    return None


def letterbox(img, size, stride=32, auto=False, color=114):
    """Resize keeping aspect ratio and pad to `size` (h, w). Returns (padded, scale, (pad_x, pad_y))."""
    h, w = img.shape[:2]
    th, tw = size
    s = min(th / float(h), tw / float(w))
    nw, nh = int(round(w * s)), int(round(h * s))
    if auto:  # pad only to the next stride multiple (dynamic-shape models)
        tw = int(np.ceil(nw / float(stride)) * stride)
        th = int(np.ceil(nh / float(stride)) * stride)
    if (nw, nh) != (w, h):
        img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    px, py = (tw - nw) / 2.0, (th - nh) / 2.0
    top, left = int(round(py - 0.1)), int(round(px - 0.1))
    bottom, right = th - nh - top, tw - nw - left
    out = cv2.copyMakeBorder(img, top, bottom, left, right, cv2.BORDER_CONSTANT, value=(color, color, color))
    return out, s, (left, top)


def nms(boxes, scores, iou=0.45):
    """Greedy NMS over [N, 4] xyxy boxes. Returns kept indices, best first."""
    if len(boxes) == 0:
        return np.zeros((0,), np.int64)
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = np.maximum(0, x2 - x1) * np.maximum(0, y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(x1[i], x1[rest])
        yy1 = np.maximum(y1[i], y1[rest])
        xx2 = np.minimum(x2[i], x2[rest])
        yy2 = np.minimum(y2[i], y2[rest])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        ov = inter / (areas[i] + areas[rest] - inter + 1e-9)
        order = rest[ov <= iou]
    return np.asarray(keep, np.int64)


def decode(output, conf=0.25, iou=0.45, classes=None, max_det=300, nc=None, agnostic=False):
    """Raw model output → (boxes xyxy in network pixels, scores, class ids)."""
    out = np.asarray(output, dtype=np.float32)
    if out.ndim == 3:
        out = out[0]
    if out.ndim != 2:
        raise ValueError("unexpected YOLO output shape %s" % (np.asarray(output).shape,))
    rows, cols = out.shape
    end2end = False
    if cols == 6 and rows > 6 and (nc is None or nc != 2):
        end2end = True
    elif rows == 6 and cols > 6 and (nc is None or nc != 2):
        out = out.T
        end2end = True
    if end2end:
        boxes, scores, cls = out[:, :4], out[:, 4], out[:, 5].astype(np.int64)
        m = scores >= conf
        if classes is not None:
            m &= np.isin(cls, list(classes))
        idx = np.argsort(-scores[m])[:max_det]
        return boxes[m][idx], scores[m][idx], cls[m][idx]

    # v8/v11 are channel-first [4 + nc, N]; v5 is [N, 5 + nc]. With a known class count the
    # channel axis is the one of size nc + 4 / nc + 5; otherwise anchors outnumber channels.
    pred, v5 = None, False
    if nc is not None:
        for arr, ch_axis_first in ((out, True), (out, False)):
            ch = arr.shape[0] if ch_axis_first else arr.shape[1]
            if ch in (nc + 4, nc + 5):
                pred = arr.T if ch_axis_first else arr
                v5 = ch == nc + 5
                break
    if pred is None:
        pred = out.T if rows < cols else out
        v5 = rows > cols  # [N, C] is the v5 export layout
    if v5:
        obj = pred[:, 4:5]
        cls_scores = pred[:, 5:] * obj
    else:
        cls_scores = pred[:, 4:]
    cls = cls_scores.argmax(axis=1)
    scores = cls_scores[np.arange(len(cls)), cls]
    m = scores >= conf
    if classes is not None:
        m &= np.isin(cls, list(classes))
    xywh, scores, cls = pred[m, :4], scores[m], cls[m]
    boxes = np.empty_like(xywh)
    boxes[:, 0] = xywh[:, 0] - xywh[:, 2] / 2
    boxes[:, 1] = xywh[:, 1] - xywh[:, 3] / 2
    boxes[:, 2] = xywh[:, 0] + xywh[:, 2] / 2
    boxes[:, 3] = xywh[:, 1] + xywh[:, 3] / 2
    # Class-aware NMS by shifting each class into its own coordinate range.
    shift = 0 if agnostic else cls[:, None].astype(np.float32) * 8192.0
    keep = nms(boxes + shift, scores, iou)[:max_det]
    return boxes[keep], scores[keep], cls[keep]


class Yolo(object):
    """A loaded detector.

    names:  class names; default from the model metadata (Ultralytics exports carry them),
            or a list, a {id: name} dict, or a data.yaml path.
    imgsz:  network input (h, w) or an int; default from the metadata / input shape / 640.
    """

    def __init__(self, path, names=None, imgsz=None, threads=4, accel=""):
        if cv2 is None or np is None:
            raise RuntimeError("YOLO needs numpy and OpenCV")
        self.session = _onnx.load(path, threads, accel)
        meta = self.session.metadata or {}
        self.names = _parse_names(names) or _parse_names(meta.get("names")) or []
        size = _parse_imgsz(imgsz) or _parse_imgsz(meta.get("imgsz"))
        shape = self.session.inputs[0]["shape"] if self.session.inputs else []
        self.dynamic = not (len(shape) == 4 and shape[2] > 0 and shape[3] > 0)
        if size is None:
            size = (shape[2], shape[3]) if not self.dynamic else (640, 640)
        self.imgsz = (int(size[0]), int(size[1]))
        self.stride = int(meta.get("stride") or 32)
        self.task = meta.get("task", "detect")
        if self.task not in ("detect", ""):
            raise RuntimeError("only detection models are supported (this model is %r)" % self.task)

    @property
    def nc(self):
        return len(self.names) or None

    def label(self, class_id):
        return self.names[class_id] if 0 <= class_id < len(self.names) else str(class_id)

    def detect(self, image=None, rect=None, conf=0.25, iou=0.45, classes=None, max_det=300, agnostic=False):
        """Detect on `image` (None = capture the screen; ndarray / Bitmap / PIL / path).

        rect: [l, t, r, b] region; results stay in full-image coordinates.
        classes: keep only these class ids or labels.
        Returns [Detection] sorted by confidence.
        """
        src = _img.to_bgr(image) if image is not None else _img.capture_bgr()
        if src is None:
            return []
        ox = oy = 0
        rect = _img._norm_rect(rect)
        if rect:
            l, t, r, b = rect
            src = src[t:b, l:r]
            ox, oy = l, t
        if src.ndim == 2:
            src = cv2.cvtColor(src, cv2.COLOR_GRAY2BGR)
        elif src.shape[2] == 4:
            src = src[:, :, :3]
        h, w = src.shape[:2]
        padded, s, (px, py) = letterbox(src, self.imgsz, self.stride)
        blob = padded[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        out = self.session.run_first(blob)
        if classes is not None:
            classes = [self.names.index(c) if isinstance(c, str) and c in self.names else c for c in classes]
        boxes, scores, cls = decode(out, conf, iou, classes, max_det, self.nc, agnostic)
        res = []
        for box, score, c in zip(boxes, scores, cls):
            x1 = min(max((box[0] - px) / s, 0), w) + ox
            y1 = min(max((box[1] - py) / s, 0), h) + oy
            x2 = min(max((box[2] - px) / s, 0), w) + ox
            y2 = min(max((box[3] - py) / s, 0), h) + oy
            if x2 - x1 < 1 or y2 - y1 < 1:
                continue
            res.append(Detection(int(c), self.label(int(c)), float(score), (x1, y1, x2, y2)))
        return res

    def find(self, label=None, **kwargs):
        """Best detection (optionally of `label`), or None."""
        hits = self.detect(**kwargs)
        if label is not None:
            hits = [d for d in hits if d.label == label or d.class_id == label]
        return hits[0] if hits else None

    def __repr__(self):
        return "Yolo(%r, classes=%d, imgsz=%s)" % (os.path.basename(self.session.path), len(self.names), self.imgsz)


_models = {}


def load(path, names=None, imgsz=None, threads=4, accel=""):
    """Load (and cache) a detector. `path` is an .onnx file."""
    key = (os.path.abspath(str(path)), str(names), str(imgsz), accel)
    m = _models.get(key)
    if m is None:
        m = Yolo(path, names=names, imgsz=imgsz, threads=threads, accel=accel)
        _models[key] = m
    return m
