from __future__ import annotations

from pathlib import Path

import pytest

from xscript_desktop.services import adb as adb_mod
from xscript_desktop.services.adb import (AdbError, AdbService, bundled_adb_paths, candidate_adb_paths, find_adb,
                                          parse_devices)

from .conftest import FakeAdb  # type: ignore[attr-defined]

SAMPLE = """* daemon not running; starting now at tcp:5037
* daemon started successfully
List of devices attached
emulator-5554          device product:sdk_gphone16k_arm64 model:sdk_gphone16k_arm64 device:emu64a16k transport_id:1
emulator-5556          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:2
R5CT123ABC             unauthorized transport_id:3
192.168.1.20:5555      offline

"""


def test_parse_devices():
    devs = parse_devices(SAMPLE)
    assert [d.serial for d in devs] == ["emulator-5554", "emulator-5556", "R5CT123ABC", "192.168.1.20:5555"]
    assert [d.state for d in devs] == ["device", "device", "unauthorized", "offline"]
    assert devs[0].is_emulator and devs[0].model == "sdk_gphone16k_arm64" and devs[0].transport_id == "1"
    assert not devs[2].is_emulator


def test_parse_devices_empty():
    assert parse_devices("List of devices attached\n\n") == []


def test_find_adb_explicit_and_missing(tmp_path: Path):
    exe = tmp_path / "adb"
    exe.write_text("#!/bin/sh\n")
    assert find_adb(str(exe)) == str(exe)
    assert find_adb(str(tmp_path / "nope")) is None


def test_find_adb_env_sdk_and_priority(tmp_path: Path):
    sdk = tmp_path / "sdk" / "platform-tools"
    sdk.mkdir(parents=True)
    (sdk / "adb").write_text("")
    assert find_adb(None, {"ANDROID_HOME": str(tmp_path / "sdk"), "PATH": ""}, "linux") == str(sdk / "adb")
    other = tmp_path / "other-adb"
    other.write_text("")
    assert find_adb(None, {"XSCRIPT_ADB": str(other), "ANDROID_HOME": str(tmp_path / "sdk"), "PATH": ""}, "linux") == str(other)


def test_candidate_paths_windows_shape():
    # path *construction* only; ⚠ not run on Windows
    c = candidate_adb_paths({"LOCALAPPDATA": r"C:\Users\u\AppData\Local", "USERPROFILE": r"C:\Users\u"}, "win32")
    names = [p.name for p in c]
    assert names and all(n == "adb.exe" for n in names)


def _bundle(tmp_path: Path, exe: str = "adb") -> Path:
    """A fake PyInstaller payload dir (sys._MEIPASS) with platform-tools/<exe> in it."""
    root = tmp_path / "bundle"
    (root / "platform-tools").mkdir(parents=True)
    (root / "platform-tools" / exe).write_text("")
    return root


def test_bundled_adb_only_in_a_frozen_build(tmp_path: Path):
    root = _bundle(tmp_path)
    assert bundled_adb_paths("darwin", frozen=False, bundle_dir=root) == []
    assert bundled_adb_paths("darwin", frozen=True, bundle_dir=root) == [root / "platform-tools" / "adb"]
    assert bundled_adb_paths("win32", frozen=True, bundle_dir=root) == [root / "platform-tools" / "adb.exe"]


def test_bundled_adb_defaults_to_meipass_then_the_executable_dir(monkeypatch, tmp_path: Path):
    assert bundled_adb_paths("linux") == []  # tests run from source: sys.frozen is not set
    monkeypatch.setattr(adb_mod.sys, "frozen", True, raising=False)
    monkeypatch.setattr(adb_mod.sys, "_MEIPASS", str(tmp_path / "meipass"), raising=False)
    assert bundled_adb_paths("linux") == [tmp_path / "meipass" / "platform-tools" / "adb"]
    monkeypatch.delattr(adb_mod.sys, "_MEIPASS")
    exe = tmp_path / "dist" / "XScript.exe"
    monkeypatch.setattr(adb_mod.sys, "executable", str(exe))
    assert bundled_adb_paths("win32") == [exe.resolve().parent / "platform-tools" / "adb.exe"]


