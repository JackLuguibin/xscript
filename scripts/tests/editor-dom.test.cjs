/* Web IDE UI (editor.js) in headless Chrome against scripts/mock_device.py: explorer tree clicks,
 * chevron vs row, keyboard navigation, create/delete flows, tab/breakpoint cleanup, syntax overlay.
 * Skipped when no local Chrome is found ($CHROME or ~/.cache/puppeteer).
 * XS_DEVICE_URL=http://127.0.0.1:19860 runs it against a real device instead (project "dom" is removed afterwards). */
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

// In-page helpers (serialised into the page with eval).
const rows = () => [...document.querySelectorAll('#files .tree-row')].map(r => ({
  path: r.dataset.path, type: r.dataset.type, level: Number(r.getAttribute('aria-level')),
  selected: r.classList.contains('selected'), expanded: r.getAttribute('aria-expanded'), tab: r.tabIndex,
  dirty: !!r.querySelector('.dirty'),
}));
const state = () => ({
  editor: document.getElementById('editor').value, disabled: document.getElementById('editor').disabled,
  message: document.getElementById('message').textContent, error: document.getElementById('message').classList.contains('error'),
  tabs: [...document.querySelectorAll('#tabs [role=tab]')].map(t => ({text: t.textContent, selected: t.getAttribute('aria-selected') === 'true'})),
  del: {text: document.getElementById('delete-file').textContent, disabled: document.getElementById('delete-file').disabled},
  active: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.path || document.activeElement.id : '',
});
const click = sel => { const n = document.querySelector(sel); if (!n) throw Error('no element ' + sel); n.click(); return true; };
const row = p => '#files .tree-row[data-path="' + p + '"]';
const idle = () => !document.getElementById('new-file').disabled;

