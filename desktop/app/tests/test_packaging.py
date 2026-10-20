import shutil
import sys
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[1] / "packaging"


def test_build_script_names_app_xscript():
    s = (PKG / "build_macos_app.sh").read_text()
    assert "--name XScript" in s and "--icon" in s and "--windowed" in s


@pytest.mark.skipif(sys.platform != "darwin" or not shutil.which("iconutil"), reason="macOS iconutil only")
def test_make_icns(tmp_path, qapp):
    sys.path.insert(0, str(PKG))
    try:
        from make_icns import make_icns
    finally:
        sys.path.pop(0)
    out = make_icns(tmp_path / "XScript.icns")
    assert out.read_bytes()[:4] == b"icns"


def test_make_ico_has_every_size_as_png(tmp_path, qapp):
    import struct
    sys.path.insert(0, str(PKG))
    try:
        from make_ico import SIZES, make_ico
    finally:
        sys.path.pop(0)
    data = make_ico(tmp_path / "x" / "XScript.ico").read_bytes()
    reserved, kind, count = struct.unpack_from("<HHH", data)
    assert (reserved, kind, count) == (0, 1, len(SIZES))
    for i, px in enumerate(SIZES):
        w, h, _, _, planes, bpp, size, off = struct.unpack_from("<BBBBHHII", data, 6 + 16 * i)
        assert (w or 256, h or 256, planes, bpp) == (px, px, 1, 32)
        assert data[off:off + 8] == b"\x89PNG\r\n\x1a\n" and off + size <= len(data)


def _iss() -> str:
    return (PKG / "xscript.iss").read_text(encoding="utf-8")


def test_inno_script_is_per_user_and_upgrades_in_place():
    s = _iss()
    # a fixed AppId is what makes a newer setup.exe (the auto-update) upgrade the same install
    assert "AppId={{6C1F4E2A-9B7D-4C35-8E21-5A0D3F7B9C64}" in s
    assert "PrivilegesRequired=lowest" in s and "DefaultDirName={autopf}\\XScript" in s
    assert "ArchitecturesInstallIn64BitMode=x64compatible" in s
    # stale PyInstaller modules of the previous version are removed before the new ones are copied
    assert 'Type: filesandordirs; Name: "{app}\\_internal"' in s.split("[InstallDelete]")[1].split("[Files]")[0]
    assert "skipifsilent" in s  # a silent (update) install never pops the app up by itself


def test_windows_build_names_match():
    iss, sh = _iss(), (PKG / "build_windows.sh").read_text()
    assert "OutputBaseFilename=xscript-desktop-v{#AppVersion}-windows-x64-setup" in iss
    assert "SETUP=dist/xscript-desktop-v$VERSION-windows-x64-setup.exe" in sh
    assert "--name XScript" in sh and "--windowed" in sh and "MSYS2_ARG_CONV_EXCL" in sh
    chk = (PKG / "check_windows_install.sh").read_text()
    assert "/VERYSILENT" in chk and "--selftest" in chk and "--report" in chk and "unins000.exe" in chk


def test_dmg_check_never_touches_applications_or_the_user_profile():
    s = (PKG / "check_macos_dmg.sh").read_text()
    assert "verify_macos_app.sh" in s and "open -n -W" in s and "--selftest" in s
    # every launch gets a temp --data-dir, and the bundle is copied to a temp folder, not installed
    launches = [ln for ln in s.splitlines() if ("XScript\" --" in ln or ln.strip().startswith("open -n")) and "--" in ln]
    assert launches and all("--data-dir" in ln for ln in launches)
    assert "/Applications/XScript" not in s and "pwd -P" in s


def test_release_workflow_desktop_feed_rules():
    wf = (PKG.parents[2] / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
    dry = wf.split("\n  desktop-update-feed:\n")[1].split("\n  perf-apk:\n")[0]
    assert "if: github.event_name != 'push'" in dry and "contents: read" in dry
    assert "secrets." not in dry and "--new-key" in dry and 'rm -f "$RUNNER_TEMP/throwaway.key"' in dry
    rel = wf.split("\n  release:\n")[1]
    assert "needs: [verify, desktop, desktop-windows]" in rel
    feed = rel.split("Desktop update feed (only with")[1].split("- name:")[0]
    assert "UK: ${{ secrets.DESKTOP_UPDATE_KEY }}" in feed and "UPDATE_PUBLIC_KEYS" in feed and "umask 077" in feed
    assert "echo \"$UK\"" not in feed and 'rm -f "$RUNNER_TEMP/update.key"' in feed
    assert "windows-x64-setup.exe" in rel.split("gh release create")[1]
