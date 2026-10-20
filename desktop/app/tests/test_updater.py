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
    assert len(pub) == 32
    if sys.platform != "win32":  # Windows has no POSIX mode bits
        assert stat.S_IMODE(kf.stat().st_mode) == 0o600
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


# ---- applying ------------------------------------------------------------------------------------------------------
import os  # noqa: E402
import subprocess  # noqa: E402
import types  # noqa: E402

from xscript_desktop.context import AppContext  # noqa: E402


def test_current_install(tmp_path):
    exe = tmp_path / "Apps" / "XScript.app" / "Contents" / "MacOS" / "XScript"
    exe.parent.mkdir(parents=True)
    exe.write_text("")
    assert U.current_install(str(exe), frozen=True, plat="darwin") == exe.parents[2].resolve()
    assert U.current_install(str(exe), frozen=False, plat="darwin") is None
    assert U.current_install(str(tmp_path / "python3"), frozen=True, plat="darwin") is None
    w = tmp_path / "XScript" / "XScript.exe"
    w.parent.mkdir()
    w.write_text("")
    assert U.current_install(str(w), frozen=True, plat="win32") is None  # not installed by Inno (no uninstaller)
    (w.parent / "unins000.exe").write_text("")
    assert U.current_install(str(w), frozen=True, plat="win32") == w.parent.resolve()
    assert U.current_install(str(w), frozen=True, plat="linux") is None
    assert U.current_install() is None  # the test run is a source checkout


def test_relaunch_args_keep_only_data_dir_and_adb():
    assert U.relaunch_args(["--update-now", "--data-dir", "/d x", "--selftest", "--adb=/a/adb", "--size", "1x1"]) == \
        ["--data-dir", "/d x", "--adb", "/a/adb"]
    assert U.relaunch_args(["--data-dir"]) == []


class FakeRun:
    """hdiutil/ditto/codesign/PlistBuddy stand-ins working on real folders."""

    def __init__(self, version="0.5.0", bundle_id=U.BUNDLE_ID, fail=None, has_app=True):
        self.version, self.bundle_id, self.fail, self.has_app, self.calls = version, bundle_id, fail, has_app, []

    def __call__(self, cmd, **kw):
        self.calls.append(cmd)
        tool = Path(cmd[0]).name
        if tool == "hdiutil" and cmd[1] == "attach":
            if self.fail == "attach":
                return types.SimpleNamespace(returncode=1, stdout="", stderr="corrupt image")
            mnt = Path(cmd[cmd.index("-mountpoint") + 1])
            if self.has_app:
                (mnt / "XScript.app" / "Contents").mkdir(parents=True)
        elif tool == "ditto":
            if self.fail == "ditto":
                return types.SimpleNamespace(returncode=1, stdout="", stderr="no space")
            import shutil
            shutil.copytree(cmd[-2], cmd[-1])
        elif tool == "hdiutil" and cmd[1] == "detach":
            import shutil
            shutil.rmtree(Path(cmd[-1]) / "XScript.app", ignore_errors=True)
        elif tool == "codesign" and self.fail == "codesign":
            return types.SimpleNamespace(returncode=1, stdout="", stderr="a sealed resource is missing")
        elif tool == "PlistBuddy":
            v = self.bundle_id if cmd[2].endswith("CFBundleIdentifier") else self.version
            return types.SimpleNamespace(returncode=0, stdout=v + "\n", stderr="")
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")


def test_stage_macos(tmp_path):
    bundle = tmp_path / "XScript.app"
    bundle.mkdir()
    dmg = tmp_path / DMG
    dmg.write_bytes(b"x")
    run = FakeRun()
    staged = U.stage_macos(dmg, bundle, "0.5.0", run=run)
    assert staged == tmp_path / ".XScript.app.update" and staged.is_dir()
    assert [Path(c[0]).name for c in run.calls] == ["hdiutil", "ditto", "hdiutil", "codesign", "PlistBuddy", "PlistBuddy"]
    assert run.calls[0][:5] == ["hdiutil", "attach", "-nobrowse", "-readonly", "-noautoopen"]
    assert run.calls[3] == ["codesign", "--verify", "--deep", "--strict", str(staged)]
    for fail, kw, msg in (("attach", {}, "cannot open the dmg"), ("ditto", {}, "cannot copy"), ("codesign", {}, "signature"),
                          (None, {"version": "0.4.9"}, "expected"), (None, {"bundle_id": "evil"}, "expected"),
                          (None, {"has_app": False}, "no XScript.app")):
        with pytest.raises(U.UpdateError) as e:
            U.stage_macos(dmg, bundle, "0.5.0", run=FakeRun(fail=fail, **kw))
        assert msg in str(e.value) and e.value.kind == "install"
        assert not (tmp_path / ".XScript.app.update").exists()  # never leaves a half-staged app


