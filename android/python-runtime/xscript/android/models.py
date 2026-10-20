"""Model files for YOLO / PaddleOCR: where they live and how they get there.

    from xscript.android import models
    models.directory()                # model directory on the device
    models.paddle("v5")               # {"det": path, "rec": path, "cls": path}; downloads if missing
    models.paddle("v6t")              # PP-OCRv6 tiny: {"det", "rec", "keys"}
    models.fetch(url, "my/best.onnx", sha256="...")

Built-in PaddleOCR packs: the RapidOCR ONNX exports of PP-OCRv5 / v4 (mobile), whose recognition
models embed the character list, and the official PP-OCRv6 tiny / small ONNX exports ("v6t", "v6s"),
whose character list comes from the recognition model's inference.yml (saved as keys.txt next to it).
Downloads go to a temp file, are checked against the pinned SHA-256, then renamed into place.

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
    # PP-OCRv6 (Apache-2.0): <repo>/<file>; every repo names its model inference.onnx, so the
    # 4th field is the local file name. "dict" is the rec model's inference.yml (character_dict).
    "v6t": {
        "det": ("PP-OCRv6_tiny_det_onnx/inference.onnx",
                "193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8", 1780590, "det.onnx"),
        "rec": ("PP-OCRv6_tiny_rec_onnx/inference.onnx",
                "9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6", 4462639, "rec.onnx"),
        "dict": ("PP-OCRv6_tiny_rec_onnx/inference.yml",
                 "66170210bad538e83fff3c4a3867e547d6bf20b50d64b20347c4b913f3034ea1", 55571, "rec.yml"),
    },
    "v6s": {
        "det": ("PP-OCRv6_small_det_onnx/inference.onnx",
                "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e", 9880512, "det.onnx"),
        "rec": ("PP-OCRv6_small_rec_onnx/inference.onnx",
                "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634", 21159378, "rec.onnx"),
        "dict": ("PP-OCRv6_small_rec_onnx/inference.yml",
                 "ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1", 150579, "rec.yml"),
    },
}

# Per-version URL templates ({repo}/{file} from the path); others use MIRRORS + path.
PADDLE_MIRRORS = {
    "v6t": ("https://www.modelscope.cn/models/PaddlePaddle/{repo}/resolve/master/{file}",
            "https://huggingface.co/PaddlePaddle/{repo}/resolve/main/{file}"),
}
PADDLE_MIRRORS["v6s"] = PADDLE_MIRRORS["v6t"]


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


def fetch(url, name, sha256=None, mirrors=None, timeout=60, progress=None, urls=None):
    """Download `url` (or each mirror + `url` if `mirrors` is given, or each of `urls`) to
    `directory()/name` unless present.

    An existing file is kept when its checksum matches (or no checksum is given).
    """
    target = path(name)
    if os.path.isfile(target):
        if not sha256 or _checked(target, sha256):
            return target
        os.remove(target)
    if not urls:
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
    """PaddleOCR files for `version` ("v5", "v4", "v6t" or "v6s"): {"det", "rec", "cls"?, "keys"?} paths."""
    pack = PADDLE.get(version)
    if pack is None:
        raise ValueError("unknown PaddleOCR version %r (use %s)" % (version, ", ".join(sorted(PADDLE))))
    templates = PADDLE_MIRRORS.get(version)
    out = {}
    for role, spec in pack.items():
        if role == "cls" and not with_cls:
            continue
        rel, digest = spec[0], spec[1]
        local = spec[3] if len(spec) > 3 else os.path.basename(rel)
        urls = None
        if templates:
            repo, file = rel.split("/", 1)
            urls = [t.format(repo=repo, file=file) for t in templates]
        out[role] = fetch(rel, os.path.join("paddle", version, local), sha256=digest, mirrors=MIRRORS,
                          progress=progress, urls=urls)
    if "dict" in out:
        out["keys"] = keys_from_yml(out.pop("dict"))
    return out


def keys_from_yml(yml_path, keys_path=None):
    """Write PostProcess.character_dict of a Paddle inference.yml as a keys file (one per line)."""
    keys_path = keys_path or os.path.join(os.path.dirname(yml_path), "keys.txt")
    if os.path.isfile(keys_path) and os.path.getmtime(keys_path) >= os.path.getmtime(yml_path):
        return keys_path
    import yaml

    with open(yml_path, "r", encoding="utf-8") as f:
        conf = yaml.safe_load(f)
    chars = (conf.get("PostProcess") or {}).get("character_dict")
    if not chars:
        raise ValueError("%s has no PostProcess.character_dict" % os.path.basename(yml_path))
    tmp = keys_path + ".part%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(str(c) for c in chars) + "\n")
    os.replace(tmp, keys_path)
    return keys_path


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
