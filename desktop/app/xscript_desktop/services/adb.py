"""AdbService: locate adb, list devices, create/remove `adb forward` (design §5.2).

Rules that matter (they come from the task's hard constraints, not just taste):
  * only `devices`, `forward`, `forward --remove` and `get-state`-style read commands are issued from here;
    there is deliberately no `uninstall`, `pm clear`, `shell` or `install` wrapper in P0;
  * forwards are auto-allocated (`tcp:0`) unless the caller asks for a port, recorded, and only forwards *this
    process created* are ever removed (other tools' forwards, e.g. VS Code's 19860, are left alone).

⚠ Windows 未验证: the Windows search paths and CREATE_NO_WINDOW below follow Android SDK conventions but have not
been run on Windows.
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DEVICE_PORT = 9860
ADB_TIMEOUT = 15.0


class AdbError(Exception):
    def __init__(self, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


@dataclass
class AdbDevice:
    serial: str
    state: str  # device | offline | unauthorized | ...
    model: str = ""
    product: str = ""
    device: str = ""
    transport_id: str = ""
    is_emulator: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "serial": self.serial, "state": self.state, "model": self.model, "product": self.product,
            "device": self.device, "transportId": self.transport_id, "isEmulator": self.is_emulator,
        }


def _exe() -> str:
    return "adb.exe" if sys.platform == "win32" else "adb"


def candidate_adb_paths(env: dict[str, str] | None = None, platform: str | None = None) -> list[Path]:
    """Places to look for adb, in priority order (explicit config is handled by the caller)."""
    env = os.environ if env is None else env
    plat = platform or sys.platform
    exe = "adb.exe" if plat == "win32" else "adb"
    out: list[Path] = []
    for key in ("XSCRIPT_ADB",):
        if env.get(key):
            out.append(Path(env[key]))
    for key in ("ANDROID_SDK_ROOT", "ANDROID_HOME"):
        if env.get(key):
            out.append(Path(env[key]) / "platform-tools" / exe)
    home = Path(env.get("HOME") or env.get("USERPROFILE") or "~").expanduser()
    if plat == "darwin":
        out.append(home / "Library" / "Android" / "sdk" / "platform-tools" / exe)
    elif plat == "win32":
        local = env.get("LOCALAPPDATA")
        if local:
            out.append(Path(local) / "XScript" / "platform-tools" / exe)  # design §5.2: our own download dir
            out.append(Path(local) / "Android" / "Sdk" / "platform-tools" / exe)
    else:
        out.append(home / "Android" / "Sdk" / "platform-tools" / exe)
    return out


def find_adb(configured: str | None = None, env: dict[str, str] | None = None, platform: str | None = None) -> str | None:
    """Return a usable adb path or None. Explicit setting > XSCRIPT_ADB/SDK env > PATH > per-OS default dirs."""
    if configured:
        p = Path(configured).expanduser()
        return str(p) if p.is_file() else None
    cands = candidate_adb_paths(env, platform)
    for p in cands:
        if p.is_file():
            return str(p)
    on_path = shutil.which("adb.exe" if (platform or sys.platform) == "win32" else "adb", path=(env or os.environ).get("PATH"))
    return on_path


_DEV_LINE = re.compile(r"^(?P<serial>\S+)\s+(?P<state>\S+)(?P<rest>.*)$")


def parse_devices(output: str) -> list[AdbDevice]:
    """Parse `adb devices -l`. Tolerates the daemon start-up noise lines."""
    devices: list[AdbDevice] = []
    for line in output.splitlines():
        line = line.strip()
        if not line or line.startswith("List of devices") or line.startswith("*"):
            continue
        m = _DEV_LINE.match(line)
        if not m:
            continue
        kv = dict(part.split(":", 1) for part in m.group("rest").split() if ":" in part)
        serial = m.group("serial")
        devices.append(AdbDevice(
            serial=serial, state=m.group("state"), model=kv.get("model", ""), product=kv.get("product", ""),
            device=kv.get("device", ""), transport_id=kv.get("transport_id", ""), is_emulator=serial.startswith("emulator-"),
        ))
    return devices


@dataclass
class Forward:
    serial: str
    local_port: int
    remote_port: int
    created_by_us: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {"serial": self.serial, "localPort": self.local_port, "remotePort": self.remote_port}


class AdbService:
    def __init__(self, adb_path: str | None = None, runner: Any = None) -> None:
        self._configured = adb_path
        self._runner = runner  # test seam: async (argv: list[str]) -> (returncode, stdout, stderr)
        self._forwards: dict[tuple[str, int], Forward] = {}  # (serial, local_port) -> Forward

    # ---- locating and running adb ----------------------------------------------------------------------------------

    def set_path(self, path: str | None) -> None:
        self._configured = path or None

    def path(self) -> str | None:
        return find_adb(self._configured)

    async def _run(self, args: list[str], timeout: float = ADB_TIMEOUT) -> str:
        exe = self.path() or ("adb" if self._runner is not None else None)
        if exe is None:
            raise AdbError("adb.not_found", "找不到 adb。请安装 Android platform-tools，或在设置里指定 adb 路径（环境变量 XSCRIPT_ADB / ANDROID_HOME）。")
        argv = [exe, *args]
        if self._runner is not None:
            rc, out, err = await self._runner(argv)
        else:
            kwargs: dict[str, Any] = {}
            if sys.platform == "win32":  # ⚠ Windows 未验证
                kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            try:
                proc = await asyncio.create_subprocess_exec(
                    *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **kwargs)
            except OSError as e:
                raise AdbError("adb.spawn", "无法启动 adb: %s" % e) from e
            try:
                o, e = await asyncio.wait_for(proc.communicate(), timeout)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                raise AdbError("adb.timeout", "adb %s 超时（%ds）" % (" ".join(args[:3]), int(timeout))) from None
            rc, out, err = proc.returncode, o.decode("utf-8", "replace"), e.decode("utf-8", "replace")
        if rc != 0:
            raise AdbError("adb.failed", (err or out).strip() or "adb exited with %s" % rc, {"args": args, "returncode": rc})
        return out

    # ---- queries --------------------------------------------------------------------------------------------------------

    async def version(self) -> str:
        out = await self._run(["version"])
        return out.strip().splitlines()[0] if out.strip() else ""

    async def devices(self) -> list[AdbDevice]:
        return parse_devices(await self._run(["devices", "-l"]))

    # ---- forwards -------------------------------------------------------------------------------------------------------

    async def forward(self, serial: str, remote_port: int = DEVICE_PORT, local_port: int = 0) -> Forward:
        """`adb -s <serial> forward tcp:<local> tcp:<remote>`; local_port=0 lets adb pick a free port."""
        if not serial or serial.startswith("-"):
            raise AdbError("adb.bad_serial", "invalid adb serial: %r" % serial)
        if not (0 <= local_port <= 65535) or not (0 < remote_port <= 65535):
            raise AdbError("adb.bad_port", "port out of range")
        out = await self._run(["-s", serial, "forward", "tcp:%d" % local_port, "tcp:%d" % remote_port])
        # `adb forward tcp:0 ...` prints the allocated port; an explicit port prints nothing (older adb) or the port.
        m = re.search(r"\d+", out)
        port = int(m.group()) if m else local_port
        if port == 0:
            raise AdbError("adb.forward", "adb forward did not report a local port: %r" % out)
        fw = Forward(serial=serial, local_port=port, remote_port=remote_port)
        self._forwards[(serial, port)] = fw
        return fw

    async def remove_forward(self, serial: str, local_port: int) -> bool:
        """Remove a forward this process created. Returns False (and does nothing) for a foreign forward."""
        fw = self._forwards.get((serial, local_port))
        if fw is None:
            return False
        try:
            await self._run(["-s", serial, "forward", "--remove", "tcp:%d" % local_port])
        finally:
            self._forwards.pop((serial, local_port), None)
        return True

    def our_forwards(self) -> list[Forward]:
        return list(self._forwards.values())

    async def cleanup(self) -> None:
        """Remove every forward this process created (called on exit)."""
        for (serial, port) in list(self._forwards):
            try:
                await self.remove_forward(serial, port)
            except AdbError:
                pass
