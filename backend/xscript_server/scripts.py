"""小程序 storage: versioned project zips and the bundles built from them.

Layout under <data>/scripts/<script id>/<version id>/:
    source.zip        the upload, as-is
    bundle.zip        project files at the archive root (what devices and 热更新 install)
    bundle-pyc.zip    same, compiled to bytecode (代码保护)
    *.sha256          digest of the matching bundle
"""

from __future__ import annotations

import hashlib
import secrets
import shutil
import tempfile
import zipfile
from pathlib import Path

from .config import Config
from .packer import PROJECT_NAME, safe_extract
from .protect import compile_tree

MAX_SOURCE_ZIP = 64 * 1024 * 1024


def new_channel() -> str:
    return "ch_" + secrets.token_urlsafe(12)


def version_dir(config: Config, script_id: int, version_id: int) -> Path:
    return config.scripts_dir / str(script_id) / str(version_id)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def inspect_zip(path: Path) -> tuple[str, int]:
    """(top folder name or "", file count) after checking the zip is a safe project archive."""
    with tempfile.TemporaryDirectory(prefix="xs-inspect-") as tmp:
        root = safe_extract(path, Path(tmp))
        top = root.name if root != Path(tmp).resolve() else ""
        files = sum(1 for p in root.rglob("*") if p.is_file() and "__pycache__" not in p.parts)
    return top, files


def guess_project_name(top: str, filename: str) -> str:
    for cand in (top, Path(filename or "").stem):
        if cand and PROJECT_NAME.match(cand):
            return cand
    return ""


def _zip_dir(root: Path, dest: Path) -> None:
    tmp = dest.with_suffix(".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(root.rglob("*")):
            if p.is_file() and "__pycache__" not in p.parts and p.name != ".DS_Store":
                info = zipfile.ZipInfo(p.relative_to(root).as_posix(), date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                zf.writestr(info, p.read_bytes())
    tmp.replace(dest)


def bundle(config: Config, script_id: int, version_id: int, protect: bool) -> tuple[Path, str, int]:
    """Build (or reuse) the device bundle. Returns (path, sha256, size). Blocking."""
    d = version_dir(config, script_id, version_id)
    path = d / ("bundle-pyc.zip" if protect else "bundle.zip")
    digest_file = path.with_name(path.name + ".sha256")
    if not (path.is_file() and digest_file.is_file()):
        with tempfile.TemporaryDirectory(prefix="xs-bundle-") as tmp:
            root = safe_extract(d / "source.zip", Path(tmp) / "src")
            if protect:
                compile_tree(root)
            _zip_dir(root, path)
        digest_file.write_text(sha256_file(path))
    return path, digest_file.read_text().strip(), path.stat().st_size


def delete_script_files(config: Config, script_id: int, version_id: int | None = None) -> None:
    target = config.scripts_dir / str(script_id)
    if version_id is not None:
        target = target / str(version_id)
    shutil.rmtree(target, ignore_errors=True)
