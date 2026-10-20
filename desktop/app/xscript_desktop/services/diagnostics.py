"""Diagnostics bundle (P5.5): a zip with info.json (versions, platform, state summary) and the app's own logs.

Nothing secret goes in: the keyring is never read, only counts/states of devices and saved settings' key names are listed,
and every text is passed through redact() (API tokens, bearer headers, key/password/token/pairing values, the home
folder). The user picks where the zip goes; nothing is uploaded.
"""
from __future__ import annotations

import io
import json
import logging
import logging.handlers
import os
import re
import zipfile
from pathlib import Path
from typing import Any

LOG_NAME = "desktop.log"
MAX_LOG = 2 * 1024 * 1024  # per file, the newest part
_PATTERNS = [
    (re.compile(r"xsk_[A-Za-z0-9_\-]+"), "xsk_***"),
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=\-]+"), r"\1 ***"),
    (re.compile(r"(?i)\b([a-z_\-]*(?:token|password|passwd|secret|api[_\-]?key|private[_\-]?key|pair(?:ing)?[_\- ]?code|authorization)[a-z_\-]*)"
                r"(\"?\s*[:=]\s*\"?|\s+)([^\s\"',;&}]+)"), r"\1\2***"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S), "***PRIVATE KEY***"),
]


def redact(text: str, home: str | None = None) -> str:
    for pat, rep in _PATTERNS:
        text = pat.sub(rep, text)
    home = home if home is not None else str(Path.home())
    if home and len(home) > 1:
        text = text.replace(home, "~")
    return text


def add_file_log(data_dir: Path) -> Path:
    """Also log to <data dir>/logs/desktop.log (3 × 1 MB, rotated) so a diagnostics bundle has something to include."""
    d = data_dir / "logs"
    d.mkdir(parents=True, exist_ok=True)
    path = d / LOG_NAME
    root = logging.getLogger()
    if not any(isinstance(h, logging.handlers.RotatingFileHandler) and Path(h.baseFilename) == path for h in root.handlers):
        h = logging.handlers.RotatingFileHandler(path, maxBytes=1024 * 1024, backupCount=3, encoding="utf-8")
        h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root.addHandler(h)
    return path


def log_files(data_dir: Path | None) -> list[Path]:
    if not data_dir:
        return []
    d = data_dir / "logs"
    return sorted((p for p in d.glob(LOG_NAME + "*") if p.is_file()), key=lambda p: p.name) if d.is_dir() else []


def _tail(path: Path) -> str:
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(max(0, size - MAX_LOG))
        data = f.read()
    text = data.decode("utf-8", "replace")
    return ("[… %d earlier bytes not included]\n" % (size - MAX_LOG) + text) if size > MAX_LOG else text


def build(info: dict[str, Any], logs: list[Path], home: str | None = None) -> tuple[bytes, list[str]]:
    buf = io.BytesIO()
    names = ["info.json"]
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("info.json", redact(json.dumps(info, ensure_ascii=False, indent=2, default=str), home))
        for p in logs:
            name = "logs/" + p.name
            z.writestr(name, redact(_tail(p), home))
            names.append(name)
        z.writestr("README.txt", "XScript desktop diagnostics bundle. Secrets are redacted (***); review before sharing.\n"
                                 "XScript 桌面端诊断包。令牌、密码等已替换为 ***；发给别人前请自己再看一遍。\n")
        names.append("README.txt")
    return buf.getvalue(), names
