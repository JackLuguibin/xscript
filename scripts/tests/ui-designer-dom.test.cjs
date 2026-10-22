/* Web IDE UI designer (tools/ui-designer.js in editor.js) in headless Chrome against scripts/mock_device.py:
 * a res/ui/<name>.ui.json opens in the designer, adding / editing / reordering fields edits the document, the
 * preview follows, 文本 shows the JSON, and saving writes res/ui/<name>.html + ui_<name>.py.
 * Skipped when no local Chrome is found ($CHROME or ~/.cache/puppeteer). */
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

const SPEC = {version: 1, title: '设置', submit: '开始', cancel: '取消', width: '85vw', height: '60vh',
  fields: [{kind: 'text', id: 'name', label: '名称', default: ''}, {kind: 'number', id: 'rounds', label: '次数', default: 3}]};

test('Web IDE UI designer edits a form spec and saving generates the code', {skip: CHROME ? false : 'no local Chrome (set $CHROME or install puppeteer browsers)', timeout: 60000 + cdp.LAUNCH_BUDGET_MS}, async t => {
  const mock = startMock();
  let browser;
  try {
    const base = 'http://127.0.0.1:' + await mock.port;
    const api = async (method, url, body) => {
      const r = await fetch(base + url, {method, headers: {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
      const data = await r.json(); if (!r.ok) throw Error(data.error); return data;
    };
    await api('POST', '/projects/uid', {});
    await api('PUT', '/projects/uid/files', {files: [{path: 'res/ui/main.ui.json', content: JSON.stringify(SPEC, null, 2) + '\n'}]});
    browser = await cdp.launch(CHROME);
    const b = browser;
    await b.goto(base + '/tools/ui/editor.html?project=uid');
    await b.waitFor(() => !document.getElementById('new-file').disabled);
    await b.waitFor(() => !!document.querySelector('#files .tree-row[data-path="res"]'));
    await b.eval(() => { const r = document.querySelector('#files .tree-row[data-path="res"]'); r.click(); });
    await b.waitFor(() => !!document.querySelector('#files .tree-row[data-path="res/ui"]'));
    await b.eval(() => document.querySelector('#files .tree-row[data-path="res/ui"]').click());
    await b.waitFor(() => !!document.querySelector('#files .tree-row[data-path="res/ui/main.ui.json"]'));
    await b.eval(() => document.querySelector('#files .tree-row[data-path="res/ui/main.ui.json"]').click());
    await b.waitFor(() => !document.getElementById('ui-designer').hidden && document.querySelectorAll('#ui-designer .item').length === 2);

    await t.test('opens in the designer with the shared view in Chinese', async () => {
      const s = await b.eval(() => ({
        editArea: document.querySelector('.ide-edit-area').hidden, mode: document.getElementById('ui-mode').textContent,
        heads: [...document.querySelectorAll('#ui-designer h4')].map(h => h.textContent),
        kinds: [...document.querySelectorAll('#ui-designer .pal button')].map(x => x.dataset.kind),
        preview: document.querySelector('#ui-designer iframe').srcdoc,
      }));
      assert.equal(s.editArea, true); assert.equal(s.mode, '文本');
      assert.deepEqual(s.heads.slice(0, 2), ['控件', '表单']);
      assert.equal(s.kinds.length, 8);
      assert.match(s.preview, /<h3>设置<\/h3>/);
    });

    await t.test('adding, editing and reordering fields edits the document', async () => {
      await b.eval(() => document.querySelector('#ui-designer .pal button[data-kind="checkbox"]').click());
      let st = await b.eval(() => ({items: [...document.querySelectorAll('#ui-designer .item .t')].map(x => x.textContent),
        save: document.getElementById('save').disabled, json: JSON.parse(document.getElementById('editor').value)}));
      assert.equal(st.items.length, 3); assert.equal(st.save, false);
      assert.deepEqual(st.json.fields.map(f => f.kind), ['text', 'number', 'checkbox']);
      // rename the selected field's label through the properties panel
      await b.eval(() => { const i = document.querySelector('#ui-designer .props input'); i.value = '循环'; i.dispatchEvent(new Event('change')); });
      // move it to the top with ↑ twice
      for (let n = 0; n < 2; n++) await b.eval(() => document.querySelector('#ui-designer .item.sel button[aria-label="上移"]').click());
      st = await b.eval(() => ({json: JSON.parse(document.getElementById('editor').value), preview: document.querySelector('#ui-designer iframe').srcdoc}));
      assert.deepEqual(st.json.fields.map(f => f.label), ['循环', '名称', '次数']);
      assert.match(st.preview, /循环/);
    });

    await t.test('文本 shows the JSON; invalid ids show an error', async () => {
      await b.eval(() => document.getElementById('ui-mode').click());
      let s = await b.eval(() => ({area: document.querySelector('.ide-edit-area').hidden, designer: document.getElementById('ui-designer').hidden, mode: document.getElementById('ui-mode').textContent}));
      assert.deepEqual(s, {area: false, designer: true, mode: '设计'});
      await b.eval(() => document.getElementById('ui-mode').click());
      await b.eval(() => { const i = [...document.querySelectorAll('#ui-designer .props label')].find(l => l.textContent.startsWith('返回字典里的键')).querySelector('input'); i.value = 'class'; i.dispatchEvent(new Event('change')); });
      s = await b.eval(() => document.querySelector('#ui-designer .errors')?.textContent || '');
      assert.match(s, /Python identifier/);
      await b.eval(() => { const i = [...document.querySelectorAll('#ui-designer .props label')].find(l => l.textContent.startsWith('返回字典里的键')).querySelector('input'); i.value = 'loop'; i.dispatchEvent(new Event('change')); });
    });

    await t.test('saving writes res/ui/main.html and ui_main.py', async () => {
      await b.eval(() => document.getElementById('save').click());
      await b.waitFor(() => /已生成/.test(document.getElementById('message').textContent));
      const page = (await api('GET', '/projects/uid/file?path=' + encodeURIComponent('res/ui/main.html'))).content;
      const mod = (await api('GET', '/projects/uid/file?path=ui_main.py')).content;
      assert.match(page, /data-key="loop"/); assert.match(mod, /"loop": bool/);
      await b.waitFor(() => !!document.querySelector('#files .tree-row[data-path="ui_main.py"]'));
    });
  } finally {
    if (browser) await browser.close();
    mock.child.kill();
  }
});
