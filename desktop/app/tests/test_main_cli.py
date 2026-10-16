"""The real entry point, run as a child process (`python -m xscript_desktop ...`): --version, --selftest, --connect-adb,
--screenshot, timeouts. Needs the built frontend (`npm run build`) for everything except --version/parse_args.
Coverage of the child is collected through coverage's `patch = ["subprocess"]`."""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from xscript_desktop import __version__
from xscript_desktop.main import default_data_dir, parse_args

from .fake_device import FakeDevice
from .harness import have_build

APP = Path(__file__).resolve().parents[1]
needs_build = pytest.mark.skipif(not have_build(), reason="frontend not built (cd desktop/frontend && npm run build)")
posix = pytest.mark.skipif(sys.platform == "win32", reason="fake adb is a POSIX shell script")

FAKE_ADB = r"""#!/bin/sh
echo "$*" >> "$FAKE_ADB_LOG"
case "$*" in
  "devices -l") printf 'List of devices attached\nemulator-5554          device product:sdk model:Pixel_Fake device:generic transport_id:1\n\n';;
  *"forward --remove"*) ;;
  *forward*) echo "$FAKE_ADB_PORT";;
  version*) echo "Android Debug Bridge version 1.0.41";;
  *) echo "unsupported: $*" >&2; exit 1;;
esac
"""


def run_app(*args: str, env: dict | None = None, timeout: float = 90) -> subprocess.CompletedProcess:
    e = dict(os.environ, QT_QPA_PLATFORM="offscreen", QTWEBENGINE_CHROMIUM_FLAGS="--disable-gpu")
    e.update(env or {})
    return subprocess.run([sys.executable, "-m", "xscript_desktop", *args], cwd=APP, env=e, capture_output=True, text=True, timeout=timeout)


@pytest.fixture()
def fake_adb(tmp_path):
    fd = FakeDevice()
    exe = tmp_path / "adb"
    exe.write_text(FAKE_ADB)
    exe.chmod(exe.stat().st_mode | stat.S_IXUSR)
    log = tmp_path / "adb.log"
    log.write_text("")
    yield exe, log, fd
    fd.close()


def test_parse_args_defaults_and_flags():
    a = parse_args([])
    assert not a.selftest and a.dev_url is None and a.adb is None and a.timeout == 30.0 and a.screenshot_delay == 2.5
    a = parse_args(["--selftest", "--adb", "/x/adb", "--connect-adb", "emulator-5554", "--timeout", "5", "--data-dir", "/d", "--click-screenshot"])
    assert a.selftest and a.adb == "/x/adb" and a.connect_adb == "emulator-5554" and a.timeout == 5 and a.data_dir == "/d" and a.click_screenshot


def test_parse_args_unknown_flag_exits_2(capsys):
    with pytest.raises(SystemExit) as e:
        parse_args(["--nope"])
    assert e.value.code == 2


@pytest.mark.parametrize("plat,env,expected", [
    ("darwin", {}, ("Library", "Application Support", "XScript")),
    ("linux", {"XDG_DATA_HOME": "/xdg"}, ("/xdg", "xscript")),
    ("linux", {"XDG_DATA_HOME": ""}, (".local", "share", "xscript")),
])
def test_default_data_dir(monkeypatch, plat, env, expected):
    monkeypatch.setattr(sys, "platform", plat)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    p = default_data_dir()
    assert str(p).endswith(os.path.join(*expected).lstrip("/")) or str(p) == os.path.join(*expected)


def test_version_flag():
    r = run_app("--version")
    assert r.returncode == 0 and r.stdout.strip() == "xscript-desktop " + __version__


@needs_build
def test_selftest_passes_with_one_bridge_roundtrip():
    r = run_app("--selftest", "--timeout", "40")
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout.strip().splitlines()[-1]) == {"selftest": "ok", "version": __version__, "page": "loaded", "bridge": "roundtrip"}


@needs_build
def test_selftest_times_out_with_exit_1_when_the_page_never_says_hello():
    r = run_app("--selftest", "--timeout", "0.05")  # too short for the page to boot
    assert r.returncode == 1 and "timeout" in r.stderr


@needs_build
@posix
def test_selftest_connect_adb_reports_device_and_removes_its_forward(fake_adb):
    exe, log, fd = fake_adb
    r = run_app("--selftest", "--adb", str(exe), "--connect-adb", "emulator-5554", "--timeout", "40",
                env={"FAKE_ADB_LOG": str(log), "FAKE_ADB_PORT": str(fd.port)})
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out["selftest"] == "ok" and out["state"] == "online" and out["device"]["sdk"] == 37 and out["device"]["deviceId"] == "ae10e6ed9b09580c"
    calls = log.read_text().splitlines()
    assert any("forward tcp:0 tcp:9860" in c for c in calls)
    assert any("forward --remove" in c for c in calls), calls  # our forward is cleaned up at exit
    for banned in ("uninstall", "install", "shell", "pm clear", "push", "pull"):
        assert not any(banned in c for c in calls)


@needs_build
@posix
def test_selftest_connect_adb_unreachable_device_times_out_cleanly(fake_adb):
    exe, log, fd = fake_adb
    r = run_app("--selftest", "--adb", str(exe), "--connect-adb", "emulator-5554", "--timeout", "6",
                env={"FAKE_ADB_LOG": str(log), "FAKE_ADB_PORT": "1"})  # nothing listens on port 1
    assert r.returncode == 1 and "connect failed" in r.stderr
    assert any("forward --remove" in c for c in log.read_text().splitlines())  # the failed attempt cleaned up its forward


@needs_build
@posix
def test_screenshot_writes_a_png_of_the_window(fake_adb, tmp_path):
    exe, log, fd = fake_adb
    out = tmp_path / "shot.png"
    r = run_app("--screenshot", str(out), "--screenshot-delay", "1", "--adb", str(exe), "--connect-adb", "emulator-5554", "--click-screenshot",
                "--timeout", "40", env={"FAKE_ADB_LOG": str(log), "FAKE_ADB_PORT": str(fd.port)})
    assert r.returncode == 0, r.stderr
    assert out.read_bytes().startswith(b"\x89PNG") and out.stat().st_size > 5000
    assert any(p == "/screen?format=jpg&quality=60&max=360" or p.startswith("/screen") for _, p in fd.requests)
