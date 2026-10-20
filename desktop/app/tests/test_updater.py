"""Auto-update (P5.4): signed manifest, trusted keys, verified download, and the feed builder (all offline)."""
import base64
import hashlib
import json
import stat
import sys
from pathlib import Path

import httpx
import pytest

from xscript_desktop.services import updater as U

PKG = Path(__file__).resolve().parents[1] / "packaging"
sys.path.insert(0, str(PKG))
import make_update_feed as F  # noqa: E402

sys.path.pop(0)

FEED = "https://updates.example/x/desktop-update.json"
DMG = "xscript-desktop-v0.5.0-macos-arm64.dmg"
EXE = "xscript-desktop-v0.5.0-windows-x64-setup.exe"


@pytest.fixture()
def key(tmp_path):
    kf = tmp_path / "k"
    pub = F.new_key(kf)
    return kf.read_text(), base64.b64decode(pub)


def make_feed(tmp_path, key_text, version="0.5.0", payload=b"dmg-bytes" * 100, mutate=None, sig=None):
    f = tmp_path / ("xscript-desktop-v%s-macos-arm64.dmg" % version)
    f.write_bytes(payload)
    data = F.build(version, [f], notes={"zh": "修复", "en": "fixes"}, published="2026-10-20T00:00:00Z")
    if mutate:
        doc = json.loads(data)
        mutate(doc)
        data = json.dumps(doc).encode()
    return data, (sig if sig is not None else F.sign(data, key_text)), payload


def client_for(files: dict[str, bytes], status: dict[str, int] | None = None, log: list | None = None):
    def handler(req: httpx.Request) -> httpx.Response:
        if log is not None:
            log.append(str(req.url))
        name = req.url.path.rsplit("/", 1)[-1]
        if status and name in status:
            return httpx.Response(status[name])
        if name not in files:
            return httpx.Response(404)
        return httpx.Response(200, content=files[name])
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_platform_key():
    assert U.platform_key("darwin", "arm64") == "macos-arm64"
    assert U.platform_key("win32", "AMD64") == "windows-x64"
    assert U.platform_key("darwin", "x86_64") is None and U.platform_key("linux", "x86_64") is None
    assert U.platform_key() in ("macos-arm64", "windows-x64", None)


def test_versions():
    assert U.is_newer("0.4.1", "0.4.0") and U.is_newer("0.10.0", "0.9.9") and U.is_newer("1.0.0", "1.0.0-rc1")
    assert not U.is_newer("0.4.0", "0.4.0") and not U.is_newer("0.3.9", "0.4.0") and not U.is_newer("1.0.0-rc1", "1.0.0")
    assert U.is_newer("1.0.0-rc2", "1.0.0-rc1")
    for bad in ("", "1.2", "v1.2.3", "1.2.3.4", None):
        with pytest.raises((ValueError, TypeError)):
            U.parse_version(bad)


@pytest.mark.parametrize("url,ok", [
    ("https://github.com/a/b.json", True), ("http://127.0.0.1:8792/x.json", True), ("http://localhost/x", True),
    ("http://[::1]:1/x", True), ("http://example.com/x.json", False), ("ftp://h/x", False), ("https:///x", False),
    ("file:///etc/passwd", False),
])
def test_check_url(url, ok):
    if ok:
        assert U.check_url(url) == url
    else:
        with pytest.raises(U.UpdateError) as e:
            U.check_url(url)
        assert e.value.kind == "config"


def test_trusted_keys_and_feed_url(key):
    _, pub = key
    b64 = base64.b64encode(pub).decode()
    assert U.trusted_keys({}) == []  # the release build ships no key yet
    assert U.trusted_keys({"XSCRIPT_UPDATE_PUBKEY": " %s , " % b64}) == [pub]
    for bad in ("not base64!", base64.b64encode(b"short").decode()):
        with pytest.raises(U.UpdateError):
            U.trusted_keys({"XSCRIPT_UPDATE_PUBKEY": bad})
    assert U.feed_url({}) == U.DEFAULT_FEED
    assert U.feed_url({"XSCRIPT_UPDATE_FEED": "http://127.0.0.1:9/f.json"}) == "http://127.0.0.1:9/f.json"
    with pytest.raises(U.UpdateError):
        U.feed_url({"XSCRIPT_UPDATE_FEED": "http://evil.example/f.json"})


