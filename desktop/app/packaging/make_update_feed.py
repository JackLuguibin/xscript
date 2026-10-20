"""Write and sign desktop-update.json (P5.4) for the desktop installers in a folder.

  python packaging/make_update_feed.py OUT_DIR --version X.Y.Z --key KEY_FILE [--base-url URL] [--notes-zh ..] [--notes-en ..] FILE...
  python packaging/make_update_feed.py --new-key KEY_FILE     # a fresh Ed25519 key (0600); prints the public key

KEY_FILE holds the base64 raw 32-byte private key. The release key would come only from GitHub Secrets; a local or
dry-run feed uses a throwaway key made with --new-key. Each FILE must be named like
xscript-desktop-vX.Y.Z-macos-arm64.dmg / -windows-x64-setup.exe; it is listed with its size and sha256, and its URL is
the file name (relative to the manifest) unless --base-url is given.
"""
from __future__ import annotations

import argparse
import base64
import datetime
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from xscript_desktop.services.updater import ASSET_NAME, PRODUCT, file_sha256, parse_version  # noqa: E402


def new_key(path: Path) -> str:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat

    k = Ed25519PrivateKey.generate()
    raw = k.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(base64.b64encode(raw).decode())
    return base64.b64encode(k.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()


def load_key(text: str):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    raw = base64.b64decode(text.strip(), validate=True)
    if len(raw) != 32:
        raise SystemExit("the update key must be base64 of 32 raw bytes")
    return Ed25519PrivateKey.from_private_bytes(raw)


def build(version: str, files: list[Path], base_url: str = "", notes: dict | None = None,
          published: str | None = None) -> bytes:
    parse_version(version)
    assets = {}
    for f in files:
        m = ASSET_NAME.match(f.name)
        if not m or not f.name.startswith("xscript-desktop-v%s-" % version):
            raise SystemExit("not a desktop installer of %s: %s" % (version, f.name))
        key = "macos-arm64" if m.group(1).endswith(".dmg") else "windows-x64"
        assets[key] = {"name": f.name, "url": (base_url.rstrip("/") + "/" + f.name) if base_url else f.name,
                       "size": f.stat().st_size, "sha256": file_sha256(f)}
    if not assets:
        raise SystemExit("no installers given")
    doc = {"schema": 1, "product": PRODUCT, "version": version,
           "published": published or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "notes": notes or {}, "assets": assets}
    return (json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def sign(data: bytes, key_text: str) -> bytes:
    return base64.b64encode(load_key(key_text).sign(data)) + b"\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("out", nargs="?")
    p.add_argument("files", nargs="*", type=Path)
    p.add_argument("--version")
    p.add_argument("--key", type=Path, help="file with the base64 private key (never printed)")
    p.add_argument("--base-url", default="")
    p.add_argument("--notes-zh", default="")
    p.add_argument("--notes-en", default="")
    p.add_argument("--new-key", type=Path, metavar="KEY_FILE")
    a = p.parse_args(argv)
    if a.new_key:
        print(new_key(a.new_key))
        return 0
    if not (a.out and a.version and a.key and a.files):
        p.error("OUT_DIR, --version, --key and at least one FILE are required")
    notes = {k: v for k, v in (("zh", a.notes_zh), ("en", a.notes_en)) if v}
    data = build(a.version, a.files, a.base_url, notes)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "desktop-update.json").write_bytes(data)
    (out / "desktop-update.json.sig").write_bytes(sign(data, a.key.read_text()))
    print("wrote %s and .sig (%s)" % (out / "desktop-update.json", ", ".join(sorted(json.loads(data)["assets"]))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
