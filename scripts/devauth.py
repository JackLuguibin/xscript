"""Pairing code for the device scripts in scripts/ (the device API needs one by default; see protocol/openapi.yaml).

Order: XSCRIPT_TOKEN, else the app's USB-only pairing socket over adb (`adb forward localabstract:xscript-pair.<app id>`,
the app id read from the public GET /status; the device is ANDROID_SERIAL / the given serial, or the only one attached).
A device with pairing switched off needs nothing. The code is never printed.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import urllib.request

_cache: dict[str, str] = {}
_CODE = re.compile(r"\b[A-Z0-9]{4}-?[A-Z0-9]{4}\b")


def mask(text: object) -> str:
    """`text` with pairing codes (XXXX-XXXX, also unhyphenated) replaced by ****-****. Device scripts pass anything
    that may hold UI dump text or device logs through this before printing it (the home screen shows the code)."""
    return _CODE.sub("****-****", str(text))


def _adb() -> str | None:
    home = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") or os.path.expanduser("~/Library/Android/sdk")
    cand = os.path.join(home, "platform-tools", "adb")
    return cand if os.path.isfile(cand) else shutil.which("adb")


def _status(base: str) -> dict:
    with urllib.request.urlopen(base.rstrip("/") + "/status", timeout=10) as r:
        return json.load(r)


def _from_adb(app_id: str, serial: str | None) -> str:
    adb = _adb()
    if not adb or not app_id:
        return ""
    sel = ["-s", serial] if serial else []
    try:
        port = subprocess.run([adb, *sel, "forward", "tcp:0", "localabstract:xscript-pair." + app_id],
                              capture_output=True, text=True, timeout=10).stdout.strip()
        if not port.isdigit():
            return ""
        try:
            with socket.create_connection(("127.0.0.1", int(port)), timeout=5) as s:
                data = b""
                while (chunk := s.recv(4096)):
                    data += chunk
        finally:
            subprocess.run([adb, *sel, "forward", "--remove", "tcp:" + port], capture_output=True, timeout=10)
        reply = json.loads(data or b"{}")
        return str(reply.get("code") or "")
    except (OSError, ValueError, subprocess.SubprocessError):
        return ""


def token(base: str, serial: str | None = None) -> str:
    """The pairing code for the device at `base` ("" when it needs none or none could be found)."""
    if base in _cache:
        return _cache[base]
    code = os.environ.get("XSCRIPT_TOKEN", "").strip()
    if not code:
        try:
            st = _status(base)
        except OSError:
            st = {}
        if st.get("pairing") and not st.get("paired"):
            code = _from_adb(str(st.get("app_id") or ""), serial or os.environ.get("ANDROID_SERIAL") or None)
            if not code:
                print("devauth: %s needs a pairing code: set XSCRIPT_TOKEN (phone: 开发与连接 → 配对码) or attach it over adb" % base)
    _cache[base] = code
    return code


def headers(base: str, extra: dict | None = None, serial: str | None = None) -> dict:
    """`extra` plus Authorization when a pairing code is needed."""
    h = dict(extra or {})
    code = token(base, serial)
    if code:
        h["Authorization"] = "Bearer " + code
    return h
