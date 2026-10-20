from __future__ import annotations

import importlib.util
import json
import socket
import sys
import threading
from pathlib import Path

import pytest

from .fake_device import FakeDevice

REPO = Path(__file__).resolve().parents[3]


def _load_mock_device():
    spec = importlib.util.spec_from_file_location("mock_device", REPO / "scripts" / "mock_device.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["mock_device"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def mock_device():
    """scripts/mock_device.py (the repo's in-process fake of protocol/openapi.yaml) on a random loopback port."""
    mod = _load_mock_device()
    httpd = mod.serve("127.0.0.1", 0)
    try:
        yield httpd.server_address[1]
    finally:
        httpd.shutdown()
        httpd.server_close()


@pytest.fixture()
def paired_mock_device():
    """mock_device with pairing on (the phone's default), code ABCD-EFGH."""
    mod = _load_mock_device()
    httpd = mod.serve("127.0.0.1", 0, token="ABCDEFGH")
    try:
        yield httpd.server_address[1]
    finally:
        httpd.shutdown()
        httpd.server_close()


def _one_line_server(line: str) -> int:
    """A loopback TCP server that answers every connection with `line` and closes; returns its port."""
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()

    def loop() -> None:
        while True:
            try:
                conn, _ = srv.accept()
            except OSError:
                return
            with conn:
                conn.sendall((line + "\n").encode())

    threading.Thread(target=loop, daemon=True).start()
    return srv.getsockname()[1]


class FakeAdb:
    """An `adb` stand-in: `devices -l` and `forward` against a list of (serial, state, port-of-a-local-server)."""

    def __init__(self, devices: list[tuple[str, str, int]]):
        self.devices = devices
        self.calls: list[list[str]] = []
        self.forwards: dict[int, tuple[str, int]] = {}
        self._next = 41000
        # serial -> pairing code the app's provider answers with (`adb shell content query ...pairing/code`)
        self.pairing: dict[str, str] = {}

    async def __call__(self, argv: list[str]):
        args = argv[1:]
        self.calls.append(args)
        if args[:2] == ["devices", "-l"]:
            lines = ["List of devices attached"]
            for serial, state, _ in self.devices:
                lines.append("%s          %s product:sdk model:Pixel_Fake device:generic transport_id:1" % (serial, state))
            return 0, "\n".join(lines) + "\n\n", ""
        if args[0] == "-s" and args[2] == "forward" and args[4].startswith("localabstract:"):
            # the app's pairing socket: answer like the phone does for the adb uid (no app -> adb errors out)
            code = self.pairing.get(args[1])
            if code is None:
                return 1, "", "error: cannot bind listener: connection refused"
            port = _one_line_server(json.dumps({"required": True, "code": code}))
            self.forwards[port] = (args[1], 0)
            return 0, "%d\n" % port, ""
        if args[0] == "-s" and args[2] == "forward" and args[3] == "--remove":
            port = int(args[4].split(":")[1])
            if port not in self.forwards:
                return 1, "", "error: listener 'tcp:%d' not found" % port
            del self.forwards[port]
            return 0, "", ""
        if args[0] == "-s" and args[2] == "forward":
            serial = args[1]
            local = int(args[3].split(":")[1])
            remote = int(args[4].split(":")[1])
            target = next(p for s, _, p in self.devices if s == serial)
            if local == 0:
                local = self._next
                self._next += 1
            self.forwards[local] = (serial, remote)
            self.target_for = getattr(self, "target_for", {})
            self.target_for[local] = target
            return 0, "%d\n" % local, ""
        if args[0] == "version":
            return 0, "Android Debug Bridge version 1.0.41\n", ""
        return 1, "", "unsupported in FakeAdb: %r" % args


@pytest.fixture()
def fake_device():
    """tests/fake_device.py: deterministic device that can misbehave (`fake_device.mode = "bad_json"` …)."""
    d = FakeDevice()
    try:
        yield d
    finally:
        d.close()
