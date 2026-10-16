"""Windows logic *simulated* on any OS (platform strings + monkeypatching). This is NOT Windows verification: every real Windows
behaviour stays "⚠ 未验证" in the design (§14.9, W-01…W-18) until it runs on a Windows machine / CI runner."""
from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

import pytest

from xscript_desktop.main import default_data_dir
from xscript_desktop.services import adb as adb_mod
from xscript_desktop.services.adb import AdbService, candidate_adb_paths, find_adb
from xscript_desktop.services.device_client import DeviceTarget
from xscript_desktop.services.project_names import validate_project_name


def test_windows_candidate_order_and_exe_suffix():
    env = {"XSCRIPT_ADB": r"C:\tools\adb.exe", "ANDROID_HOME": r"C:\Android", "LOCALAPPDATA": r"C:\Users\d\AppData\Local", "USERPROFILE": r"C:\Users\d"}
    c = [str(p) for p in candidate_adb_paths(env, "win32")]
    assert c[0].endswith("adb.exe") and all(p.endswith("adb.exe") for p in c)
    assert any("XScript" in p and "platform-tools" in p for p in c)  # our own download dir comes before the SDK default
    assert c.index(next(p for p in c if "XScript" in p)) < c.index(next(p for p in c if p.endswith("Sdk/platform-tools/adb.exe") or p.endswith("Sdk\\platform-tools\\adb.exe")))


def test_find_adb_picks_adb_exe_on_a_windows_layout(tmp_path):
    pt = tmp_path / "Android" / "Sdk" / "platform-tools"
    pt.mkdir(parents=True)
    (pt / "adb.exe").write_text("")
    env = {"LOCALAPPDATA": str(tmp_path), "PATH": ""}
    found = find_adb(None, env, "win32")
    assert found and Path(found).name == "adb.exe"


def test_default_data_dir_windows(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", "/c/Users/d/AppData/Local")
    assert default_data_dir() == Path("/c/Users/d/AppData/Local") / "XScript"
    monkeypatch.delenv("LOCALAPPDATA")
    assert default_data_dir().parts[-3:] == ("AppData", "Local", "XScript")


async def test_windows_spawn_uses_create_no_window(monkeypatch, tmp_path):
    """On win32 the adb child must not flash a console window (design §5.2 / W-06). Simulated: we only check the kwargs."""
    seen = {}

    class P:
        returncode = 0

        async def communicate(self):
            return b"Android Debug Bridge version 1.0.41\n", b""

    async def fake_exec(*argv, **kw):
        seen.update(kw)
        return P()

    exe = tmp_path / "adb"
    exe.write_text("")
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(subprocess, "CREATE_NO_WINDOW", 0x08000000, raising=False)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    assert (await AdbService(str(exe)).version()).startswith("Android Debug Bridge")
    assert seen.get("creationflags") == 0x08000000 and seen["stdin"] == asyncio.subprocess.DEVNULL


@pytest.mark.parametrize("name,ok", [
    ("demo", True), ("我的脚本", True), ("my_project", True),
    ("CON", False), ("nul", False), ("COM1", False), ("lpt9", False), ("a.", False), ("a ", False), ("a<b", False), ("a:b", False), ("a|b", False),
])
def test_windows_reserved_names_are_rejected_by_the_project_name_rules(name, ok):
    assert bool(validate_project_name(name)) is ok


def test_ipv6_and_unc_looking_targets_do_not_crash_the_parser():
    assert DeviceTarget.parse(r"\\server\share").host  # garbage in, a target out (the connect attempt then fails cleanly)
    assert DeviceTarget.parse("[fe80::1%25eth0]:9860").port == 9860
