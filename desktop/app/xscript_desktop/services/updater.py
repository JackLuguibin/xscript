"""Desktop auto-update (P5.4): a signed update manifest, a verified download, and (see apply_*) the swap.

The feed is two files next to each other:
  desktop-update.json      {"schema": 1, "product": "xscript-desktop", "version": "X.Y.Z", "published": "...",
                            "notes": {"zh": "...", "en": "..."},
                            "assets": {"macos-arm64": {"name", "url", "size", "sha256"}, "windows-x64": {...}}}
  desktop-update.json.sig  base64 Ed25519 signature over the exact bytes of desktop-update.json
The manifest is only trusted when one of the trusted public keys signed it; the downloaded file is only kept when its
size and sha256 match the (signed) manifest. Nothing is installed without the user confirming (see context.py).

Trusted keys: UPDATE_PUBLIC_KEYS (empty until the release key exists; the private key would live only in GitHub
Secrets), plus XSCRIPT_UPDATE_PUBKEY for testing against a local feed (scripts/desktop_update_feed.py). The feed URL is
DEFAULT_FEED unless XSCRIPT_UPDATE_FEED is set. Only https, or http to this machine (a local test feed), is fetched.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import platform
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urljoin, urlsplit

import httpx

DEFAULT_FEED = "https://github.com/JackLuguibin/xscript/releases/latest/download/desktop-update.json"
# Base64 raw 32-byte Ed25519 public keys of the release update key. Empty: no release key exists yet, so a release
# build reports "updates are not configured" instead of trusting anything.
UPDATE_PUBLIC_KEYS: tuple[str, ...] = ()
PRODUCT = "xscript-desktop"
MAX_MANIFEST = 64 * 1024
MAX_ASSET = 1024 * 1024 * 1024
ASSET_NAME = re.compile(r"^xscript-desktop-v[0-9][0-9A-Za-z.\-]*-(macos-arm64\.dmg|windows-x64-setup\.exe)$")
VERSION = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?$")
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


class UpdateError(Exception):
    """kind: config | network | signature | manifest | integrity | platform"""

    def __init__(self, message: str, kind: str) -> None:
        super().__init__(message)
        self.kind = kind


def platform_key(plat: str | None = None, machine: str | None = None) -> str | None:
    plat = plat or sys.platform
    machine = (machine or platform.machine()).lower()
    if plat == "darwin" and machine in ("arm64", "aarch64"):
        return "macos-arm64"
    if plat == "win32" and machine in ("amd64", "x86_64"):
        return "windows-x64"
    return None


def parse_version(v: str) -> tuple:
    m = VERSION.match(v or "")
    if not m:
        raise ValueError("not a version: %r" % v)
    major, minor, patch, pre = m.groups()
    # a pre-release sorts before its release (0.5.0-rc1 < 0.5.0); pre-release parts compare as strings
    return (int(major), int(minor), int(patch), (0, pre) if pre else (1, ""))


def is_newer(candidate: str, current: str) -> bool:
    return parse_version(candidate) > parse_version(current)


def check_url(url: str) -> str:
    u = urlsplit(url)
    if u.scheme == "https" and u.hostname:
        return url
    if u.scheme == "http" and (u.hostname or "") in LOOPBACK:
        return url
    raise UpdateError("update URL must be https (or http to this machine): %s" % url, "config")


def trusted_keys(env: dict | None = None) -> list[bytes]:
    env = os.environ if env is None else env
    keys = list(UPDATE_PUBLIC_KEYS) + [k for k in (env.get("XSCRIPT_UPDATE_PUBKEY") or "").split(",") if k.strip()]
    out = []
    for k in keys:
        try:
            raw = base64.b64decode(k.strip(), validate=True)
        except (binascii.Error, ValueError):
            raise UpdateError("bad update public key (not base64)", "config") from None
        if len(raw) != 32:
            raise UpdateError("bad update public key (not 32 bytes)", "config")
        out.append(raw)
    return out


def feed_url(env: dict | None = None) -> str:
    env = os.environ if env is None else env
    return check_url((env.get("XSCRIPT_UPDATE_FEED") or "").strip() or DEFAULT_FEED)


def verify_signature(data: bytes, sig_b64: bytes, keys: list[bytes]) -> None:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    if not keys:
        raise UpdateError("no trusted update key is configured", "config")
    try:
        sig = base64.b64decode(sig_b64.strip(), validate=True)
    except (binascii.Error, ValueError):
        raise UpdateError("the update signature is not base64", "signature") from None
    for k in keys:
        try:
            Ed25519PublicKey.from_public_bytes(k).verify(sig, data)
            return
        except InvalidSignature:
            continue
    raise UpdateError("the update manifest signature does not match any trusted key", "signature")


@dataclass
class Asset:
    name: str
    url: str
    size: int
    sha256: str


@dataclass
class Update:
    version: str
    published: str
    notes: dict[str, str]
    asset: Asset
    newer: bool

    def to_dict(self) -> dict[str, Any]:
        return {"version": self.version, "published": self.published, "notes": self.notes, "newer": self.newer,
                "asset": {"name": self.asset.name, "size": self.asset.size, "sha256": self.asset.sha256}}


def parse_manifest(data: bytes, base_url: str, key: str, current: str) -> Update:
    try:
        m = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise UpdateError("the update manifest is not JSON", "manifest") from None
    if not isinstance(m, dict) or m.get("schema") != 1 or m.get("product") != PRODUCT:
        raise UpdateError("not an XScript desktop update manifest (schema 1)", "manifest")
    version = m.get("version")
    try:
        parse_version(version)
    except (ValueError, TypeError):
        raise UpdateError("bad version in the update manifest: %r" % (version,), "manifest") from None
    notes = m.get("notes") or {}
    if isinstance(notes, str):
        notes = {"zh": notes, "en": notes}
    notes = {k: str(v) for k, v in notes.items() if k in ("zh", "en")} if isinstance(notes, dict) else {}
    a = (m.get("assets") or {}).get(key) if isinstance(m.get("assets"), dict) else None
    if not isinstance(a, dict):
        raise UpdateError("this version has no download for %s" % key, "platform")
    name, url, size, sha = a.get("name"), a.get("url") or a.get("name"), a.get("size"), a.get("sha256")
    if not isinstance(name, str) or not ASSET_NAME.match(name) or ("-" + key) not in name:
        raise UpdateError("bad file name in the update manifest: %r" % (name,), "manifest")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= MAX_ASSET:
        raise UpdateError("bad file size in the update manifest", "manifest")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise UpdateError("bad sha256 in the update manifest", "manifest")
    if not isinstance(url, str):
        raise UpdateError("bad download URL in the update manifest", "manifest")
    url = check_url(urljoin(base_url, url))
    return Update(version, str(m.get("published") or ""), notes, Asset(name, url, size, sha), is_newer(version, current))


async def check(current: str, *, client: httpx.AsyncClient, url: str | None = None, keys: list[bytes] | None = None,
                key: str | None = None) -> Update:
    """Fetch and verify the manifest. Raises UpdateError; `newer` says whether to offer it."""
    url = check_url(url) if url else feed_url()
    keys = trusted_keys() if keys is None else keys
    if not keys:
        raise UpdateError("updates are not configured in this build (no trusted update key)", "config")
    key = key or platform_key()
    if not key:
        raise UpdateError("no updates for this platform (%s %s)" % (sys.platform, platform.machine()), "platform")
    try:
        r = await client.get(url, follow_redirects=True)
        if r.status_code == 404:
            raise UpdateError("no update manifest at %s" % url, "network")
        r.raise_for_status()
        data = r.content
        s = await client.get(url + ".sig", follow_redirects=True)
        s.raise_for_status()
    except httpx.HTTPError as e:
        raise UpdateError("cannot fetch the update manifest: %s" % e, "network") from e
    if len(data) > MAX_MANIFEST or len(s.content) > 1024:
        raise UpdateError("the update manifest is too large", "manifest")
    verify_signature(data, s.content, keys)  # before parsing anything
    return parse_manifest(data, str(r.url), key, current)


async def download(asset: Asset, dest_dir: Path, *, client: httpx.AsyncClient,
                   progress: Callable[[int, int], None] | None = None) -> Path:
    """Stream the asset to dest_dir/<name>; keep it only when size and sha256 match the manifest."""
    if not ASSET_NAME.match(asset.name):
        raise UpdateError("bad file name: %r" % asset.name, "manifest")
    check_url(asset.url)
    dest_dir.mkdir(parents=True, exist_ok=True)
    final = dest_dir / asset.name
    part = dest_dir / (asset.name + ".part")
    h = hashlib.sha256()
    n = 0
    try:
        async with client.stream("GET", asset.url, follow_redirects=True) as r:
            r.raise_for_status()
            with open(part, "wb") as f:
                async for chunk in r.aiter_bytes(1 << 16):
                    n += len(chunk)
                    if n > asset.size:
                        raise UpdateError("the download is larger than the manifest says", "integrity")
                    h.update(chunk)
                    f.write(chunk)
                    if progress:
                        progress(n, asset.size)
    except httpx.HTTPError as e:
        part.unlink(missing_ok=True)
        raise UpdateError("download failed: %s" % e, "network") from e
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    if n != asset.size or h.hexdigest() != asset.sha256:
        part.unlink(missing_ok=True)
        raise UpdateError("the download does not match the signed manifest (size %d, sha256 %s)" % (n, h.hexdigest()),
                          "integrity")
    os.replace(part, final)
    return final


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---- applying a verified download ----------------------------------------------------------------------------------
# macOS: the dmg is mounted read-only, XScript.app is copied next to the running bundle as .XScript.app.update and checked
# (deep+strict signature, bundle id, version == the signed manifest). A detached helper then waits for this process to
# exit, swaps the bundles with two renames (rolling back if the second fails) and relaunches the app.
# Windows (⚠ only the script text is tested): a detached helper waits for this process to exit, runs the verified setup.exe
# silently over the current install folder (same Inno AppId → in-place upgrade) and starts the new XScript.exe.
BUNDLE_ID = "com.xscript.desktop"
RELAUNCH_FLAGS = ("--data-dir", "--adb")  # the only start options carried over to the relaunched app


def current_install(executable: str | None = None, frozen: bool | None = None, plat: str | None = None) -> Path | None:
    """The .app bundle (macOS) or install folder (Windows) this process runs from; None for a source checkout."""
    frozen = getattr(sys, "frozen", False) if frozen is None else frozen
    if not frozen:
        return None
    exe = Path(executable or sys.executable).resolve()
    plat = plat or sys.platform
    if plat == "darwin" and exe.parent.name == "MacOS" and exe.parent.parent.name == "Contents" \
            and exe.parents[2].suffix == ".app":
        return exe.parents[2]
    if plat == "win32" and exe.name.lower() == "xscript.exe" and (exe.parent / "unins000.exe").exists():
        return exe.parent
    return None


def relaunch_args(argv: list[str]) -> list[str]:
    out, i = [], 0
    while i < len(argv):
        a = argv[i]
        name, eq, val = a.partition("=")
        if name in RELAUNCH_FLAGS:
            if eq:
                out += [name, val]
            elif i + 1 < len(argv):
                out += [name, argv[i + 1]]
                i += 1
        i += 1
    return out


def _run(cmd: list[str], **kw) -> "subprocess.CompletedProcess[str]":
    import subprocess

    return subprocess.run(cmd, capture_output=True, text=True, timeout=600, **kw)


def stage_macos(dmg: Path, bundle: Path, version: str, run: Callable = _run) -> Path:
    import shutil
    import tempfile

    parent = bundle.parent
    if not os.access(parent, os.W_OK):
        raise UpdateError("cannot write to %s; open the downloaded dmg and drag XScript there yourself" % parent, "install")
    staged = parent / ".XScript.app.update"
    shutil.rmtree(staged, ignore_errors=True)
    mnt = Path(tempfile.mkdtemp(prefix="xscript-update-"))
    try:
        r = run(["hdiutil", "attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", str(mnt), str(dmg)])
        if r.returncode != 0:
            raise UpdateError("cannot open the dmg: %s" % (r.stderr or r.stdout).strip(), "install")
        try:
            if not (mnt / "XScript.app").is_dir():
                raise UpdateError("the dmg has no XScript.app", "install")
            r = run(["ditto", "--norsrc", "--noextattr", str(mnt / "XScript.app"), str(staged)])
            if r.returncode != 0:
                raise UpdateError("cannot copy the new app: %s" % r.stderr.strip(), "install")
        finally:
            run(["hdiutil", "detach", "-quiet", str(mnt)])
        r = run(["codesign", "--verify", "--deep", "--strict", str(staged)])
        if r.returncode != 0:
            raise UpdateError("the new app's signature does not verify: %s" % r.stderr.strip(), "install")
        plist = staged / "Contents" / "Info.plist"
        got = {}
        for k in ("CFBundleIdentifier", "CFBundleShortVersionString"):
            r = run(["/usr/libexec/PlistBuddy", "-c", "Print :" + k, str(plist)])
            got[k] = r.stdout.strip()
        if got["CFBundleIdentifier"] != BUNDLE_ID or got["CFBundleShortVersionString"] != version:
            raise UpdateError("the new app is %s %s, expected %s %s" % (got["CFBundleIdentifier"],
                              got["CFBundleShortVersionString"], BUNDLE_ID, version), "install")
    except BaseException:
        shutil.rmtree(staged, ignore_errors=True)
        raise
    finally:
        try:
            mnt.rmdir()
        except OSError:
            pass
    return staged


def macos_swap_script(bundle: Path, staged: Path, pid: int, args: list[str]) -> str:
    import shlex

    q = shlex.quote
    old = bundle.parent / (".XScript.app.old-%d" % pid)
    relaunch = " ".join(q(a) for a in args)
    return f"""#!/bin/bash
