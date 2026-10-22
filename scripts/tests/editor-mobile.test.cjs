/* Web IDE on phone-sized viewports (headless Chrome with mobile + touch emulation) against scripts/mock_device.py:
 * no horizontal overflow, the explorer drawer, completion popup and search panel stay inside the screen.
 * Skipped when no local Chrome is found. XS_DEVICE_URL=http://127.0.0.1:19860 runs it against a real device instead.
 * XS_CDP=http://127.0.0.1:9222 (with XS_PAGE_URL=http://127.0.0.1:9860, the device URL as the phone sees it) drives the
 * phone's own Chrome over `adb forward tcp:9222 localabstract:chrome_devtools_remote` with its real screen size. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');
const cdp = require('./cdp.cjs');

const CHROME = cdp.find();
const REMOTE = process.env.XS_CDP || '';
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

test('Web IDE on phone-sized viewports', {skip: CHROME || REMOTE ? false : 'no local Chrome (set $CHROME or install puppeteer browsers)', timeout: 60000 + cdp.LAUNCH_BUDGET_MS}, async t => {
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
      {path: '__init__.py', content: 'from xscript.android import action\n' + long}, {path: 'utils/a.py', content: 'A = 1\nneedle = 2\n'}, {path: 'notes.txt', content: 'hi\n'}, {path: 'redos.txt', content: 'a'.repeat(60) + 'b\n'}]});
    b = REMOTE ? await cdp.attach(REMOTE) : await cdp.launch(CHROME);
    const pageBase = process.env.XS_PAGE_URL ? process.env.XS_PAGE_URL.replace(/\/$/, '') : base;
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
      if (!REMOTE) {
        await b.cmd('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: 2, mobile: true});
        await b.cmd('Emulation.setTouchEmulationEnabled', {enabled: true});
      }
      await go(pageBase + '/tools/ui/editor.html?project=mob');
      await b.waitFor(() => document.getElementById('editor').value.startsWith('from xscript'));
      await b.waitFor(() => window.XSApi && Object.keys(window.XSApi.modules || {}).length > 0, 8000);
    };
    const settled = sel => b.waitFor(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.left >= -0.5 && r.left <= 0.5; }, 3000, sel);
    const noOverflow = async (w, label) => {
      const m = await b.eval(() => ({sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth}));
      assert.ok(m.sw <= w && m.bw <= w, label + ': page scrolls horizontally ' + JSON.stringify(m));
    };
    const setup = text => b.eval(txt => { const e = document.getElementById('editor'); e.focus(); e.value = txt; e.setSelectionRange(txt.length, txt.length); e.dispatchEvent(new Event('input')); }, text);

    let sizes = [[360, 740], [320, 568], [412, 915]];
    if (REMOTE) {   // the phone's real viewport
      await b.goto('about:blank'); await go(pageBase + '/tools/ui/editor.html?project=mob');
      sizes = [await b.eval(() => [innerWidth, innerHeight])]; console.error('phone viewport', sizes[0].join('x'), await b.eval(() => navigator.userAgent));
    }
    for (const [w, h] of sizes) {
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
        for (const prefix of ['', 'z = ' + '1 + '.repeat(14)]) {   // the second line runs past the right edge of the screen
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
          assert.ok(pop && pop.w > 0, 'completion popup opened; page state ' + JSON.stringify(await b.eval(() => ({disabled: document.getElementById('editor').disabled, tab: (document.querySelector('#tabs .active') || {dataset: {}}).dataset.path, value: document.getElementById('editor').value.slice(-40), hidden: document.getElementById('complete').hidden, auto: document.getElementById('auto-complete').checked, focus: document.activeElement.id}))));
          assert.ok(pop.l >= host.l - 1 && pop.r <= host.r + 1, 'popup inside the editor horizontally: ' + JSON.stringify({pop, host}));
          assert.ok(inside(pop, w, h), 'popup inside the viewport ' + JSON.stringify(pop));
          // the browser scrolls the textarea to follow the caret on a narrow screen: that must not close the popup
          await b.eval(() => document.getElementById('editor').dispatchEvent(new Event('scroll')));
          assert.equal(await b.eval(() => !document.getElementById('complete').hidden), true, 'popup survives a scroll event while the caret is visible');
          const again = await b.eval(rect, '#complete');
          assert.ok(again && again.r <= w + 0.5 && again.l >= -0.5, 'and is still on screen after repositioning ' + JSON.stringify(again));
          await b.key('Enter', 'Enter', 13);
          await b.waitFor(() => /action\.click$/.test(document.getElementById('editor').value), 2000).catch(async e => { throw Error(e.message + ' [value ' + JSON.stringify(await b.eval(() => document.getElementById('editor').value.slice(-50))) + ', popup hidden ' + await b.eval(() => document.getElementById('complete').hidden) + ']'); });
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

    await step('phone: replace all, undo it, and the ReDoS guard — all from the drawer with touch', async () => {
      const [w, h] = sizes[0];
      await open(w, h);
      await b.eval(() => { window.confirm = () => true; });
      const set = (id, v) => b.eval((i, val) => { const n = document.getElementById(i); n.value = val; n.dispatchEvent(new Event('input')); }, id, v);
      const disk = async p => (await api('GET', '/projects/mob/file?path=' + encodeURIComponent(p))).content;
      await tap('#sidebar-toggle'); await settled('#files-drawer');
      await b.eval(() => document.getElementById('open-search').click());
      await set('search-q', 'needle'); await set('search-r', 'pin'); await set('search-inc', 'utils/**');
      await tap('#search-go');
      await b.waitFor(() => document.querySelectorAll('#search-results .sr-match').length === 1);
      await tap('#replace-all');
      await b.waitFor(() => /已替换 1 处/.test(document.getElementById('search-summary').textContent));
      assert.equal(await disk('utils/a.py'), 'A = 1\npin = 2\n');
      assert.equal(await b.eval(() => document.getElementById('replace-undo').disabled), false);
      await tap('#replace-undo');
      await b.waitFor(() => /已撤销 1 个文件/.test(document.getElementById('search-summary').textContent));
      assert.equal(await disk('utils/a.py'), 'A = 1\nneedle = 2\n', 'undo wrote the original text back to the device');
      // ReDoS: refused up front, and a hidden catastrophic pattern is cut off by the worker timeout without freezing the page
      await b.eval(() => { if (document.getElementById('s-regex').getAttribute('aria-pressed') !== 'true') document.getElementById('s-regex').click(); });
      await set('search-inc', 'redos.txt'); await set('search-q', '(a+)+$'); await tap('#search-go');
      await b.waitFor(() => /嵌套的无限重复/.test(document.getElementById('search-summary').textContent));
      await set('search-q', '(a|aa)+$');
      const t0 = Date.now(); await tap('#search-go');
      const ticks = await b.eval(() => new Promise(res => { let n = 0; const id = setInterval(() => n++, 50); setTimeout(() => { clearInterval(id); res(n); }, 1000); }));
      assert.ok(ticks >= 8, 'page stayed responsive while the worker spun (ticks ' + ticks + ')');
      await b.waitFor(() => /超时/.test(document.getElementById('search-summary').textContent), 15000);
      const took = Date.now() - t0;
      assert.ok(took >= 2000 && took < 9000, 'aborted around the 2.5 s limit (took ' + took + ' ms)');
    });

    if (!REMOTE) await step('desktop width keeps the two-column layout and hides the drawer toggle', async () => {
      await b.cmd('Emulation.setDeviceMetricsOverride', {width: 1280, height: 800, deviceScaleFactor: 1, mobile: false});
      await b.cmd('Emulation.setTouchEmulationEnabled', {enabled: false});
      await go(base + '/tools/ui/editor.html?project=mob');
      await b.waitFor(() => document.getElementById('editor').value.startsWith('from xscript'));
      assert.equal(await b.eval(() => getComputedStyle(document.getElementById('sidebar-toggle')).display), 'none');
      assert.equal(await b.eval(() => getComputedStyle(document.getElementById('files-drawer')).visibility), 'visible');
      assert.equal((await b.eval(rect, '#files-drawer')).w, 230);
      // the 文件 heading (title + 搜索 / 新建 / 文件夹 / 刷新) stays on one line and inside the sidebar
      const head = await b.eval(() => {
        const h = document.getElementById('files-heading'), side = document.getElementById('files-drawer').getBoundingClientRect();
        const items = [h.querySelector('strong'), ...h.querySelectorAll('button')].map(e => e.getBoundingClientRect());
        const title = h.querySelector('strong').getBoundingClientRect();
        return {titleH: title.height, titleW: title.width, h: h.getBoundingClientRect().height, tops: items.map(r => Math.round(r.top + r.height / 2)), right: Math.max(...items.map(r => r.right)), sideRight: side.right};
      });
      assert.ok(head.titleH < 20 && head.titleW > head.titleH, 'the 文件 title is not squeezed into a vertical stack: ' + JSON.stringify(head));
      assert.ok(head.h < 44, 'heading is one row high (two rows measured 56 px): ' + JSON.stringify(head));
      assert.equal(new Set(head.tops).size, 1, 'title and buttons share one row: ' + JSON.stringify(head));
      assert.ok(head.right <= head.sideRight, 'buttons stay inside the sidebar: ' + JSON.stringify(head));
    });
    if (!REMOTE) await step('desktop widths 721–1180 px keep the toolbar, 文件 and debugger headings on one row', async () => {
      for (const w of [721, 760, 800, 860, 900, 1024, 1100, 1180]) {
        await b.cmd('Emulation.setDeviceMetricsOverride', {width: w, height: 720, deviceScaleFactor: 1, mobile: false});
        await go(base + '/tools/ui/editor.html?project=mob');
        await b.waitFor(() => document.getElementById('editor').value.startsWith('from xscript'));
        await noOverflow(w, w + 'px');
        const m = await b.eval(() => {
          const shown = e => e.offsetParent && getComputedStyle(e).display !== 'none';
          const rows = root => new Set([...root.querySelectorAll('button,a,strong')].filter(shown).map(e => { const r = e.getBoundingClientRect(); return Math.round(r.top + r.height / 2); })).size;
          const tb = document.querySelector('.ide-toolbar').getBoundingClientRect(), last = [...document.querySelectorAll('.ide-toolbar button,.ide-toolbar a')].filter(shown).map(e => e.getBoundingClientRect().right);
          const bar = document.querySelector('.ide-toolbar');
          return {toolbarRows: rows(bar), headingRows: rows(document.getElementById('files-heading')), debugRows: rows(document.querySelector('.ide-debug > .ide-heading')), right: Math.max(...last), tbRight: tb.right, scroll: bar.scrollWidth - bar.clientWidth, scrollable: getComputedStyle(bar).overflowX === 'auto'};
        });
        assert.equal(m.toolbarRows, 1, w + 'px: toolbar buttons share one row (删除文件 used to wrap alone): ' + JSON.stringify(m));
        assert.equal(m.headingRows, 1, w + 'px: 文件 heading is one row: ' + JSON.stringify(m));
        assert.equal(m.debugRows, 1, w + 'px: debugger heading is one row: ' + JSON.stringify(m));
        // ≤800 px the toolbar may scroll sideways instead of wrapping; wider than that everything fits
        if (w > 800) assert.ok(m.right <= m.tbRight && m.scroll <= 0, w + 'px: toolbar buttons fit: ' + JSON.stringify(m));
        else assert.ok(m.scroll <= 0 || (m.scrollable && m.scroll < 80), w + 'px: toolbar overflow is scrollable and small: ' + JSON.stringify(m));
      }
    });
    assert.deepEqual(b.errors, [], 'no page errors');
  } finally {
    if (b) await b.close();
    if (mock) mock.child.kill();
    if (device) await fetch(device + '/projects/mob', {method: 'DELETE'}).catch(() => {});
  }
});
