#!/usr/bin/env python3
"""Reject files that should never be committed: symlinks, dependency and build folders, compiled output, big files.

    python3 scripts/check_repo_files.py            # the tracked files (git ls-files); exits 1 on a problem
    python3 scripts/check_repo_files.py --staged   # what `git commit` would add now (use before committing)

A symlinked node_modules slipped into main once (#170/#171): `node_modules/` in .gitignore ignores folders, not links.
Allowed exceptions are listed in ALLOW with the reason.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MAX_BYTES = 3_000_000
# A path segment that is a dependency, cache or build folder (or a link named like one).
BAD_DIRS = {"node_modules", ".venv", "venv", "__pycache__", ".gradle", ".pytest_cache", ".mypy_cache", ".ruff_cache",
            ".tox", "dist", "build", "out", "target", ".next", ".idea", ".DS_Store"}
BAD_EXT = re.compile(r"\.(pyc|pyo|class|vsix|apk|aab|ipa|dmg|exe|msi|jar|so|dylib|dll|o|log)$", re.I)
ALLOW = {
    "android/gradle/wrapper/gradle-wrapper.jar": "Gradle wrapper, needed to build",
    "ide/pycharm-plugin/gradle/wrapper/gradle-wrapper.jar": "Gradle wrapper, needed to build",
}


def entries(staged: bool) -> list[tuple[str, str, str]]:
    """(mode, object id, path) of the tracked files, or of the files added/changed in the index."""
    if staged:
        out = subprocess.run(["git", "diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"], cwd=ROOT,
                             capture_output=True, text=True, check=True).stdout
        paths = [p for p in out.split("\0") if p]
        if not paths:
            return []
        out = subprocess.run(["git", "ls-files", "-s", "-z", "--", *paths], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    else:
        out = subprocess.run(["git", "ls-files", "-s", "-z"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    res = []
    for rec in out.split("\0"):
        if rec:
            meta, path = rec.split("\t", 1)
            mode, oid = meta.split()[:2]
            res.append((mode, oid, path))
    return res


def sizes(oids: list[str]) -> dict[str, int]:
    """Blob sizes in one `git cat-file --batch-check` call (submodule commits have none)."""
    blobs = sorted(set(oids))
    out = subprocess.run(["git", "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], cwd=ROOT,
                         input="\n".join(blobs) + "\n", capture_output=True, text=True, check=True).stdout
    res = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[1] == "blob":
            res[parts[0]] = int(parts[2])
    return res


def problems_for(mode: str, path: str, size: int | None) -> list[str]:
    if path in ALLOW:
        return []
    out = []
    if mode == "120000":
        out.append("%s: symlink (commit the real file, or ignore it)" % path)
    if mode == "160000":
        out.append("%s: submodule" % path)
    bad = [seg for seg in path.split("/") if seg in BAD_DIRS]
    if bad:
        out.append("%s: inside or named %s (dependency / build output)" % (path, bad[0]))
    elif BAD_EXT.search(path):
        out.append("%s: compiled or packaged file" % path)
    if size is not None and size > MAX_BYTES:
        out.append("%s: %.1f MB (limit %.0f MB)" % (path, size / 1e6, MAX_BYTES / 1e6))
    return out


def main() -> int:
    staged = "--staged" in sys.argv
    found = []
    files = entries(staged)
    size = sizes([oid for mode, oid, _ in files if mode != "160000"])
    for mode, oid, path in files:
        found += problems_for(mode, path, size.get(oid))
    for p in found:
        print(p)
    print("%s: %d problem(s)" % ("staged files" if staged else "tracked files", len(found)))
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
