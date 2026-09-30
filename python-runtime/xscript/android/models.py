"""Model files for YOLO / PaddleOCR: where they live and how they get there.

    from xscript.android import models
    models.directory()                # model directory on the device
    models.paddle("v5")               # {"det": path, "rec": path, "cls": path}; downloads if missing
    models.fetch(url, "my/best.onnx", sha256="...")

Built-in PaddleOCR packs are the RapidOCR ONNX exports of PP-OCRv5 / v4 (mobile). Their
recognition models embed the character list, so no dictionary file is needed. Downloads go
to a temp file, are checked against the pinned SHA-256, then renamed into place.

Offline devices: copy the files into `models.directory()/paddle/<version>/` with the same names
(for example with `adb push`), or upload them through the HTTP API (`PUT /models/<path>`).
"""

import hashlib
import json
import os
import time

from xscript.runtime.bridge import bridge

MIRRORS = (
    "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master/",
    "https://huggingface.co/SWHL/RapidOCR/resolve/main/",
)

# name -> (path under the mirror, sha256, bytes)
PADDLE = {
    "v5": {
        "det": ("onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx",
                "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae", 4819576),
        "rec": ("onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile.onnx",
                "5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5", 16631306),
        "cls": ("onnx/PP-OCRv5/cls/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx",
                "54379ae5174d026780215fc748a7f31910dee36818e63d49e17dc598ecc82df7", 1018508),
    },
    "v4": {
        "det": ("onnx/PP-OCRv4/det/ch_PP-OCRv4_det_mobile.onnx",
                "d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9", 4745517),
        "rec": ("onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile.onnx",
                "48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b", 10857958),
    },
}


def directory():
    """Model directory: the app's external files dir on the device, ~/.xscript/models on a PC."""
    if bridge.available:
        raw = bridge.system("models_dir", "")
        if raw:
            return raw
    return os.environ.get("XSCRIPT_MODELS") or os.path.join(os.path.expanduser("~"), ".xscript", "models")


def path(*parts):
    return os.path.join(directory(), *parts)


def sha256(file_path):
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _download(url, target, expect_sha=None, timeout=60, progress=None):
    import requests

    tmp = "%s.part%d" % (target, os.getpid())
    os.makedirs(os.path.dirname(target), exist_ok=True)
    h = hashlib.sha256()
    got = 0
    try:
        with requests.get(url, stream=True, timeout=timeout, allow_redirects=True) as r:
            r.raise_for_status()
            total = int(r.headers.get("Content-Length") or 0)
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(1 << 16):
                    if not chunk:
                        continue
                    f.write(chunk)
                    h.update(chunk)
                    got += len(chunk)
                    if progress:
                        progress(got, total)
        digest = h.hexdigest()
        if expect_sha and digest != expect_sha:
            raise IOError("checksum mismatch for %s (got %s)" % (os.path.basename(target), digest[:12]))
        os.replace(tmp, target)
        return target
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def fetch(url, name, sha256=None, mirrors=None, timeout=60, progress=None):
    """Download `url` (or each mirror + `url` if `mirrors` is given) to `directory()/name` unless present.

    An existing file is kept when its checksum matches (or no checksum is given).
    """
    target = path(name)
    if os.path.isfile(target):
        if not sha256 or _checked(target, sha256):
            return target
        os.remove(target)
    urls = [m + url for m in mirrors] if mirrors else [url]
    errors = []
    for u in urls:
        try:
            print("xscript: downloading model %s" % os.path.basename(target))
            started = time.time()
            _download(u, target, sha256, timeout, progress)
            _remember(target, sha256)
            print("xscript: model %s ready (%.1fs)" % (os.path.basename(target), time.time() - started))
            return target
        except Exception as e:  # try the next mirror
            errors.append("%s: %s" % (u.split("/")[2], e))
    raise IOError("model download failed: " + "; ".join(errors))


def _stamp(target):
    return target + ".sha256"


def _checked(target, expect):
    """Verify once, then trust the size+mtime stamp (hashing 16 MB on every run is slow)."""
    st = os.stat(target)
    key = "%d:%d" % (st.st_size, int(st.st_mtime))
    try:
        with open(_stamp(target), "r") as f:
            saved = json.load(f)
        if saved.get("key") == key and saved.get("sha256") == expect:
            return True
    except Exception:
        pass
    if sha256(target) != expect:
        return False
    _remember(target, expect)
    return True


def _remember(target, digest):
    if not digest:
        return
    st = os.stat(target)
    try:
        with open(_stamp(target), "w") as f:
            json.dump({"key": "%d:%d" % (st.st_size, int(st.st_mtime)), "sha256": digest}, f)
    except Exception:
        pass


def paddle(version="v5", with_cls=True, progress=None):
    """PaddleOCR files for `version` ("v5" or "v4"): {"det", "rec", "cls"?} absolute paths."""
    pack = PADDLE.get(version)
    if pack is None:
        raise ValueError("unknown PaddleOCR version %r (use %s)" % (version, ", ".join(sorted(PADDLE))))
    out = {}
    for role, (rel, digest, _size) in pack.items():
        if role == "cls" and not with_cls:
            continue
        out[role] = fetch(rel, os.path.join("paddle", version, os.path.basename(rel)), sha256=digest,
                          mirrors=MIRRORS, progress=progress)
    return out


def installed():
    """Files under the model directory: [{"path", "size"}]."""
    base = directory()
    items = []
    for root, _dirs, files in os.walk(base):
        for f in files:
            if f.endswith(".sha256") or ".part" in f:
                continue
            full = os.path.join(root, f)
            items.append({"path": os.path.relpath(full, base).replace(os.sep, "/"), "size": os.path.getsize(full)})
    return sorted(items, key=lambda i: i["path"])
