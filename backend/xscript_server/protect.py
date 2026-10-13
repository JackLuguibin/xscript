"""代码保护: compile a project to Python bytecode and drop the sources.

Packed apps and 云控 deployments then ship `.pyc` files only. This stops casual copying and
editing; bytecode can still be decompiled, so treat it as obfuscation, not encryption.

The bytecode must match the app's interpreter (Chaquopy, Python 3.10), so compilation runs
in a Python 3.10 found via $XSCRIPT_BUILD_PYTHON, `python3.10` on PATH, or `uv python find`.
Stdlib only: xscript_pack.py imports this without the server dependencies.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

TARGET = (3, 10)

# Runs inside the target interpreter. Legacy layout (foo.pyc next to where foo.py was) is
# importable without sources, including packages via __init__.pyc.
_SNIPPET = r"""
import os, sys, py_compile
root = sys.argv[1]
n = 0
for d, dirs, files in os.walk(root):
    dirs[:] = [x for x in dirs if x != "__pycache__"]
    for f in files:
        if f.endswith(".py"):
            src = os.path.join(d, f)
            py_compile.compile(src, cfile=src + "c", dfile=os.path.relpath(src, root), doraise=True,
                               invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
            os.remove(src)
            n += 1
print(n)
"""

_cache: dict[str, str | None] = {}


def _version(python: str) -> tuple[int, int] | None:
    try:
        out = subprocess.run([python, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
                             capture_output=True, text=True, timeout=20, check=True).stdout.strip()
        major, minor = out.split(".")
        return int(major), int(minor)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def find_python() -> str | None:
    """A Python 3.10 interpreter, or None."""
    if "py" in _cache:
        return _cache["py"]
    candidates = [os.environ.get("XSCRIPT_BUILD_PYTHON", ""), shutil.which("python3.10") or ""]
    uv = shutil.which("uv") or os.path.expanduser("~/.local/bin/uv")
    if os.path.isfile(uv):
        try:
            candidates.append(subprocess.run([uv, "python", "find", "3.10"], capture_output=True, text=True,
                                             timeout=20).stdout.strip())
        except (OSError, subprocess.SubprocessError):
            pass
    found = next((c for c in candidates if c and _version(c) == TARGET), None)
    _cache["py"] = found
    return found


def compile_tree(root: str | os.PathLike, python: str | None = None, check_version: bool = True) -> int:
    """Replace every .py under root with .pyc. Returns the number of files compiled."""
    py = python or find_python()
    if not py:
        raise RuntimeError("代码保护需要 Python 3.10（设置 XSCRIPT_BUILD_PYTHON 或安装 python3.10）")
    if check_version and _version(py) != TARGET:
        raise RuntimeError("%s 不是 Python 3.10，编译出的字节码无法在 App 里运行" % py)
    res = subprocess.run([py, "-c", _SNIPPET, str(root)], capture_output=True, text=True, timeout=600)
    if res.returncode != 0:
        tail = (res.stderr or res.stdout).strip().splitlines()[-3:]
        raise RuntimeError("编译失败: " + " / ".join(tail))
    for d in Path(root).rglob("__pycache__"):
        shutil.rmtree(d, ignore_errors=True)
    return int(res.stdout.strip() or 0)


def has_entry(project: str | os.PathLike) -> bool:
    p = Path(project)
    return (p / "__init__.py").is_file() or (p / "__init__.pyc").is_file()
