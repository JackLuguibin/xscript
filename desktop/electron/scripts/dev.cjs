const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const vite = spawn(process.execPath, [path.join(root, '../frontend/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], { cwd: path.join(root, '../frontend'), stdio: 'inherit' });
let electron, stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  vite.kill();
  if (electron) electron.kill();
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
vite.on('exit', code => { if (!stopping) stop(code || 0); });
function ready() {
  return new Promise(resolve => {
    const request = http.get('http://127.0.0.1:5173', response => { response.resume(); resolve(response.statusCode === 200); });
    request.on('error', () => resolve(false));
    request.setTimeout(500, () => { request.destroy(); resolve(false); });
  });
}
(async () => {
  for (let n = 0; n < 100 && !stopping; n++) {
    if (await ready()) {
      // Give Vite a chance to report a port conflict instead of attaching to another project.
      await new Promise(resolve => setTimeout(resolve, 300));
      if (stopping) return;
      electron = spawn(require('electron'), [root, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env: { ...process.env, XSCRIPT_DEV_URL: 'http://127.0.0.1:5173' } });
      electron.on('exit', code => stop(code || 0));
      electron.on('error', error => { console.error(error); stop(1); });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!stopping) { console.error('Vite startup timed out'); stop(1); }
})();
