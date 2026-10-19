"""ONNX model sessions (the inference engine behind `yolo` and PaddleOCR).

    from xscript.android import onnx
    s = onnx.Session("/sdcard/models/best.onnx")
    out = s.run(tensor)                 # {output_name: float32 ndarray}

On the device, inference runs in ONNX Runtime (Java) inside the script process; tensors
cross the Java/Python boundary as raw little-endian float32 bytes. On a PC the same class
uses the `onnxruntime` Python package when it is installed, so pipelines can be tested
against real models before they go to the phone.
"""

import json
import os
import struct

from xscript.runtime.bridge import bridge

try:
    import numpy as np
except Exception:  # pragma: no cover - numpy ships in the APK
    np = None


class OnnxError(RuntimeError):
    pass


class _DeviceBackend(object):
    """ONNX Runtime for Android, reached through Bridge.onnx*."""

    def __init__(self, path, threads, accel):
        raw = bridge.onnx_load(path, json.dumps({"threads": int(threads), "accel": accel or ""}))
        info = json.loads(raw or "{}")
        if info.get("error"):
            raise OnnxError(info["error"])
        self.handle = info["handle"]
        self.inputs = info.get("inputs") or []
        self.outputs = info.get("outputs") or []
        self.metadata = info.get("metadata") or {}

    def run(self, name, tensor, reduce=""):
        tensor = np.ascontiguousarray(tensor, dtype="<f4")
        raw = bridge.onnx_run(self.handle, name, json.dumps(list(tensor.shape)), tensor.tobytes(), reduce)
        return _unpack(raw)

    def close(self):
        if self.handle:
            bridge.onnx_close(self.handle)
            self.handle = None


class _PcBackend(object):
    """`onnxruntime` Python package (PC tests and tools)."""

    def __init__(self, path, threads, accel):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        if threads:
            opts.intra_op_num_threads = int(threads)
        self._s = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
        self.inputs = [{"name": i.name, "shape": [d if isinstance(d, int) else -1 for d in i.shape]}
                       for i in self._s.get_inputs()]
        self.outputs = [{"name": o.name, "shape": [d if isinstance(d, int) else -1 for d in o.shape]}
                        for o in self._s.get_outputs()]
        self.metadata = dict(self._s.get_modelmeta().custom_metadata_map)
        self.handle = "pc"

    def run(self, name, tensor, reduce=""):
        names = [o["name"] for o in self.outputs]
        res = self._s.run(names, {name: np.ascontiguousarray(tensor, dtype=np.float32)})
        out = {n: np.asarray(r) for n, r in zip(names, res)}
        return _argmax(out) if reduce == "argmax" else out

    def close(self):
        self._s = None


def _unpack(raw):
    """Bridge reply: u32 header length, JSON header, then each output's bytes back to back.

    Header: {"outputs": [{"name", "shape", "dtype": "f32"|"i64"}], "error"?}.
    """
    if not raw or len(raw) < 4:
        raise OnnxError("empty inference result")
    raw = bytes(raw)
    (n,) = struct.unpack("<I", raw[:4])
    header = json.loads(raw[4:4 + n].decode("utf-8"))
    if header.get("error"):
        raise OnnxError(header["error"])
    off = 4 + n
    out = {}
    for o in header.get("outputs", []):
        shape = [int(d) for d in o["shape"]]
        dtype = "<i8" if o.get("dtype") == "i64" else "<f4"
        count = 1
        for d in shape:
            count *= d
        size = count * (8 if dtype == "<i8" else 4)
        out[o["name"]] = np.frombuffer(raw, dtype=dtype, count=count, offset=off).reshape(shape)
        off += size
    return out


def _argmax(outputs):
    """Same reduction the device does natively: `<name>:idx` / `<name>:max` over the last axis."""
    red = {}
    for n, arr in outputs.items():
        if arr.dtype.kind == "f" and arr.ndim:
            red[n + ":idx"] = arr.argmax(axis=-1).astype(np.int64)
            red[n + ":max"] = arr.max(axis=-1).astype(np.float32)
        else:
            red[n] = arr
    return red


def available():
    """True when a backend can run models here (always on the device; PC needs onnxruntime)."""
    if bridge.available:
        return True
    try:
        import onnxruntime  # noqa: F401
        return True
    except Exception:
        return False


class Session(object):
    """One loaded model. `threads` = CPU threads (0 = runtime default).

    `accel`: "" (CPU, default) or "nnapi" (Android NNAPI; falls back to CPU if the device
    rejects the model).
    """

    def __init__(self, path, threads=4, accel=""):
        if np is None:
            raise OnnxError("numpy is required")
        path = os.path.abspath(str(path))
        if not os.path.isfile(path):
            raise OnnxError("model not found: %s" % path)
        self.path = path
        if bridge.available:
            self._b = _DeviceBackend(path, threads, accel)
        else:
            try:
                self._b = _PcBackend(path, threads, accel)
            except ImportError:
                raise OnnxError("ONNX inference needs the device, or `pip install onnxruntime` on a PC")

    @property
    def inputs(self):
        """[{"name", "shape"}]; dynamic dimensions are -1."""
        return self._b.inputs

    @property
    def outputs(self):
        return self._b.outputs

    @property
    def metadata(self):
        """Custom metadata of the model (Ultralytics stores names / imgsz / stride here)."""
        return self._b.metadata

    def run(self, tensor, input_name=None, reduce=""):
        """Run with one float32 input. Returns {output_name: ndarray} in output order.

        reduce="argmax": each float output becomes `<name>:idx` (int64) and `<name>:max`
        (float32) over its last axis, computed next to the model. Use it for classifier
        and CTC outputs with many classes; it avoids copying the full score tensor.
        """
        name = input_name or self.inputs[0]["name"]
        return self._b.run(name, tensor, reduce)

    def run_argmax(self, tensor, input_name=None):
        """(indices, max values) of the first output over its last axis."""
        res = self.run(tensor, input_name, "argmax")
        first = self.outputs[0]["name"]
        return res[first + ":idx"], res[first + ":max"]

    def run_first(self, tensor, input_name=None):
        """First output only."""
        res = self.run(tensor, input_name)
        return res[self.outputs[0]["name"]] if self.outputs[0]["name"] in res else next(iter(res.values()))

    def close(self):
        self._b.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def __repr__(self):
        return "onnx.Session(%r)" % os.path.basename(self.path)


_cache = {}


def load(path, threads=4, accel=""):
    """Cached Session per (path, threads, accel): loading a model costs far more than running it."""
    key = (os.path.abspath(str(path)), int(threads or 0), accel or "")
    s = _cache.get(key)
    if s is None:
        s = Session(path, threads, accel)
        _cache[key] = s
    return s
