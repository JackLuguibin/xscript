"""packaging/fetch_platform_tools.py: the build-time download of Google's adb (issue #213). No network here: the
official zips are replaced by small fakes with the same layout."""
from __future__ import annotations

import hashlib
import os
import sys
import zipfile
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[1] / "packaging"
sys.path.insert(0, str(PKG))
try:
    import fetch_platform_tools as fpt
finally:
    sys.path.pop(0)

DARWIN = ("adb", "NOTICE.txt", "source.properties", "fastboot", "sqlite3", "lib64/libc++.dylib")
WIN = ("adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "NOTICE.txt", "source.properties", "fastboot.exe")


def _zip(path: Path, names: tuple[str, ...]) -> tuple[Path, str]:
    with zipfile.ZipFile(path, "w") as z:
        for n in names:
            z.writestr("platform-tools/" + n, ("content of " + n).encode())
    return path, hashlib.sha256(path.read_bytes()).hexdigest()


def _pin(monkeypatch, host: str, sha: str) -> None:
    name, _sha, sha1, keep = fpt.ARCHIVES[host]
    monkeypatch.setitem(fpt.ARCHIVES, host, (name, sha, sha1, keep))


def test_pinned_archives_are_official_and_complete():
    assert fpt.BASE_URL == "https://dl.google.com/android/repository/"
    for host, (name, sha256, sha1, keep) in fpt.ARCHIVES.items():
        assert fpt.url_for(host) == fpt.BASE_URL + name
        assert name == f"platform-tools_r{fpt.VERSION}-{host}.zip"
        assert len(sha256) == 64 and len(sha1) == 40 and int(sha256, 16) and int(sha1, 16)
        assert "NOTICE.txt" in keep and "source.properties" in keep  # the licenses travel with the binary
    assert fpt.ARCHIVES["darwin"][3][0] == "adb"
    assert set(fpt.ARCHIVES["win"][3]) >= {"adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll"}


def test_extract_keeps_only_adb_and_its_notices(tmp_path):
    z, sha = _zip(tmp_path / "pt.zip", DARWIN)
    out = tmp_path / "out"
    (out / "stale").mkdir(parents=True)  # a previous build's leftovers are replaced
    files = fpt.extract(z, "darwin", out, sha)
    assert [p.name for p in files] == ["adb", "NOTICE.txt", "source.properties"]
    assert sorted(p.name for p in out.iterdir()) == ["NOTICE.txt", "adb", "source.properties"]
    assert (out / "adb").read_bytes() == b"content of adb"
    if os.name != "nt":
        assert os.access(out / "adb", os.X_OK) and not os.access(out / "NOTICE.txt", os.X_OK)


def test_extract_windows_keeps_the_dlls_adb_loads(tmp_path):
    z, sha = _zip(tmp_path / "pt.zip", WIN)
    files = fpt.extract(z, "win", tmp_path / "out", sha)
    assert [p.name for p in files] == ["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "NOTICE.txt", "source.properties"]


def test_extract_rejects_a_zip_that_is_not_the_pinned_one(tmp_path):
    z, _sha = _zip(tmp_path / "pt.zip", DARWIN)
    out = tmp_path / "out"
    with pytest.raises(fpt.FetchError, match="sha256"):
        fpt.extract(z, "darwin", out)  # the real pinned sha256
    assert not out.exists()  # nothing unverified is written


def test_extract_fails_when_a_kept_file_is_missing(tmp_path):
    z, sha = _zip(tmp_path / "pt.zip", ("adb", "source.properties"))
    with pytest.raises(fpt.FetchError, match="NOTICE.txt"):
        fpt.extract(z, "darwin", tmp_path / "out", sha)


def test_download_refuses_other_urls(tmp_path):
    with pytest.raises(fpt.FetchError, match="non-official"):
        fpt.download("https://example.com/platform-tools.zip", tmp_path / "x.zip")


def test_fetch_downloads_once_then_uses_the_cache(monkeypatch, tmp_path):
    src, sha = _zip(tmp_path / "src.zip", DARWIN)
    _pin(monkeypatch, "darwin", sha)
    calls: list[str] = []

    def fake_download(url: str, dest: Path) -> Path:
        calls.append(url)
        dest.write_bytes(src.read_bytes())
        return dest

    cache = tmp_path / "cache"
    fpt.fetch("darwin", tmp_path / "out", cache_dir=cache, downloader=fake_download)
    fpt.fetch("darwin", tmp_path / "out2", cache_dir=cache, downloader=fake_download)
    assert calls == [fpt.url_for("darwin")]
    assert (tmp_path / "out2" / "adb").is_file()
    # a corrupted cache entry is downloaded again
    (cache / fpt.ARCHIVES["darwin"][0]).write_bytes(b"broken")
    fpt.fetch("darwin", tmp_path / "out3", cache_dir=cache, downloader=fake_download)
    assert len(calls) == 2


def test_fetch_unknown_host(tmp_path):
    with pytest.raises(fpt.FetchError, match="unknown host"):
        fpt.fetch("linux", tmp_path / "out")


def test_main_with_a_local_zip(monkeypatch, tmp_path, capsys):
    z, sha = _zip(tmp_path / "pt.zip", WIN)
    _pin(monkeypatch, "win", sha)
    assert fpt.main(["win", str(tmp_path / "out"), "--zip", str(z)]) == 0
    assert "adb.exe" in capsys.readouterr().out
    _pin(monkeypatch, "win", "0" * 64)
    assert fpt.main(["win", str(tmp_path / "out"), "--zip", str(z)]) == 1
    assert "does not match" in capsys.readouterr().err


def test_build_scripts_bundle_platform_tools():
    mac = (PKG / "build_macos_app.sh").read_text()
    win = (PKG / "build_windows.sh").read_text()
    assert "fetch_platform_tools.py darwin" in mac and '--add-binary "$PT/adb:platform-tools"' in mac
    assert '"$PT/NOTICE.txt:platform-tools"' in mac
    assert "fetch_platform_tools.py win" in win
    for f in ("adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "NOTICE.txt"):
        assert f"$PTW\\\\{f};platform-tools" in win
    # the bundled adb is found where services/adb.py looks: <_MEIPASS>/platform-tools
    from xscript_desktop.services.adb import BUNDLED_DIR
    assert BUNDLED_DIR == "platform-tools"
    # the packaging checks prove the app picks it
    assert "Frameworks/platform-tools/adb" in (PKG / "check_macos_dmg.sh").read_text()
    assert "_internal/platform-tools/adb.exe" in (PKG / "check_windows_install.sh").read_text()


def test_inno_stops_the_bundled_adb_server_before_upgrade_and_uninstall():
    s = (PKG / "xscript.iss").read_text(encoding="utf-8")
    run = s.split("[UninstallRun]")[1].split("[")[0]
    assert "{app}\\_internal\\platform-tools\\adb.exe" in run and 'Parameters: "kill-server"' in run
    code = s.split("[Code]")[1]
    assert "function PrepareToInstall" in code and "'kill-server'" in code