async def test_check_offers_a_newer_signed_version(tmp_path, key):
    ktext, pub = key
    data, sig, payload = make_feed(tmp_path, ktext)
    log = []
    async with client_for({"desktop-update.json": data, "desktop-update.json.sig": sig}, log=log) as c:
        u = await U.check("0.4.0", client=c, url=FEED, keys=[pub], key="macos-arm64")
    assert u.newer and u.version == "0.5.0" and u.notes == {"zh": "修复", "en": "fixes"}
    assert u.asset.url == "https://updates.example/x/" + DMG  # relative to the manifest
    assert u.asset.size == len(payload) and u.asset.sha256 == hashlib.sha256(payload).hexdigest()
    assert u.to_dict()["asset"] == {"name": DMG, "size": len(payload), "sha256": u.asset.sha256}
    assert log == [FEED, FEED + ".sig"]
    async with client_for({"desktop-update.json": data, "desktop-update.json.sig": sig}) as c:
        same = await U.check("0.5.0", client=c, url=FEED, keys=[pub], key="macos-arm64")
    assert not same.newer


async def test_check_refuses_unsigned_tampered_or_foreign_signatures(tmp_path, key):
    ktext, pub = key
    data, sig, _ = make_feed(tmp_path, ktext)
    F.new_key(tmp_path / "k2")
    other_text = (tmp_path / "k2").read_text()
    cases = {
        "tampered": (data.replace(b"0.5.0", b"0.9.0"), sig),
        "foreign": (data, F.sign(data, other_text)),
        "garbage": (data, b"!!!"),
        "empty": (data, b""),
    }
    for name, (d, s) in cases.items():
        async with client_for({"desktop-update.json": d, "desktop-update.json.sig": s}) as c:
            with pytest.raises(U.UpdateError) as e:
                await U.check("0.4.0", client=c, url=FEED, keys=[pub], key="macos-arm64")
        assert e.value.kind == "signature", name
    async with client_for({"desktop-update.json": data}) as c:  # no .sig at all
        with pytest.raises(U.UpdateError) as e:
            await U.check("0.4.0", client=c, url=FEED, keys=[pub], key="macos-arm64")
    assert e.value.kind == "network"
    async with client_for({}) as c:
        with pytest.raises(U.UpdateError) as e:
            await U.check("0.4.0", client=c, url=FEED, keys=[], key="macos-arm64")
    assert e.value.kind == "config"


@pytest.mark.parametrize("mutate,kind", [
    (lambda d: d.update(schema=2), "manifest"),
    (lambda d: d.update(product="other"), "manifest"),
    (lambda d: d.update(version="latest"), "manifest"),
    (lambda d: d["assets"].pop("macos-arm64"), "platform"),
    (lambda d: d["assets"]["macos-arm64"].update(name="../../evil.dmg"), "manifest"),
    (lambda d: d["assets"]["macos-arm64"].update(name=EXE), "manifest"),  # a Windows file for the Mac
    (lambda d: d["assets"]["macos-arm64"].update(size=0), "manifest"),
    (lambda d: d["assets"]["macos-arm64"].update(size=True), "manifest"),
    (lambda d: d["assets"]["macos-arm64"].update(sha256="ABC"), "manifest"),
    (lambda d: d["assets"]["macos-arm64"].update(url=5), "manifest"),
    (lambda d: d["assets"]["macos-arm64"].update(url="http://evil.example/" + DMG), "config"),
])
async def test_signed_but_invalid_manifests_are_refused(tmp_path, key, mutate, kind):
    ktext, pub = key
    data, sig, _ = make_feed(tmp_path, ktext, mutate=mutate)  # signed after mutating: only the content is wrong
    async with client_for({"desktop-update.json": data, "desktop-update.json.sig": sig}) as c:
        with pytest.raises(U.UpdateError) as e:
            await U.check("0.4.0", client=c, url=FEED, keys=[pub], key="macos-arm64")
    assert e.value.kind == kind


def test_parse_manifest_edge_cases(key):
    with pytest.raises(U.UpdateError):
        U.parse_manifest(b"\xff", FEED, "macos-arm64", "0.4.0")
    with pytest.raises(U.UpdateError):
        U.parse_manifest(b"[]", FEED, "macos-arm64", "0.4.0")
    doc = {"schema": 1, "product": U.PRODUCT, "version": "0.5.0", "notes": "plain", "assets": {
        "windows-x64": {"name": EXE, "size": 3, "sha256": "a" * 64}}}
    u = U.parse_manifest(json.dumps(doc).encode(), FEED, "windows-x64", "0.4.0")
    assert u.notes == {"zh": "plain", "en": "plain"} and u.asset.url.endswith("/x/" + EXE)
    doc["assets"] = []
    with pytest.raises(U.UpdateError):
        U.parse_manifest(json.dumps(doc).encode(), FEED, "windows-x64", "0.4.0")


