/* Web IDE 节点 dock (tools/editor-nodes.js in editor.js) in headless Chrome against scripts/mock_device.py: the dock
 * reads /ui-tree and /screen, picking a node in the tree or on the screenshot shows its attributes and box, the code
 * follows the chosen kind, 插入到光标 writes it at the caret with the import added once, filter / folding / 完整树 work,
 * the 截图 and 节点 docks replace each other, and a missing accessibility channel is explained.
 * XS_NODES_SHOT=docs/images/ide-nodes.png also saves the documentation screenshot, and ide-nodes-fragile.png (and -run, -a11y, ide-run-a11y, ide-run-overlay) beside it
 * (a node only its path can pin, with the warning comment) and ide-nodes-run.png (在手机上运行 after 插入).
 * Skipped when no local Chrome is found ($CHROME or ~/.cache/puppeteer). */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
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

const view = () => ({
  open: !document.getElementById('node-panel').hidden, pressed: document.getElementById('node-toggle').getAttribute('aria-pressed'),
  rows: [...document.querySelectorAll('#node-tree .node-row')].map(r => r.dataset.path),
  selected: (document.querySelector('#node-tree [aria-selected="true"]') || {}).dataset?.path || '',
  info: document.getElementById('node-info').textContent, infoError: document.getElementById('node-info').classList.contains('error'),
  code: document.getElementById('node-code').value, insert: document.getElementById('node-insert').disabled,
  attrs: [...document.querySelectorAll('#node-attrs dt')].map(d => [d.textContent, d.nextElementSibling.textContent]),
  shot: !document.getElementById('node-shot').hidden, box: document.getElementById('node-box').hidden ? null : document.getElementById('node-box').style.cssText,
  editor: document.getElementById('editor').value,
});

