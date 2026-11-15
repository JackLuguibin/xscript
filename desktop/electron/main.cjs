const { app, BrowserWindow, ipcMain, protocol, net, dialog, clipboard, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Backend } = require('./backend.cjs');
const { rendererRequest, trusted, staticPath } = require('./policy.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'xsapp', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const root = path.resolve(__dirname, '..');
const smoke = process.argv.includes('--smoke');
const devUrl = !app.isPackaged && process.env.XSCRIPT_DEV_URL;
if (devUrl && !/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(devUrl)) throw new Error('Dev URL must be a loopback Vite origin');
let backend, mainWindow, quitting = false, serviceDataDir;
const dataFlag = process.argv.indexOf('--data-dir');
const cliDataDir = dataFlag >= 0 ? process.argv[dataFlag + 1] : undefined;
const toolWindows = new Set();
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'";

function filters(spec = '') {
  const extensions = [...spec.matchAll(/\*\.([a-zA-Z0-9]+)/g)].map(match => match[1]);
  return extensions.length ? [{ name: spec.split('(')[0].trim() || 'File', extensions }] : undefined;
}
async function native(message) {
  const args = message.args || [];
  try {
    let result = null;
    switch (message.native) {
      case 'directory': {
        const response = await dialog.showOpenDialog(mainWindow, { title: args[0], properties: ['openDirectory'] });
        result = response.canceled ? null : response.filePaths[0]; break;
      }
      case 'save': {
        const response = await dialog.showSaveDialog(mainWindow, { title: args[0] || '保存截图', defaultPath: args[1] || 'xscript-screen.png', filters: filters(args[2] || 'PNG (*.png)') });
        result = response.canceled ? null : response.filePath; break;
      }
      case 'open': {
        const response = await dialog.showOpenDialog(mainWindow, { title: args[0], defaultPath: args[1], filters: filters(args[2]), properties: ['openFile'] });
        result = response.canceled ? null : response.filePaths[0]; break;
      }
      case 'clipboard': clipboard.writeText(args[0]); break;
      case 'tools': {
        const [host, port, url, title] = args;
        const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
        if (new URL(url).origin !== origin) throw new Error('Invalid device tools origin');
        const win = new BrowserWindow({ title, width: 1100, height: 780, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'xscript-tools' } });
        toolWindows.add(win);
        win.on('closed', () => toolWindows.delete(win));
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== origin) event.preventDefault(); });
        await win.loadURL(url); break;
      }
      case 'quit': app.quit(); break;
      default: throw new Error('Unknown native action');
    }
    if (message.nativeId) backend.send({ nativeResult: message.nativeId, result });
  } catch (error) {
    if (message.nativeId) backend.send({ nativeResult: message.nativeId, error: error.message });
  }
}
function updateEnvironment() {
  if (!app.isPackaged) return {};
  const config = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'update-keys.json'), 'utf8'));
  // Packaged trust roots are baked in at build time, never supplied by renderer content.
  return { XSCRIPT_UPDATE_PUBKEY: config.keys.join(',') };
}
function startBackend() {
  const pythonRoot = path.join(root, 'app');
  const bundled = path.join(process.resourcesPath, 'sidecar', 'xscript-service', process.platform === 'win32' ? 'xscript-service.exe' : 'xscript-service');
  const python = process.env.XSCRIPT_PYTHON || path.join(pythonRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const command = app.isPackaged ? bundled : python;
  const args = app.isPackaged ? [] : ['-m', 'xscript_desktop.electron_host'];
  const dataDir = smoke ? path.join(app.getPath('temp'), `xscript-electron-smoke-${process.pid}`) : cliDataDir || process.env.XSCRIPT_DATA_DIR || app.getPath('userData');
  serviceDataDir = dataDir;
  args.push('--data-dir', dataDir, '--app-version', app.getVersion());
  if (app.isPackaged) args.push('--electron-executable', process.execPath, '--electron-pid', String(process.pid));
  if (smoke) args.push('--memory-secrets');
  backend = new Backend(command, args, { cwd: app.isPackaged ? process.resourcesPath : pythonRoot, env: { ...process.env, ...updateEnvironment(), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } });
  backend.on('native', native);
  backend.on('message', json => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('xscript:message', json);
  });
  backend.on('failure', error => {
    console.error(error.message);
    if (!quitting) { if (smoke) process.exitCode = 1; else dialog.showErrorBox('XScript 设备服务已停止', error.message); app.quit(); }
  });
}
async function createWindow() {
  mainWindow = new BrowserWindow({ width: 1280, height: 820, minWidth: 720, minHeight: 480, title: 'XScript', show: !smoke,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!trusted(url, devUrl)) event.preventDefault(); });
  mainWindow.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    app.quit();
  });
  await mainWindow.loadURL(devUrl || 'xsapp://app/index.html');
}
app.whenReady().then(async () => {
  const profile = process.platform === 'darwin' ? path.join(app.getPath('appData'), 'XScript')
    : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'XScript')
    : path.join(process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local/share'), 'xscript');
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  const staticRoot = app.isPackaged ? path.join(process.resourcesPath, 'frontend') : path.join(root, 'app/xscript_desktop/resources/app');
  startBackend();
  protocol.handle('xsapp', async request => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'app' || request.method !== 'GET') return new Response(null, { status: 403 });
      if (/^\/_(shot|cloudshot|frame)\//.test(url.pathname)) {
        const resource = await backend.request('resource', { url: url.pathname + url.search });
        return new Response(Buffer.from(resource.body, 'base64'), { headers: { 'Content-Type': resource.mime, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': devUrl ? new URL(devUrl).origin : 'xsapp://app' } });
      }
      if (url.pathname === '/qwebchannel.js') return new Response('', { headers: { 'Content-Type': 'text/javascript' } });
      const file = await staticPath(staticRoot, url.pathname);
      if (!file) return new Response(null, { status: 404 });
      const response = await net.fetch(pathToFileURL(file).toString());
      response.headers.set('Content-Security-Policy', csp);
      return response;
    } catch (error) { console.error('Resource failed:', error.message); return new Response(null, { status: 500 }); }
  });
  ipcMain.on('xscript:rpc', (event, raw) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !trusted(event.senderFrame.url, devUrl)) return;
    try {
      const request = rendererRequest(raw);
      backend.send(request);
      if (request.method === 'app.hello' && request.params?.pingOk) {
        fs.mkdirSync(serviceDataDir, { recursive: true });
        fs.writeFileSync(path.join(serviceDataDir, 'electron-startup.json'), JSON.stringify({ version: app.getVersion(), pid: process.pid }));
      }
    } catch (error) { console.error('Rejected RPC:', error.message); }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }, { role: 'windowMenu' },
  ]));
  await createWindow();
  if (devUrl && !smoke) mainWindow.webContents.openDevTools({ mode: 'detach' });
  if (process.argv.includes('--update-now')) {
    const result = await backend.request('update', {}, 1800000);
    console.log('Update result:', result.state);
    if (result.state !== 'installing') app.quit();
  }
  if (smoke) {
    // Renderer boot must round-trip ping + hello through preload, main and Python.
    let ready = false;
    for (let n = 0; n < 100; n++) {
      ready = await mainWindow.webContents.executeJavaScript("!!document.querySelector('.sidebar')");
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Renderer did not complete service handshake');
    if (process.env.XSCRIPT_SMOKE_DEVICE) {
      const address = JSON.stringify(process.env.XSCRIPT_SMOKE_DEVICE);
      await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const id = 'electron-smoke-device';
        const timer = setTimeout(() => { off(); reject(new Error('Device connection timed out')); }, 30000);
        const off = window.xscriptElectron.onMessage(raw => {
          const message = JSON.parse(raw);
          if (message.id !== id) return;
          clearTimeout(timer); off();
          message.ok ? resolve(message.result) : reject(new Error(message.error.message));
        });
        window.xscriptElectron.send(JSON.stringify({id, method:'device.connect', params:{transport:'lan', address:${address}}}));
      })`);
      await new Promise(resolve => setTimeout(resolve, 500));
      await mainWindow.webContents.executeJavaScript("document.querySelector('.details-toggle')?.click()");
      await new Promise(resolve => setTimeout(resolve, 200));
      // Exercise the custom protocol and actual Python screenshot handler, not a DOM-only assertion.
      const resource = await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error('Device screenshot protocol failed'));
        image.src = 'xsapp://app/_shot/' + encodeURIComponent('lan:' + ${address}) + '.jpg?max=480';
      })`);
      if (!resource.width) throw new Error('Empty device screenshot');
      console.log('Electron device smoke passed: connection, card expansion, screenshot protocol');
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    const output = process.env.XSCRIPT_SMOKE_SCREENSHOT;
    if (output) fs.writeFileSync(output, (await mainWindow.webContents.capturePage()).toPNG());
    console.log('Electron smoke passed: React + preload IPC + Python RPC');
    app.quit();
  }
}).catch(error => { console.error(error); process.exitCode = 1; app.quit(); });
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void (async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        const state = await backend.request('state', {}, 3000);
        if (state.unsaved) {
          const result = await dialog.showMessageBox(mainWindow, { type: 'warning', message: state.lang === 'en' ? 'Discard unsaved changes and quit?' : '有未保存的修改，确定退出？', buttons: ['Cancel', 'Quit'], defaultId: 0, cancelId: 0 });
          if (result.response !== 1) { quitting = false; return; }
        }
      } catch {}
    }
    for (const win of toolWindows) win.destroy();
    if (backend) await backend.stop();
    app.quit();
  })();
});
app.on('window-all-closed', () => app.quit());