test('Web IDE explorer, editor and create/delete flows in a real browser', {skip: CHROME ? false : 'no local Chrome (set $CHROME or install puppeteer browsers)', timeout: 60000}, async t => {
  const device = process.env.XS_DEVICE_URL ? process.env.XS_DEVICE_URL.replace(/\/$/, '') : '';
  const mock = device ? null : startMock();
  let browser, base;
  try {
    base = device || 'http://127.0.0.1:' + await mock.port;
    const api = async (method, url, body) => {
      const r = await fetch(base + url, {method, headers: {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
      const data = await r.json(); if (!r.ok) throw Error(data.error); return data;
    };
    if (device) await fetch(base + '/projects/dom', {method: 'DELETE'});
    await api('POST', '/projects/dom', {});
    // The device scaffolds res/img in new projects (the mock does not); start from the same tree.
    for (const p of ['res/img', 'res']) await fetch(base + '/projects/dom/file?path=' + encodeURIComponent(p), {method: 'DELETE'});
    const longMain = 'import time\n' + Array.from({length: 80}, (_, i) => `def f${i}():\n    return "s${i}"  # c${i}`).join('\n') + '\n';
    await api('PUT', '/projects/dom/files', {files: [
      {path: '__init__.py', content: longMain}, {path: 'utils/a.py', content: 'A = 1\n'}, {path: 'utils/b.py', content: 'B = 2\n'},
      {path: 'utils/deep/c.py', content: 'C = 3\n'}, {path: 'readme.txt', content: 'hello\n'}]});
    await api('POST', '/projects/dom/dir', {path: 'assets'});

    browser = await cdp.launch(CHROME);
    const b = browser;
    const prompts = answers => b.eval(a => { window.__prompts = []; window.__answers = a.slice(); window.prompt = (msg, def) => { window.__prompts.push({msg, def}); return window.__answers.length ? window.__answers.shift() : null; }; }, answers);
    const confirms = answers => b.eval(a => { window.__confirms = []; window.__cAnswers = a.slice(); window.confirm = msg => { window.__confirms.push(msg); return window.__cAnswers.length ? window.__cAnswers.shift() : false; }; }, answers);
    const settle = () => b.waitFor(idle);
    const R = () => b.eval(rows), S = () => b.eval(state);

    await b.goto(base + '/tools/ui/editor.html?project=dom');
    await b.waitFor(() => document.getElementById('editor').value.startsWith('import time'));

    await t.test('initial tree: folders first, collapsed, entry open and selected', async () => {
      const r = await R();
      assert.deepEqual(r.map(x => x.path), ['assets', 'utils', '__init__.py', 'readme.txt']);
      assert.deepEqual(r.map(x => x.expanded), ['false', 'false', null, null]);
      assert.deepEqual(r.filter(x => x.selected).map(x => x.path), ['__init__.py']);
      assert.deepEqual(r.filter(x => x.tab === 0).map(x => x.path), ['__init__.py'], 'roving tabindex on the selected row');
      const s = await S();
      assert.deepEqual(s.tabs, [{text: '__init__.py', selected: true}]);
      assert.equal(s.del.disabled, true, 'entry point cannot be deleted');
    });

    await t.test('chevron toggles a folder without changing selection or editor', async () => {
      await b.eval(click, row('utils') + ' .twisty');
      let r = await R();
      assert.deepEqual(r.map(x => x.path), ['assets', 'utils', 'utils/deep', 'utils/a.py', 'utils/b.py', '__init__.py', 'readme.txt']);
      assert.equal(r.find(x => x.path === 'utils/a.py').level, 2);
      assert.deepEqual(r.filter(x => x.selected).map(x => x.path), ['__init__.py']);
      assert.match((await S()).editor, /^import time/);
      await b.eval(click, row('utils') + ' .twisty');
      r = await R(); assert.equal(r.some(x => x.path === 'utils/a.py'), false);
    });

    await t.test('row click on a folder toggles and selects it; delete becomes 删除文件夹', async () => {
      await b.eval(click, row('utils'));
      const r = await R();
      assert.equal(r.find(x => x.path === 'utils').expanded, 'true');
      assert.deepEqual(r.filter(x => x.selected).map(x => x.path), ['utils']);
      const s = await S();
      assert.equal(s.del.text, '删除文件夹'); assert.equal(s.del.disabled, false);
      assert.match(s.editor, /^import time/, 'open file is kept');
    });

    await t.test('clicking a file opens it in a tab', async () => {
      await b.eval(click, row('utils/a.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'A = 1\n');
      const s = await S();
      assert.deepEqual(s.tabs.map(x => x.text), ['__init__.py', 'utils/a.py']);
      assert.equal(s.tabs[1].selected, true);
      assert.equal(s.del.text, '删除文件');
    });

    await t.test('keyboard: arrows move selection, Left collapses/goes to parent, Enter opens', async () => {
      await b.eval(() => document.querySelector('#files .tree-row[data-path="utils/a.py"]').focus());
      await b.key('ArrowDown', 'ArrowDown', 40);
      let s = await S(), r = await R();
      assert.equal(s.active, 'utils/b.py');
      assert.deepEqual(r.filter(x => x.selected).map(x => x.path), ['utils/b.py']);
      assert.equal(s.editor, 'A = 1\n', 'arrow keys do not open files');
      await b.key('ArrowUp', 'ArrowUp', 38); await b.key('ArrowUp', 'ArrowUp', 38);
      assert.equal((await S()).active, 'utils/deep');
      await b.key('ArrowRight', 'ArrowRight', 39);
      r = await R(); assert.equal(r.find(x => x.path === 'utils/deep').expanded, 'true');
      await b.key('ArrowRight', 'ArrowRight', 39);
      assert.equal((await S()).active, 'utils/deep/c.py');
      await b.key('Enter', 'Enter', 13);
      await b.waitFor(() => document.getElementById('editor').value === 'C = 3\n');
      await b.key('ArrowLeft', 'ArrowLeft', 37);
      assert.equal((await S()).active, 'utils/deep');
      await b.key('ArrowLeft', 'ArrowLeft', 37);
      r = await R(); assert.equal(r.find(x => x.path === 'utils/deep').expanded, 'false');
      await b.key('Home', 'Home', 36); assert.equal((await S()).active, 'assets');
      await b.key('End', 'End', 35); assert.equal((await S()).active, 'readme.txt');
    });

    await t.test('new file defaults to the selected folder, reveals and opens it; duplicates are rejected', async () => {
      await b.eval(click, row('assets'));
      await prompts(['assets/new.py']);
      await b.eval(click, '#new-file'); await settle();
      assert.deepEqual(await b.eval(() => window.__prompts.map(p => p.def)), ['assets/']);
      await b.waitFor(() => document.getElementById('message').textContent.includes('已创建 assets/new.py'));
      const r = await R(); let s = await S();
      assert.equal(r.find(x => x.path === 'assets').expanded, 'true');
      assert.deepEqual(r.filter(x => x.selected).map(x => x.path), ['assets/new.py']);
      assert.equal(s.editor, ''); assert.equal(s.tabs.find(x => x.selected).text, 'assets/new.py');
      assert.equal(s.active, 'editor');
      assert((await api('GET', '/projects/dom/files')).files.some(f => f.path === 'assets/new.py'));
      await prompts(['assets/new.py']);
      await b.eval(click, '#new-file'); await settle();
      s = await S(); assert.equal(s.error, true); assert.match(s.message, /已存在/);
      await prompts(['../evil.py']);
      await b.eval(click, '#new-file'); await settle();
      s = await S(); assert.equal(s.error, true);
      await prompts([null]); const before = await R();
      await b.eval(click, '#new-file'); await settle();
      assert.deepEqual(await R(), before, 'cancelled prompt changes nothing');
    });

    await t.test('new folder from an open file defaults to its folder and selects the new folder', async () => {
      await b.eval(click, row('utils/a.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'A = 1\n');
      await prompts(['utils/empty']);
      await b.eval(click, '#new-folder'); await settle();
      assert.deepEqual(await b.eval(() => window.__prompts.map(p => p.def)), ['utils/']);
      const r = await R();
      assert.deepEqual(r.filter(x => x.selected).map(x => x.path), ['utils/empty']);
      assert.equal(r.find(x => x.path === 'utils/empty').type, 'dir');
      assert.ok(r.findIndex(x => x.path === 'utils/empty') < r.findIndex(x => x.path === 'utils/a.py'), 'folders sort before files');
    });

    await t.test('deleting folders: non-empty is refused locally, empty one is removed after confirm', async () => {
      await b.eval(click, row('utils')); // collapse + select
      await confirms([true]);
      await b.eval(click, '#delete-file'); await settle();
      let s = await S(); assert.equal(s.error, true); assert.match(s.message, /非空/);
      assert.deepEqual(await b.eval(() => window.__confirms), [], 'no confirm for a non-empty folder');
      await b.eval(click, row('utils')); // expand again
      await b.eval(click, row('utils/empty'));
      await confirms([false]);
      await b.eval(click, '#delete-file'); await settle();
      assert((await R()).some(x => x.path === 'utils/empty'), 'cancel keeps the folder');
      await confirms([true]);
      await b.eval(click, '#delete-file'); await settle();
      await b.waitFor(() => document.getElementById('message').textContent.includes('已删除文件夹 utils/empty/'));
      assert.equal((await R()).some(x => x.path === 'utils/empty'), false);
      assert.equal((await api('GET', '/projects/dom/files')).dirs.includes('utils/empty'), false);
    });

    await t.test('delete removes the file selected in the tree, closes its tab and clears its breakpoints', async () => {
      await b.eval(click, row('utils/a.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'A = 1\n');
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); e.setSelectionRange(0, 0); });
      await b.eval(click, '#breakpoint');
      await b.waitFor(() => document.getElementById('line-numbers').textContent.startsWith('● 1'));
      await confirms([true]);
      await b.eval(click, '#delete-file'); await settle();
      await b.waitFor(() => document.getElementById('message').textContent.includes('已删除 utils/a.py'));
      let s = await S();
      assert.equal(s.tabs.some(x => x.text.startsWith('utils/a.py')), false, 'tab closed');
      assert.match(s.editor, /^import time/, 'falls back to the entry file');
      assert.equal((await R()).some(x => x.path === 'utils/a.py'), false);
      // Recreating the same path starts without the old breakpoint.
      await b.eval(click, row('utils'));
      await prompts(['utils/a.py']);
      await b.eval(click, '#new-file'); await settle();
      await b.waitFor(() => document.getElementById('message').textContent.includes('已创建 utils/a.py'));
      assert.equal(await b.eval(() => document.getElementById('line-numbers').textContent.includes('●')), false);
      assert.equal(await b.eval(() => document.getElementById('breakpoint-list').textContent), '当前文件无断点');
      // Keyboard selection (without opening) is what 删除文件 acts on.
      await b.eval(click, row('readme.txt'));
      await b.waitFor(() => document.getElementById('editor').value === 'hello\n');
      await b.eval(() => document.querySelector('#files .tree-row[data-path="readme.txt"]').focus());
      await b.key('ArrowUp', 'ArrowUp', 38);
      assert.equal((await S()).active, '__init__.py');
      s = await S(); assert.equal(s.del.disabled, true, 'entry point selected: delete disabled');
      await b.eval(click, row('utils/b.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'B = 2\n');
      await b.eval(() => document.querySelector('#files .tree-row[data-path="utils/b.py"]').focus());
      await b.key('ArrowUp', 'ArrowUp', 38); // utils/a.py selected, utils/b.py still open
      assert.deepEqual((await R()).filter(x => x.selected).map(x => x.path), ['utils/a.py']);
      await confirms([true]);
      await b.eval(click, '#delete-file'); await settle();
      assert.match(await b.eval(() => window.__confirms[0]), /utils\/a\.py/, 'confirm names the selected file');
      const files = (await api('GET', '/projects/dom/files')).files.map(f => f.path);
      assert.equal(files.includes('utils/a.py'), false, 'selected file deleted');
      assert.equal(files.includes('utils/b.py'), true, 'open (unselected) file kept');
    });

    await t.test('dirty edits: input marks tab and tree row, Cmd/Ctrl+S saves', async () => {
      await b.eval(click, row('utils/b.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'B = 2\n');
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); e.value = 'B = 3\n'; e.dispatchEvent(new Event('input')); });
      let s = await S(), r = await R();
      assert.equal(s.tabs.find(x => x.selected).text, 'utils/b.py ●');
      assert.equal(r.find(x => x.path === 'utils/b.py').dirty, true);
      await b.eval(() => window.dispatchEvent(new KeyboardEvent('keydown', {key: 's', ctrlKey: true})));
      await b.waitFor(() => document.getElementById('message').textContent.includes('已保存 utils/b.py'));
      assert.equal((await api('GET', '/projects/dom/file?path=utils/b.py')).content, 'B = 3\n');
      r = await R(); assert.equal(r.find(x => x.path === 'utils/b.py').dirty, false);
    });

    await t.test('syntax overlay: highlighted Python, plain text for others, follows edits and scroll', async () => {
      await b.eval(click, row('__init__.py'));
      await b.waitFor(() => document.querySelector('#highlight .tok-keyword'));
      assert.equal(await b.eval(() => document.getElementById('editor').classList.contains('highlighted')), true);
      assert.equal(await b.eval(() => document.getElementById('highlight').textContent.replace(/\n$/, '') === document.getElementById('editor').value), true, 'overlay text matches the textarea');
      await b.eval(() => { const e = document.getElementById('editor'); e.scrollTop = 400; e.dispatchEvent(new Event('scroll')); });
      const scroll = await b.eval(() => [document.getElementById('editor').scrollTop, document.getElementById('highlight').scrollTop, document.getElementById('line-numbers').scrollTop]);
      assert.ok(scroll[0] > 0); assert.equal(scroll[1], scroll[0]); assert.equal(scroll[2], scroll[0]);
      await b.eval(() => { const e = document.getElementById('editor'); e.value = 'while True:\n    pass\n'; e.dispatchEvent(new Event('input')); });
      await b.waitFor(() => document.getElementById('highlight').textContent.startsWith('while True:'));
      assert.deepEqual(await b.eval(() => [...document.querySelectorAll('#highlight .tok-keyword')].map(n => n.textContent)), ['while', 'True', 'pass']);
      assert.ok(await b.eval(() => [...document.querySelectorAll('#highlight span')].some(n => n.textContent === 'while')));
      await b.eval(click, row('readme.txt'));
      await b.waitFor(() => document.getElementById('editor').value === 'hello\n');
      await b.waitFor(() => !document.getElementById('editor').classList.contains('highlighted') || !document.querySelector('#highlight span'));
      assert.equal(await b.eval(() => document.querySelector('#highlight span')), null, 'non-Python files are not tokenised');
    });

    assert.deepEqual(b.errors.filter(e => !/favicon/.test(e)), [], 'no page errors');
  } finally {
    if (browser) await browser.close();
    if (device && base) await fetch(base + '/projects/dom', {method: 'DELETE'}).catch(() => {});
    if (mock) mock.child.kill();
  }
});
