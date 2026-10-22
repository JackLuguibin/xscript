/* Minimal headless-Chrome driver over the DevTools protocol (Node's built-in WebSocket, no npm deps).
 * Chrome comes from $CHROME or the puppeteer cache (~/.cache/puppeteer); find() returns "" when absent. */
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function find() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  const cache = path.join(os.homedir(), '.cache', 'puppeteer');
  const candidates = [];
  for (const kind of ['chrome-headless-shell', 'chrome']) {
    const dir = path.join(cache, kind);
    if (!fs.existsSync(dir)) continue;
    for (const ver of fs.readdirSync(dir).sort().reverse()) {
      const root = path.join(dir, ver);
      for (const sub of fs.readdirSync(root)) {
        candidates.push(path.join(root, sub, 'chrome-headless-shell'),
          path.join(root, sub, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
          path.join(root, sub, 'chrome'));
      }
    }
  }
  return candidates.find(p => fs.existsSync(p)) || '';
}

/** Drive a browser that is already running (e.g. Chrome on an Android emulator via
 *  `adb forward tcp:9222 localabstract:chrome_devtools_remote`): attach('http://127.0.0.1:9222'). A fresh tab is opened and closed again. */
async function attach(endpoint) {
  const info = await (await fetch(endpoint.replace(/\/$/, '') + '/json/version')).json();
  return session(info.webSocketDebuggerUrl, null, '');
}

/** Start a headless Chrome and drive it. A start that fails (no "DevTools listening" line within `startupMs`, an early
 *  exit, a refused DevTools socket) kills that Chrome and removes its profile before retrying with a fresh one, up to
 *  `attempts` starts in all. An orphaned Chrome would otherwise keep the test process alive until the CI job limit. */
// onStart(child, profile) is called synchronously for every Chrome spawned (tests count attempts with it: a process killed
// at the startup deadline may never have run a single instruction, so it cannot be counted from inside).
const STARTUP_MS = 15000, ATTEMPTS = 2;
/** Worst case launch() can spend before the page is driven (a hung first start, then a retry). Browser tests add it to
 *  their own timeout so a slow Chrome start on a busy CI runner does not eat the time budgeted for the steps. */
const LAUNCH_BUDGET_MS = STARTUP_MS * ATTEMPTS;
async function launch(bin, {startupMs = STARTUP_MS, attempts = ATTEMPTS, onStart} = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const {child, profile, wsUrl} = startChrome(bin, startupMs);
    if (onStart) onStart(child, profile);
    try {
      return await session(await wsUrl, child, profile);
    } catch (e) {
      last = e;
      await stopChrome(child, profile);
    }
  }
  throw last;
}

function startChrome(bin, startupMs) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-cdp-'));
  // GitHub-hosted Ubuntu runners block the unprivileged user namespaces Chrome's sandbox needs
  const noSandbox = process.env.CI ? ['--no-sandbox'] : [];
  const child = spawn(bin, [...noSandbox, '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900', 'about:blank'],
    {stdio: ['ignore', 'ignore', 'pipe']});
  const wsUrl = new Promise((resolve, reject) => {
    let err = ''; const timer = setTimeout(() => reject(Error('Chrome startup timed out: ' + err)), startupMs);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(Error('Chrome exited ' + code + ': ' + err)); });
    child.stderr.on('data', b => { err += b; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
  return {child, profile, wsUrl};
}

async function stopChrome(child, profile) {
  if (child.exitCode === null && child.signalCode === null) {
    const gone = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await gone;
  }
  child.stderr.destroy();
  try { fs.rmSync(profile, {recursive: true, force: true, maxRetries: 3}); } catch {}
}

async function session(wsUrl, child, profile) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0; const waiting = new Map(), listeners = [];
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) { const {resolve, reject} = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? reject(Error(msg.error.message)) : resolve(msg.result); }
    else for (const fn of listeners) fn(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id; waiting.set(n, {resolve, reject}); ws.send(JSON.stringify({id: n, method, params, sessionId}));
  });
  const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
  const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
  const page = (method, params) => send(method, params, sessionId);
  const errors = [];
  listeners.push(msg => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
  });
  await page('Runtime.enable'); await page('Page.enable');
  return {
    errors,
    /** Raw DevTools command on the page session (e.g. Page.captureScreenshot). */
    cmd: (method, params) => page(method, params),
    async goto(url) {
      const loaded = new Promise(resolve => listeners.push(msg => { if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') resolve(); }));
      await page('Page.navigate', {url}); await loaded;
    },
    /** Evaluate `fn` (a function or expression string) in the page; promises are awaited, the value returned by value. */
    async eval(fn, ...args) {
      const expression = typeof fn === 'function' ? '(' + fn + ')(...' + JSON.stringify(args) + ')' : fn;
      const r = await page('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
      if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(fn, timeout = 5000, ...args) {
      const end = Date.now() + timeout; let last;
      while (Date.now() < end) { try { last = await this.eval(fn, ...args); if (last) return last; } catch (e) { last = e.message; } await new Promise(r => setTimeout(r, 50)); }
      throw Error('waitFor timed out: ' + fn + ' → ' + JSON.stringify(last));
    },
    /** Real (trusted) key press on the focused element. */
    async key(key, code = key, keyCode = 0) {
      for (const type of ['keyDown', 'keyUp']) await page('Input.dispatchKeyEvent', {type, key, code, windowsVirtualKeyCode: keyCode});
    },
    /** Real text input on the focused element (fires a trusted `input` event with inputType "insertText"). */
    async insertText(text) { await page('Input.insertText', {text}); },
    attached: !child,
    async close() {
      if (!child) { try { await send('Target.closeTarget', {targetId}); } catch {} try { ws.close(); } catch {} return; }
      try { ws.close(); } catch {}
      const gone = new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
      child.kill(); await gone;
      try { fs.rmSync(profile, {recursive: true, force: true, maxRetries: 3}); } catch {}
    },
  };
}

module.exports = {find, launch, attach, LAUNCH_BUDGET_MS};
