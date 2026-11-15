"""macOS signed-feed update rehearsal in a temporary Applications folder.
Uses disposable trust keys, never touches /Applications or the normal user profile.
Run: desktop/app/.venv/bin/python scripts/electron_update_e2e.py
"""
from __future__ import annotations

import base64
import functools
import hashlib
import http.server
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = Path(__file__).resolve().parents[1]
ELECTRON = ROOT / 'desktop/electron'


def run(args, **kwargs):
    print('$', ' '.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), check=True, **kwargs)


def sha256(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    if sys.platform != 'darwin':
        raise SystemExit('This real bundle-swap rehearsal requires macOS')
    key = Ed25519PrivateKey.generate()
    public = base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
    config = ELECTRON / 'sidecar-build/update-keys.json'
    old_config = config.read_bytes() if config.exists() else None
    process = None
    server = None
    with tempfile.TemporaryDirectory(prefix='xscript-electron-update-') as tmp:
        temp = Path(tmp)
        try:
            env = {**os.environ, 'XSCRIPT_UPDATE_PUBKEY': public}
            run(['npm', 'run', 'build'], cwd=ELECTRON)
            run(['npm', 'run', 'build:sidecar'], cwd=ELECTRON, env=env)
            version = json.loads((ELECTRON / 'package.json').read_text())['version']
            parts = version.split('.')
            newer = '.'.join([parts[0], parts[1], str(int(parts[2]) + 1)])
            apps = []
            for v in (version, newer):
                out = temp / ('build-' + v)
                run(['npx', 'electron-builder', '--dir', '--publish', 'never', '-c.directories.output=' + str(out), '-c.extraMetadata.version=' + v], cwd=ELECTRON)
                bundle = out / 'mac-arm64/XScript.app'
                # electron-builder skips signing in PR environments. These disposable
                # rehearsal bundles use ad-hoc signing, without release credentials.
                run(['codesign', '--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,requirements,flags', bundle])
                run(['codesign', '--verify', '--deep', '--strict', bundle])
                apps.append(bundle)
            install_dir = temp / 'Applications'
            install_dir.mkdir()
            installed = install_dir / 'XScript.app'
            run(['ditto', apps[0], installed])
            feed = temp / 'feed'
            feed.mkdir()
            name = f'xscript-desktop-v{newer}-macos-arm64.dmg'
            dmg = feed / name
            run(['hdiutil', 'create', '-quiet', '-format', 'UDRO', '-srcfolder', apps[1].parent, dmg])
            manifest = json.dumps({'schema': 1, 'product': 'xscript-desktop', 'version': newer,
                'published': '2026-11-15T00:00:00Z', 'notes': {'en': 'Electron local update rehearsal'},
                'assets': {'macos-arm64': {'name': name, 'size': dmg.stat().st_size,
                    'sha256': sha256(dmg)}}}).encode()
            (feed / 'desktop-update.json').write_bytes(manifest)
            (feed / 'desktop-update.json.sig').write_bytes(base64.b64encode(key.sign(manifest)))
            class Handler(http.server.SimpleHTTPRequestHandler):
                def log_message(self, *_args):
                    pass
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(feed)))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            profile = temp / 'profile'
            env = {**os.environ, 'XSCRIPT_UPDATE_FEED': f'http://127.0.0.1:{server.server_port}/desktop-update.json'}
            log = (temp / 'update.log').open('w')
            process = subprocess.Popen([str(installed / 'Contents/MacOS/XScript'), '--update-now', '--data-dir', str(profile)], env=env, stdout=log, stderr=subprocess.STDOUT)
            if process.wait(timeout=180) != 0:
                raise RuntimeError((temp / 'update.log').read_text())
            receipt = profile / 'electron-startup.json'
            for _ in range(180):
                if receipt.exists() and json.loads(receipt.read_text())['version'] == newer:
                    break
                time.sleep(0.5)
            else:
                helper_log = profile / 'updates/update-helper.log'
                raise RuntimeError('New Electron app did not relaunch: ' + (temp / 'update.log').read_text() + '\n' + (helper_log.read_text() if helper_log.exists() else 'Update helper did not start'))
            started = json.loads(receipt.read_text())
            os.kill(started['pid'], signal.SIGTERM)
            time.sleep(1)
            run(['codesign', '--verify', '--deep', '--strict', installed])
            run([installed / 'Contents/MacOS/XScript', '--smoke'], timeout=60)
            print(f'PASS: Electron {version} → signed feed → verified download → bundle swap → {newer} relaunched → packaged smoke', flush=True)
        finally:
            if process and process.poll() is None:
                process.terminate()
            if server:
                server.shutdown()
            if old_config is None:
                config.unlink(missing_ok=True)
            else:
                config.write_bytes(old_config)


if __name__ == '__main__':
    main()