test('Web IDE 节点 dock reads the UI tree and generates node code', {skip: CHROME ? false : 'no local Chrome (set $CHROME or install puppeteer browsers)', timeout: 60000 + cdp.LAUNCH_BUDGET_MS}, async t => {
  const mock = startMock();
  let browser;
  try {
    const base = 'http://127.0.0.1:' + await mock.port;
    const api = async (method, url, body) => {
      const r = await fetch(base + url, {method, headers: {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
      const data = await r.json(); if (!r.ok) throw Error(data.error); return data;
    };
    await api('POST', '/projects/nodes', {});
    await api('PUT', '/projects/nodes/files', {files: [{path: '__init__.py', content: 'import time\n\n\ndef main():\n    \n    time.sleep(1)\n'}]});
    browser = await cdp.launch(CHROME);
    const b = browser;
    await b.goto(base + '/tools/ui/editor.html?project=nodes&file=__init__.py');
    await b.waitFor(() => !document.getElementById('editor').disabled && document.getElementById('editor').value.includes('def main'));

    await t.test('opening the dock lists the tree, the screenshot and nothing selected', async () => {
      await b.eval(() => document.getElementById('node-toggle').click());
      await b.waitFor(() => document.querySelectorAll('#node-tree .node-row').length > 0 && !document.getElementById('node-shot').hidden);
      const v = await b.eval(view);
      assert.equal(v.open, true); assert.equal(v.pressed, 'true');
      assert.deepEqual(v.rows, ['0/0', '1', '1/0', '1/0/0', '1/0/1', '1/0/2', '1/0/3']);
      assert.match(v.info, /^7 个节点 · 1080×2400/); assert.equal(v.infoError, false);
      assert.equal(v.code, ''); assert.equal(v.insert, true); assert.equal(v.box, null);
      const labels = await b.eval(() => [...document.querySelectorAll('#node-tree .node-label')].map(n => n.textContent));
      assert.deepEqual(labels, ['Search', 'FrameLayout', 'LinearLayout', '应用图标', 'com.demo.app:id/user', '他说"你好"，\'欢迎\'', '登录']);
    });

    await t.test('picking a row shows attributes, the box over the screenshot and the selector code', async () => {
      await b.eval(() => document.querySelector('#node-tree .node-row[data-path="1/0/3"]').click());
      const v = await b.eval(view);
      assert.equal(v.selected, '1/0/3');
      assert.equal(v.code, "from xscript.android import node\nhit = node.Selector().text('登录').clickable().find(timeout=5)");
      assert.equal(v.insert, false);
      const a = Object.fromEntries(v.attrs);
      assert.equal(a['文字 text'], '登录'); assert.equal(a['类名 type'], 'android.widget.Button'); assert.equal(a['中心'], '540, 1045');
      assert.match(v.box, /left: 7\.4\d*%/); assert.match(v.box, /top: 40\.8\d*%/);
      assert.equal(await b.eval(() => document.activeElement.dataset.path), '1/0/3');
    });

    await t.test('试一下 runs the selector on the phone (find_all, nothing clicked) and boxes what it finds', async () => {
      // the mock's /eval never executes code: answer it here and keep what was sent
      await b.eval(() => {
        window.__evalSent = []; window.__evalReply = {ok: true, result: '[["1/0/3", 80, 980, 1000, 1110]]', error: ''};
        const real = window.fetch;
        window.fetch = (url, init) => String(url).startsWith('/eval')
          ? (window.__evalSent.push(JSON.parse(init.body)), Promise.resolve(new Response(JSON.stringify(window.__evalReply), {status: 200, headers: {'Content-Type': 'application/json'}})))
          : real(url, init);
      });
      const tryNow = async () => {
        await b.eval(() => document.getElementById('node-try').click());
        await b.waitFor(() => !/在手机上查找/.test(document.getElementById('node-try-result').textContent) && document.getElementById('node-try-result').textContent);
        return b.eval(() => ({text: document.getElementById('node-try-result').textContent, cls: document.getElementById('node-try-result').className,
          hits: [...document.querySelectorAll('#node-hits .node-hit')].map(h => h.className + ' ' + h.title), sent: window.__evalSent.slice(-1)[0]}));
      };
      const shotBefore = await b.eval(() => document.getElementById('node-shot').src);
      let v = await tryNow();
      assert.equal(v.text, '试一下：找到 1 个，就是选中的节点 · 截图已刷新');
      // the screenshot was taken again at try time; the tree-time box gives way to the try's boxes
      assert.notEqual(await b.eval(() => document.getElementById('node-shot').src), shotBefore);
      assert.equal(await b.eval(() => document.getElementById('node-box').hidden), true); assert.match(v.cls, /\bok\b/);
      assert.deepEqual(v.hits, ['node-hit self 1/0/3']);
      assert.equal(v.sent.code, "from xscript.android import node\n_hits = node.Selector().text('登录').clickable().find_all(timeout=0, limit=20)\n_result = [[h.path, h.left, h.top, h.right, h.bottom, h.id, h.text, h.desc, h.type] for h in _hits]");
      assert.equal(v.sent.timeout_ms, 5000);
      await b.eval(() => { window.__evalReply = {ok: true, result: '[["1/0/2", 80, 800, 1000, 900], ["1/0/3", 80, 980, 1000, 1110]]', error: ''}; });
      v = await tryNow();
      assert.equal(v.text, '试一下：找到 2 个，第一个不是选中的节点（路径 1/0/2） · 截图已刷新'); assert.match(v.cls, /\berror\b/);
      assert.deepEqual(v.hits, ['node-hit 1/0/2', 'node-hit self 1/0/3']);
      await b.eval(() => { window.__evalReply = {ok: true, result: '[]', error: ''}; });
      v = await tryNow();
      assert.equal(v.text, '试一下：没找到。界面可能变了，点「重新获取」再试 · 截图已刷新'); assert.deepEqual(v.hits, []);
      await b.eval(() => { window.__evalReply = {ok: false, result: '', error: 'Traceback (most recent call last):\nNameError: boom\n'}; });
      v = await tryNow();
      assert.equal(v.text, '试一下失败：NameError: boom');
      // a new pick clears the result; 点击中心坐标 has nothing to look up
      await b.eval(() => document.querySelector('#node-tree .node-row[data-path="1/0/1"]').click());
      assert.equal(await b.eval(() => document.getElementById('node-try-result').textContent), '');
      await b.eval(() => { const s = document.getElementById('node-kind'); s.value = 'tap'; s.dispatchEvent(new Event('change')); });
      assert.equal(await b.eval(() => document.getElementById('node-try').disabled), true);
      await b.eval(() => { const s = document.getElementById('node-kind'); s.value = 'find'; s.dispatchEvent(new Event('change')); document.querySelector('#node-tree .node-row[data-path="1/0/3"]').click(); });
    });

    await t.test('the kind picker changes the code and is remembered', async () => {
      const pick = kind => b.eval(k => { const s = document.getElementById('node-kind'); s.value = k; s.dispatchEvent(new Event('change')); return document.getElementById('node-code').value; }, kind);
      assert.deepEqual(await b.eval(() => [...document.querySelectorAll('#node-kind option')].map(o => o.textContent)), ['查找节点', '查找并点击', '等待出现', 'XPath 查找', '点击中心坐标']);
      assert.equal(await pick('xpath'), "from xscript.android import node\nhit = node.Selector(xpath='//Button[@text=\"登录\"]').find(timeout=5)");
      assert.equal(await pick('tap'), 'from xscript.android import action\naction.click(540, 1045)  # 登录');
      assert.equal(await pick('click'), "from xscript.android import node\nnode.Selector().text('登录').clickable().click().find(timeout=5)");
      assert.equal(await b.eval(() => localStorage.getItem('xs-node-kind')), 'click');
    });

    await t.test('插入到光标 writes the code at the caret, indented, and adds the import once', async () => {
      await b.eval(() => { const e = document.getElementById('editor'), at = e.value.indexOf('    \n') + 4; e.focus(); e.setSelectionRange(at, at); });
      await b.eval(() => document.getElementById('node-insert').click());
      let v = await b.eval(view);
      assert.equal(v.editor, "import time\nfrom xscript.android import node\n\n\ndef main():\n    node.Selector().text('登录').clickable().click().find(timeout=5)\n    time.sleep(1)\n");
      assert.match(await b.eval(() => document.getElementById('message').textContent), /已插入节点代码：登录/);
      assert.equal(await b.eval(() => document.getElementById('save').disabled), false);
      // multi-line code keeps the indent; the import is not added twice
      await b.eval(() => { const s = document.getElementById('node-kind'); s.value = 'exists'; s.dispatchEvent(new Event('change')); });
      await b.eval(() => { const e = document.getElementById('editor'), at = e.value.indexOf('    time.sleep'); e.value = e.value.slice(0, at) + '    \n' + e.value.slice(at); e.focus(); e.setSelectionRange(at + 4, at + 4); });
      await b.eval(() => document.getElementById('node-insert').click());
      v = await b.eval(view);
      assert.equal(v.editor.split('from xscript.android import node').length, 2);
      assert.match(v.editor, /\n    if node\.Selector\(\)\.text\('登录'\)\.clickable\(\)\.exists\(timeout=5\):\n        pass\n    time\.sleep/);
    });

    await t.test('after 插入, 在手机上运行 runs the inserted code for real and says what happened', async () => {
      const state = () => b.eval(() => ({hidden: document.getElementById('node-run').hidden, label: document.getElementById('node-run').textContent}));
      // shown only after an insert; a new pick hides it
      assert.deepEqual(await state(), {hidden: false, label: '在手机上运行'});
      await b.eval(() => document.querySelector('#node-tree .node-row[data-path="1/0/3"]').click());
      assert.equal((await state()).hidden, true);
      const before = await b.eval(() => document.getElementById('editor').value);
      await b.eval(() => {
        const e = document.getElementById('editor'), at = e.value.indexOf('    time.sleep'); e.value = e.value.slice(0, at) + '    \n' + e.value.slice(at); e.focus(); e.setSelectionRange(at + 4, at + 4);
        const s = document.getElementById('node-kind'); s.value = 'click'; s.dispatchEvent(new Event('change')); document.getElementById('node-insert').click();
      });
      assert.deepEqual(await state(), {hidden: false, label: '在手机上运行（会点击）'});
      await b.eval(() => { window.__evalReply = {ok: true, result: "已点击 Node(text='登录', id='', type='Button', path='1/0/3')", error: ''}; document.getElementById('node-run').click(); });
      await b.waitFor(() => /^运行结果/.test(document.getElementById('node-try-result').textContent));
      assert.equal(await b.eval(() => document.getElementById('node-try-result').textContent), "运行结果：已点击 Node(text='登录', id='', type='Button', path='1/0/3')");
      const sent = await b.eval(() => window.__evalSent.slice(-1)[0]);
      assert.equal(sent.code, "from xscript.android import node\nhit = node.Selector().text('登录').clickable().click().find(timeout=5)\n_result = \"没找到（5 秒内）\" if hit is None else (\"已点击 \" if True else \"找到 \") + repr(hit)");
      assert.equal(sent.timeout_ms, 8000);
      await b.eval(() => { window.__evalReply = {ok: true, result: '没找到（5 秒内）', error: ''}; document.getElementById('node-run').click(); });
      await b.waitFor(() => /没找到/.test(document.getElementById('node-try-result').textContent));
      assert.match(await b.eval(() => document.getElementById('node-try-result').className), /\berror\b/);
      // put the editor and kind back for the tests below
      await b.eval(() => { const k = document.getElementById('node-kind'); k.value = 'exists'; k.dispatchEvent(new Event('change')); try { localStorage.setItem('xs-node-kind', 'exists'); } catch (e) { /* off */ } });
      await b.eval(v => { const e = document.getElementById('editor'); e.value = v; e.dispatchEvent(new Event('input')); }, before);
    });

    await t.test('clicking the screenshot selects the node under the point and reveals it', async () => {
      await b.eval(() => { document.querySelector('#node-tree .node-row[data-path="1/0"] .node-twisty').click(); });
      assert.deepEqual((await b.eval(view)).rows, ['0/0', '1', '1/0']);
      // the EditText spans x 80–1000, y 640–760 of 1080×2400
      await b.eval(() => {
        const img = document.getElementById('node-shot'), r = img.getBoundingClientRect();
        img.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: r.left + r.width * 500 / 1080, clientY: r.top + r.height * 700 / 2400}));
      });
      const v = await b.eval(view);
      assert.equal(v.selected, '1/0/1'); assert.ok(v.rows.includes('1/0/1'), 'folded parent reopened');
      assert.match(v.code, /node\.Selector\(\)\.id\('com\.demo\.app:id\/user'\)\.clickable\(\)\.exists/);
      assert.equal(Object.fromEntries(v.attrs)['提示 hint'], '请输入账号');
    });

    await t.test('keyboard: arrows move the selection, Left folds and Right opens', async () => {
      await b.eval(() => document.querySelector('#node-tree .node-row[data-path="1/0"]').click());
      await b.key('ArrowLeft'); assert.deepEqual((await b.eval(view)).rows, ['0/0', '1', '1/0']);
      await b.key('ArrowRight'); assert.equal((await b.eval(view)).rows.length, 7);
      await b.key('ArrowDown'); assert.equal((await b.eval(view)).selected, '1/0/0');
      await b.key('ArrowUp'); assert.equal((await b.eval(view)).selected, '1/0');
    });

    await t.test('最近选过 lists clicked nodes (not arrow keys) and finds one again after 重新获取', async () => {
      const recent = () => b.eval(() => [...document.querySelectorAll('#node-recent option')].map(o => o.textContent));
      const before = await recent();
      assert.equal(before[0], '最近选过（' + (before.length - 1) + '）');
      assert.ok(before.includes('com.demo.app:id/user · EditText') && before.includes('登录 · Button'), before.join(' / '));
      assert.ok(!before.some(o => o.startsWith('应用图标')), 'arrow keys do not count');
      // newest first, no duplicates
      await b.eval(() => document.querySelector('#node-tree .node-row[data-path="1/0/2"]').click());
      await b.eval(() => document.querySelector('#node-tree .node-row[data-path="1/0/3"]').click());
      const list = await recent();
      assert.deepEqual(list.slice(1, 3), ['登录 · Button', '他说"你好"，\'欢迎\' · TextView']);
      assert.equal(list.filter(o => o === '登录 · Button').length, 1);
      // re-read the tree, pick the EditText from the list
      await b.eval(() => document.getElementById('node-take').click());
      await b.waitFor(() => !document.getElementById('node-take').disabled && /个节点/.test(document.getElementById('node-info').textContent));
      await b.eval(() => { const s = document.getElementById('node-recent'), i = [...s.options].findIndex(o => o.textContent.startsWith('com.demo.app:id/user')); s.value = s.options[i].value; s.dispatchEvent(new Event('change')); });
      const v = await b.eval(view);
      assert.equal(v.selected, '1/0/1'); assert.match(v.info, /^已选中最近的「com\.demo\.app:id\/user」（路径 1\/0\/1）/);
      assert.equal((await recent())[1], 'com.demo.app:id/user · EditText', 'chosen one moves to the front');
      assert.match(await b.eval(() => localStorage.getItem('xs-node-recent')), /com\.demo\.app:id\/user/);
      await b.eval(() => document.querySelector('#node-tree .node-row[data-path="1/0/1"]').click());
    });

    await t.test('重新获取 keeps the same control selected even when the rows shifted, and says when it is gone', async () => {
      await b.eval(() => document.querySelector('#node-tree .node-row[data-path="1/0/3"]').click());
      // the phone's list shifted: a new 注册 button now sits at 1/0/3 and 登录 moved to 1/0/5
      await b.eval(() => {
        const real = window.fetch;
        window.__shift = 'move';
        window.fetch = (url, init) => !String(url).startsWith('/ui-tree') || !window.__shift ? real(url, init) : real(url, init).then(r => r.json()).then(d => {
          const form = d.roots.find(n => n.path === '1').children[0];
          const login = form.children.find(n => n.path === '1/0/3');
          if (window.__shift === 'move') form.children.splice(3, 0, Object.assign({}, login, {path: '1/0/3', text: '注册'})), login.path = '1/0/5';
          else form.children = form.children.filter(n => n !== login);
          return new Response(JSON.stringify(d), {status: 200, headers: {'Content-Type': 'application/json'}});
        });
      });
      const retake = async () => { await b.eval(() => document.getElementById('node-take').click()); await b.waitFor(() => !document.getElementById('node-take').disabled && /个节点/.test(document.getElementById('node-info').textContent)); return b.eval(view); };
      let v = await retake();
      assert.equal(v.selected, '1/0/5', 'still 登录, not 注册 at its old path'); assert.match(v.code, /text\('登录'\)/);
      assert.match(v.info, /点截图或树选中节点$/);
      await b.eval(() => { window.__shift = 'gone'; });
      v = await retake();
      assert.equal(v.selected, ''); assert.equal(v.code, '');
      assert.match(v.info, /之前选中的「登录」不在当前界面上$/);
      await b.eval(() => { window.__shift = null; });
      await retake();
      await b.eval(() => document.querySelector('#node-tree .node-row[data-path="1/0/3"]').click());
      assert.equal((await b.eval(view)).selected, '1/0/3');
    });

    await t.test('filter keeps matches and their parents; 完整树 adds layout-only nodes', async () => {
      await b.eval(() => { const f = document.getElementById('node-filter'); f.value = 'edittext'; f.dispatchEvent(new Event('input')); });
      assert.deepEqual((await b.eval(view)).rows, ['1', '1/0', '1/0/1']);
      await b.eval(() => { const f = document.getElementById('node-filter'); f.value = 'zzz'; f.dispatchEvent(new Event('input')); });
      assert.equal(await b.eval(() => document.getElementById('node-tree').textContent), '没有匹配的节点');
      await b.eval(() => { const f = document.getElementById('node-filter'); f.value = ''; f.dispatchEvent(new Event('input')); });
      await b.eval(() => { const c = document.getElementById('node-full'); c.checked = true; c.dispatchEvent(new Event('change')); });
      await b.waitFor(() => !!document.querySelector('#node-tree .node-row[data-path="1/0/4"]'));
      await b.eval(() => document.querySelector('#node-tree .node-row[data-path="1/0/4"]').click());
      const v = await b.eval(view);
      assert.match(v.info, /^8 个节点/);
      assert.match(v.code, /\n# 没有唯一的 id、文字或描述，只能靠路径定位：界面变了可能找不到\nif node\.Selector\(1\)\.type\('android\.view\.View'\)\.path\('1\/0\/4'\)\.exists/);
      // nothing stable around the View (its parents have no id / text either): no suggestion
      assert.equal(await b.eval(() => document.getElementById('node-alt').hidden), true);
      // the LinearLayout holding the form: its icon's description is unique, one click switches to it
      await b.eval(() => document.querySelector('#node-tree .node-row[data-path="1/0"]').click());
      assert.deepEqual(await b.eval(() => [document.getElementById('node-alt').hidden, document.getElementById('node-alt-text').textContent]),
        [false, '更稳的选择：子节点「应用图标」，它的 id、文字或描述在界面上唯一']);
      await b.eval(() => document.getElementById('node-alt-use').click());
      const w = await b.eval(view);
      assert.equal(w.selected, '1/0/0'); assert.doesNotMatch(w.code, /path\(/);
      assert.equal(await b.eval(() => document.getElementById('node-alt').hidden), true);
      await b.eval(() => document.querySelector('#node-tree .node-row[data-path="1/0/4"]').click());
    });

    if (process.env.XS_NODES_SHOT) await t.test('documentation screenshot', async () => {
      const paint = async () => {
        // the mock's /screen is a 24×48 gradient: paint the mock login screen from the tree rects instead
        await b.eval(() => new Promise(resolve => {
          const c = document.createElement('canvas'); c.width = 540; c.height = 1200; const g = c.getContext('2d'); g.scale(0.5, 0.5);
          g.fillStyle = '#f6f7fb'; g.fillRect(0, 0, 1080, 2400); g.fillStyle = '#3b6fe0'; g.fillRect(0, 0, 1080, 90);
          g.fillStyle = '#5b8def'; g.beginPath(); g.arc(540, 400, 100, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#fff'; g.strokeStyle = '#c9cfdb'; g.lineWidth = 4; g.fillRect(80, 640, 920, 120); g.strokeRect(80, 640, 920, 120);
          g.font = '44px sans-serif'; g.fillStyle = '#9aa1ad'; g.fillText('请输入账号', 110, 715);
          g.fillStyle = '#444'; g.fillText('他说"你好"，\'欢迎\'', 80, 845);
          g.fillStyle = '#3b6fe0'; g.fillRect(80, 980, 920, 130); g.fillStyle = '#fff'; g.font = 'bold 52px sans-serif'; g.fillText('登录', 488, 1063);
          const img = document.getElementById('node-shot'); img.onload = resolve; img.src = c.toDataURL('image/png');
        }));
      };
      const save = async file => {
        await b.cmd('Emulation.setDeviceMetricsOverride', {width: 1280, height: 860, deviceScaleFactor: 2, mobile: false});
        await new Promise(r => setTimeout(r, 300));
        const shot = await b.cmd('Page.captureScreenshot', {format: 'png'});
        fs.writeFileSync(path.resolve(__dirname, '../..', file), Buffer.from(shot.data, 'base64'));
        await b.cmd('Emulation.clearDeviceMetricsOverride', {});
      };
      // full tree, the form's LinearLayout (no id / text / desc): the code warns about the path, 更稳的选择 offers its icon
      await b.eval(() => { const s = document.getElementById('node-kind'); s.value = 'click'; s.dispatchEvent(new Event('change')); document.querySelector('#node-tree .node-row[data-path="1/0"]').click(); });
      await paint();
      await save(process.env.XS_NODES_SHOT.replace(/\.png$/, '-fragile.png'));
      await b.eval(() => { const c = document.getElementById('node-full'); c.checked = false; c.dispatchEvent(new Event('change')); });
      await b.waitFor(() => !document.querySelector('#node-tree .node-row[data-path="1/0/4"]') && document.querySelectorAll('#node-tree .node-row').length === 7);
      await b.eval(() => { document.querySelector('#node-tree .node-row[data-path="1/0/3"]').click(); });
      await paint();
      // 试一下 on the picked 登录 button (the /eval stub from the 试一下 test answers)
      await b.eval(() => { window.__evalReply = {ok: true, result: '[["1/0/3", 80, 980, 1000, 1110]]', error: ''}; document.getElementById('node-try').click(); });
      await b.waitFor(() => /就是选中的节点/.test(document.getElementById('node-try-result').textContent));
      await paint();                                   // 试一下 took a fresh (mock gradient) screenshot: paint the login screen again
      await save(process.env.XS_NODES_SHOT);
      // 插入到光标, then 在手机上运行 (stubbed /eval answers like the phone does)
      await b.eval(() => { const e = document.getElementById('editor'), at = e.value.indexOf('    time.sleep'); e.value = e.value.slice(0, at) + '    \n' + e.value.slice(at); e.dispatchEvent(new Event('input')); e.focus(); e.setSelectionRange(at + 4, at + 4); document.getElementById('node-insert').click(); });
      await b.eval(() => { window.__evalReply = {ok: true, result: "已点击 Node(text='登录', id='', type='Button', path='1/0/3')", error: ''}; document.getElementById('node-run').click(); });
      await b.waitFor(() => /^运行结果/.test(document.getElementById('node-try-result').textContent));
      await save(process.env.XS_NODES_SHOT.replace(/\.png$/, '-run.png'));
    });

    await t.test('the 截图 and 节点 docks replace each other', async () => {
      await b.eval(() => document.getElementById('shot-toggle').click());
      assert.deepEqual(await b.eval(() => [document.getElementById('shot-panel').hidden, document.getElementById('node-panel').hidden, document.getElementById('node-toggle').getAttribute('aria-pressed')]), [false, true, 'false']);
      await b.eval(() => document.getElementById('node-toggle').click());
      assert.deepEqual(await b.eval(() => [document.getElementById('shot-panel').hidden, document.getElementById('node-panel').hidden]), [true, false]);
    });

    await t.test('without an editable file 插入 explains instead of writing', async () => {
      const before = await b.eval(() => document.getElementById('editor').value);
      const r = await b.eval(() => {
        const e = document.getElementById('editor'); e.disabled = true; document.getElementById('node-insert').click(); e.disabled = false;
        return {msg: document.getElementById('message').textContent, error: document.getElementById('message').classList.contains('error'), value: e.value};
      });
      assert.deepEqual(r, {msg: '先打开一个 .py 文件', error: true, value: before});
    });

    await t.test('no accessibility channel: the dock says how to fix it', async () => {
      await b.eval(() => {
        const real = window.fetch;
        window.fetch = (url, opts) => String(url).startsWith('/ui-tree') ? Promise.resolve(new Response(JSON.stringify({error: 'no_channel: enable accessibility or root'}), {status: 503, headers: {'Content-Type': 'application/json'}})) : real(url, opts);
        document.getElementById('node-take').click();
      });
      await b.waitFor(() => document.getElementById('node-info').classList.contains('error'));
      const v = await b.eval(view);
      assert.match(v.info, /开启 XScript 的无障碍服务/); assert.deepEqual(v.rows, []); assert.equal(v.code, ''); assert.equal(v.insert, true);
      // one tap opens the phone's accessibility settings through /eval
      assert.deepEqual(await b.eval(() => [document.getElementById('node-a11y').hidden, document.getElementById('node-shot').hidden]), [false, true]);
      if (process.env.XS_NODES_SHOT) {
        await b.cmd('Emulation.setDeviceMetricsOverride', {width: 1280, height: 860, deviceScaleFactor: 2, mobile: false});
        await new Promise(r => setTimeout(r, 300));
        const shot = await b.cmd('Page.captureScreenshot', {format: 'png'});
        fs.writeFileSync(path.resolve(__dirname, '../..', process.env.XS_NODES_SHOT.replace(/\.png$/, '-a11y.png')), Buffer.from(shot.data, 'base64'));
        await b.cmd('Emulation.clearDeviceMetricsOverride', {});
      }
      await b.eval(() => {
        const real = window.fetch; window.__a11ySent = null;
        window.fetch = (url, opts) => String(url) === '/eval' ? (window.__a11ySent = JSON.parse(opts.body), Promise.resolve(new Response(JSON.stringify({ok: true, result: '0'}), {headers: {'Content-Type': 'application/json'}}))) : real(url, opts);
        document.getElementById('node-a11y').click();
      });
      await b.waitFor(() => /已在手机上打开无障碍设置/.test(document.getElementById('node-info').textContent));
      const a = await b.eval(() => ({code: window.__a11ySent.code, error: document.getElementById('node-info').classList.contains('error')}));
      assert.deepEqual(a, {code: 'from xscript.android import permission\n_result = permission.request(permission.ACCESSIBILITY_SERVICE, 1)', error: false});
      // 运行 whose reply lists accessibility as missing: the status line warns and offers the same one-tap fix
      await b.eval(() => {
        const real = window.fetch; window.__runA11y = null;
        window.fetch = (url, opts) => /\/projects\/[^/]+\/run$/.test(String(url)) ? Promise.resolve(new Response(JSON.stringify({ok: true, running: true, missing: [{label: '无障碍', why: '点击、滑动、输入、读取控件', where: '__init__.py:4'}]}), {headers: {'Content-Type': 'application/json'}}))
          : String(url) === '/eval' ? (window.__runA11y = JSON.parse(opts.body), Promise.resolve(new Response(JSON.stringify({ok: true, result: '0'}), {headers: {'Content-Type': 'application/json'}}))) : real(url, opts);
        document.getElementById('run').click();
      });
      await b.waitFor(() => /手机上还缺：无障碍/.test(document.getElementById('message').textContent));
      assert.deepEqual(await b.eval(() => [document.getElementById('message').classList.contains('error'), document.getElementById('run-a11y').hidden]), [true, false]);
      if (process.env.XS_NODES_SHOT) {
        await b.cmd('Emulation.setDeviceMetricsOverride', {width: 1280, height: 860, deviceScaleFactor: 2, mobile: false});
        await new Promise(r => setTimeout(r, 300));
        const shot = await b.cmd('Page.captureScreenshot', {format: 'png'});
        fs.writeFileSync(path.resolve(__dirname, '../..', process.env.XS_NODES_SHOT.replace(/ide-nodes\.png$/, 'ide-run-a11y.png')), Buffer.from(shot.data, 'base64'));
        await b.cmd('Emulation.clearDeviceMetricsOverride', {});
      }
      await b.eval(() => document.getElementById('run-a11y').click());
      await b.waitFor(() => /开启 XScript 后再运行/.test(document.getElementById('message').textContent));
      assert.deepEqual(await b.eval(() => [window.__runA11y.code, document.getElementById('run-a11y').hidden]), ['from xscript.android import permission\n_result = permission.request(permission.ACCESSIBILITY_SERVICE, 1)', true]);
      // only the overlay missing: the button names that page and opens it; screen capture asks the phone instead
      await b.eval(() => {
        const real = window.fetch; window.__runFix = [];
        window.fetch = (url, opts) => /\/projects\/[^/]+\/run$/.test(String(url)) ? Promise.resolve(new Response(JSON.stringify({ok: true, running: true, missing: window.__missing}), {headers: {'Content-Type': 'application/json'}}))
          : (String(url) === '/eval' || String(url) === '/capture/request') ? (window.__runFix.push([String(url), opts.body ? JSON.parse(opts.body).code : null]), Promise.resolve(new Response(JSON.stringify({ok: true, result: '0'}), {headers: {'Content-Type': 'application/json'}}))) : real(url, opts);
        window.__missing = [{label: '悬浮窗权限', why: '悬浮窗、浮动菜单、网页窗口', where: '__init__.py:2'}];
        document.getElementById('run').click();
      });
      await b.waitFor(() => /手机上还缺：悬浮窗权限/.test(document.getElementById('message').textContent));
      assert.deepEqual(await b.eval(() => [document.getElementById('run-a11y').hidden, document.getElementById('run-a11y').textContent]), [false, '打开手机悬浮窗设置']);
      if (process.env.XS_NODES_SHOT) {
        await b.cmd('Emulation.setDeviceMetricsOverride', {width: 1280, height: 860, deviceScaleFactor: 2, mobile: false});
        await new Promise(r => setTimeout(r, 300));
        const shot = await b.cmd('Page.captureScreenshot', {format: 'png'});
        fs.writeFileSync(path.resolve(__dirname, '../..', process.env.XS_NODES_SHOT.replace(/ide-nodes\.png$/, 'ide-run-overlay.png')), Buffer.from(shot.data, 'base64'));
        await b.cmd('Emulation.clearDeviceMetricsOverride', {});
      }
      await b.eval(() => document.getElementById('run-a11y').click());
      await b.waitFor(() => /悬浮窗设置，允许 XScript 后再运行/.test(document.getElementById('message').textContent));
      await b.eval(() => { window.__missing = [{label: '图色权限（截图）', why: '找图', where: 'a.py:1'}]; document.getElementById('run').click(); });
      await b.waitFor(() => document.getElementById('run-a11y').textContent === '在手机上授权截图' && !document.getElementById('run-a11y').hidden);
      await b.eval(() => document.getElementById('run-a11y').click());
      await b.waitFor(() => /截图授权/.test(document.getElementById('message').textContent));
      assert.deepEqual(await b.eval(() => window.__runFix), [['/eval', 'from xscript.android import permission\n_result = permission.request(permission.OVERLAY, 1)'], ['/capture/request', null]]);
    });

    assert.deepEqual(b.errors, []);
  } finally {
    if (browser) await browser.close();
    mock.child.kill();
  }
});
