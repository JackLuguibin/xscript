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

async function launch(bin) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-cdp-'));
  const child = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900', 'about:blank'],
    {stdio: ['ignore', 'ignore', 'pipe']});
  const wsUrl = await new Promise((resolve, reject) => {
    let err = ''; const timer = setTimeout(() => reject(Error('Chrome startup timed out: ' + err)), 15000);
    child.once('exit', code => { clearTimeout(timer); reject(Error('Chrome exited ' + code + ': ' + err)); });
    child.stderr.on('data', b => { err += b; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
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
    async close() {
      try { ws.close(); } catch {}
      const gone = new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
      child.kill(); await gone;
      try { fs.rmSync(profile, {recursive: true, force: true, maxRetries: 3}); } catch {}
    },
  };
}

module.exports = {find, launch};
