#!/usr/bin/env python3
"""Which heavy CI jobs a pull request needs, from the files it changes.

usage: scripts/ci_changes.py <base-sha> <head-sha>   -> prints `android=`, `desktop=` and `postgres=true|false`
       scripts/ci_changes.py --all                   -> everything true (push to main, release, manual runs)

A job is skipped only when *every* changed file is in an area listed below as unable to affect it. Anything else, a
new top-level folder, scripts/, the workflow itself, or a git error, runs the job. Pushes to main always run all jobs.
"""

from __future__ import annotations

import subprocess
import sys

ROOT_DOCS = {"README.md", "README.en.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md", "LICENSE", "Dockerfile"}

# The Android build reads android/ only (plus android/python-runtime, which is inside it).
ANDROID_UNAFFECTED = ("desktop/", "ide/", "backend/", "docs/", "deploy/")

# The desktop client reads docs/ (test matrix, security scan), ide/python-stubs (editor completion),
# android/python-runtime (node specs), scripts/ (mock device) and schema/nodes at the top level.
DESKTOP_UNAFFECTED = ("android/", "backend/", "ide/vscode-extension/", "ide/mcp-server/", "deploy/")
DESKTOP_NEEDED_INSIDE = ("android/python-runtime/",)

# The backend suite on PostgreSQL only needs the server's Python code (the console and docs cannot change SQL).
POSTGRES_UNAFFECTED = ("android/", "desktop/", "ide/", "docs/", "deploy/", "backend/web/", "backend/README.md")


def _unaffected(path: str, prefixes: tuple[str, ...], needed: tuple[str, ...] = ()) -> bool:
    if path in ROOT_DOCS:
        return True
    if any(path.startswith(p) for p in needed):
        return False
    return any(path.startswith(p) for p in prefixes)


def decide(files: list[str]) -> dict[str, bool]:
    if not files:  # nothing to compare (or an empty diff): be safe
        return {"android": True, "desktop": True, "postgres": True}
    return {
        "android": not all(_unaffected(f, ANDROID_UNAFFECTED) for f in files),
        "desktop": not all(_unaffected(f, DESKTOP_UNAFFECTED, DESKTOP_NEEDED_INSIDE) for f in files),
        "postgres": not all(_unaffected(f, POSTGRES_UNAFFECTED) for f in files),
    }


def changed_files(base: str, head: str) -> list[str]:
    # -z: raw paths (no quoting of the Chinese file names under docs/), NUL separated
    out = subprocess.run(["git", "diff", "--name-only", "-z", base, head], capture_output=True, check=True).stdout
    return [p for p in out.decode("utf-8", "surrogateescape").split("\0") if p]


def main(argv: list[str]) -> int:
    if argv[1:] == ["--all"]:
        result = {"android": True, "desktop": True, "postgres": True}
    elif len(argv) == 3:
        try:
            files = changed_files(argv[1], argv[2])
        except (OSError, subprocess.CalledProcessError) as e:
            print("ci_changes: git diff failed (%s); running everything" % e, file=sys.stderr)
            files = []
        print("ci_changes: %d changed files" % len(files), file=sys.stderr)
        for f in files[:50]:
            print("  " + f, file=sys.stderr)
        result = decide(files)
    else:
        print(__doc__, file=sys.stderr)
        return 2
    for k, v in result.items():
        print("%s=%s" % (k, "true" if v else "false"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
