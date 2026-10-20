/* WebSelector's in-page JS (android/python-runtime/ascript/android/_websel_js.py) in headless Chrome:
 * exact / regex matching, innermost text, child / brother / parent indexes, click, input, long_click.
 * Skipped when no local Chrome is found ($CHROME or ~/.cache/puppeteer). */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cdp = require('./cdp.cjs');

const CHROME = cdp.find();
const SRC = fs.readFileSync(path.resolve(__dirname, '../../android/python-runtime/ascript/android/_websel_js.py'), 'utf8');
const JS = SRC.match(/JS = r"""([\s\S]*?)"""/)[1];

const PAGE = `<!doctype html><meta charset="utf-8"><body>
<div id="nav" class="bar"><a href="/a">首页</a><a href="/docs" class="cur">AScript 文档</a><a href="/b">下载</a><a href="/c">社区</a></div>
<form id="f"><input id="user" value="请输入账号"><input id="pwd" type="password" value="">
<select id="s"><option value="1">一</option><option value="2" selected>二</option></select>
<button id="go" type="button"><span>登录</span></button></form>
<ul id="list"><li>1</li><li>2</li><li>3</li><li>4</li><li>5</li></ul>
<script>
window.log = [];
document.getElementById('go').addEventListener('click', () => log.push('click'));
document.getElementById('user').addEventListener('input', e => log.push('input:' + e.target.value));
document.getElementById('user').addEventListener('change', () => log.push('change'));
document.getElementById('go').addEventListener('contextmenu', () => log.push('long'));
</script></body>`;

test('WebSelector JS in headless Chrome', {skip: CHROME ? false : 'no Chrome'}, async t => {
  const b = await cdp.launch(CHROME);
  try {
    await b.goto('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
    await b.eval(code => { (0, eval)(code); (0, eval)(code); return true; }, JS);  // injected twice: idempotent
    const q = (spec) => b.eval(s => window.__xsWeb.query(Object.assign({base: null, steps: [], actions: [], limit: 0}, s)), spec);
    const S = s => ({s}), R = (re, flags = '') => ({re, flags});
    const tags = rows => rows.map(r => r.tag + (r.attrs.id ? '#' + r.attrs.id : '') + (r.text && r.tag !== 'ul' && r.tag !== 'div' && r.tag !== 'form' ? ':' + r.text : ''));

    await t.test('tag, exact text and attr', async () => {
      assert.equal((await q({steps: [{k: 'tag', m: S('a')}]})).length, 4);
      const [doc] = await q({steps: [{k: 'tag', m: S('a')}, {k: 'text', m: S('AScript 文档')}]});
      assert.deepEqual([doc.tag, doc.text, doc.attrs.href, doc.attrs.class], ['a', 'AScript 文档', '/docs', 'cur']);
      assert.equal(doc.bounds.length, 4);
      assert.ok(doc.bounds[2] > doc.bounds[0] && doc.bounds[3] > doc.bounds[1]);
      assert.equal((await q({steps: [{k: 'attr', key: 'href', m: R('^/[ab]$')}]})).length, 2);
      assert.equal((await q({steps: [{k: 'attr', key: 'nope', m: S('')}]})).length, 0);
    });

    await t.test('regex text keeps the innermost element', async () => {
      const rows = await q({steps: [{k: 'text', m: R('登')}]});
      assert.deepEqual(tags(rows), ['span:登录']);
      assert.equal((await q({steps: [{k: 'text', m: R('[', '')}]})).length, 0);  // bad regex -> no match, no throw
    });

    await t.test('value matches inputs and selects', async () => {
      assert.deepEqual(tags(await q({steps: [{k: 'value', m: S('请输入账号')}]})), ['input#user']);
      assert.deepEqual(tags(await q({steps: [{k: 'tag', m: S('select')}, {k: 'value', m: S('2')}]})).map(x => x.split(':')[0]), ['select#s']);
    });

    await t.test('child indexes, negative and ranges', async () => {
      const list = [{k: 'attr', key: 'id', m: S('list')}];
      const kids = async (...args) => (await q({steps: [...list, {k: 'child', args}]})).map(r => r.text);
      assert.deepEqual(await kids(), ['1', '2', '3', '4', '5']);
      assert.deepEqual(await kids(1), ['1']);
      assert.deepEqual(await kids(-1), ['5']);
      assert.deepEqual(await kids(1, 3), ['1', '3']);
      assert.deepEqual(await kids(2.4), ['2', '3', '4']);
      assert.deepEqual(await kids(-1.2), ['5', '4']);
      assert.deepEqual(await kids(9), []);
    });

    await t.test('brother: all, nth, next/previous, last', async () => {
      const doc = [{k: 'attr', key: 'href', m: S('/docs')}];
      const bro = async (...args) => (await q({steps: [...doc, {k: 'brother', args}]})).map(r => r.text);
      assert.deepEqual(await bro(), ['首页', '下载', '社区']);
      assert.deepEqual(await bro(1), ['首页']);
      assert.deepEqual(await bro(0.1), ['下载']);
      assert.deepEqual(await bro(-0.1), ['首页']);
      assert.deepEqual(await bro(0.2), ['社区']);
      assert.deepEqual(await bro(-1), ['社区']);
    });

    await t.test('parent: all ancestors and nth', async () => {
      const span = [{k: 'tag', m: S('span')}];
      assert.deepEqual((await q({steps: [...span, {k: 'parent', args: []}]})).map(r => r.tag), ['button', 'form', 'body', 'html']);
      assert.deepEqual((await q({steps: [...span, {k: 'parent', args: [2]}]})).map(r => r.tag), ['form']);
      assert.deepEqual((await q({steps: [...span, {k: 'parent', args: [1, 3]}]})).map(r => r.tag), ['button', 'body']);
    });

    await t.test('limit and base ids (WebNode re-query)', async () => {
      const [first] = await q({steps: [{k: 'tag', m: S('li')}], limit: 1});
      assert.equal(first.text, '1');
      const again = await q({steps: [{k: 'tag', m: S('li')}], limit: 1});
      assert.equal(again[0].id, first.id);  // stable ids
      const sib = await q({base: [first.id], steps: [{k: 'brother', args: [0.1]}]});
      assert.equal(sib[0].text, '2');
      assert.deepEqual(await q({base: [99999], steps: []}), []);
    });

    await t.test('click, input (input + change events) and long_click', async () => {
      await q({steps: [{k: 'attr', key: 'id', m: S('go')}], actions: [{k: 'click'}]});
      const rows = await q({steps: [{k: 'attr', key: 'id', m: S('user')}], actions: [{k: 'input', arg: 'tom'}]});
      assert.equal(rows[0].value, 'tom');
      await q({steps: [{k: 'attr', key: 'id', m: S('go')}], actions: [{k: 'long_click'}]});
      await b.waitFor(() => window.log.includes('long'), 3000);
      assert.deepEqual(await b.eval(() => window.log), ['click', 'input:tom', 'change', 'long']);
    });
  } finally {
    await b.close();
  }
});
