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
const REMOTE = process.env.XS_CDP || '';   // drive the phone's own Chrome (adb forward tcp:9222 localabstract:chrome_devtools_remote); XS_PAGE_URL = device URL as the phone sees it

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

test('Web IDE explorer, editor and create/delete flows in a real browser', {skip: CHROME || REMOTE ? false : 'no local Chrome (set $CHROME or install puppeteer browsers)', timeout: 60000 + cdp.LAUNCH_BUDGET_MS}, async t => {
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

    const launched = Date.now();
    browser = REMOTE ? await cdp.attach(REMOTE) : await cdp.launch(CHROME);
    const b = browser;
    t.diagnostic('browser ready in ' + (Date.now() - launched) + ' ms');   // the slow part when CI times out
    const prompts = answers => b.eval(a => { window.__prompts = []; window.__answers = a.slice(); window.prompt = (msg, def) => { window.__prompts.push({msg, def}); return window.__answers.length ? window.__answers.shift() : null; }; }, answers);
    const confirms = answers => b.eval(a => { window.__confirms = []; window.__cAnswers = a.slice(); window.confirm = msg => { window.__confirms.push(msg); return window.__cAnswers.length ? window.__cAnswers.shift() : false; }; }, answers);
    const settle = () => b.waitFor(idle);
    const R = () => b.eval(rows), S = () => b.eval(state);

    await b.goto((process.env.XS_PAGE_URL ? process.env.XS_PAGE_URL.replace(/\/$/, '') : base) + '/tools/ui/editor.html?project=dom');
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

    await t.test('deleting folders: non-empty asks with the file list (cancel keeps it), empty one is removed after confirm', async () => {
      await b.eval(click, row('utils')); // collapse + select
      await confirms([false]);
      await b.eval(click, '#delete-file'); await settle();
      const asked = await b.eval(() => window.__confirms);
      assert.equal(asked.length, 1, 'a non-empty folder asks once');
      assert.match(asked[0], /删除文件夹 utils\/ 及其中的 \d+ 个文件？此操作不可撤销/);
      assert.match(asked[0], /utils\/a\.py/, 'the confirm lists the files');
      assert.ok((await api('GET', '/projects/dom/files')).files.some(f => f.path.startsWith('utils/')), 'cancel keeps a non-empty folder');
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


    await t.test('completion popup: typing opens it, arrows/Enter/Tab/Esc/click behave, never in strings or comments', async () => {
      await b.eval(click, row('__init__.py'));
      await b.waitFor(() => document.getElementById('editor').value.length > 0 && !document.getElementById('editor').disabled);
      const setup = text => b.eval(txt => { const e = document.getElementById('editor'); e.focus(); e.value = txt; e.setSelectionRange(txt.length, txt.length); e.dispatchEvent(new Event('input')); }, text);
      const popup = () => b.eval(() => { const p = document.getElementById('complete'); return {open: !p.hidden, labels: [...p.querySelectorAll('li')].map(l => l.dataset.label), selected: [...p.querySelectorAll('li')].findIndex(l => l.getAttribute('aria-selected') === 'true'), expanded: document.getElementById('editor').getAttribute('aria-expanded')}; });
      const value = () => b.eval(() => document.getElementById('editor').value);
      await setup('from xscript.android import action\n');
      await b.insertText('action.cl');
      await b.waitFor(() => !document.getElementById('complete').hidden);
      let p = await popup();
      assert.ok(p.labels.includes('click'), JSON.stringify(p.labels)); assert.equal(p.expanded, 'true'); assert.equal(p.selected, 0);
      assert.ok(await b.eval(() => { const li = document.querySelector('#complete li[aria-selected=true]'); return document.getElementById('editor').getAttribute('aria-activedescendant') === li.id; }), 'aria-activedescendant');
      const geo = await b.eval(() => { const p = document.getElementById('complete').getBoundingClientRect(), h = document.querySelector('.ide-code').getBoundingClientRect(); return {inside: p.left >= h.left - 1 && p.right <= h.right + 1 && p.top >= h.top - 1 && p.bottom <= h.bottom + 1, docShown: !!document.querySelector('#complete .cdoc').textContent}; });
      assert.ok(geo.inside, 'popup stays inside the editor area'); assert.ok(geo.docShown, 'signature/doc line shown');
      await b.key('ArrowDown', 'ArrowDown', 40);
      assert.equal((await popup()).selected, 1);
      await b.key('ArrowUp', 'ArrowUp', 38);
      const first = (await popup()).labels[0];
      await b.key('Enter', 'Enter', 13);
      assert.equal((await popup()).open, false, 'Enter accepts and closes');
      assert.equal(await value(), 'from xscript.android import action\naction.' + first, 'Enter accepted, no newline inserted');
      assert.equal(await b.eval(() => document.getElementById('editor').selectionStart === document.getElementById('editor').value.length), true);
      assert.equal(await b.eval(() => document.getElementById('save').disabled), false, 'accepting counts as an edit');
      // Tab accepts too (and does not insert spaces); Esc closes without changing text
      await setup('from xscript.android import action\n');
      await b.insertText('action.sw');
      await b.waitFor(() => !document.getElementById('complete').hidden);
      await b.key('Escape', 'Escape', 27);
      assert.equal((await popup()).open, false); assert.equal(await value(), 'from xscript.android import action\naction.sw');
      await b.insertText('i');
      await b.waitFor(() => !document.getElementById('complete').hidden);
      await b.key('Tab', 'Tab', 9);
      assert.equal(await value(), 'from xscript.android import action\naction.swipe');
      // mouse click on an item
      await setup('import xscript.android.sc');
      await b.insertText('r');
      await b.waitFor(() => !document.getElementById('complete').hidden);
      await b.eval(() => document.querySelector('#complete li').dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true})));
      assert.match(await value(), /^import xscript\.android\.scr/); assert.equal((await popup()).open, false);
      assert.equal(await b.eval(() => document.activeElement.id), 'editor', 'focus stays in the editor');
      // not in comments or strings; not for a bare number
      for (const text of ['# act', 'x = "act', 'x = 12']) {
        await setup(text.slice(0, -1)); await b.insertText(text.slice(-1));
        await new Promise(r => setTimeout(r, 60));
        assert.equal((await popup()).open, false, text);
      }
      // Ctrl+Space forces; deleting never opens; the checkbox turns auto-popup off but Ctrl+Space still works
      await setup('import time\ntime.');
      await b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: ' ', code: 'Space', ctrlKey: true, bubbles: true, cancelable: true})));
      await new Promise(r => setTimeout(r, 30));
      await setup('import time\nxscript');
      await b.key('Backspace', 'Backspace', 8);
      assert.equal((await popup()).open, false, 'backspace does not open');
      await b.eval(() => { const c = document.getElementById('auto-complete'); c.checked = false; c.dispatchEvent(new Event('change')); });
      await setup('from xscript.android import action\n'); await b.insertText('action.cl');
      await new Promise(r => setTimeout(r, 60));
      assert.equal((await popup()).open, false, 'auto popup disabled');
      await b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: ' ', code: 'Space', ctrlKey: true, bubbles: true, cancelable: true})));
      assert.equal((await popup()).open, true, 'Ctrl+Space still opens it');
      await b.key('Escape', 'Escape', 27);
      await b.eval(() => { const c = document.getElementById('auto-complete'); c.checked = true; c.dispatchEvent(new Event('change')); });
    });

    await t.test('signature help while typing a call, hover docs on the mouse, Esc / Ctrl+Shift+Space', async () => {
      await b.eval(click, row('__init__.py'));
      await b.waitFor(() => document.getElementById('editor').value.length > 0 && !document.getElementById('editor').disabled);
      const setup = text => b.eval(txt => { const e = document.getElementById('editor'); e.focus(); e.value = txt; e.setSelectionRange(txt.length, txt.length); e.dispatchEvent(new Event('input')); }, text);
      const tip = id => b.eval(i => { const t = document.getElementById(i), a = t.querySelector('.tip-active'), h = document.querySelector('.ide-code').getBoundingClientRect(), r = t.getBoundingClientRect();
        return {shown: !t.hidden, sig: (t.querySelector('.tip-sig') || {}).textContent || '', active: a ? a.textContent : '', doc: (t.querySelector('.tip-doc') || {}).textContent || '',
          inside: r.left >= h.left - 1 && r.right <= h.right + 1 && r.top >= h.top - 1 && r.bottom <= h.bottom + 1}; }, id);
      await setup('from xscript.android import action\n\n\n');
      await b.insertText('action.click(');
      await b.waitFor(() => !document.getElementById('sig-help').hidden);
      let s = await tip('sig-help');
      assert.equal(s.sig, 'click(x, y=None, dur=20)'); assert.equal(s.active, 'x'); assert.match(s.doc, /^Tap/); assert.ok(s.inside, 'inside the editor');
      await b.insertText('1, ');
      assert.equal((await tip('sig-help')).active, 'y=None');
      await b.insertText('dur=');
      assert.equal((await tip('sig-help')).active, 'dur=20');
      await b.insertText('5)');
      assert.equal((await tip('sig-help')).shown, false, 'closed after the call');
      await b.key('ArrowLeft', 'ArrowLeft', 37);
      await b.waitFor(() => !document.getElementById('sig-help').hidden);
      await b.key('Escape', 'Escape', 27);
      assert.equal((await tip('sig-help')).shown, false, 'Esc closes it');
      await b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: ' ', code: 'Space', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true})));
      assert.equal((await tip('sig-help')).shown, true, 'Ctrl+Shift+Space reopens it');
      assert.equal((await b.eval(() => document.getElementById('complete').hidden)), true, 'and not the completion popup');
      // hover: point at "click" on line 4 (synthetic mousemove at its coordinates)
      await setup('from xscript.android import action\n\n\naction.click(1, 2)\n');
      await b.eval(() => {
        const e = document.getElementById('editor'), host = document.querySelector('.ide-code').getBoundingClientRect();
        const probe = document.createElement('span'), cs = getComputedStyle(e);
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'; probe.style.fontFamily = cs.fontFamily; probe.style.fontSize = cs.fontSize; probe.style.fontWeight = cs.fontWeight; probe.textContent = 'action.cl';
        document.body.append(probe); const w = probe.getBoundingClientRect().width; probe.remove();
        e.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: host.left + 12 + w - e.scrollLeft, clientY: host.top + 16 + 3 * 21 + 10 - e.scrollTop}));
      });
      await b.waitFor(() => !document.getElementById('hover-doc').hidden, 3000);
      const h = await tip('hover-doc');
      assert.equal(h.sig, 'def click(x, y=None, dur=20)'); assert.match(h.doc, /^Tap/); assert.ok(h.inside, 'hover inside the editor');
      assert.match(await b.eval(() => document.querySelector('#hover-doc .tip-where').textContent), /^xscript\.android\.action\.click$/);
      await b.eval(() => document.getElementById('editor').dispatchEvent(new MouseEvent('mouseleave')));
      assert.equal((await tip('hover-doc')).shown, false, 'mouse leaving hides it');
    });

    await t.test('hover on project names: signatures, docstrings and inferred types', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'hv_lib.py', content: 'class Square:\n    """A square."""\n    def __init__(self, side: int = 2):\n        self.side = side\n    def area(self, scale=1.5) -> float:\n        """Area times scale."""\n        return self.side * scale\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py'));
      await b.waitFor(() => !document.getElementById('editor').disabled);
      await b.eval(txt => { const e = document.getElementById('editor'); e.focus(); e.value = txt; e.dispatchEvent(new Event('input')); },
        'from hv_lib import Square\nsq = Square(3)\ntotal = sq.area() + 1\nnames = [1, 2]\n');
      const hover = (row, prefix) => b.eval((r, pre) => {
        const e = document.getElementById('editor'), host = document.querySelector('.ide-code').getBoundingClientRect();
        const probe = document.createElement('span'), cs = getComputedStyle(e);
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'; probe.style.fontFamily = cs.fontFamily; probe.style.fontSize = cs.fontSize; probe.style.fontWeight = cs.fontWeight; probe.textContent = pre;
        document.body.append(probe); const w = probe.getBoundingClientRect().width; probe.remove();
        e.dispatchEvent(new MouseEvent('mouseleave'));
        e.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: host.left + 12 + w + 2 - e.scrollLeft, clientY: host.top + 16 + r * 21 + 10 - e.scrollTop}));
      }, row, prefix);
      const shown = () => b.eval(() => { const t = document.getElementById('hover-doc'); return t.hidden ? null : [t.querySelector('.tip-sig').textContent, (t.querySelector('.tip-where') || {}).textContent || '', (t.querySelector('.tip-doc') || {}).textContent || '']; });
      const expectHover = async (row, prefix, want) => {
        await hover(row, prefix);
        await b.waitFor(() => !document.getElementById('hover-doc').hidden, 3000);
        assert.deepEqual(await shown(), want);
      };
      await expectHover(1, 'sq = Squ', ['class Square', 'hv_lib.py:1', 'A square.']);
      await expectHover(2, 'total = sq.ar', ['def Square.area(self, scale=1.5) -> float', 'hv_lib.py:5', 'Area times scale.']);
      await expectHover(1, 's', ['(变量) sq: Square', '__init__.py:2', '']);
      await expectHover(2, 'tot', ['(变量) total: float', '__init__.py:3', '']);
      await expectHover(3, 'nam', ['(变量) names: list', '__init__.py:4', '']);
      // nothing on a number
      await hover(2, 'total = sq.area() + '); await new Promise(r => setTimeout(r, 700));
      assert.equal(await shown(), null);
      await b.eval(() => document.getElementById('editor').dispatchEvent(new MouseEvent('mouseleave')));
      await fetch(base + '/projects/dom/file?path=hv_lib.py', {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('syntax diagnostics: wavy underlines, gutter marks, problems button; cleared while typing; Python files only', async () => {
      await b.eval(click, row('__init__.py'));
      await b.waitFor(() => document.getElementById('editor').value.length > 0 && !document.getElementById('editor').disabled);
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); e.value = 'if x\n    pass\nprint "hi"\nok = (1,\n'; e.setSelectionRange(0, 0); e.dispatchEvent(new Event('input')); });
      await b.waitFor(() => document.querySelectorAll('#diag .sq').length >= 1);
      const state = () => b.eval(() => ({
        layer: document.getElementById('diag').textContent.replace(/\n$/, '') === document.getElementById('editor').value,
        marks: [...document.querySelectorAll('#line-numbers .diag-line')].map(n => n.textContent.trim()),
        title: (document.querySelector('#line-numbers .diag-line') || {}).title || '',
        count: document.getElementById('problems').dataset.count, text: document.getElementById('problems').textContent, hidden: document.getElementById('problems').hidden,
        sq: getComputedStyle(document.querySelector('#diag .sq')).textDecorationLine,
      }));
      // like CPython, the parser reports the first syntax error; fixing it reveals the next one
      let d = await state();
      assert.equal(d.layer, true, 'diagnostic layer text matches the textarea (alignment)');
      assert.deepEqual(d.marks, ['1']); assert.match(d.title, /冒号/);
      assert.equal(d.count, '1'); assert.equal(d.hidden, false); assert.match(d.text, /第 1 行/); assert.match(d.sq, /underline/);
      // problems button jumps to the problem and moves the caret there
      await b.eval(() => document.getElementById('editor').setSelectionRange(30, 30));
      await b.eval(click, '#problems');
      assert.equal(await b.eval(() => document.getElementById('editor').value.slice(0, document.getElementById('editor').selectionStart).split('\n').length), 1);
      // typing clears stale squiggles immediately, then the check re-runs
      await b.insertText('x');
      assert.equal(await b.eval(() => document.querySelectorAll('#diag .sq').length), 0, 'stale marks dropped while typing');
      await b.waitFor(() => document.querySelectorAll('#diag .sq').length >= 1);
      const setText = (v) => b.eval((v) => { const e = document.getElementById('editor'); e.value = v; e.dispatchEvent(new Event('input')); }, v);
      await setText('if x:\n    pass\nprint "hi"\nok = (1,\n');
      await b.waitFor(() => [...document.querySelectorAll('#line-numbers .diag-line')].map(n => n.textContent.trim()).join() === '3');
      assert.match((await state()).title, /print/);
      await setText('if x:\n    pass\nprint("hi")\nok = (1,\n');
      await b.waitFor(() => [...document.querySelectorAll('#line-numbers .diag-line')].map(n => n.textContent.trim()).join() === '4');
      assert.match((await state()).title, /没有闭合/);
      // fix everything -> clean
      await b.eval(() => { const e = document.getElementById('editor'); e.value = 'if True:\n    pass\nprint("hi")\nok = (1,)\n'; e.dispatchEvent(new Event('input')); });
      await b.waitFor(() => document.getElementById('problems').dataset.count === '0');
      assert.equal(await b.eval(() => document.querySelectorAll('#diag .sq, #line-numbers .diag-line').length), 0);
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /无语法问题/);
      // non-Python files are not checked
      await b.eval(click, row('readme.txt'));
      await b.waitFor(() => document.getElementById('editor').value === 'hello\n');
      await b.eval(() => { const e = document.getElementById('editor'); e.value = 'if x\n(((\n'; e.dispatchEvent(new Event('input')); });
      await new Promise(r => setTimeout(r, 500));
      assert.deepEqual(await b.eval(() => [document.querySelectorAll('#diag .sq').length, document.getElementById('problems').hidden]), [0, true]);
      await b.eval(() => { const e = document.getElementById('editor'); e.value = 'hello\n'; e.dispatchEvent(new Event('input')); });
    });

    await t.test('basic checks: undefined names and wrong call arguments as warnings, only when the syntax is clean', async () => {
      await api('PUT', '/projects/dom/files', {files: [
        {path: 'chk_lib.py', content: 'def scale(v, k=2, *, unit="px"):\n    return v * k\n'},
        {path: 'chk_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('chk_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      const setText = v => b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); }, v);
      const warnings = () => b.eval(() => ({
        sq: [...document.querySelectorAll('#diag .sq')].map(n => n.textContent + (n.classList.contains('warn') ? '!' : '')),
        marks: [...document.querySelectorAll('#line-numbers .diag-line')].map(n => n.textContent.trim() + (n.classList.contains('warn') ? '!' : '')),
        text: document.getElementById('problems').textContent, warn: document.getElementById('problems').classList.contains('has-warnings'),
      }));
      await setText('from chk_lib import scale\nimport some_lib\nscale(1, 2, 3)\nscale(1, size=3)\nscale()\nprint(totl, some_lib.x, len([]))\nscale(1, unit="m")\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 4, 5000);
      const w = await warnings();
      assert.deepEqual(w.sq, ['scale!', 'scale!', 'scale!', 'totl!']);
      assert.deepEqual(w.marks, ['3!', '4!', '5!', '6!']);
      assert.equal(w.warn, true); assert.match(w.text, /4 个问题/);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 3 行：scale\(\) 最多接受 2 个位置参数，这里传了 3 个/);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 4 行：scale\(\) 没有名为 size 的参数/);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 5 行：scale\(\) 缺少参数 v/);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 6 行：未定义的名字 totl/);
      // a syntax error hides the warnings (only the error is shown); fixing it brings them back
      await setText('scale(\nprint(totl)\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq').length === 1);
      await new Promise(r => setTimeout(r, 600));
      assert.deepEqual((await warnings()).sq.map(x => x.endsWith('!')), [false]);
      await setText('from chk_lib import scale\nprint(scale(1), totl)\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 1, 5000);
      assert.deepEqual((await warnings()).sq, ['totl!']);
      await setText('from chk_lib import scale\nprint(scale(1))\n');
      await b.waitFor(() => document.getElementById('problems').dataset.count === '0');
      await new Promise(r => setTimeout(r, 600));
      assert.equal(await b.eval(() => document.querySelectorAll('#diag .sq').length), 0);
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      for (const p of ['chk_lib.py', 'chk_main.py']) await fetch(base + '/projects/dom/file?path=' + p, {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });


    await t.test('basic checks: unknown attributes of project classes and instances', async () => {
      await api('PUT', '/projects/dom/files', {files: [
        {path: 'at_lib.py', content: 'class Box:\n    def __init__(self, w):\n        self.w = w\n    def size(self):\n        return self.ww\n'},
        {path: 'at_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('at_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      await b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); },
        'from at_lib import Box\nb = Box(1)\nb.size()\nb.sise()\nb.w\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 1, 5000);
      assert.deepEqual(await b.eval(() => [...document.querySelectorAll('#diag .sq.warn')].map(n => n.textContent)), ['sise']);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 4 行：Box 没有属性或方法 sise（是不是 size？Ctrl\+\. 改正）/);
      // Ctrl+. replaces the typo (undoable), the caret stays inside the name
      await b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: '.', ctrlKey: true, bubbles: true, cancelable: true})));
      await b.waitFor(() => document.getElementById('editor').value.includes('b.size()\nb.size()'));
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('undo'); });
      assert.equal(await b.eval(() => document.getElementById('editor').value.includes('b.sise()')), true, 'undo restores the typo');
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('redo'); });
      await b.waitFor(() => document.getElementById('problems').dataset.count === '0', 5000);
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('at_lib.py'));
      await b.waitFor(() => document.getElementById('editor').value.startsWith('class Box'));
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 1, 5000);
      assert.deepEqual(await b.eval(() => [...document.querySelectorAll('#diag .sq.warn')].map(n => n.textContent)), ['ww']);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      for (const p of ['at_lib.py', 'at_main.py']) await fetch(base + '/projects/dom/file?path=' + p, {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('quick fix (Ctrl+.): import an undefined name from the project module that defines it', async () => {
      await api('PUT', '/projects/dom/files', {files: [
        {path: 'qf_a.py', content: 'def helper():\n    return 1\n'}, {path: 'qf_b.py', content: 'class helper:\n    pass\nLIMIT = 3\n'},
        {path: 'qf_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('qf_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      const setText = v => b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); }, v);
      const caret = at => b.eval(at => { const e = document.getElementById('editor'); e.focus(); e.setSelectionRange(at, at); }, at);
      const ctrlDot = () => b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: '.', ctrlKey: true, bubbles: true, cancelable: true})));
      const value = () => b.eval(() => document.getElementById('editor').value);
      await setText('"""Doc."""\nimport os\n\nprint(LIMIT, os.sep)\nhelper()\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 2, 5000);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /未定义的名字 LIMIT（Ctrl\+\. 从 qf_b 导入）/);
      // one candidate: inserted after the docstring and imports, caret stays on the same name
      const at = (await value()).indexOf('LIMIT') + 2; await caret(at); await ctrlDot();
      await b.waitFor(() => document.getElementById('editor').value.includes('from qf_b import LIMIT'));
      assert.equal(await value(), '"""Doc."""\nimport os\n\nfrom qf_b import LIMIT\nprint(LIMIT, os.sep)\nhelper()\n');
      assert.equal(await b.eval(() => document.getElementById('editor').selectionStart), at + 'from qf_b import LIMIT\n'.length);
      // the insertion is in the textarea's undo history: undo removes it, redo puts it back
      assert.equal(await b.eval(() => document.querySelector('#complete') ? document.querySelector('#complete').hidden !== false : true), true, 'no completion popup');
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('undo'); });
      assert.equal((await value()).includes('from qf_b import LIMIT'), false);
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('redo'); });
      assert.equal(await value(), '"""Doc."""\nimport os\n\nfrom qf_b import LIMIT\nprint(LIMIT, os.sep)\nhelper()\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 1, 5000);
      // two candidates: a numbered prompt; cancel changes nothing, 1 picks qf_a
      await prompts([null]); await caret((await value()).indexOf('helper')); await ctrlDot();
      await b.waitFor(() => window.__prompts.length === 1);
      assert.match(await b.eval(() => window.__prompts[0].msg), /1\. qf_a\n2\. qf_b/);
      assert.equal((await value()).includes('import helper'), false);
      await prompts(['1']); await ctrlDot();
      await b.waitFor(() => document.getElementById('editor').value.includes('from qf_a import helper'));
      await b.waitFor(() => document.getElementById('problems').dataset.count === '0', 5000);
      // nothing to fix under the caret
      await caret(0); await ctrlDot();
      await b.waitFor(() => /没有可自动修复/.test(document.body.textContent));
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      for (const p of ['qf_a.py', 'qf_b.py', 'qf_main.py']) await fetch(base + '/projects/dom/file?path=' + p, {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('unused imports and variables are faded; Ctrl+. removes an unused import (undoable)', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'un_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('un_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      await b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); },
        'import os\nimport sys, json\n\ndef f():\n    total = 1\n    return sys.argv\n');
      await b.waitFor(() => document.querySelectorAll('#diag .fade').length === 3, 5000);
      assert.deepEqual(await b.eval(() => [...document.querySelectorAll('#diag .fade')].map(n => n.textContent)), ['os', 'json', 'total']);
      // faded names are hints, not problems: no squiggle, no gutter mark, the problems count stays 0
      assert.deepEqual(await b.eval(() => [document.querySelectorAll('#diag .sq, #line-numbers .diag-line').length, document.getElementById('problems').dataset.count]), [0, '0']);
      const caret = at => b.eval(at => { const e = document.getElementById('editor'); e.focus(); e.setSelectionRange(at, at); e.dispatchEvent(new Event('keyup')); }, at);
      const ctrlDot = () => b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: '.', ctrlKey: true, bubbles: true, cancelable: true})));
      const value = () => b.eval(() => document.getElementById('editor').value);
      await caret(8);
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 1 行：未使用的 import os（Ctrl\+\. 删除）/);
      await ctrlDot();
      await b.waitFor(() => !document.getElementById('editor').value.startsWith('import os'));
      assert.equal(await value(), 'import sys, json\n\ndef f():\n    total = 1\n    return sys.argv\n');
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('undo'); });
      assert.equal((await value()).startsWith('import os\n'), true, 'undo brings the import back');
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('redo'); });
      await caret((await value()).indexOf('json') + 1); await ctrlDot();
      await b.waitFor(() => document.getElementById('editor').value.startsWith('import sys\n'));
      await b.waitFor(() => [...document.querySelectorAll('#diag .fade')].map(n => n.textContent).join() === 'total', 5000);
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      await fetch(base + '/projects/dom/file?path=un_main.py', {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('basic checks: a literal argument of the wrong type is underlined at the argument', async () => {
      await api('PUT', '/projects/dom/files', {files: [
        {path: 'ty_lib.py', content: 'def wait(seconds: float, label: str = ""):\n    return seconds\n'}, {path: 'ty_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('ty_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      await b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); },
        'from ty_lib import wait\nwait(1)\nwait("2")\nwait(0.5, label=3)\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 2, 5000);
      assert.deepEqual(await b.eval(() => [...document.querySelectorAll('#diag .sq.warn')].map(n => n.textContent)), ['"2"', '3']);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 3 行：wait\(\) 的参数 seconds 应为 float，这里传了 str/);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 4 行：wait\(\) 的参数 label 应为 str，这里传了 int/);
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      for (const p of ['ty_lib.py', 'ty_main.py']) await fetch(base + '/projects/dom/file?path=' + p, {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('undefined names: "did you mean" a close name; Ctrl+. corrects it (undoable)', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'nm_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('nm_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      await b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); }, 'total = 2\nprnt(totl)\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 2, 5000);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 2 行：未定义的名字 prnt（是不是 print？Ctrl\+\. 改正）/);
      const ctrlDot = () => b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: '.', ctrlKey: true, bubbles: true, cancelable: true})));
      await ctrlDot();
      await b.waitFor(() => document.getElementById('editor').value === 'total = 2\nprint(totl)\n');
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); const at = e.value.indexOf('totl') + 1; e.setSelectionRange(at, at); });
      await ctrlDot();
      await b.waitFor(() => document.getElementById('editor').value === 'total = 2\nprint(total)\n');
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('undo'); });
      assert.equal(await b.eval(() => document.getElementById('editor').value), 'total = 2\nprint(totl)\n');
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('redo'); });
      await b.waitFor(() => document.getElementById('problems').dataset.count === '0', 5000);
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      await fetch(base + '/projects/dom/file?path=nm_main.py', {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('basic checks: a return value that does not match the return annotation', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'rt_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('rt_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      await b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); },
        'def count() -> int:\n    return "3"\n\ndef ratio() -> float:\n    return 1\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 1, 5000);
      assert.deepEqual(await b.eval(() => [...document.querySelectorAll('#diag .sq.warn')].map(n => n.textContent)), ['"3"']);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 2 行：count\(\) 声明返回 int，这里返回了 str/);
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      await fetch(base + '/projects/dom/file?path=rt_main.py', {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('argument types: Ctrl+. converts a mismatched literal (undoable)', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'af_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('af_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      await b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); },
        'def wait(s: float, label: str = ""):\n    pass\nwait("2", label=3)\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 2, 5000);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 3 行：wait\(\) 的参数 s 应为 float，这里传了 str（Ctrl\+\. 改为 2）/);
      const ctrlDot = () => b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: '.', ctrlKey: true, bubbles: true, cancelable: true})));
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); const at = e.value.indexOf('"2"') + 1; e.setSelectionRange(at, at); });
      await ctrlDot();
      await b.waitFor(() => document.getElementById('editor').value.includes('wait(2, label=3)'));
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); const at = e.value.indexOf('=3') + 1; e.setSelectionRange(at, at); });
      await ctrlDot();
      await b.waitFor(() => document.getElementById('editor').value.includes('wait(2, label="3")'));
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('undo'); });
      assert.match(await b.eval(() => document.getElementById('editor').value), /wait\(2, label=3\)/);
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('redo'); });
      await b.waitFor(() => document.getElementById('problems').dataset.count === '0', 5000);
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      await fetch(base + '/projects/dom/file?path=af_main.py', {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('call arguments: "did you mean" a keyword; Ctrl+. renames it (undoable)', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'kw_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('kw_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      await b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); },
        'def wait(seconds=1):\n    pass\nwait(secnds=2)\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 1, 5000);
      assert.deepEqual(await b.eval(() => [...document.querySelectorAll('#diag .sq.warn')].map(n => n.textContent)), ['secnds']);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 3 行：wait\(\) 没有名为 secnds 的参数（是不是 seconds？Ctrl\+\. 改正）/);
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); const at = e.value.indexOf('secnds') + 2; e.setSelectionRange(at, at); });
      await b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: '.', ctrlKey: true, bubbles: true, cancelable: true})));
      await b.waitFor(() => document.getElementById('editor').value.endsWith('wait(seconds=2)\n'));
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('undo'); });
      assert.match(await b.eval(() => document.getElementById('editor').value), /wait\(secnds=2\)/);
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('redo'); });
      await b.waitFor(() => document.getElementById('problems').dataset.count === '0', 5000);
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      await fetch(base + '/projects/dom/file?path=kw_main.py', {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('unreachable code after return is faded and explained on its line; Ctrl+. deletes it (undoable)', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'ur_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('ur_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      await b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); },
        'def f():\n    return 1\n    print("never")\n    x = 2\n\nprint(f())\n');
      await b.waitFor(() => document.querySelectorAll('#diag .fade').length === 2, 5000);
      assert.deepEqual(await b.eval(() => [...document.querySelectorAll('#diag .fade')].map(n => n.textContent)), ['print("never")', 'x = 2']);
      assert.equal(await b.eval(() => document.getElementById('problems').dataset.count), '0');
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); const at = e.value.indexOf('never'); e.setSelectionRange(at, at); e.dispatchEvent(new Event('keyup')); });
      await b.waitFor(() => document.getElementById('problems').textContent.includes('第 3 行：执行不到的代码（前面已经 return；Ctrl+. 删除）'), 5000);
      await b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: '.', ctrlKey: true, bubbles: true, cancelable: true})));
      await b.waitFor(() => document.getElementById('editor').value === 'def f():\n    return 1\n\nprint(f())\n');
      await b.waitFor(() => document.querySelectorAll('#diag .fade').length === 0, 5000);
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('undo'); });
      assert.equal(await b.eval(() => document.getElementById('editor').value), 'def f():\n    return 1\n    print("never")\n    x = 2\n\nprint(f())\n');
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('redo'); });
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      await fetch(base + '/projects/dom/file?path=ur_main.py', {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('call arguments: Ctrl+. fills missing parameters (undoable)', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'ma_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('ma_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      await b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); },
        'def tap(x, y, times=1):\n    pass\ntap(10)\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 1, 5000);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 3 行：tap\(\) 缺少参数 y（Ctrl\+\. 补上）/);
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); const at = e.value.indexOf('tap(10)') + 1; e.setSelectionRange(at, at); });
      await b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: '.', ctrlKey: true, bubbles: true, cancelable: true})));
      await b.waitFor(() => document.getElementById('editor').value.endsWith('tap(10, y=...)\n'));
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('undo'); });
      assert.match(await b.eval(() => document.getElementById('editor').value), /tap\(10\)\n$/);
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('redo'); });
      await b.waitFor(() => document.getElementById('problems').dataset.count === '0', 5000);
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      await fetch(base + '/projects/dom/file?path=ma_main.py', {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('imports: "did you mean" a documented module or name; Ctrl+. corrects it (undoable)', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'im_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('im_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      await b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); },
        'from xscript.andriod.action import clik\nclik(1, 2)\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 1, 5000);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 1 行：xscript 里没有模块 andriod（是不是 android？Ctrl\+\. 改正）/);
      const ctrlDot = () => b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: '.', ctrlKey: true, bubbles: true, cancelable: true})));
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); const at = e.value.indexOf('andriod') + 2; e.setSelectionRange(at, at); });
      await ctrlDot();
      await b.waitFor(() => document.getElementById('editor').value.startsWith('from xscript.android.action import clik\n'));
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 1, 5000);   // now the name: clik -> click
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); const at = e.value.indexOf('clik') + 1; e.setSelectionRange(at, at); });
      await ctrlDot();
      await b.waitFor(() => document.getElementById('editor').value.startsWith('from xscript.android.action import click\n'));
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('undo'); });
      assert.match(await b.eval(() => document.getElementById('editor').value), /^from xscript\.android\.action import clik\n/);
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('redo'); });
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      await fetch(base + '/projects/dom/file?path=im_main.py', {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('duplicate definitions: warning on the later def; Ctrl+. jumps to the earlier one', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'dd_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('dd_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      await b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); },
        'def login():\n    return 1\n\n\ndef login():\n    return 2\n\n\nprint(login())\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 1, 5000);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 5 行：重复定义函数 login，会覆盖第 1 行的函数（Ctrl\+\. 跳过去）/);
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); const at = e.value.lastIndexOf('def login') + 5; e.setSelectionRange(at, at); });
      await b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: '.', ctrlKey: true, bubbles: true, cancelable: true})));
      await b.waitFor(() => document.getElementById('editor').selectionStart === 4);
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      await fetch(base + '/projects/dom/file?path=dd_main.py', {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('unused variables: Ctrl+. removes the assignment (undoable)', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'uv_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('uv_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      const src = 'def f():\n    total = 0\n    rows = len("abc")\n    return 1\n\n\nprint(f())\n';
      await b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); }, src);
      await b.waitFor(() => document.querySelectorAll('#diag .fade').length === 2, 5000);
      const ctrlDot = () => b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: '.', ctrlKey: true, bubbles: true, cancelable: true})));
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); const at = e.value.indexOf('rows') + 1; e.setSelectionRange(at, at); e.dispatchEvent(new Event('keyup')); });
      await b.waitFor(() => document.getElementById('problems').textContent.includes('第 3 行：未使用的变量 rows（Ctrl+. 删除赋值，保留右边）'), 5000);
      await ctrlDot();
      await b.waitFor(() => document.getElementById('editor').value === 'def f():\n    total = 0\n    len("abc")\n    return 1\n\n\nprint(f())\n');
      await b.waitFor(() => document.querySelectorAll('#diag .fade').length === 1, 5000);
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); const at = e.value.indexOf('total') + 1; e.setSelectionRange(at, at); });
      await ctrlDot();
      await b.waitFor(() => document.getElementById('editor').value === 'def f():\n    len("abc")\n    return 1\n\n\nprint(f())\n');
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('undo'); });
      assert.equal(await b.eval(() => document.getElementById('editor').value), 'def f():\n    total = 0\n    len("abc")\n    return 1\n\n\nprint(f())\n');
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('redo'); });
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      await fetch(base + '/projects/dom/file?path=uv_main.py', {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('imports: "did you mean" a project module; Ctrl+. corrects it (undoable)', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'pi_helpers.py', content: 'def greet():\n    return "hi"\n'}, {path: 'pi_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('pi_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      await b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); }, 'from pi_helper import greet\nprint(greet())\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 1, 5000);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 1 行：工程里没有模块 pi_helper（是不是 pi_helpers？Ctrl\+\. 改正）/);
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); e.setSelectionRange(7, 7); });
      await b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: '.', ctrlKey: true, bubbles: true, cancelable: true})));
      await b.waitFor(() => document.getElementById('editor').value === 'from pi_helpers import greet\nprint(greet())\n');
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('undo'); });
      assert.equal(await b.eval(() => document.getElementById('editor').value), 'from pi_helper import greet\nprint(greet())\n');
      await b.eval(() => { document.getElementById('editor').focus(); document.execCommand('redo'); });
      await b.waitFor(() => document.getElementById('problems').dataset.count === '0', 5000);
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      for (const p of ['pi_helpers.py', 'pi_main.py']) await fetch(base + '/projects/dom/file?path=' + p, {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('async / await: warning for an async def called without await', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'aw_main.py', content: 'print("ok")\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('aw_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'print("ok")\n' && !document.getElementById('editor').disabled);
      await b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.value = v; e.dispatchEvent(new Event('input')); },
        'async def fetch():\n    return 1\n\n\nasync def main():\n    fetch()\n');
      await b.waitFor(() => document.querySelectorAll('#diag .sq.warn').length === 1, 5000);
      assert.deepEqual(await b.eval(() => [...document.querySelectorAll('#diag .sq.warn')].map(n => n.textContent)), ['fetch']);
      await b.eval(click, '#problems');
      assert.match(await b.eval(() => document.getElementById('problems').textContent), /第 6 行：fetch\(\) 是 async 函数，这样调用不会执行，前面要加 await/);
      await b.eval(click, '#save'); await b.waitFor(idle);
      await b.eval(click, row('__init__.py')); await b.waitFor(() => !document.getElementById('editor').disabled);
      await fetch(base + '/projects/dom/file?path=aw_main.py', {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('project search and replace: results, options, jump to match, replace saves clean files and keeps unsaved ones dirty', async () => {
      await api('PUT', '/projects/dom/files', {files: [
        {path: 'search/a.py', content: 'needle = 1\nprint(needle)\n'}, {path: 'search/b.py', content: '# NEEDLE\nx = 2\n'}, {path: 'search/c.txt', content: 'no match here\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await confirms([true]);
      const set = (id, v) => b.eval((i, val) => { const n = document.getElementById(i); n.value = val; n.dispatchEvent(new Event('input')); }, id, v);
      const summary = () => b.eval(() => document.getElementById('search-summary').textContent);
      const results = () => b.eval(() => [...document.querySelectorAll('#search-results .sr-file')].map(f => ({path: f.querySelector('.sr-path').textContent, count: f.querySelector('.sr-count').textContent})));
      await b.eval(click, '#open-search');
      assert.deepEqual(await b.eval(() => [document.getElementById('search-panel').hidden, document.querySelector('.ide').classList.contains('searching'), getComputedStyle(document.getElementById('files')).display]), [false, true, 'none']);
      await set('search-q', 'needle'); await b.eval(click, '#search-go');
      await b.waitFor(() => /3 处匹配/.test(document.getElementById('search-summary').textContent));
      assert.match(await summary(), /3 处匹配，2 个文件/);
      assert.deepEqual(await results(), [{path: 'search/a.py', count: '2'}, {path: 'search/b.py', count: '1'}]);
      await b.eval(click, '#s-case'); await b.waitFor(() => /2 处匹配，1 个文件/.test(document.getElementById('search-summary').textContent));
      await b.eval(click, '#s-case'); await b.waitFor(() => /3 处匹配/.test(document.getElementById('search-summary').textContent));
      await set('search-inc', '*.txt'); await b.eval(click, '#search-go');
      await b.waitFor(() => /没有找到/.test(document.getElementById('search-summary').textContent));
      await set('search-inc', ''); await b.eval(click, '#s-regex'); await set('search-q', '(');
      await b.eval(click, '#search-go'); await b.waitFor(() => /正则表达式无效/.test(document.getElementById('search-summary').textContent));
      assert.equal(await b.eval(() => document.getElementById('search-summary').classList.contains('error')), true);
      await b.eval(click, '#s-regex'); await set('search-q', 'needle'); await b.eval(click, '#search-go');
      await b.waitFor(() => /3 处匹配/.test(document.getElementById('search-summary').textContent));
      // clicking a match opens the file with the match selected
      await b.eval(() => document.querySelectorAll('#search-results .sr-match')[1].click());
      await b.waitFor(() => document.getElementById('editor').value === 'needle = 1\nprint(needle)\n');
      assert.deepEqual(await b.eval(() => { const e = document.getElementById('editor'); return [e.value.slice(e.selectionStart, e.selectionEnd), e.value.slice(0, e.selectionStart).split('\n').length]; }), ['needle', 2]);
      // b.py gets an unsaved edit; a.py is clean
      await b.eval(() => document.querySelectorAll('#search-results .sr-match')[2].click());
      await b.waitFor(() => document.getElementById('editor').value === '# NEEDLE\nx = 2\n');
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); e.value = '# NEEDLE\nx = 22\n'; e.dispatchEvent(new Event('input')); });
      await set('search-r', 'pin'); await b.eval(click, '#replace-all');
      await b.waitFor(() => /已替换 3 处/.test(document.getElementById('message').textContent));
      const conf = await b.eval(() => window.__confirms);
      assert.equal(conf.length, 1); assert.match(conf[0], /2 个文件中的 3 处“needle”替换为“pin”/); assert.match(conf[0], /1 个文件只改编辑器内容/);
      assert.equal((await api('GET', '/projects/dom/file?path=search/a.py')).content, 'pin = 1\nprint(pin)\n', 'clean file written to the device');
      assert.equal((await api('GET', '/projects/dom/file?path=search/b.py')).content, '# NEEDLE\nx = 2\n', 'file with unsaved edits is not written');
      assert.equal(await b.eval(() => document.getElementById('editor').value), '# pin\nx = 22\n', 'open editor shows the replaced text');
      assert.match(await b.eval(() => document.getElementById('message').textContent), /未保存：search\/b\.py/);
      assert.equal(await b.eval(() => document.querySelector('#tabs .active [role=tab]').textContent), 'search/b.py ●');
      // the other direction: Escape returns to the file tree
      await b.eval(() => document.getElementById('search-q').focus());
      await b.key('Escape', 'Escape', 27);
      assert.deepEqual(await b.eval(() => [document.getElementById('search-panel').hidden, getComputedStyle(document.getElementById('files')).display !== 'none']), [true, true]);
      await b.eval(() => { const e = document.getElementById('editor'); e.value = '# pin\nx = 2\n'; e.dispatchEvent(new Event('input')); });
      await b.eval(() => document.getElementById('save').click());
      await b.waitFor(() => document.getElementById('message').textContent.includes('已保存 search/b.py'));
    });

    await t.test('go to definition (F12, Ctrl+click), library docs, find references (Shift+F12)', async () => {
      await api('PUT', '/projects/dom/files', {files: [
        {path: 'nav_lib.py', content: 'def helper(x):\n    return x * 2\n\nclass Tool:\n    def run(self):\n        return helper(1)\n'},
        {path: 'nav_main.py', content: 'from nav_lib import helper, Tool\nfrom xscript.android import action\n\nt = Tool()\nprint(helper(2), t.run())\naction.click(1, 2)\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('nav_main.py'));
      await b.waitFor(() => document.getElementById('editor').value.startsWith('from nav_lib'));
      const caret = (needle, nth = 0) => b.eval((w, k) => { const e = document.getElementById('editor'); let i = -1; for (let j = 0; j <= k; j++) i = e.value.indexOf(w, i + 1); e.focus(); e.setSelectionRange(i + 1, i + 1); return i; }, needle, nth);
      const where = () => b.eval(() => { const e = document.getElementById('editor'); return [e.value.slice(0, 12), e.value.slice(e.selectionStart, e.selectionEnd), e.value.slice(0, e.selectionStart).split('\n').length]; });
      const msg = () => b.eval(() => document.getElementById('message').textContent);
      // F12 on a call of an imported function opens the other file at the def
      await caret('helper(2)'); await b.key('F12', 'F12', 123);
      await b.waitFor(() => document.getElementById('editor').value.startsWith('def helper'));
      assert.deepEqual(await where(), ['def helper(x', 'helper', 1]); assert.match(await msg(), /定义 · nav_lib\.py:1/);
      // Ctrl/Cmd+click on a method through an instance
      await b.eval(click, row('nav_main.py')); await b.waitFor(() => document.getElementById('editor').value.startsWith('from nav_lib'));
      await caret('run()');
      await b.eval(() => document.getElementById('editor').dispatchEvent(new MouseEvent('click', {bubbles: true, ctrlKey: true})));
      await b.waitFor(() => document.getElementById('editor').value.startsWith('def helper') && document.getElementById('editor').selectionStart > 0);
      assert.deepEqual(await where(), ['def helper(x', 'run', 5]);
      // library symbol: stub signature and docs in the tip, the file stays put
      await b.eval(click, row('nav_main.py')); await b.waitFor(() => document.getElementById('editor').value.startsWith('from nav_lib'));
      await caret('click('); await b.key('F12', 'F12', 123);
      await b.waitFor(() => !document.getElementById('hover-doc').hidden);
      assert.equal(await b.eval(() => document.querySelector('#hover-doc .tip-sig').textContent), 'def click(x, y=None, dur=20)');
      assert.match(await msg(), /库符号 · xscript\.android\.action\.click/);
      await b.key('Escape', 'Escape', 27);
      // builtins have no project definition
      await caret('print('); await b.key('F12', 'F12', 123);
      await b.waitFor(() => /没有找到定义/.test(document.getElementById('message').textContent));
      // Shift+F12: references across files in the sidebar list; a row jumps there; Esc returns to the files
      await caret('helper(2)');
      await b.eval(() => document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', {key: 'F12', shiftKey: true, bubbles: true})));
      await b.waitFor(() => !document.getElementById('refs-panel').hidden);
      const panel = await b.eval(() => ({title: document.getElementById('refs-title').textContent, summary: document.getElementById('refs-summary').textContent,
        files: getComputedStyle(document.getElementById('files')).display, sidebar: document.querySelector('.ide').classList.contains('refs'),
        rows: [...document.querySelectorAll('#refs-results .sr-match')].map(r => r.title + ' ' + r.querySelector('mark').textContent)}));
      assert.deepEqual(panel, {title: '引用：helper', summary: '4 处，2 个文件', files: 'none', sidebar: true,
        rows: ['nav_lib.py:1（定义） helper', 'nav_lib.py:6 helper', 'nav_main.py:1 helper', 'nav_main.py:5 helper']});
      await b.eval(() => document.querySelectorAll('#refs-results .sr-match')[1].click());
      await b.waitFor(() => document.getElementById('editor').value.startsWith('def helper') && document.getElementById('editor').selectionEnd > document.getElementById('editor').selectionStart);
      assert.deepEqual(await where(), ['def helper(x', 'helper', 6]);
      await b.eval(() => document.querySelector('#refs-results .sr-match').focus());
      await b.key('Escape', 'Escape', 27);
      assert.deepEqual(await b.eval(() => [document.getElementById('refs-panel').hidden, getComputedStyle(document.getElementById('files')).display !== 'none']), [true, true]);
      for (const p of ['nav_lib.py', 'nav_main.py']) await fetch(base + '/projects/dom/file?path=' + p, {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('replace undo: restores written files, skips files edited since', async () => {
      const undo = () => b.eval(() => { const n = document.getElementById('replace-undo'); return {disabled: n.disabled, title: n.title}; });
      assert.equal((await undo()).disabled, false, 'enabled after the replace above');
      assert.match((await undo()).title, /2 个文件/);
      await confirms([false]);
      await b.eval(click, '#replace-undo');
      assert.equal((await api('GET', '/projects/dom/file?path=search/a.py')).content, 'pin = 1\nprint(pin)\n', 'declined confirm changes nothing');
      await confirms([true]);
      await b.eval(click, '#replace-undo');
      await b.waitFor(() => /已撤销 1 个文件/.test(document.getElementById('message').textContent));
      const msg = await b.eval(() => document.getElementById('message').textContent);
      assert.match(msg, /search\/b\.py（替换之后又被修改过）/);
      assert.equal((await api('GET', '/projects/dom/file?path=search/a.py')).content, 'needle = 1\nprint(needle)\n', 'written back to the device');
      assert.equal((await api('GET', '/projects/dom/file?path=search/b.py')).content, '# pin\nx = 2\n', 'file edited since is untouched');
      assert.match((await b.eval(() => window.__confirms))[0], /撤销上一次替换（2 个文件）/);
    });

    await t.test('rename symbol (F2): prompt, confirm, every file written, undo; bad names refused', async () => {
      await api('PUT', '/projects/dom/files', {files: [
        {path: 'ren_lib.py', content: 'def helper(x):\n    return x * 2\n'},
        {path: 'ren_main.py', content: 'from ren_lib import helper\nhelper_count = 0\nprint(helper(2))\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      await b.eval(click, row('ren_main.py'));
      await b.waitFor(() => document.getElementById('editor').value.startsWith('from ren_lib'));
      const caretAt = needle => b.eval(w => { const e = document.getElementById('editor'); const i = e.value.indexOf(w); e.focus(); e.setSelectionRange(i + 1, i + 1); }, needle);
      const msg = () => b.eval(() => document.getElementById('message').textContent);
      // a declined confirm changes nothing
      await prompts(['assist']); await confirms([false]);
      await caretAt('helper(2)'); await b.key('F2', 'F2', 113);
      await b.waitFor(() => window.__confirms && window.__confirms.length === 1);
      assert.deepEqual(await b.eval(() => window.__prompts.map(p => p.def)), ['helper']);
      assert.match((await b.eval(() => window.__confirms))[0], /把 2 个文件中的 3 处 helper 重命名为 assist/);
      assert.equal((await api('GET', '/projects/dom/file?path=ren_lib.py')).content, 'def helper(x):\n    return x * 2\n');
      // accepted: both files written, helper_count untouched, the editor shows the new text
      await prompts(['assist']); await confirms([true]);
      await caretAt('helper(2)'); await b.key('F2', 'F2', 113);
      await b.waitFor(() => /已把 helper 重命名为 assist：3 处（2 个文件）/.test(document.getElementById('message').textContent));
      assert.equal((await api('GET', '/projects/dom/file?path=ren_lib.py')).content, 'def assist(x):\n    return x * 2\n');
      assert.equal((await api('GET', '/projects/dom/file?path=ren_main.py')).content, 'from ren_lib import assist\nhelper_count = 0\nprint(assist(2))\n');
      assert.equal(await b.eval(() => document.getElementById('editor').value), 'from ren_lib import assist\nhelper_count = 0\nprint(assist(2))\n');
      // 撤销替换 undoes the rename
      assert.equal(await b.eval(() => document.getElementById('replace-undo').disabled), false);
      await confirms([true]); await b.eval(click, '#replace-undo');
      await b.waitFor(() => /已撤销 2 个文件/.test(document.getElementById('message').textContent));
      assert.equal((await api('GET', '/projects/dom/file?path=ren_lib.py')).content, 'def helper(x):\n    return x * 2\n');
      // refused: a keyword, a library symbol
      await prompts(['class']); await confirms([]);
      await caretAt('helper(2)'); await b.key('F2', 'F2', 113);
      await b.waitFor(() => /不是合法的 Python 名字/.test(document.getElementById('message').textContent));
      await caretAt('print('); await b.key('F2', 'F2', 113);
      await b.waitFor(() => /找不到 print 的定义/.test(document.getElementById('message').textContent));
      assert.deepEqual(await b.eval(() => window.__confirms), []);
      for (const p of ['ren_lib.py', 'ren_main.py']) await fetch(base + '/projects/dom/file?path=' + p, {method: 'DELETE'});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
    });

    await t.test('ReDoS guard: nested repeats are refused up front; a hidden catastrophic pattern is killed by the worker timeout and the page stays responsive', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'search/redos.txt', content: 'a'.repeat(60) + 'b\n'}]});
      await b.eval(click, '#refresh'); await b.waitFor(idle);
      const set = (id, v) => b.eval((i, val) => { const n = document.getElementById(i); n.value = val; n.dispatchEvent(new Event('input')); }, id, v);
      const summary = () => b.eval(() => document.getElementById('search-summary').textContent);
      if (!(await b.eval(() => document.getElementById('s-regex').getAttribute('aria-pressed') === 'true'))) await b.eval(click, '#s-regex');
      await b.eval(() => { document.getElementById('search-panel').hidden && document.getElementById('open-search').click(); });
      await set('search-inc', 'search/redos.txt');
      await set('search-q', '(a+)+$'); await b.eval(click, '#search-go');
      await b.waitFor(() => /嵌套的无限重复/.test(document.getElementById('search-summary').textContent));
      // not caught by the static check, still exponential: (a|aa)+$ on 60 a's then b
      await set('search-q', '(a|aa)+$');
      const t0 = Date.now();
      await b.eval(click, '#search-go');
      // the page must keep answering while the worker spins
      const ticks = await b.eval(() => new Promise(res => { let n = 0; const id = setInterval(() => n++, 50); setTimeout(() => { clearInterval(id); res(n); }, 1000); }));
      assert.ok(ticks >= 10, 'main thread stayed responsive during the search (ticks ' + ticks + ')');
      await b.waitFor(() => /超时/.test(document.getElementById('search-summary').textContent), 15000);
      const took = Date.now() - t0;
      assert.ok(took >= 2000 && took < 9000, 'aborted around the 2.5 s limit (took ' + took + ' ms)');
      assert.match(await summary(), /正则表达式运行超时/);
      // the guard is reusable afterwards: a normal regex works
      await set('search-q', 'a{3}b'); await b.eval(click, '#search-go');
      await b.waitFor(() => /1 处/.test(document.getElementById('search-summary').textContent));
      await b.eval(click, '#s-regex');   // back to literal for later tests
      await set('search-inc', '');
      await b.eval(click, '#search-close');   // back to the file tree for the tests below
    });

    await t.test('tabs: × button, middle click, context menu actions, dirty confirm, close all', async () => {
      await b.eval(click, row('search')).catch(() => {});
      for (const p of ['search/a.py', 'search/b.py', 'readme.txt']) { await b.waitFor(sel => !!document.querySelector(sel), 2000, row(p)).catch(async () => { await b.eval(click, row('search')); }); await b.eval(click, row(p)); await b.waitFor(path => document.querySelector('#tabs .active').dataset.path === path, 3000, p); }
      const tabs = () => b.eval(() => [...document.querySelectorAll('#tabs .tab')].map(t => t.dataset.path + (t.classList.contains('active') ? '*' : '')));
      assert.ok((await tabs()).length >= 3);
      // make the active tab (readme.txt) dirty, try × and refuse
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); e.value = 'hello\nmore\n'; e.dispatchEvent(new Event('input')); });
      await confirms([false, true]);
      const before = (await tabs()).length;
      await b.eval(() => document.querySelector('#tabs .tab.active .tab-close').click());
      assert.equal((await tabs()).length, before, 'refused: tab stays'); assert.match((await b.eval(() => window.__confirms))[0], /readme\.txt 有未保存的修改/);
      assert.equal(await b.eval(() => document.getElementById('editor').value), 'hello\nmore\n');
      await b.eval(() => document.querySelector('#tabs .tab.active .tab-close').click());
      assert.equal((await tabs()).length, before - 1, 'accepted: tab closed');
      assert.ok((await tabs()).some(t => t.endsWith('*')), 'a neighbour became active');
      assert.equal((await b.eval(() => document.getElementById('editor').value)).includes('more'), false);
      // reopening shows the saved content again
      await b.eval(click, row('readme.txt')); await b.waitFor(() => document.getElementById('editor').value === 'hello\n');
      // middle click on a tab closes it
      const target = await b.eval(() => [...document.querySelectorAll('#tabs .tab:not(.active)')].find(t => !t.textContent.includes('●')).dataset.path);
      await b.eval(p => document.querySelector('#tabs .tab[data-path="' + p + '"]').dispatchEvent(new MouseEvent('auxclick', {button: 1, bubbles: true, cancelable: true})), target);
      assert.equal((await tabs()).some(t => t.replace('*', '') === target), false, 'middle click closed it');
      // context menu: close others
      await b.eval(click, row('search/a.py')); await b.waitFor(() => document.querySelector('#tabs .active').dataset.path === 'search/a.py');
      await b.eval(() => document.querySelector('#tabs .tab[data-path="search/a.py"]').dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 300, clientY: 120})));
      assert.equal(await b.eval(() => !document.getElementById('tab-menu').hidden), true);
      assert.deepEqual(await b.eval(() => [...document.querySelectorAll('#tab-menu button')].map(x => x.dataset.act)), ['one', 'others', 'right', 'saved', 'all']);
      await confirms([true]);   // earlier tests left unsaved edits in __init__.py and others: one confirm lists them
      await b.eval(() => document.querySelector('#tab-menu [data-act=others]').click());
      assert.match((await b.eval(() => window.__confirms))[0], /^__init__\.py 有未保存的修改/);
      assert.deepEqual(await tabs(), ['search/a.py*']);
      // Alt+W closes the active tab; with none left the editor is empty and disabled
      await b.eval(() => window.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyW', key: 'w', altKey: true, bubbles: true, cancelable: true})));
      assert.deepEqual(await tabs(), []);
      assert.deepEqual(await b.eval(() => [document.getElementById('editor').disabled, document.getElementById('editor').value, document.getElementById('message').textContent]), [true, '', '没有打开的文件']);
      // close all with a mix of dirty and clean tabs: one confirm listing the dirty files
      for (const p of ['search/a.py', 'search/b.py']) { await b.eval(click, row(p)); await b.waitFor(path => document.querySelector('#tabs .active')?.dataset.path === path, 3000, p); }
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); e.value += '# x\n'; e.dispatchEvent(new Event('input')); });
      await confirms([false, true]);
      const menu = () => b.eval(() => { document.querySelector('#tabs .tab').dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 200, clientY: 100})); document.querySelector('#tab-menu [data-act=all]').click(); });
      await menu(); assert.equal((await tabs()).length, 2, 'refused');
      assert.match((await b.eval(() => window.__confirms))[0], /search\/b\.py/);
      await menu(); assert.deepEqual(await tabs(), []);
      await b.eval(click, row('search/b.py')); await b.waitFor(() => document.getElementById('editor').value === '# pin\nx = 2\n');
    });

    await t.test('screenshot dock: capture, pick coordinates and colour, insert, save into res/img; clear error without capture permission', async () => {
      const status = await api('GET', '/status');
      await b.eval(click, '#shot-toggle');
      assert.equal(await b.eval(() => !document.getElementById('shot-panel').hidden), true);
      await b.waitFor(() => /×|权限|失败/.test(document.getElementById('shot-info').textContent), 8000);
      const info = await b.eval(() => document.getElementById('shot-info').textContent);
      if (!status.capture) {
        assert.match(info, /屏幕截取/); assert.equal(await b.eval(() => document.getElementById('shot-info').classList.contains('error')), true);
        assert.equal(await b.eval(() => document.getElementById('shot-save').disabled), true);
      } else {
        assert.match(info, /^\d+×\d+ · /);
        await b.eval(() => { const c = document.getElementById('shot-canvas'), r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: r.left + 1, clientY: r.top + 1})); });
        assert.match(await b.eval(() => document.getElementById('shot-info').textContent), /^x=\d+，y=\d+ · #[0-9a-f]{6}/);
        await b.eval(() => { const e = document.getElementById('editor'); e.focus(); e.setSelectionRange(0, 0); });
        const first = await b.eval(() => document.getElementById('editor').value);
        await b.eval(click, '#shot-insert');
        assert.match(await b.eval(() => document.getElementById('editor').value), /^\d+, \d+/);
        await b.eval(v => { const e = document.getElementById('editor'); e.value = v; e.dispatchEvent(new Event('input')); }, first);   // undo the insertion
        await b.eval(click, '#shot-save');
        await b.waitFor(() => /已保存到 res\/img\/shot-\d{8}-\d{6}\.png/.test(document.getElementById('shot-info').textContent), 8000);
        const saved = (await api('GET', '/projects/dom/files')).files.find(f => /^res\/img\/shot-/.test(f.path));
        assert.ok(saved, 'screenshot written to the project');
        const file = await api('GET', '/projects/dom/file?path=' + encodeURIComponent(saved.path));
        assert.equal(file.encoding, 'base64'); assert.ok(Buffer.from(file.content, 'base64').subarray(1, 4).toString() === 'PNG');
        await fetch(base + '/projects/dom/file?path=' + encodeURIComponent(saved.path), {method: 'DELETE'});
      }
      await b.eval(click, '#shot-close');
      assert.equal(await b.eval(() => document.getElementById('shot-panel').hidden), true);
    });

    assert.deepEqual(b.errors.filter(e => !/favicon/.test(e)), [], 'no page errors');

    await t.test('rename / move: F2, button, context menu and drag; tabs, edits and breakpoints follow', async () => {
      const paths = async () => (await api('GET', '/projects/dom/files')).files.map(f => f.path);
      const msg = text => b.waitFor(m => document.getElementById('message').textContent.includes(m), 5000, text).catch(async e => { throw Error(e.message + ' [wanted ' + JSON.stringify(text) + ', message is ' + JSON.stringify(await b.eval(() => document.getElementById('message').textContent)) + ']'); });
      await api('PUT', '/projects/dom/files', {files: [{path: 'mv/x.py', content: 'X = 1\n'}, {path: 'z.py', content: 'Z\n'}]});
      await b.eval(click, '#refresh'); await settle();
      await b.eval(click, row('mv')); await b.eval(click, row('mv/x.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'X = 1\n');
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); e.setSelectionRange(0, 0); });
      await b.eval(click, '#breakpoint');
      await b.waitFor(() => document.getElementById('line-numbers').textContent.startsWith('● 1'));
      await b.eval(() => { const e = document.getElementById('editor'); e.value = 'X = 2\n'; e.dispatchEvent(new Event('input')); });

      // F2 on the tree row; the prompt starts from the current path.
      await prompts(['mv/y.py']);
      await b.eval(() => document.querySelector('#files .tree-row[data-path="mv/x.py"]').dispatchEvent(new KeyboardEvent('keydown', {key: 'F2', bubbles: true})));
      await msg('移动为 mv/y.py'); await settle();
      assert.deepEqual(await b.eval(() => window.__prompts.map(p => p.def)), ['mv/x.py']);
      let s = await S();
      assert.ok(s.tabs.some(x => x.text === 'mv/y.py ●' && x.selected), 'open tab follows the rename and stays dirty');
      assert.equal(s.tabs.some(x => x.text.startsWith('mv/x.py')), false);
      assert.equal(s.editor, 'X = 2\n', 'unsaved edit kept');
      assert.ok(await b.eval(() => document.getElementById('line-numbers').textContent.startsWith('● 1')), 'breakpoint follows');
      assert.deepEqual((await R()).filter(x => x.selected).map(x => x.path), ['mv/y.py']);
      let files = await paths();
      assert.ok(files.includes('mv/y.py') && !files.includes('mv/x.py'));
      assert.equal((await api('GET', '/projects/dom/file?path=mv/y.py')).content, 'X = 1\n', 'rename does not save');
      await b.eval(() => window.dispatchEvent(new KeyboardEvent('keydown', {key: 's', ctrlKey: true})));
      await msg('已保存 mv/y.py');
      assert.equal((await api('GET', '/projects/dom/file?path=mv/y.py')).content, 'X = 2\n');

      // Folder move with the 重命名 button: children, tab and expanded state follow.
      await b.eval(click, row('mv')); await settle();
      await prompts(['pkg/mv']);
      await b.eval(click, '#rename'); await msg('移动为 pkg/mv/'); await settle();
      let r = await R();
      assert.ok(['pkg', 'pkg/mv', 'pkg/mv/y.py'].every(p => r.some(x => x.path === p)), 'moved folder revealed');
      assert.equal(r.find(x => x.path === 'pkg/mv').expanded, 'true');
      assert.ok((await S()).tabs.some(x => x.text === 'pkg/mv/y.py'));

      // Conflicts and the entry point.
      await b.eval(click, row('z.py')); await b.waitFor(() => document.getElementById('editor').value === 'Z\n'); await settle();
      await prompts(['readme.txt']);
      await b.eval(click, '#rename'); await settle();
      s = await S(); assert.equal(s.error, true, s.message); assert.match(s.message, /已存在/);
      assert.ok((await paths()).includes('z.py'));
      await b.eval(click, row('__init__.py')); await settle();
      assert.equal(await b.eval(() => document.getElementById('rename').disabled), true, 'entry point cannot be renamed');
      assert.equal(await b.eval(() => document.querySelector('#files .tree-row[data-path="__init__.py"]').draggable), false);

      // opening __init__.py is asynchronous on a real device: let it finish so it cannot re-select itself mid-test
      await b.waitFor(() => document.querySelector('#tabs .active') && document.querySelector('#tabs .active').dataset.path === '__init__.py' && document.getElementById('editor').value.startsWith('import time'));
      // Right-click menu.
      await b.eval(() => { const n = document.querySelector('#files .tree-row[data-path="z.py"]'); const box = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: box.left + 5, clientY: box.top + 5})); });
      assert.equal(await b.eval(() => document.getElementById('tree-menu').hidden), false);
      await prompts(['zz.py']);
      await b.eval(click, '#tree-menu [data-act="rename"]'); await msg('移动为 zz.py'); await settle();
      assert.equal(await b.eval(() => document.getElementById('tree-menu').hidden), true);

      // Drag a file onto a folder.
      await b.eval(() => {
        const dt = new DataTransfer(), src = document.querySelector('#files .tree-row[data-path="zz.py"]'), dst = document.querySelector('#files .tree-row[data-path="pkg"]');
        src.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: dt}));
        dst.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: dt}));
        dst.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt}));
      });
      await msg('移动为 pkg/zz.py'); await settle();
      files = await paths();
      assert.ok(files.includes('pkg/zz.py') && !files.includes('zz.py'));
    });
    await t.test('新建工程 dialog: template list, validation, Esc cancels, creates from the chosen template', async () => {
      const name = 'dom_tpl_' + Date.now() % 100000;
      if (device) await fetch(base + '/projects/' + name, {method: 'DELETE'});
      const open = async () => { await b.eval(click, '#new-project'); await b.waitFor(() => document.querySelectorAll('.new-project-dialog .tpl-item').length > 0); };
      await open();
      const items = await b.eval(() => [...document.querySelectorAll('.tpl-item')].map(r => ({id: r.dataset.id, checked: r.querySelector('input').checked})));
      assert.ok(items.length >= 7); assert.deepEqual(items.filter(i => i.checked).map(i => i.id), ['empty']);
      assert.equal(await b.eval(() => document.activeElement.id), 'np-name');
      await b.eval(() => { document.querySelector('.new-project-dialog').requestSubmit(); });
      assert.match(await b.eval(() => document.querySelector('.np-error').textContent), /不能为空/);
      await b.eval(() => { const n = document.getElementById('np-name'); n.value = '9bad'; document.querySelector('.new-project-dialog').requestSubmit(); });
      assert.match(await b.eval(() => document.querySelector('.np-error').textContent), /工程名/);
      await b.eval(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})));
      assert.equal(await b.eval(() => !!document.querySelector('.xs-dialog-backdrop')), false);
      await open();
      await b.eval(n => { document.getElementById('np-name').value = n; document.querySelector('.tpl-item[data-id="ocr"] input').click(); document.querySelector('.new-project-dialog').requestSubmit(); }, name);
      await b.waitFor(n => document.getElementById('projects').value === n, 5000, name); await settle();
      const main = (await api('GET', '/projects/' + name + '/file?path=__init__.py')).content;
      assert.match(main, /Ocr|ocr/); assert.ok(!main.includes('{{name}}'));
      await fetch(base + '/projects/' + name, {method: 'DELETE'});
    });

    await t.test('line-number gutter: kept while typing on a line, rebuilt when the line count changes', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'gut_main.py', content: 'a = 1\nb = 2\n'}]});
      await b.goto((process.env.XS_PAGE_URL ? process.env.XS_PAGE_URL.replace(/\/$/, '') : base) + '/tools/ui/editor.html?project=dom');
      await b.waitFor(() => !document.getElementById('editor').disabled); await b.waitFor(idle);
      await b.eval(click, row('gut_main.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'a = 1\nb = 2\n' && !document.getElementById('editor').disabled);
      await b.eval(() => { window.__firstNumber = document.querySelector('#line-numbers span'); });
      const type = text => b.eval(v => { const e = document.getElementById('editor'); e.focus(); e.setSelectionRange(5, 5); e.setRangeText(v, 5, 5, 'end'); e.dispatchEvent(new InputEvent('input', {inputType: 'insertText', data: v})); }, text);
      await type('0');
      assert.equal(await b.eval(() => document.querySelector('#line-numbers span') === window.__firstNumber), true, 'same gutter nodes after typing within a line');
      assert.equal(await b.eval(() => document.querySelectorAll('#line-numbers span').length), 3);
      await type('\n');
      assert.deepEqual(await b.eval(() => [...document.querySelectorAll('#line-numbers span')].map(s => s.textContent.trim())), ['1', '2', '3', '4']);
      assert.equal(await b.eval(() => document.getElementById('cursor').textContent), '行 2，列 1');
    });

    await t.test('?project=…&file=… opens that file (the phone editor links here for files too big to edit on the phone)', async () => {
      await api('PUT', '/projects/dom/files', {files: [{path: 'link dir/deep link.py', content: 'LINKED = 1\n'}]});
      await b.goto((process.env.XS_PAGE_URL ? process.env.XS_PAGE_URL.replace(/\/$/, '') : base) + '/tools/ui/editor.html?project=dom&file=' + encodeURIComponent('link dir/deep link.py'));
      await b.waitFor(() => document.getElementById('editor').value === 'LINKED = 1\n' && !document.getElementById('editor').disabled);
      assert.equal((await S()).tabs.find(x => x.selected).text.includes('deep link.py'), true);
      // an unknown file falls back to the entry file
      await b.goto((process.env.XS_PAGE_URL ? process.env.XS_PAGE_URL.replace(/\/$/, '') : base) + '/tools/ui/editor.html?project=dom&file=nope.py');
      await b.waitFor(() => !document.getElementById('editor').disabled && document.getElementById('editor').value !== 'LINKED = 1\n');
      assert.equal((await S()).tabs.find(x => x.selected).text.includes('__init__.py'), true);
    });
  } finally {
    if (browser) await browser.close();
    if (device && base) await fetch(base + '/projects/dom', {method: 'DELETE'}).catch(() => {});
    if (mock) mock.child.kill();
  }
});
