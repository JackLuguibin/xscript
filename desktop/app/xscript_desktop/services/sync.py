"""Local folder ⇄ device project sync. A port of ide/vscode-extension/src/{sync,project}.ts (same .syncignore rules, same
skip lists, same "size on device + hash we uploaded last time" incremental rule), so a folder synced from VS Code and from
the desktop app behaves the same."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

SYNCIGNORE_PATH = Path(".vscode") / ".syncignore"
SKIP_DIRS = {"__pycache__", ".git", ".mypy_cache", ".pytest_cache", ".venv", "venv", ".idea", ".vscode", "node_modules"}
TEXT_EXT = {".py", ".txt", ".json", ".md", ".html", ".js", ".css", ".yaml", ".yml", ".ini", ".cfg", ".csv", ".xml"}
MAX_FILES = 5000
MAX_TOTAL_BYTES = 200 * 1024 * 1024
BATCH_BYTES = 2 * 1024 * 1024  # one PUT /files body (base64 grows it by 4/3)


class SyncError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _glob_to_regex(glob: str) -> str:
    out, i = "", 0
    while i < len(glob):
        c = glob[i]
        if c == "*":
            if glob[i + 1:i + 2] == "*":
                i += 1
                if glob[i + 1:i + 2] == "/":
                    i += 1
                    out += "(?:.*/)?"
                else:
                    out += ".*"
            else:
                out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        else:
            out += re.escape(c)
        i += 1
    return out


class IgnoreRules:
    """gitignore-lite matcher (sync.ts IgnoreRules); the last matching rule wins."""

    def __init__(self, text: str = "") -> None:
        self.rules: list[tuple[re.Pattern[str], bool, bool]] = []
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            negate = line.startswith("!")
            if negate:
                line = line[1:]
            dir_only = line.endswith("/")
            if dir_only:
                line = line[:-1]
            anchored = line.startswith("/") or "/" in line
            line = line.lstrip("/")
            if not line:
                continue
            body = _glob_to_regex(line)
            self.rules.append((re.compile(("^" + body + "$") if anchored else ("(?:^|/)" + body + "$")), dir_only, negate))

    def ignores(self, rel: str, is_dir: bool) -> bool:
        ignored = False
        for rx, dir_only, negate in self.rules:
            if dir_only and not is_dir:
                continue
            if rx.search(rel):
                ignored = not negate
        return ignored


def load_ignore_rules(root: Path) -> IgnoreRules:
    try:
        return IgnoreRules((root / SYNCIGNORE_PATH).read_text("utf-8"))
    except OSError:
        return IgnoreRules()


def is_project_dir(root: Path) -> bool:
    return (root / "__init__.py").is_file() or (root / "build.as").is_file()


def safe_relative(rel: str) -> bool:
    if not rel or rel.startswith("/") or "\\" in rel or "\0" in rel:
        return False
    return all(seg not in ("", ".", "..") for seg in rel.split("/"))


@dataclass
class LocalFile:
    path: str
    data: bytes
    sha1: str = field(init=False)

    def __post_init__(self) -> None:
        self.sha1 = hashlib.sha1(self.data).hexdigest()

    def upload_body(self) -> dict[str, Any]:
        if Path(self.path).suffix.lower() in TEXT_EXT:
            try:
                return {"path": self.path, "content": self.data.decode("utf-8"), "encoding": "utf-8"}
            except UnicodeDecodeError:
                pass
        return {"path": self.path, "content": base64.b64encode(self.data).decode("ascii"), "encoding": "base64"}


def collect_files(root: Path, ignore: IgnoreRules | None = None) -> list[LocalFile]:
    """project.ts collectFiles: dot entries, SKIP_DIRS and *.pyc/*.pyo are always skipped; symlinked folders are not followed."""
    out: list[LocalFile] = []
    total = 0

    def walk(d: Path) -> None:
        nonlocal total
        for ent in sorted(os.scandir(d), key=lambda e: e.name):
            if ent.name.startswith("."):
                continue
            rel = Path(ent.path).relative_to(root).as_posix()
            if ent.is_dir(follow_symlinks=False):
                if ent.name not in SKIP_DIRS and not (ignore and ignore.ignores(rel, True)):
                    walk(Path(ent.path))
                continue
            if not ent.is_file() or re.search(r"\.py[co]$", ent.name) or (ignore and ignore.ignores(rel, False)):
                continue
            data = Path(ent.path).read_bytes()
            total += len(data)
            out.append(LocalFile(rel, data))
            if len(out) > MAX_FILES or total > MAX_TOTAL_BYTES:
                raise SyncError("sync.too_large", "folder has more than %d files or %d MB: is it really a project folder?" % (MAX_FILES, MAX_TOTAL_BYTES >> 20))

    walk(root)
    out.sort(key=lambda f: f.path)
    return out


@dataclass
class UploadPlan:
    upload: list[LocalFile]
    skipped: list[str]
    hashes: dict[str, str]

    def summary(self) -> dict[str, Any]:
        return {"upload": [f.path for f in self.upload], "skipped": self.skipped, "bytes": sum(len(f.data) for f in self.upload)}


def plan_upload(files: list[LocalFile], remote: list[dict[str, Any]] | None, cache: dict[str, str]) -> UploadPlan:
    """sync.ts planUpload: skip a file only when the device has it with the same size AND its hash is what we uploaded last."""
    remote_size = {f.get("path"): f.get("size") for f in (remote or [])}
    upload: list[LocalFile] = []
    skipped: list[str] = []
    hashes: dict[str, str] = {}
    for f in files:
        hashes[f.path] = f.sha1
        if remote is not None and remote_size.get(f.path) == len(f.data) and cache.get(f.path) == f.sha1:
            skipped.append(f.path)
        else:
            upload.append(f)
    return UploadPlan(upload, skipped, hashes)


def batches(files: Iterable[LocalFile], max_bytes: int = BATCH_BYTES) -> list[list[LocalFile]]:
    out: list[list[LocalFile]] = []
    cur: list[LocalFile] = []
    size = 0
    for f in files:
        if cur and size + len(f.data) > max_bytes:
            out.append(cur)
            cur, size = [], 0
        cur.append(f)
        size += len(f.data)
    if cur:
        out.append(cur)
    return out


def diff_against_local(root: Path, pulled: list[tuple[str, bytes]]) -> dict[str, list[str]]:
    d: dict[str, list[str]] = {"added": [], "changed": [], "unchanged": []}
    for rel, data in pulled:
        p = root.joinpath(*rel.split("/"))
        if not p.exists():
            d["added"].append(rel)
        elif p.is_file() and p.read_bytes() == data:
            d["unchanged"].append(rel)
        else:
            d["changed"].append(rel)
    return d


def write_pulled(root: Path, pulled: list[tuple[str, bytes]], diff: dict[str, list[str]]) -> int:
    """Writes only new/changed files; local files the device does not have are left alone (sync.ts writePulled)."""
    todo = set(diff["added"]) | set(diff["changed"])
    root_r = root.resolve()
    n = 0
    for rel, data in pulled:
        if rel not in todo or not safe_relative(rel):
            continue
        p = root.joinpath(*rel.split("/"))
        p.resolve().relative_to(root_r)  # never write outside the folder (symlinked parents)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        n += 1
    return n


class SyncCache:
    """`<device key>:<project>` → {path: sha1 last uploaded}. A JSON file in the app data dir (memory only when None)."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._data: dict[str, dict[str, str]] = {}
        if path is not None:
            try:
                raw = json.loads(path.read_text("utf-8"))
                if isinstance(raw, dict):
                    self._data = {k: v for k, v in raw.items() if isinstance(v, dict)}
            except (OSError, ValueError):
                pass

    def get(self, key: str) -> dict[str, str]:
        with self._lock:
            return dict(self._data.get(key, {}))

    def put(self, key: str, hashes: dict[str, str]) -> None:
        with self._lock:
            self._data[key] = dict(hashes)
            if self.path is not None:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text(json.dumps(self._data, ensure_ascii=False, sort_keys=True), "utf-8")
                tmp.replace(self.path)