@pytest.mark.skipif(sys.platform == "win32", reason="bash helper")
def test_stage_macos_needs_a_writable_folder(tmp_path):
    ro = tmp_path / "ro"
    (ro / "XScript.app").mkdir(parents=True)
    ro.chmod(0o555)
    try:
        with pytest.raises(U.UpdateError) as e:
            U.stage_macos(tmp_path / DMG, ro / "XScript.app", "0.5.0", run=FakeRun())
        assert "cannot write" in str(e.value)
    finally:
        ro.chmod(0o755)


def _fake_open(tmp_path):
    bin_ = tmp_path / "bin"
    bin_.mkdir(exist_ok=True)
    (bin_ / "open").write_text('#!/bin/sh\necho "open $*" >> "%s"\n' % (tmp_path / "opened.txt"))
    (bin_ / "open").chmod(0o755)
    return dict(os.environ, PATH="%s:%s" % (bin_, os.environ["PATH"]))


@pytest.mark.skipif(sys.platform == "win32", reason="bash helper")
def test_macos_swap_script_swaps_and_relaunches(tmp_path):
    apps = tmp_path / "Apps dir"
    (apps / "XScript.app").mkdir(parents=True)
    (apps / "XScript.app" / "v").write_text("old")
    (apps / ".XScript.app.update").mkdir()
    (apps / ".XScript.app.update" / "v").write_text("new")
    p = subprocess.Popen(["true"])
    p.wait()  # a pid that has exited
    script = U.macos_swap_script(apps / "XScript.app", apps / ".XScript.app.update", p.pid, ["--data-dir", "/d x"])
    r = subprocess.run(["/bin/bash", "-c", script], env=_fake_open(tmp_path), capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (apps / "XScript.app" / "v").read_text() == "new"
    assert sorted(x.name for x in apps.iterdir()) == ["XScript.app"]  # old copy removed, nothing staged left
    assert (tmp_path / "opened.txt").read_text().strip() == "open -n %s --args --data-dir /d x" % (apps / "XScript.app")


@pytest.mark.skipif(sys.platform == "win32", reason="bash helper")
def test_macos_swap_script_waits_and_restores(tmp_path):
    apps = tmp_path / "a"
    (apps / "XScript.app").mkdir(parents=True)
    script = U.macos_swap_script(apps / "XScript.app", apps / ".XScript.app.update", os.getpid(), [])
    # this test process never exits: shorten the 120 s wait and check the helper gives up without touching anything
    script = script.replace("seq 1 240", "seq 1 2")
    r = subprocess.run(["/bin/bash", "-c", script], env=_fake_open(tmp_path), capture_output=True, text=True, timeout=30)
    assert r.returncode == 1 and "still running" in r.stdout and (apps / "XScript.app").is_dir()
    p = subprocess.Popen(["true"])
    p.wait()
    script = U.macos_swap_script(apps / "XScript.app", apps / ".XScript.app.update", p.pid, [])  # staged copy missing
    r = subprocess.run(["/bin/bash", "-c", script], env=_fake_open(tmp_path), capture_output=True, text=True, timeout=30)
    assert r.returncode == 1 and "old app restored" in r.stdout
    assert sorted(x.name for x in apps.iterdir()) == ["XScript.app"] and not (tmp_path / "opened.txt").exists()


def test_windows_install_script_text(tmp_path):
    s = U.windows_install_script(Path(r"C:\U\updates\x.exe"), Path(r"C:\U\Programs\XScript"), 4242, ["--data-dir", r'D:\d "x"'],
                                 Path(r"C:\U\updates\setup.log"))
    assert 'tasklist /FI "PID eq 4242"' in s and "if %n% gtr 240" in s
    assert r'"C:\U\updates\x.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /DIR="C:\U\Programs\XScript"' in s
    assert r'start "" "C:\U\Programs\XScript\XScript.exe" "--data-dir" "D:\d x"' in s  # quotes cannot break out


def test_launch_helper_detaches(tmp_path):
    calls = []
    U.launch_helper(tmp_path / "s.sh", tmp_path / "log", plat="darwin", popen=lambda *a, **k: calls.append((a, k)))
    U.launch_helper(tmp_path / "s.cmd", tmp_path / "log", plat="win32", popen=lambda *a, **k: calls.append((a, k)))
    (mac_a, mac_k), (win_a, win_k) = calls
    assert mac_a[0] == ["/bin/bash", str(tmp_path / "s.sh")] and mac_k["start_new_session"]
    assert win_a[0][:3] == ["cmd.exe", "/d", "/c"] and win_k["creationflags"] & 0x08000000


def _service(tmp_path, files, *, install=None, plat="darwin", env=None, current="0.4.0"):
    return U.UpdateService(current, lambda: tmp_path / "updates", client_factory=lambda: client_for(files),
                           env=env, install=install, argv=["--data-dir", "/d"], plat=plat)


async def test_update_service_flow(tmp_path, key, monkeypatch):
    ktext, pub = key
    data, sig, payload = make_feed(tmp_path, ktext)
    env = {"XSCRIPT_UPDATE_PUBKEY": base64.b64encode(pub).decode(), "XSCRIPT_UPDATE_FEED": FEED}
    files = {"desktop-update.json": data, "desktop-update.json.sig": sig, DMG: payload}
    monkeypatch.setattr(U, "platform_key", lambda *a: "macos-arm64")
    bundle = tmp_path / "Apps" / "XScript.app"
    bundle.mkdir(parents=True)
    s = _service(tmp_path, files, install=bundle, env=env)
    info = s.info()
    assert info["configured"] and info["canInstall"] and info["feed"] == FEED and info["state"] == "idle"
    with pytest.raises(U.UpdateError):
        await s.download()  # nothing checked yet
    with pytest.raises(U.UpdateError):
        s.prepare_install()
    st = await s.check()
    assert st["state"] == "available" and st["update"]["version"] == "0.5.0"
    st = await s.download()
    assert st["state"] == "ready" and st["progress"] == {"done": len(payload), "total": len(payload)}
    assert s.file == tmp_path / "updates" / DMG
    assert (await s.check())["state"] == "available"  # a re-check starts over
    await s.download()
    calls = []
    r = s.prepare_install(pid=4242, popen=lambda *a, **k: calls.append(a), run=FakeRun())
    assert r["state"] == "installing" and r["helperLog"].endswith("update-helper.log")
    script = (tmp_path / "updates" / "apply-update.sh").read_text()
    assert "kill -0 4242" in script and "--args --data-dir /d" in script and calls
    assert (await s.check())["state"] == "installing"  # no new check while installing


async def test_update_service_errors(tmp_path, key, monkeypatch):
    ktext, pub = key
    monkeypatch.setattr(U, "platform_key", lambda *a: "macos-arm64")
    assert _service(tmp_path, {}).info()["configured"] is False
    bad = _service(tmp_path, {}, env={"XSCRIPT_UPDATE_PUBKEY": "!!"}).info()
    assert bad["configured"] is False and "public key" in bad["configError"]
    st = await _service(tmp_path, {}, env={}).check()
    assert st["state"] == "error" and st["error"]["kind"] == "config"

    data, sig, payload = make_feed(tmp_path, ktext)
    env = {"XSCRIPT_UPDATE_PUBKEY": base64.b64encode(pub).decode(), "XSCRIPT_UPDATE_FEED": FEED}
    same = _service(tmp_path, {"desktop-update.json": data, "desktop-update.json.sig": sig}, env=env, current="0.5.0")
    assert (await same.check())["state"] == "none"
    with pytest.raises(U.UpdateError):
        await same.download()
    broken = _service(tmp_path, {"desktop-update.json": data, "desktop-update.json.sig": sig, DMG: b"tampered"}, env=env)
    await broken.check()
    st = await broken.download()
    assert st["state"] == "error" and st["error"]["kind"] == "integrity"

    files = {"desktop-update.json": data, "desktop-update.json.sig": sig, DMG: payload}
    src = _service(tmp_path, files, env=env, install=None)  # a source checkout cannot replace itself
    await src.check()
    await src.download()
    with pytest.raises(U.UpdateError) as e:
        src.prepare_install()
    assert e.value.kind == "install" and DMG in str(e.value)

    b = tmp_path / "B" / "XScript.app"
    b.mkdir(parents=True)
    changed = _service(tmp_path, files, env=env, install=b)
    await changed.check()
    await changed.download()
    changed.file.write_bytes(b"swapped on disk")
    with pytest.raises(U.UpdateError) as e:
        changed.prepare_install(popen=lambda *a, **k: None, run=FakeRun())
    assert e.value.kind == "integrity"

    staging = _service(tmp_path, files, env=env, install=b)
    await staging.check()
    await staging.download()
    with pytest.raises(U.UpdateError):
        staging.prepare_install(popen=lambda *a, **k: None, run=FakeRun(version="0.4.9"))
    assert staging.state == "error"

    linux = _service(tmp_path, files, env=env, install=b, plat="linux")
    await linux.check()
    await linux.download()
    with pytest.raises(U.UpdateError) as e:
        linux.prepare_install(popen=lambda *a, **k: None)
    assert e.value.kind == "platform"


async def test_update_service_windows_helper(tmp_path, key, monkeypatch):
    ktext, pub = key
    monkeypatch.setattr(U, "platform_key", lambda *a: "windows-x64")
    f = tmp_path / EXE
    f.write_bytes(b"setup" * 50)
    data = F.build("0.5.0", [f])
    sig = F.sign(data, ktext)
    env = {"XSCRIPT_UPDATE_PUBKEY": base64.b64encode(pub).decode(), "XSCRIPT_UPDATE_FEED": FEED}
    inst = tmp_path / "Programs" / "XScript"
    inst.mkdir(parents=True)
    s = _service(tmp_path, {"desktop-update.json": data, "desktop-update.json.sig": sig, EXE: f.read_bytes()}, env=env,
                 install=inst, plat="win32")
    await s.check()
    await s.download()
    calls = []
    s.prepare_install(pid=7, popen=lambda *a, **k: calls.append((a, k)))
    cmd = (tmp_path / "updates" / "apply-update.cmd").read_text(encoding="utf-8")
    assert '/DIR="%s"' % inst in cmd and "PID eq 7" in cmd and calls[0][0][0][0] == "cmd.exe"


async def _rpc(ctx, method):
    return json.loads(await ctx.dispatcher.handle(json.dumps({"id": 1, "method": method, "params": {}})))


async def test_rpc_update_methods(tmp_path, monkeypatch):
    monkeypatch.delenv("XSCRIPT_UPDATE_PUBKEY", raising=False)
    monkeypatch.delenv("XSCRIPT_UPDATE_FEED", raising=False)
    ctx = AppContext(data_dir=tmp_path)
    info = (await _rpc(ctx, "update.info"))["result"]
    assert info["configured"] is False and info["feed"] == U.DEFAULT_FEED and info["canInstall"] is False
    st = (await _rpc(ctx, "update.check"))["result"]
    assert st["state"] == "error" and st["error"]["kind"] == "config"
    assert (await _rpc(ctx, "update.status"))["result"]["state"] == "error"
    r = await _rpc(ctx, "update.download")
    assert r["error"]["code"] == "update.state"
    ctx.unsaved = True
    r = await _rpc(ctx, "update.install")
    assert r["error"]["code"] == "update.unsaved"
    ctx.unsaved = False
    quits = []
    ctx.quit_app = lambda: quits.append(1)
    r = await _rpc(ctx, "update.install")
    assert r["error"]["code"] == "update.state" and not quits
    assert ctx._update_dir() == tmp_path / "updates"
    tmp_ctx = AppContext(data_dir=None)
    assert tmp_ctx._update_dir() == tmp_ctx._update_dir() and tmp_ctx._update_dir().is_dir()
    ctx.updates.state, ctx.updates.prepare_install = "ready", lambda: {"state": "installing"}
    r = await _rpc(ctx, "update.install")
    assert r["result"] == {"state": "installing"} and quits == [1]



def test_default_client_bypasses_proxies_only_for_a_loopback_feed(tmp_path):
    local = U.UpdateService("0.4.0", lambda: tmp_path, env={"XSCRIPT_UPDATE_FEED": "http://127.0.0.1:1/f.json"}, install=None)
    remote = U.UpdateService("0.4.0", lambda: tmp_path, env={}, install=None)
    bad = U.UpdateService("0.4.0", lambda: tmp_path, env={"XSCRIPT_UPDATE_FEED": "http://evil.example/f"}, install=None)
    assert local.client_factory()._trust_env is False
    assert remote.client_factory()._trust_env is True and bad.client_factory()._trust_env is True
