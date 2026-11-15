"""Electron adapter for the signed-manifest updater; never guesses a sidecar as the app."""
from __future__ import annotations

import os
from pathlib import Path

from .updater import UpdateError, UpdateService


def electron_install(executable: Path, platform: str) -> Path | None:
    exe = executable.resolve()
    if platform == "darwin" and exe.parent.name == "MacOS" and exe.parent.parent.name == "Contents" and exe.parents[2].suffix == ".app":
        return exe.parents[2]
    if platform == "win32" and exe.name.lower() == "xscript.exe":
        return exe.parent
    return None


class ElectronUpdateService(UpdateService):
    def __init__(self, current, work_dir, *, executable: Path | None, parent_pid: int, platform: str, **kwargs):
        self.parent_pid = parent_pid
        super().__init__(current, work_dir, install=electron_install(executable, platform) if executable else None,
                         argv=kwargs.pop("argv", []), plat=platform, installer="nsis", **kwargs)

    def prepare_install(self, **kwargs):
        if self.parent_pid <= 1:
            raise UpdateError("Electron parent process is unavailable", "install")
        return super().prepare_install(pid=self.parent_pid, **kwargs)
