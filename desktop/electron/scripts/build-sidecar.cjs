const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const python = process.env.XSCRIPT_PYTHON || path.join(root, '../app/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const fs = require('node:fs');
const keys = (process.env.XSCRIPT_UPDATE_PUBKEY || '').split(',').map(key => key.trim()).filter(Boolean);
for (const key of keys) {
  if (Buffer.from(key, 'base64').length !== 32) throw new Error('Update public keys must be base64 Ed25519 raw keys');
}
fs.mkdirSync(path.join(root, 'sidecar-build'), { recursive: true });
fs.writeFileSync(path.join(root, 'sidecar-build/update-keys.json'), JSON.stringify({ keys }));
const platformTools = path.join(root, 'sidecar-build/platform-tools');
const fetched = spawnSync(python, [path.join(root, '../app/packaging/fetch_platform_tools.py'), process.platform, platformTools], { cwd: root, stdio: 'inherit' });
if (fetched.status !== 0) process.exit(fetched.status ?? 1);
const result = spawnSync(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--name', 'xscript-service', '--onedir',
  '--distpath', path.join(root, 'sidecar-dist'), '--workpath', path.join(root, 'sidecar-build/pyinstaller'), '--specpath', path.join(root, 'sidecar-build'),
  '--paths', path.join(root, '../app'), '--collect-submodules', 'keyring.backends', '--exclude-module', 'PySide6',
  '--add-data', platformTools + path.delimiter + 'platform-tools',
  path.join(root, 'scripts/service-entry.py')], { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
