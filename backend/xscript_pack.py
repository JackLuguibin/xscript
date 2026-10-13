#!/usr/bin/env python3
"""APK 打包: build a standalone Android app from one XScript / AScript project.

    python backend/xscript_pack.py examples/xs_smoke \\
        --app-id com.example.smoke --name "冒烟测试" --version 1.0.0 --version-code 1 \\
        --icon icon.png --license-key xscript-data/keys/private.pem \\
        --license-server https://cloud.example.com --keystore release.jks --out dist/

The 管理后台 (backend/xscript_server, APK 打包 page) runs this script for you and fills in the
卡密 key, license server and 云控 URL. Use it directly for CI or local builds.

The app contains the XScript runtime and the project; it opens straight into the project
(start / stop, permissions, 卡密 activation), without the developer home or LAN API unless
--dev-server is given.

Licensing: --license-key <private.pem> (or --license-pubkey <base64>) makes the app require
a 卡密. Give --license-server (the 管理后台 URL) so users can type short card codes; without
it they paste offline tokens (管理后台 → 卡密管理 → 离线授权码).

云控: --cloud-url wss://host/ws?token=<设备密钥>, or env XSCRIPT_CLOUD_URL so the key stays
out of the process list.

代码保护: --protect ships bytecode instead of .py sources (harder to copy or edit; bytecode
can still be decompiled). 热更新: --update-server/--update-channel/--update-pubkey make the
app download newer published versions of its 小程序 (signed manifest, sha256-checked zip).

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
    sys.path.insert(0, os.path.join(ROOT, "android", "python-runtime"))
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
        "update_server": (a.update_server or "").rstrip("/"),
        "update_channel": a.update_channel or "",
        "update_pubkey": (a.update_pubkey or "").strip(),
        "script_code": str(a.script_code or 0),
    }
    if a.icon:
        if not a.icon.lower().endswith(".png") or not os.path.isfile(a.icon):
            raise SystemExit("--icon must be an existing .png file")
        props["icon"] = os.path.abspath(a.icon)
    pub = a.license_pubkey or ""
    if a.license_key:
        sys.path.insert(0, os.path.join(ROOT, "backend"))
        from xscript_server import licensing  # only needs `cryptography`

        pub = licensing.public_b64(licensing.load_private(a.license_key))
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
    ap.add_argument("--license-server", help="管理后台 base URL serving /license/activate")
    ap.add_argument("--cloud-url", default=os.environ.get("XSCRIPT_CLOUD_URL"),
                    help="connect to this 云控 server on first start (or env XSCRIPT_CLOUD_URL, which keeps "
                         "the device key out of the process list)")
    ap.add_argument("--cloud-group", help="云控 group reported by the app")
    ap.add_argument("--autostart", action="store_true", help="start the project after boot")
    ap.add_argument("--dev-server", action="store_true", help="keep the LAN developer API (debugging only)")
    ap.add_argument("--bundle-requirements", action="store_true",
                    help="install requirements.txt at build time instead of on first run")
    ap.add_argument("--protect", action="store_true",
                    help="代码保护: ship Python 3.10 bytecode only (needs python3.10 on the build machine)")
    ap.add_argument("--update-server", help="热更新: 管理后台 base URL serving /pub/update")
    ap.add_argument("--update-channel", help="热更新: the 小程序 channel id")
    ap.add_argument("--update-pubkey", help="热更新: base64 public key that signs update manifests")
    ap.add_argument("--script-code", type=int, default=0, help="热更新: version code of the bundled project")
    ap.add_argument("--abis", default="arm64-v8a,x86_64", help="comma-separated; arm64-v8a alone is ~40%% smaller")
    ap.add_argument("--keystore")
    ap.add_argument("--key-alias", default="key0")
    ap.add_argument("--store-pass")
    ap.add_argument("--key-pass")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"))
    a = ap.parse_args(argv)

    project_dir = os.path.abspath(a.project)
    if not any(os.path.isfile(os.path.join(project_dir, e)) for e in ("__init__.py", "__init__.pyc")):
        raise SystemExit("%s has no __init__.py" % project_dir)
    project_name = a.project_name or os.path.basename(project_dir.rstrip("/"))
    if not NAME.match(project_name):
        raise SystemExit("project name %r must be a Python identifier (use --project-name)" % project_name)
    if not APP_ID.match(a.app_id):
        raise SystemExit("--app-id must look like com.example.app")
    if a.license_server and not (a.license_key or a.license_pubkey):
        raise SystemExit("--license-server needs --license-key or --license-pubkey")
    if bool(a.update_channel) != bool(a.update_server) or (a.update_channel and not a.update_pubkey):
        raise SystemExit("--update-channel, --update-server and --update-pubkey go together")

    workdir = tempfile.mkdtemp(prefix="xscript-pack-")
    try:
        if a.protect:
            # Compile a copy; the caller's sources stay untouched.
            sys.path.insert(0, os.path.join(ROOT, "backend"))
            from xscript_server.protect import compile_tree

            staged = os.path.join(workdir, "src", project_name)
            shutil.copytree(project_dir, staged, ignore=shutil.ignore_patterns("__pycache__", ".git", "*.pyc"))
            n = compile_tree(staged)
            print("代码保护: compiled %d files to bytecode" % n)
            project_dir = staged
        props_path, props = build_props(a, project_dir, project_name, workdir)
        release = bool(a.keystore)
        task = ":app:assembleRelease" if release else ":app:assembleDebug"
        # build.gradle.kts puts packed builds in build-pack/<app id>/.
        build_dir = os.path.join(ROOT, "android", "app", "build-pack", a.app_id)
        cmd = [os.path.join(ROOT, "android", "build.sh"), "-q", "-Pxscript.pack=" + props_path]
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
