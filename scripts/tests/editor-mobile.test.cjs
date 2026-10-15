/* Web IDE on phone-sized viewports (headless Chrome with mobile + touch emulation) against scripts/mock_device.py:
 * no horizontal overflow, the explorer drawer, completion popup and search panel stay inside the screen.
 * Skipped when no local Chrome is found. XS_DEVICE_URL=http://127.0.0.1:19860 runs it against a real device instead. */
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
    let out = '', err = ''; const timer = setTimeout(() => reject(Error('Mock startup timed out: ' + err)), 5000);
    child.once('exit', code => { clearTimeout(timer); reject(Error('Mock exited ' + code + ': ' + err)); });
    child.stderr.on('data', b => { err += b; });
    child.stdout.on('data', b => { out += b; if (out.includes('\n')) { clearTimeout(timer); resolve(Number(out.trim())); } });
  });
  return {child, port};
}

const rect = sel => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return {l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height}; };
const inside = (r, w, h) => r && r.l >= -0.5 && r.r <= w + 0.5 && r.t >= -0.5 && r.b <= h + 0.5;

test('Web IDE on phone-sized viewports', {skip: CHROME ? false : 'no local Chrome (set $CHROME or install puppeteer browsers)', timeout: 90000}, async t => {
  const device = process.env.XS_DEVICE_URL ? process.env.XS_DEVICE_URL.replace(/\/$/, '') : '';
  const mock = device ? null : startMock();
  let b;
  try {
    const base = device || 'http://127.0.0.1:' + await mock.port;
    const api = async (method, url, body) => {
      const r = await fetch(base + url, {method, headers: {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
      const data = await r.json(); if (!r.ok) throw Error(data.error); return data;
    };
    if (device) await fetch(base + '/projects/mob', {method: 'DELETE'});
    await api('POST', '/projects/mob', {});
    const long = 'x = "' + 'w'.repeat(120) + '"\n';
    await api('PUT', '/projects/mob/files', {files: [
      {path: '__init__.py', content: 'from xscript.android import action\n' + long}, {path: 'utils/a.py', content: 'A = 1\nneedle = 2\n'}, {path: 'notes.txt', content: 'hi\n'}]});
    b = await cdp.launch(CHROME);
    const step = (name, fn) => t.test(name, async () => { try { await fn(); } catch (e) { console.error('FAIL ' + name + ': ' + e.message.slice(0, 600)); throw e; } });
    if (process.env.XS_TRACE) for (const k of ['goto', 'eval', 'waitFor']) { const f = b[k].bind(b); b[k] = (...a) => { console.error('>', k, String(a[0]).slice(0, 90).replace(/\s+/g, ' ')); return f(...a); }; }
    // unsaved edits from the previous test raise a beforeunload dialog that blocks navigation: accept it
    const go = async url => { const p = b.goto(url); const iv = setInterval(() => b.cmd('Page.handleJavaScriptDialog', {accept: true}).catch(() => {}), 150); try { await p; } finally { clearInterval(iv); } };
    const tap = async (sel, at) => {
      const r = await b.eval(rect, sel); const x = at ? at.x : r.l + r.w / 2, y = at ? at.y : r.t + r.h / 2;
      await b.cmd('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
      await b.cmd('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    };
    const open = async (w, h) => {
      await b.cmd('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: 2, mobile: true});
      await b.cmd('Emulation.setTouchEmulationEnabled', {enabled: true});
      await go(base + '/tools/ui/editor.html?project=mob');
      await b.waitFor(() => document.getElementById('editor').value.startsWith('from xscript'));
      await b.waitFor(() => window.XSApi && Object.keys(window.XSApi.modules || {}).length > 0, 8000);
    };
    const settled = sel => b.waitFor(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.left >= -0.5 && r.left <= 0.5; }, 3000, sel);
    const noOverflow = async (w, label) => {
      const m = await b.eval(() => ({sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth}));
      assert.ok(m.sw <= w && m.bw <= w, label + ': page scrolls horizontally ' + JSON.stringify(m));
    };
    const setup = text => b.eval(txt => { const e = document.getElementById('editor'); e.focus(); e.value = txt; e.setSelectionRange(txt.length, txt.length); e.dispatchEvent(new Event('input')); }, text);

    for (const [w, h] of [[360, 740], [320, 568], [412, 915]]) {
      await step(`${w}x${h}: drawer, editor width, no overflow`, async () => {
        await open(w, h);
        await noOverflow(w, 'initial');
        assert.equal(await b.eval(() => getComputedStyle(document.getElementById('sidebar-toggle')).display !== 'none'), true, 'toggle visible on a phone');
        assert.equal(await b.eval(() => getComputedStyle(document.getElementById('files-drawer')).visibility), 'hidden', 'drawer closed at start');
        const ed = await b.eval(rect, '.ide-code');
        assert.ok(ed.w >= w - 60, 'editor uses the screen width (' + ed.w + ' of ' + w + ')');
        for (const id of ['save', 'run', 'sidebar-toggle']) assert.ok(inside(await b.eval(rect, '#' + id), w, h), id + ' on screen');
        // real touch: open the drawer, pick a file, drawer closes
        await tap('#sidebar-toggle');
        await b.waitFor(() => document.querySelector('.ide').classList.contains('sidebar-open'));
        assert.equal(await b.eval(() => document.getElementById('sidebar-toggle').getAttribute('aria-expanded')), 'true');
        const dr = await b.eval(rect, '#files-drawer');
        assert.ok(dr.r <= w && dr.w >= 200, 'drawer inside the screen ' + JSON.stringify(dr));
        await settled('#files-drawer');
        await noOverflow(w, 'drawer open');
        await tap('#files .tree-row[data-path="notes.txt"]');
        await b.waitFor(() => document.getElementById('editor').value === 'hi\n');
        await b.waitFor(() => !document.querySelector('.ide').classList.contains('sidebar-open'));
        // tap on the editor closes the drawer too
        await tap('#sidebar-toggle'); await settled('#files-drawer');
        await tap('#editor', {x: w - 8, y: h / 3}); await b.waitFor(() => !document.querySelector('.ide').classList.contains('sidebar-open'));
      });

      await step(`${w}x${h}: completion popup stays on screen, also at the right edge`, async () => {
        await open(w, h);
        for (const prefix of ['', 'y' + ' '.repeat(40)]) {
          // against a real device the page may still be settling (slow link, project poll): retry the typing a few times
          let host, pop;
          for (let attempt = 0; attempt < 5 && !(pop && pop.w > 0); attempt++) {
            await setup('from xscript.android import action\n' + prefix);
            await b.insertText('action.cl');
            ({host, pop} = await b.waitFor(() => {
              const p = document.getElementById('complete'); if (p.hidden || !p.offsetWidth || !p.querySelector('li')) return null;
              const r = e => { const x = e.getBoundingClientRect(); return {l: x.left, r: x.right, t: x.top, b: x.bottom, w: x.width, h: x.height}; };
              return {host: r(document.querySelector('.ide-code')), pop: r(p)};
            }, 1500).catch(() => ({})));
            if (!(pop && pop.w > 0) && process.env.XS_TRACE) console.error('popup retry', attempt);
          }
          assert.ok(pop && pop.w > 0, 'completion popup opened');
          assert.ok(pop.l >= host.l - 1 && pop.r <= host.r + 1, 'popup inside the editor horizontally: ' + JSON.stringify({pop, host}));
          assert.ok(inside(pop, w, h), 'popup inside the viewport ' + JSON.stringify(pop));
          await b.key('Enter', 'Enter', 13);
          await b.waitFor(() => /action\.click$/.test(document.getElementById('editor').value), 2000);
        }
        await noOverflow(w, 'after completion');
      });

      await step(`${w}x${h}: search panel and undo button fit the drawer`, async () => {
        await open(w, h);
        await tap('#sidebar-toggle'); await settled('#files-drawer');
        await b.eval(() => document.getElementById('open-search').click());
        await b.eval(() => { const q = document.getElementById('search-q'); q.value = 'needle'; q.dispatchEvent(new Event('input')); document.getElementById('search-go').click(); });
        await b.waitFor(() => document.querySelectorAll('#search-results .sr-match').length === 1);
        const dr = await b.eval(rect, '#files-drawer');
        for (const id of ['search-q', 'search-r', 'search-go', 'replace-all', 'replace-undo', 's-regex']) {
          const r = await b.eval(rect, '#' + id);
          assert.ok(r.l >= dr.l - 0.5 && r.r <= dr.r + 0.5, id + ' inside the drawer ' + JSON.stringify({r, dr}));
        }
        await noOverflow(w, 'search');
        await tap('#search-results .sr-match');
        await b.waitFor(() => document.getElementById('editor').value === 'A = 1\nneedle = 2\n');
        await b.waitFor(() => !document.querySelector('.ide').classList.contains('sidebar-open'));
      });
    }

    await step('desktop width keeps the two-column layout and hides the drawer toggle', async () => {
      await b.cmd('Emulation.setDeviceMetricsOverride', {width: 1280, height: 800, deviceScaleFactor: 1, mobile: false});
      await b.cmd('Emulation.setTouchEmulationEnabled', {enabled: false});
      await go(base + '/tools/ui/editor.html?project=mob');
      await b.waitFor(() => document.getElementById('editor').value.startsWith('from xscript'));
      assert.equal(await b.eval(() => getComputedStyle(document.getElementById('sidebar-toggle')).display), 'none');
      assert.equal(await b.eval(() => getComputedStyle(document.getElementById('files-drawer')).visibility), 'visible');
      assert.equal((await b.eval(rect, '#files-drawer')).w, 230);
    });
    assert.deepEqual(b.errors, [], 'no page errors');
  } finally {
    if (b) await b.close();
    if (mock) mock.child.kill();
    if (device) await fetch(device + '/projects/mob', {method: 'DELETE'}).catch(() => {});
  }
});
