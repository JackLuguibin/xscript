#!/usr/bin/env python3
"""APK 打包: build a standalone Android app from one XScript / AScript project.

    python scripts/xscript_pack.py examples/xs_smoke \\
        --app-id com.example.smoke --name "冒烟测试" --version 1.0.0 --version-code 1 \\
        --icon icon.png --license-key keys/private.pem --license-server https://my.server:8765 \\
        --cloud-url wss://my.server:8765/ws?token=SECRET --keystore release.jks --out dist/

The app contains the XScript runtime and the project; it opens straight into the project
(start / stop, permissions, 卡密 activation), without the developer home or LAN API unless
--dev-server is given.

Licensing: --license-key <private.pem> (or --license-pubkey <base64>) makes the app require
a 卡密. Give --license-server so users can type short card codes (served by
scripts/xscript_cloud.py --licenses); without it they paste offline tokens from
`xscript_license.py issue`.

Signing: --keystore/--key-alias (passwords from --store-pass / env XSCRIPT_STORE_PASS and
XSCRIPT_KEY_PASS) build a signed release APK. Without a keystore a debug-signed APK is built,
which installs fine but cannot be published as an update of a release-signed app.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_ID = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$")
NAME = re.compile(r"^[^\W\d]\w*$", re.UNICODE)


def _prop(value):
    """java.util.Properties escaping (written as UTF-8, loaded with a UTF-8 reader)."""
    out = str(value).replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "")
    return out.replace("=", "\\=").replace(":", "\\:")


def _requirements(project_dir):
    path = os.path.join(project_dir, "requirements.txt")
    if not os.path.isfile(path):
        return []
    sys.path.insert(0, os.path.join(ROOT, "python-runtime"))
    from xscript.android.pip import parse_requirements

    with open(path, "r", encoding="utf-8") as f:
        return parse_requirements(f.read())


def build_props(a, project_dir, project_name, workdir):
    props = {
        "project_dir": project_dir,
        "project_name": project_name,
        "app_id": a.app_id,
        "app_name": a.name or project_name,
        "version_name": a.version,
        "version_code": str(a.version_code),
        "autostart": "true" if a.autostart else "false",
        "dev_server": "true" if a.dev_server else "false",
        "cloud_url": a.cloud_url or "",
        "cloud_group": a.cloud_group or "",
        "license_server": (a.license_server or "").rstrip("/"),
        "abis": a.abis,
    }
    if a.icon:
        if not a.icon.lower().endswith(".png") or not os.path.isfile(a.icon):
            raise SystemExit("--icon must be an existing .png file")
        props["icon"] = os.path.abspath(a.icon)
    pub = a.license_pubkey or ""
    if a.license_key:
        sys.path.insert(0, os.path.join(ROOT, "scripts"))
        import xscript_license as lic

        pub = lic.public_b64(lic.load_private(a.license_key))
    if pub:
        props["license_pubkey"] = pub.strip()
    if a.bundle_requirements:
        # Pre-install at build time (works offline on the phone; native wheels must exist
        # in Chaquopy's index). Otherwise requirements.txt installs on the first run.
        props["pip"] = ",".join(_requirements(project_dir))
    if a.keystore:
        store_pass = a.store_pass or os.environ.get("XSCRIPT_STORE_PASS", "")
        key_pass = a.key_pass or os.environ.get("XSCRIPT_KEY_PASS", "") or store_pass
        if not store_pass:
            raise SystemExit("--keystore needs --store-pass or XSCRIPT_STORE_PASS")
        props.update(keystore=os.path.abspath(a.keystore), keystore_password=store_pass,
                     key_alias=a.key_alias, key_password=key_pass)
    path = os.path.join(workdir, "pack.properties")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # may hold signing passwords
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        for k, v in props.items():
            f.write("%s=%s\n" % (k, _prop(v)))
    return path, props


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", help="project directory (with __init__.py)")
    ap.add_argument("--app-id", required=True, help="applicationId, e.g. com.example.mygame")
    ap.add_argument("--name", help="launcher label (default: project name)")
    ap.add_argument("--version", default="1.0.0")
    ap.add_argument("--version-code", type=int, default=1, help="increase for every update")
    ap.add_argument("--icon", help="launcher icon .png (512x512 recommended)")
    ap.add_argument("--project-name", help="package name inside the app (default: directory name)")
    ap.add_argument("--license-key", help="private.pem: require 卡密 (public key is embedded)")
    ap.add_argument("--license-pubkey", help="base64 public key instead of --license-key")
    ap.add_argument("--license-server", help="base URL serving /license/activate (xscript_cloud.py)")
    ap.add_argument("--cloud-url", help="connect to this 云控 server on first start")
    ap.add_argument("--cloud-group", help="云控 group reported by the app")
    ap.add_argument("--autostart", action="store_true", help="start the project after boot")
    ap.add_argument("--dev-server", action="store_true", help="keep the LAN developer API (debugging only)")
    ap.add_argument("--bundle-requirements", action="store_true",
                    help="install requirements.txt at build time instead of on first run")
    ap.add_argument("--abis", default="arm64-v8a,x86_64", help="comma-separated; arm64-v8a alone is ~40%% smaller")
    ap.add_argument("--keystore")
    ap.add_argument("--key-alias", default="key0")
    ap.add_argument("--store-pass")
    ap.add_argument("--key-pass")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"))
    a = ap.parse_args(argv)

    project_dir = os.path.abspath(a.project)
    if not os.path.isfile(os.path.join(project_dir, "__init__.py")):
        raise SystemExit("%s has no __init__.py" % project_dir)
    project_name = a.project_name or os.path.basename(project_dir.rstrip("/"))
    if not NAME.match(project_name):
        raise SystemExit("project name %r must be a Python identifier (use --project-name)" % project_name)
    if not APP_ID.match(a.app_id):
        raise SystemExit("--app-id must look like com.example.app")
    if a.license_server and not (a.license_key or a.license_pubkey):
        raise SystemExit("--license-server needs --license-key or --license-pubkey")

    workdir = tempfile.mkdtemp(prefix="xscript-pack-")
    try:
        props_path, props = build_props(a, project_dir, project_name, workdir)
        release = bool(a.keystore)
        task = ":app:assembleRelease" if release else ":app:assembleDebug"
        # build.gradle.kts puts packed builds in build-pack/<app id>/.
        build_dir = os.path.join(ROOT, "android", "app", "build-pack", a.app_id)
        cmd = [os.path.join(ROOT, "scripts", "build_android.sh"), "-q", "-Pxscript.pack=" + props_path]
        env = dict(os.environ, XSCRIPT_GRADLE_TASK=task)
        print("building %s (%s) from %s" % (a.app_id, "release" if release else "debug", project_dir))
        subprocess.run(cmd, check=True, env=env)
        variant = "release" if release else "debug"
        apk_dir = os.path.join(build_dir, "outputs", "apk", variant)
        apks = [f for f in os.listdir(apk_dir) if f.endswith(".apk")]
        if not apks:
            raise SystemExit("no APK produced in %s" % apk_dir)
        os.makedirs(a.out, exist_ok=True)
        dest = os.path.join(a.out, "%s-%s.apk" % (a.app_id, a.version))
        shutil.copyfile(os.path.join(apk_dir, apks[0]), dest)
        size = os.path.getsize(dest) / 1e6
        print("ok: %s (%.1f MB)%s" % (dest, size, "" if release else " [debug-signed]"))
        if props.get("license_pubkey"):
            print("卡密: required%s" % (" (server %s)" % props["license_server"] if props["license_server"] else " (offline tokens)"))
        return 0
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
