"""Project-name validation (docs/桌面端设计.md §14.8).

The device imports a project with `importlib.import_module(<name>)` while `<files>/projects` and the project dir are first on
`sys.path` (docs/桌面端-入口执行实测.md). Measured on both emulators: a project named like a standard-library module shadows it
(`json`, `random`, `colorsys`), so such names are refused up front. Windows-specific rules are ⚠ not verified on Windows.
"""
from __future__ import annotations

import keyword
import re
import sys
import unicodedata
from dataclasses import dataclass
from typing import Iterable

# The device accepts [\p{L}_][\p{L}\p{N}_]* (docs/桌面端-入口执行实测.md §2.5). Python's str.isidentifier() is a close match
# (letters, digits, underscore; NFKC-normalised identifiers); we additionally check the shape explicitly below.
MAX_LEN = 64

# Packages that ship with the device runtime or are routinely installed there; a project of the same name would hide them.
RESERVED_PACKAGES = frozenset({
    "xscript", "ascript", "numpy", "cv2", "PIL", "pillow", "requests", "yaml", "paddle", "paddleocr", "onnxruntime", "onnx",
    "scipy", "pandas", "torch", "tensorflow", "sklearn", "setuptools", "pip", "debugpy", "pydevd", "java", "jnius", "chaquopy",
    "android", "com", "org",
})

WINDOWS_RESERVED = frozenset({"con", "prn", "aux", "nul", *("com%d" % i for i in range(1, 10)), *("lpt%d" % i for i in range(1, 10))})  # ⚠ Windows 未验证


@dataclass(frozen=True)
class NameCheck:
    ok: bool
    code: str = ""  # "" | name.empty | name.too_long | name.syntax | name.dunder | name.keyword | name.stdlib | name.reserved | name.windows | name.exists
    message: str = ""

    def __bool__(self) -> bool:
        return self.ok


def _bad(code: str, message: str) -> NameCheck:
    return NameCheck(False, code, message)


def validate_project_name(name: str, existing: Iterable[str] = ()) -> NameCheck:
    """Return NameCheck(ok=True) or the first reason this project name must be refused.

    `existing` are the project names already on the target (compared case-insensitively: Windows and macOS file systems are
    case-insensitive by default, so two names differing only in case cannot coexist in a local workspace)."""
    if not isinstance(name, str) or name == "":
        return _bad("name.empty", "工程名不能为空")
    if len(name) > MAX_LEN:
        return _bad("name.too_long", "工程名最长 %d 个字符" % MAX_LEN)
    if unicodedata.normalize("NFC", name) != name:
        return _bad("name.syntax", "工程名必须是 NFC 规范化的文本")
    if not re.fullmatch(r"[^\W\d]\w*", name, flags=re.UNICODE) or not name.isidentifier():
        return _bad("name.syntax", "工程名只能由字母、数字、下划线组成，且不能以数字开头")
    if name.startswith("__") and name.endswith("__"):
        return _bad("name.dunder", "不能使用 __xxx__ 形式的名字")
    if keyword.iskeyword(name):
        return _bad("name.keyword", "%s 是 Python 关键字" % name)
    stdlib = getattr(sys, "stdlib_module_names", frozenset())
    if name in stdlib or name in sys.builtin_module_names:
        return _bad("name.stdlib", "%s 与 Python 标准库同名，会遮挡标准库（设备上实测：工程内 import %s 得到的是工程自己）" % (name, name))
    if name in RESERVED_PACKAGES or name.lower() in {p.lower() for p in RESERVED_PACKAGES}:
        return _bad("name.reserved", "%s 与设备运行时/常用包同名，会遮挡它" % name)
    if name.lower() in WINDOWS_RESERVED:
        return _bad("name.windows", "%s 是 Windows 保留设备名" % name)
    lowered = name.lower()
    for e in existing:
        if e.lower() == lowered:
            return _bad("name.exists", "已有同名工程：%s" % e)
    return NameCheck(True)
