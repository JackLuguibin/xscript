"""Diagnostics bundle (P5.5): redaction, the zip, the log file and the RPC."""
import io
import json
import logging
import logging.handlers
import zipfile

import pytest

from xscript_desktop.context import AppContext
from xscript_desktop.services import diagnostics as D


@pytest.mark.parametrize("raw,leak", [
    ("token=xsk_AbC123-_x and more", "xsk_AbC123"),
    ("Authorization: Bearer eyJhbGciOi.JIUzI1.NiJ9", "eyJhbGciOi"),
    ('{"api_key": "sk-live-123", "password":"hunter2"}', "hunter2"),
    ("pairing_code 482913 accepted", "482913"),
    ("pairing code: 482913", "482913"),
    ("Pair-Code=482913", "482913"),
    ("XSCRIPT_UPDATE_PRIVATE_KEY=QUJDRA==", "QUJDRA=="),
    ("-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----", "MIIEv"),
    ("secret: s3cr3t;", "s3cr3t"),
])
def test_redact_removes_secrets(raw, leak):
    out = D.redact(raw, home="/Users/someone")
    assert leak not in out and "***" in out


def test_redact_keeps_normal_text_and_hides_home():
    s = "device emulator-5554 online at 127.0.0.1:9860; file /Users/someone/Desktop/p.py"
    assert D.redact(s, home="/Users/someone") == "device emulator-5554 online at 127.0.0.1:9860; file ~/Desktop/p.py"
    assert D.redact("x", home="/") == "x"


def test_build_zip(tmp_path):
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "desktop.log").write_text("a token=xsk_zzz line\n")
    big = logs / "desktop.log.1"
    big.write_bytes(b"x" * (D.MAX_LOG + 10) + b"\nlast line\n")
    data, names = D.build({"app": {"version": "1"}, "note": "Bearer abc.def", "home": str(tmp_path)},
                          D.log_files(tmp_path), home=str(tmp_path))
    z = zipfile.ZipFile(io.BytesIO(data))
    assert names == ["info.json", "logs/desktop.log", "logs/desktop.log.1", "README.txt"] == z.namelist()
    info = json.loads(z.read("info.json"))
    assert info["note"] == "Bearer ***" and info["home"] == "~"
    assert "xsk_zzz" not in z.read("logs/desktop.log").decode()
    tail = z.read("logs/desktop.log.1").decode()
    assert tail.startswith("[… 21 earlier bytes not included]") and tail.endswith("last line\n")
    assert D.log_files(None) == [] and D.log_files(tmp_path / "nope") == []


def test_add_file_log_is_idempotent(tmp_path):
    root = logging.getLogger()
    before = list(root.handlers)
    try:
        p = D.add_file_log(tmp_path)
        D.add_file_log(tmp_path)
        added = [h for h in root.handlers if h not in before]
        assert len(added) == 1 and isinstance(added[0], logging.handlers.RotatingFileHandler)
        logging.getLogger("xscript_desktop.test").warning("hello diagnostics")
        added[0].flush()
        assert "hello diagnostics" in p.read_text()
    finally:
        for h in [h for h in root.handlers if h not in before]:
            root.removeHandler(h)
            h.close()


async def _rpc(ctx, method):
    return json.loads(await ctx.dispatcher.handle(json.dumps({"id": 1, "method": method, "params": {}})))


async def test_rpc_writes_a_redacted_bundle(tmp_path):
    ctx = AppContext(data_dir=tmp_path / "data")
    (tmp_path / "data" / "logs").mkdir(parents=True)
    (tmp_path / "data" / "logs" / "desktop.log").write_text("connect with token=xsk_secretvalue\npairing code: 123456\n")
    assert (await _rpc(ctx, "app.diagnostics"))["error"]["code"] == "app.unavailable"
    asked = []

    async def cancel(*a):
        asked.append(a)
        return None
    ctx.save_file = cancel
    assert (await _rpc(ctx, "app.diagnostics"))["result"] == {"saved": False}
    assert asked[0][1].startswith("xscript-diagnostics-") and asked[0][2] == "Zip (*.zip)"

    async def choose(*a):
        return str(tmp_path / "out" / "diag")  # no extension: .zip is added
    (tmp_path / "out").mkdir()
    ctx.save_file = choose
    r = (await _rpc(ctx, "app.diagnostics"))["result"]
    assert r["saved"] and r["path"].endswith("diag.zip") and r["files"][:2] == ["info.json", "logs/desktop.log"]
    z = zipfile.ZipFile(r["path"])
    everything = "".join(z.read(n).decode() for n in z.namelist())
    assert "xsk_secretvalue" not in everything and "123456" not in everything
    info = json.loads(z.read("info.json"))
    assert info["app"]["version"] and info["platform"]["python"] and info["devices"]["connected"] == 0
    assert info["cloud"] == {"configured": False} and info["update"]["configured"] in (True, False)
