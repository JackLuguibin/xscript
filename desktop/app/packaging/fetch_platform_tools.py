#!/usr/bin/env python3
"""Fetch Google's Android SDK Platform-Tools at build time and keep only what the desktop app runs (issue #213).

    python packaging/fetch_platform_tools.py darwin build/platform-tools   # macOS build (build_macos_app.sh)
    python packaging/fetch_platform_tools.py win build/platform-tools      # Windows build (build_windows.sh)
    ... --zip path/to/platform-tools_r37.0.1-darwin.zip                     # offline: the same pinned zip, checked the same way

Only the official URL is used (dl.google.com/android/repository), the version is pinned and the zip must match the
sha256 below, so a build never picks up an unexpected binary. Kept: adb (plus the two DLLs adb.exe loads on Windows),
NOTICE.txt (the licenses of everything in platform-tools) and source.properties (the version). PyInstaller then puts
them into <sys._MEIPASS>/platform-tools/, where services/adb.py:bundled_adb_paths() looks first.

To update: take the new revision from https://dl.google.com/android/repository/repository2-3.xml (path="platform-tools"),
download both zips, check their sha1 against that file, and put the sha256 here.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import stat
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

VERSION = "37.0.1"
BASE_URL = "https://dl.google.com/android/repository/"
# per host OS: (file name, sha256, sha1 from repository2-3.xml, files to keep)
ARCHIVES: dict[str, tuple[str, str, str, tuple[str, ...]]] = {
    "darwin": (f"platform-tools_r{VERSION}-darwin.zip",
               "ee39ad5967e95c2a07f04dbcbde96b1a0c916ba376096db5d2f498b7727a5d1d",
               "6ae73f4de6452dc57e62ec02b68eed92a4c21661",
               ("adb", "NOTICE.txt", "source.properties")),
    "win": (f"platform-tools_r{VERSION}-win.zip",
            "45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99",
            "e03e78b1d80b396f1c3358e31251cb31740e1110",
            ("adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "NOTICE.txt", "source.properties")),
}
EXECUTABLES = {"adb"}  # zipfile drops the unix mode; put the x bit back


class FetchError(Exception):
    pass


def url_for(host: str) -> str:
    return BASE_URL + ARCHIVES[host][0]


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path, timeout: float = 120.0) -> Path:
    if not url.startswith(BASE_URL):
        raise FetchError(f"refusing a non-official URL: {url}")
    tmp = dest.with_name(dest.name + ".part")
    with urllib.request.urlopen(url, timeout=timeout) as r, open(tmp, "wb") as f:  # noqa: S310 (fixed https URL)
        shutil.copyfileobj(r, f)
    os.replace(tmp, dest)
    return dest


def extract(zip_path: Path, host: str, out_dir: Path, expected_sha256: str | None = None) -> list[Path]:
    """Check the zip's sha256, then copy only the kept files to out_dir (replacing what was there)."""
    _name, sha256, _sha1, keep = ARCHIVES[host]
    want = expected_sha256 or sha256
    got = sha256_of(zip_path)
    if got != want:
        raise FetchError(f"{zip_path.name}: sha256 {got} does not match the pinned {want}")
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    written: list[Path] = []
    with zipfile.ZipFile(zip_path) as z:
        members = set(z.namelist())
        for fname in keep:
            member = "platform-tools/" + fname
            if member not in members:
                raise FetchError(f"{zip_path.name} has no {member}")
            target = out_dir / fname
            with z.open(member) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            if fname in EXECUTABLES:
                target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            written.append(target)
    return written


def fetch(host: str, out_dir: Path, zip_path: Path | None = None, cache_dir: Path | None = None,
          downloader=download) -> list[Path]:
    if host not in ARCHIVES:
        raise FetchError(f"unknown host {host!r} (expected one of {', '.join(ARCHIVES)})")
    if zip_path is None:
        cache = cache_dir or Path(tempfile.gettempdir()) / "xscript-platform-tools"
        cache.mkdir(parents=True, exist_ok=True)
        zip_path = cache / ARCHIVES[host][0]
        if not zip_path.is_file() or sha256_of(zip_path) != ARCHIVES[host][1]:
            downloader(url_for(host), zip_path)
    return extract(zip_path, host, out_dir)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Fetch the pinned Android SDK Platform-Tools for the desktop bundle.")
    ap.add_argument("host", choices=sorted(ARCHIVES))
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--zip", type=Path, help="use this local zip instead of downloading (still sha256-checked)")
    ap.add_argument("--cache-dir", type=Path, help="where downloads are kept between builds")
    a = ap.parse_args(argv)
    try:
        files = fetch(a.host, a.out_dir, a.zip, a.cache_dir)
    except (FetchError, OSError) as e:
        print(f"fetch_platform_tools: {e}", file=sys.stderr)
        return 1
    print(f"platform-tools {VERSION} ({a.host}) -> {a.out_dir}: " + ", ".join(p.name for p in files))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