# XScript desktop update helper (written by the app; safe to delete)
set -u
for _ in $(seq 1 240); do kill -0 {pid} 2>/dev/null || break; sleep 0.5; done
if kill -0 {pid} 2>/dev/null; then echo "XScript is still running; update not applied"; exit 1; fi
mv {q(str(bundle))} {q(str(old))} || {{ echo "cannot move the old app aside"; exit 1; }}
if ! mv {q(str(staged))} {q(str(bundle))}; then mv {q(str(old))} {q(str(bundle))}; echo "swap failed, old app restored"; exit 1; fi
rm -rf {q(str(old))}
echo "replaced {bundle}"
open -n {q(str(bundle))}{(" --args " + relaunch) if args else ""}
echo "relaunched"
"""


def windows_install_script(setup: Path, install_dir: Path, pid: int, args: list[str], log: Path) -> str:
    def cq(s: str) -> str:
        return '"' + s.replace('"', "") + '"'
    relaunch = " ".join(cq(a) for a in args)
    return f"""@echo off
rem XScript desktop update helper (written by the app; safe to delete)
set n=0
:wait
tasklist /FI "PID eq {pid}" 2>nul | find " {pid} " >nul || goto install
set /a n+=1
if %n% gtr 240 (echo XScript is still running; update not applied & exit /b 1)
ping -n 2 127.0.0.1 >nul
goto wait
:install
{cq(str(setup))} /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /DIR={cq(str(install_dir))} /LOG={cq(str(log))}
if errorlevel 1 (echo setup failed & exit /b 1)
echo installed
start "" {cq(str(install_dir).rstrip(chr(92)) + chr(92) + "XScript.exe")} {relaunch}
"""


def launch_helper(script: Path, log: Path, plat: str | None = None, popen: Callable | None = None):
    import subprocess

    popen = popen or subprocess.Popen
    plat = plat or sys.platform
    out = open(log, "ab")
    try:
        if plat == "win32":
            flags = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
            return popen(["cmd.exe", "/d", "/c", str(script)], stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                         creationflags=flags, close_fds=True)
        return popen(["/bin/bash", str(script)], stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                     start_new_session=True, close_fds=True)
    finally:
        out.close()


class UpdateService:
    """State for the UI: idle → checking → none | available → downloading → ready → installing; error on failure."""

    def __init__(self, current: str, work_dir: Callable[[], Path], *, client_factory: Callable[[], httpx.AsyncClient] | None = None,
                 env: dict | None = None, install: Path | None | bool = False, argv: list[str] | None = None,
                 plat: str | None = None) -> None:
        self.current = current
        self.work_dir = work_dir
        self.client_factory = client_factory or self._default_client
        self.env = env
        self.install_path = current_install() if install is False else install
        self.argv = sys.argv[1:] if argv is None else argv
        self.plat = plat or sys.platform
        self.state = "idle"
        self.update: Update | None = None
        self.error: dict[str, str] | None = None
        self.progress = (0, 0)
        self.file: Path | None = None
        self._task = None

    def _default_client(self) -> httpx.AsyncClient:
        # A loopback test feed must not go through a configured HTTP(S)_PROXY (it would answer 502); a real feed keeps
        # the user's proxy settings.
        try:
            local = (urlsplit(feed_url(self.env)).hostname or "") in LOOPBACK
        except UpdateError:
            local = False
        return httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=120.0), trust_env=not local)

    def _keys(self) -> list[bytes]:
        return trusted_keys(self.env)

    def info(self) -> dict[str, Any]:
        try:
            configured, feed, why = bool(self._keys()), feed_url(self.env), ""
        except UpdateError as e:
            configured, feed, why = False, "", str(e)
        return {"version": self.current, "platform": platform_key(), "configured": configured, "feed": feed,
                "configError": why, "canInstall": self.install_path is not None, **self.status()}

    def status(self) -> dict[str, Any]:
        return {"state": self.state, "update": self.update.to_dict() if self.update else None, "error": self.error,
                "progress": {"done": self.progress[0], "total": self.progress[1]}}

    def _fail(self, e: UpdateError) -> None:
        self.state, self.error = "error", {"kind": e.kind, "message": str(e)}

    async def check(self) -> dict[str, Any]:
        if self.state in ("downloading", "installing"):
            return self.status()
        self.state, self.error, self.update, self.file = "checking", None, None, None
        try:
            async with self.client_factory() as c:
                u = await check(self.current, client=c, url=feed_url(self.env), keys=self._keys())
        except UpdateError as e:
            self._fail(e)
            return self.status()
        self.update = u
        self.state = "available" if u.newer else "none"
        return self.status()

    async def download(self) -> dict[str, Any]:
        """Runs until the file is verified; poll status() meanwhile for progress."""
        if self.state not in ("available", "error") or not self.update or not self.update.newer:
            raise UpdateError("no newer version to download (check first)", "state")
        self.state, self.error, self.progress = "downloading", None, (0, self.update.asset.size)

        def prog(n: int, total: int) -> None:
            self.progress = (n, total)
        try:
            async with self.client_factory() as c:
                self.file = await download(self.update.asset, self.work_dir(), client=c, progress=prog)
        except UpdateError as e:
            self._fail(e)
            return self.status()
        self.state = "ready"
        return self.status()

    def prepare_install(self, pid: int | None = None, popen: Callable | None = None, run: Callable = _run) -> dict[str, Any]:
        """Stage the new build and start the helper; the caller then quits the app so the helper can finish."""
        if self.state != "ready" or not self.file or not self.update:
            raise UpdateError("nothing downloaded to install", "state")
        if self.install_path is None:
            raise UpdateError("this copy was not installed from a package (source checkout); install the download by hand: %s"
                              % self.file, "install")
        if file_sha256(self.file) != self.update.asset.sha256:  # changed on disk since the download
            raise UpdateError("the downloaded file changed since it was verified", "integrity")
        pid = pid or os.getpid()
        work = self.work_dir()
        log = work / "update-helper.log"
        args = relaunch_args(self.argv)
        try:
            if self.plat == "darwin":
                staged = stage_macos(self.file, self.install_path, self.update.version, run=run)
                script = work / "apply-update.sh"
                script.write_text(macos_swap_script(self.install_path, staged, pid, args))
            elif self.plat == "win32":
                script = work / "apply-update.cmd"
                script.write_text(windows_install_script(self.file, self.install_path, pid, args, work / "setup.log"),
                                  encoding="utf-8")
            else:
                raise UpdateError("no installer for %s" % self.plat, "platform")
            launch_helper(script, log, plat=self.plat, popen=popen)
        except UpdateError as e:
            self._fail(e)
            raise
        self.state = "installing"
        return {**self.status(), "helperLog": str(log)}