def test_bundled_adb_is_preferred_over_sdk_defaults_and_path(tmp_path: Path):
    root = _bundle(tmp_path)
    bundled = bundled_adb_paths("linux", frozen=True, bundle_dir=root)
    sdk = tmp_path / "sdk" / "platform-tools"
    sdk.mkdir(parents=True)
    (sdk / "adb").write_text("")
    on_path = tmp_path / "bin"
    on_path.mkdir()
    (on_path / "adb").write_text("")
    (on_path / "adb").chmod(0o755)
    home = tmp_path / "home" / "Android" / "Sdk" / "platform-tools"
    home.mkdir(parents=True)
    (home / "adb").write_text("")
    env = {"ANDROID_HOME": str(tmp_path / "sdk"), "HOME": str(tmp_path / "home"), "PATH": str(on_path)}
    assert find_adb(None, env, "linux", bundled) == str(root / "platform-tools" / "adb")
    # the explicit setting and XSCRIPT_ADB still win over the bundled one
    mine = tmp_path / "my-adb"
    mine.write_text("")
    assert find_adb(str(mine), env, "linux", bundled) == str(mine)
    assert find_adb(None, {**env, "XSCRIPT_ADB": str(mine)}, "linux", bundled) == str(mine)
    # order of the candidates: XSCRIPT_ADB, bundled, SDK env, per-OS default
    cands = candidate_adb_paths({**env, "XSCRIPT_ADB": str(mine)}, "linux", bundled)
    assert cands == [mine, root / "platform-tools" / "adb", sdk / "adb", home / "adb"]


def test_missing_bundled_adb_falls_back_to_sdk_then_path(tmp_path: Path):
    gone = [tmp_path / "bundle" / "platform-tools" / "adb"]  # a frozen build whose platform-tools was stripped
    sdk = tmp_path / "sdk" / "platform-tools"
    sdk.mkdir(parents=True)
    (sdk / "adb").write_text("")
    assert find_adb(None, {"ANDROID_HOME": str(tmp_path / "sdk"), "PATH": ""}, "linux", gone) == str(sdk / "adb")
    # PATH lookup goes through shutil.which, which only finds "adb.exe" on a Windows host
    plat, exe = ("win32", "adb.exe") if adb_mod.sys.platform == "win32" else ("linux", "adb")
    on_path = tmp_path / "bin"
    on_path.mkdir()
    (on_path / exe).write_text("")
    (on_path / exe).chmod(0o755)
    found = find_adb(None, {"HOME": str(tmp_path / "nohome"), "PATH": str(on_path)}, plat, gone)
    assert found is not None and Path(found) == on_path / exe


def test_service_uses_the_bundled_adb_of_a_frozen_build(monkeypatch, tmp_path: Path):
    exe = "adb.exe" if adb_mod.sys.platform == "win32" else "adb"
    root = _bundle(tmp_path, exe)
    for k in ("XSCRIPT_ADB", "ANDROID_HOME", "ANDROID_SDK_ROOT"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("PATH", "")
    monkeypatch.setattr(adb_mod.sys, "frozen", True, raising=False)
    monkeypatch.setattr(adb_mod.sys, "_MEIPASS", str(root), raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    assert AdbService().path() == str(root / "platform-tools" / exe)


async def test_devices_and_forward_lifecycle():
    fake = FakeAdb([("emulator-5554", "device", 1234)])
    adb = AdbService(runner=fake)
    assert (await adb.devices())[0].serial == "emulator-5554"
    fw = await adb.forward("emulator-5554")
    assert fw.local_port == 41000 and fw.remote_port == 9860
    assert ["-s", "emulator-5554", "forward", "tcp:0", "tcp:9860"] in fake.calls
    assert await adb.remove_forward("emulator-5554", 41000) is True
    assert fake.forwards == {}


async def test_never_removes_foreign_forwards():
    fake = FakeAdb([("emulator-5554", "device", 1234)])
    fake.forwards[19860] = ("emulator-5554", 9860)  # e.g. created by the VS Code extension
    adb = AdbService(runner=fake)
    assert await adb.remove_forward("emulator-5554", 19860) is False
    assert 19860 in fake.forwards
    await adb.cleanup()
    assert 19860 in fake.forwards


async def test_explicit_local_port():
    fake = FakeAdb([("emulator-5554", "device", 1234)])
    adb = AdbService(runner=fake)
    fw = await adb.forward("emulator-5554", 9860, 19877)
    assert fw.local_port == 19877


async def test_bad_serial_and_failures():
    adb = AdbService(runner=FakeAdb([]))
    with pytest.raises(AdbError) as e:
        await adb.forward("-evil")
    assert e.value.code == "adb.bad_serial"
    with pytest.raises(AdbError) as e:
        await adb.remove_forward("x", 1) or await adb._run(["bogus"])
    assert e.value.code == "adb.failed"


async def test_adb_not_found(monkeypatch):
    monkeypatch.setenv("PATH", "")
    monkeypatch.delenv("XSCRIPT_ADB", raising=False)
    monkeypatch.delenv("ANDROID_HOME", raising=False)
    monkeypatch.delenv("ANDROID_SDK_ROOT", raising=False)
    monkeypatch.setenv("HOME", "/nonexistent-home")
    adb = AdbService()
    with pytest.raises(AdbError) as e:
        await adb.devices()
    assert e.value.code == "adb.not_found"
