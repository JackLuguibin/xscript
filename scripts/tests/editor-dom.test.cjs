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

    await t.test('syntax diagnostics: wavy underlines, gutter marks, problems button; cleared while typing; Python files only', async () => {
      await b.eval(click, row('__init__.py'));
      await b.waitFor(() => document.getElementById('editor').value.length > 0 && !document.getElementById('editor').disabled);
      await b.eval(() => { const e = document.getElementById('editor'); e.focus(); e.value = 'if x\n    pass\nprint "hi"\nok = (1,\n'; e.setSelectionRange(0, 0); e.dispatchEvent(new Event('input')); });
      await b.waitFor(() => document.querySelectorAll('#diag .sq').length >= 3);
      const d = await b.eval(() => ({
        layer: document.getElementById('diag').textContent.replace(/\n$/, '') === document.getElementById('editor').value,
        marks: [...document.querySelectorAll('#line-numbers .diag-line')].map(n => n.textContent.trim()),
        title: document.querySelector('#line-numbers .diag-line').title,
        count: document.getElementById('problems').dataset.count, text: document.getElementById('problems').textContent, hidden: document.getElementById('problems').hidden,
        sq: getComputedStyle(document.querySelector('#diag .sq')).textDecorationLine,
      }));
      assert.equal(d.layer, true, 'diagnostic layer text matches the textarea (alignment)');
      assert.deepEqual(d.marks, ['1', '3', '4']); assert.ok(d.title.length > 0);
      assert.equal(d.count, '3'); assert.equal(d.hidden, false); assert.match(d.text, /第 1 行/); assert.match(d.sq, /underline/);
      // problems button jumps to the next problem and moves the caret there
      await b.eval(click, '#problems');
      assert.equal(await b.eval(() => document.getElementById('editor').value.slice(0, document.getElementById('editor').selectionStart).split('\n').length), 1);
      await b.eval(click, '#problems');
      assert.equal(await b.eval(() => document.getElementById('editor').value.slice(0, document.getElementById('editor').selectionStart).split('\n').length), 3);
      // typing clears stale squiggles immediately, then the check re-runs
      await b.insertText('x');
      assert.equal(await b.eval(() => document.querySelectorAll('#diag .sq').length), 0, 'stale marks dropped while typing');
      await b.waitFor(() => document.querySelectorAll('#diag .sq').length >= 2);   // `xprint "hi"` is no longer a py2 print
      // fix everything -> clean
      await b.eval(() => { const e = document.getElementById('editor'); e.value = 'if x:\n    pass\nprint("hi")\nok = (1,)\n'; e.dispatchEvent(new Event('input')); });
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
  } finally {
    if (browser) await browser.close();
    if (device && base) await fetch(base + '/projects/dom', {method: 'DELETE'}).catch(() => {});
    if (mock) mock.child.kill();
  }
});
