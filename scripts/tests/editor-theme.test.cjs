/* Web IDE in light and dark theme (headless Chrome, prefers-color-scheme emulated) against scripts/mock_device.py:
 * at a narrow (721 px) and a wide (1280 px) desktop window the toolbar, 文件 and debugger headings stay one row with no
 * horizontal scrolling, and every visible text that is not disabled reaches WCAG AA contrast (4.5:1) against what is
 * actually behind it (backgrounds and opacity composited). Skipped when no local Chrome is found. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');
const cdp = require('./cdp.cjs');

const CHROME = cdp.find();

function startMock() {
  const child = spawn(process.env.PYTHON || 'python3', ['-u', '-c',
    'import sys,threading;sys.path.insert(0,"scripts");from mock_device import serve;s=serve();print(s.server_address[1],flush=True);threading.Event().wait()'],
    {cwd: path.resolve(__dirname, '../..'), stdio: ['ignore', 'pipe', 'pipe']});
  const port = new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(Error('Mock startup timed out')), 5000);
    child.stdout.on('data', b => { out += b; if (out.includes('\n')) { clearTimeout(timer); resolve(Number(out.trim())); } });
  });
  return {child, port};
}

/* Runs in the page: layout rows and low-contrast texts. */
function measure() {
  const parse = c => { const m = c.match(/[\d.]+/g).map(Number); return {r: m[0], g: m[1], b: m[2], a: m[3] === undefined ? 1 : m[3]}; };
  const lum = ({r, g, b}) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (top, a, under) => ({r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a)});
  const bgOf = e => {
    const stack = [];
    for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.a > 0) { stack.push(c); if (c.a >= 1) break; } }
    let out = {r: 255, g: 255, b: 255};
    for (const c of stack.reverse()) out = over(c, c.a, out);
    return out;
  };
  const low = [];
  for (const e of document.querySelectorAll('body *')) {
    if (!e.offsetParent) continue;
    if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || e.closest('button:disabled,[aria-disabled="true"],[disabled]')) continue;
    let op = 1; for (let n = e; n; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
    const bg = bgOf(e), c = parse(cs.color), fg = over(c, c.a * op, bg);
    const L1 = lum(fg), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    if (ratio < 4.5) low.push((e.id ? '#' + e.id : e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '')) + ' "' + e.textContent.trim().slice(0, 16) + '" ' + ratio.toFixed(2));
  }
  const shown = e => e.offsetParent && getComputedStyle(e).display !== 'none';
  const rows = root => new Set([...root.querySelectorAll('button,a,strong')].filter(shown).map(e => { const r = e.getBoundingClientRect(); return Math.round(r.top + r.height / 2); })).size;
  return {theme: document.documentElement.dataset.theme, scroll: document.documentElement.scrollWidth - innerWidth,
    toolbar: rows(document.querySelector('.ide-toolbar')), files: rows(document.getElementById('files-heading')),
    debug: rows(document.querySelector('.ide-debug > .ide-heading')), low: [...new Set(low)]};
}

test('Web IDE light and dark theme: layout and text contrast', {skip: CHROME ? false : 'no local Chrome', timeout: 60000}, async t => {
  const mock = startMock();
  let b;
  try {
    const base = 'http://127.0.0.1:' + await mock.port;
    const api = (method, url, body) => fetch(base + url, {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    await api('POST', '/projects/theme', {});
    await api('PUT', '/projects/theme/files', {files: [
      {path: '__init__.py', content: 'from xscript.android import action\n\ndef main():\n    # 注释\n    action.click(540, 1200)\n    print("done", 42)\n'},
      {path: 'utils/a.py', content: 'A = 1\n'}]});
    b = await cdp.launch(CHROME);
    for (const scheme of ['light', 'dark']) {
      for (const w of [721, 1280]) {
        await t.test(`${scheme} ${w}px`, async () => {
          await b.cmd('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: scheme}]});
          await b.cmd('Emulation.setDeviceMetricsOverride', {width: w, height: 720, deviceScaleFactor: 1, mobile: false});
          await b.goto(base + '/tools/ui/editor.html?project=theme');
          await b.waitFor(() => document.getElementById('editor').value.startsWith('from xscript'));
          const m = await b.eval(measure);
          assert.equal(m.theme, scheme);
          assert.ok(m.scroll <= 0, 'no horizontal scrolling: ' + JSON.stringify(m));
          assert.deepEqual([m.toolbar, m.files, m.debug], [1, 1, 1], 'toolbar, 文件 and debugger headings are one row each: ' + JSON.stringify(m));
          assert.deepEqual(m.low, [], 'texts below 4.5:1 contrast');
        });
      }
    }
    assert.deepEqual(b.errors, [], 'no page errors');
  } finally {
    if (b) await b.close();
    mock.child.kill();
  }
});