async def test_check_errors(tmp_path, key, monkeypatch):
    ktext, pub = key
    async with client_for({}) as c:
        with pytest.raises(U.UpdateError) as e:
            await U.check("0.4.0", client=c, url=FEED, keys=[pub], key="macos-arm64")
    assert e.value.kind == "network" and "no update manifest" in str(e.value)
    async with client_for({}, status={"desktop-update.json": 500}) as c:
        with pytest.raises(U.UpdateError) as e:
            await U.check("0.4.0", client=c, url=FEED, keys=[pub], key="macos-arm64")
    assert e.value.kind == "network"
    big = b"x" * (U.MAX_MANIFEST + 1)
    async with client_for({"desktop-update.json": big, "desktop-update.json.sig": b"x"}) as c:
        with pytest.raises(U.UpdateError) as e:
            await U.check("0.4.0", client=c, url=FEED, keys=[pub], key="macos-arm64")
    assert e.value.kind == "manifest"
    monkeypatch.setattr(U, "platform_key", lambda: None)
    async with client_for({}) as c:
        with pytest.raises(U.UpdateError) as e:
            await U.check("0.4.0", client=c, url=FEED, keys=[pub])
    assert e.value.kind == "platform"
    monkeypatch.setenv("XSCRIPT_UPDATE_FEED", "http://evil.example/f.json")
    async with client_for({}) as c:
        with pytest.raises(U.UpdateError) as e:
            await U.check("0.4.0", client=c, keys=[pub], key="macos-arm64")
    assert e.value.kind == "config"
    monkeypatch.delenv("XSCRIPT_UPDATE_FEED")
    monkeypatch.delenv("XSCRIPT_UPDATE_PUBKEY", raising=False)
    async with client_for({}) as c:
        with pytest.raises(U.UpdateError) as e:
            await U.check("0.4.0", client=c, url=FEED, key="macos-arm64")  # release build: no trusted key
    assert e.value.kind == "config" and "not configured" in str(e.value)


async def test_download_keeps_only_a_matching_file(tmp_path, key):
    payload = b"x" * 200_000
    a = U.Asset(DMG, "https://updates.example/x/" + DMG, len(payload), hashlib.sha256(payload).hexdigest())
    seen = []
    async with client_for({DMG: payload}) as c:
        out = await U.download(a, tmp_path / "updates", client=c, progress=lambda n, t: seen.append((n, t)))
    assert out.read_bytes() == payload and out.name == DMG and seen[-1] == (len(payload), len(payload))
    assert not (tmp_path / "updates" / (DMG + ".part")).exists()

    for bad, why in ((b"y" * 200_000, "sha"), (b"x" * 100, "short"), (b"x" * 300_000, "long")):
        async with client_for({DMG: bad}) as c:
            with pytest.raises(U.UpdateError) as e:
                await U.download(a, tmp_path / ("bad-" + why), client=c)
        assert e.value.kind == "integrity", why
        assert not list((tmp_path / ("bad-" + why)).iterdir()), why  # nothing left behind
    async with client_for({}) as c:
        with pytest.raises(U.UpdateError) as e:
            await U.download(a, tmp_path / "missing", client=c)
    assert e.value.kind == "network" and not list((tmp_path / "missing").iterdir())
    with pytest.raises(U.UpdateError):
        await U.download(U.Asset("../x.dmg", a.url, 1, a.sha256), tmp_path, client=c)
    with pytest.raises(U.UpdateError):
        await U.download(U.Asset(DMG, "http://evil.example/" + DMG, 1, a.sha256), tmp_path, client=c)


def test_feed_builder_cli(tmp_path, capsys):
    kf = tmp_path / "key"
    assert F.main(["--new-key", str(kf)]) == 0
    pub = base64.b64decode(capsys.readouterr().out.strip())
    assert len(pub) == 32 and stat.S_IMODE(kf.stat().st_mode) == 0o600
    d = tmp_path / ("xscript-desktop-v0.5.0-macos-arm64.dmg")
    w = tmp_path / ("xscript-desktop-v0.5.0-windows-x64-setup.exe")
    d.write_bytes(b"d")
    w.write_bytes(b"ww")
    out = tmp_path / "feed"
    assert F.main([str(out), str(d), str(w), "--version", "0.5.0", "--key", str(kf), "--notes-zh", "中",
                   "--base-url", "https://h/r/"]) == 0
    data = (out / "desktop-update.json").read_bytes()
    U.verify_signature(data, (out / "desktop-update.json.sig").read_bytes(), [pub])
    doc = json.loads(data)
    assert doc["notes"] == {"zh": "中"} and doc["assets"]["windows-x64"]["url"] == "https://h/r/" + w.name
    assert doc["assets"]["macos-arm64"] == {"name": d.name, "url": "https://h/r/" + d.name, "size": 1,
                                            "sha256": hashlib.sha256(b"d").hexdigest()}
    assert "PRIVATE" not in capsys.readouterr().out and kf.read_text() not in data.decode()
    with pytest.raises(SystemExit):
        F.main([str(out), str(d), "--version", "0.6.0", "--key", str(kf)])  # file of another version
    with pytest.raises(SystemExit):
        F.main([str(out), "--version", "0.5.0"])
    with pytest.raises(SystemExit):
        F.load_key(base64.b64encode(b"short").decode())
    with pytest.raises(SystemExit):
        F.build("0.5.0", [])
