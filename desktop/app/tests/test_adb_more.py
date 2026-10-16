"""AdbService against a REAL subprocess (a tiny fake `adb` script), plus the command-whitelist guarantee (hard constraint:
never uninstall / clear data / shell / install from the desktop app in P0)."""
from __future__ import annotations

import inspect
import stat
import sys
from pathlib import Path

import pytest

from xscript_desktop.services import adb as adb_mod
from xscript_desktop.services.adb import AdbError, AdbService, find_adb, parse_devices

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell fake-adb scripts (Windows: see test_windows_sim.py)")


def make_adb(tmp_path: Path, body: str, name: str = "adb") -> Path:
    p = tmp_path / name
    p.write_text("#!/bin/sh\n" + body + "\n")
    p.chmod(p.stat().st_mode | stat.S_IXUSR)
    return p


async def test_real_subprocess_success_and_version(tmp_path):
    a = make_adb(tmp_path, 'echo "Android Debug Bridge version 1.0.41"; echo second line')
    s = AdbService(str(a))
    assert await s.version() == "Android Debug Bridge version 1.0.41"


async def test_real_subprocess_nonzero_exit_is_adb_failed_with_stderr(tmp_path):
    a = make_adb(tmp_path, 'echo "error: device offline" >&2; exit 1')
    with pytest.raises(AdbError) as e:
        await AdbService(str(a)).devices()
    assert e.value.code == "adb.failed" and "device offline" in e.value.message and e.value.details["returncode"] == 1


async def test_real_subprocess_empty_stderr_falls_back_to_exit_code(tmp_path):
    a = make_adb(tmp_path, "exit 3")
    with pytest.raises(AdbError) as e:
        await AdbService(str(a)).devices()
    assert "exited with 3" in e.value.message


async def test_real_subprocess_timeout_kills_the_child(tmp_path):
    a = make_adb(tmp_path, "sleep 30")
    with pytest.raises(AdbError) as e:
        await AdbService(str(a))._run(["devices"], timeout=0.3)
    assert e.value.code == "adb.timeout"


async def test_spawn_failure_is_adb_spawn(tmp_path):
    p = tmp_path / "adb"
    p.write_text("not executable")  # exists (so find_adb accepts it) but cannot be exec'd
    with pytest.raises(AdbError) as e:
        await AdbService(str(p)).version()
    assert e.value.code == "adb.spawn"


async def test_adb_missing_from_every_place(monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", str(tmp_path))
    for k in ("XSCRIPT_ADB", "ANDROID_HOME", "ANDROID_SDK_ROOT"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    s = AdbService()
    assert s.path() is None
    with pytest.raises(AdbError) as e:
        await s.devices()
    assert e.value.code == "adb.not_found" and "platform-tools" in e.value.message


async def test_configured_path_that_does_not_exist_is_not_found(tmp_path):
    assert find_adb(str(tmp_path / "nope")) is None
    s = AdbService(str(tmp_path / "nope"))
    with pytest.raises(AdbError):
        await s.version()
    s.set_path(None)  # back to auto-detection (whatever it finds, no crash)
    s.path()


async def test_forward_with_no_port_in_output_is_an_error(tmp_path):
    a = make_adb(tmp_path, "exit 0")  # prints nothing for `forward tcp:0 tcp:9860`
    with pytest.raises(AdbError) as e:
        await AdbService(str(a)).forward("emulator-5554")
    assert e.value.code == "adb.forward"


async def test_forward_explicit_port_with_silent_adb(tmp_path):
    a = make_adb(tmp_path, "exit 0")
    fw = await AdbService(str(a)).forward("emulator-5554", local_port=19860)
    assert fw.local_port == 19860


@pytest.mark.parametrize("serial", ["", "-a", "--help"])
async def test_forward_rejects_option_like_serials(serial, tmp_path):
    with pytest.raises(AdbError) as e:
        await AdbService(str(make_adb(tmp_path, "exit 0"))).forward(serial)
    assert e.value.code == "adb.bad_serial"


@pytest.mark.parametrize("remote,local", [(0, 0), (70000, 0), (9860, -1), (9860, 70000)])
async def test_forward_rejects_bad_ports(remote, local, tmp_path):
    with pytest.raises(AdbError) as e:
        await AdbService(str(make_adb(tmp_path, "exit 0"))).forward("emulator-5554", remote, local)
    assert e.value.code == "adb.bad_port"


async def test_remove_forward_failure_still_forgets_it_and_cleanup_swallows(tmp_path):
    a = make_adb(tmp_path, 'case "$*" in *--remove*) echo "error: gone" >&2; exit 1;; *) echo 41234;; esac')
    s = AdbService(str(a))
    fw = await s.forward("emulator-5554")
    with pytest.raises(AdbError):
        await s.remove_forward("emulator-5554", fw.local_port)
    assert s.our_forwards() == []  # forgotten even though adb failed (device already gone)
    await s.forward("emulator-5554")
    await s.cleanup()  # must not raise
    assert s.our_forwards() == []


def test_parse_devices_tolerates_daemon_noise_and_odd_lines():
    out = ("* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n"
           "emulator-5554\tdevice product:sdk_gphone model:sdk_gphone16k_arm64 device:emu64a16k transport_id:1\n"
           "0123456789ABCDEF\tunauthorized transport_id:2\n\n   \nR58M\toffline\n")
    d = parse_devices(out)
    assert [(x.serial, x.state) for x in d] == [("emulator-5554", "device"), ("0123456789ABCDEF", "unauthorized"), ("R58M", "offline")]
    assert d[0].is_emulator and d[0].model == "sdk_gphone16k_arm64" and not d[1].is_emulator
    assert d[0].to_dict()["transportId"] == "1"


def test_adb_service_only_ever_builds_whitelisted_commands():
    """The hard constraint is enforced structurally: the module has no wrapper for uninstall / pm clear / shell / install."""
    src = inspect.getsource(adb_mod)
    used = {"version", "devices", "forward"}
    for banned in ('"uninstall"', '"install"', '"shell"', '"clear"', '"pm"', '"push"', '"pull"', '"reboot"', '"root"', "'uninstall'", "'shell'"):
        assert banned not in src, banned
    # every _run([...]) call starts with one of the allowed verbs (or `-s <serial> forward`)
    import re

    for m in re.finditer(r"self\._run\(\[([^\]]*)\]", src):
        first = m.group(1).split(",")[0].strip().strip('"')
        assert first in used | {"-s"}, m.group(0)
