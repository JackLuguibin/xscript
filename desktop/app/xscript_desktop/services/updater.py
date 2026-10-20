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
