/* Web IDE 节点 dock helpers (tools/editor-nodes.js): hit testing, tree rows with folding and filter, labels, selector /
 * XPath generation (same rules as the desktop inspector), import placement; the generated code is then run by the real
 * python-runtime Selector / XPath against the same tree to prove it finds the picked node. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {EditorNodes: N} = require('../../android/app/src/main/assets/tools/editor-nodes.js');

const node = (p, type, rect, kids = [], extra = {}) => Object.assign({path: p, id: '', text: '', desc: '', type, rect: {l: rect[0], t: rect[1], r: rect[2], b: rect[3]}, clickable: false, children: kids}, extra);
const QUOTE = '他说"你好"，\'欢迎\'';
const ROOTS = [node('0', 'android.widget.FrameLayout', [0, 0, 1080, 2400], [
  node('0/0', 'android.widget.LinearLayout', [0, 200, 1080, 1300], [
    node('0/0/0', 'android.widget.ImageView', [440, 300, 640, 500], [], {desc: '应用图标'}),
    node('0/0/1', 'android.widget.EditText', [80, 640, 1000, 760], [], {id: 'com.demo:id/user', hint: '请输入账号', clickable: true, editable: true}),
    node('0/0/2', 'android.widget.TextView', [80, 800, 1000, 860], [], {text: QUOTE}),
    node('0/0/3', 'android.widget.Button', [80, 980, 1000, 1110], [], {text: '登录', clickable: true}),
    node('0/0/4', 'android.view.View', [0, 1200, 1080, 1210]),
  ]),
])];
const at = p => { let hit = null; const walk = l => l.forEach(n => { if (n.path === p) hit = n; walk(n.children); }); walk(ROOTS); return hit; };

test('hitTest picks the deepest, smallest node under the point', () => {
  assert.equal(N.hitTest(ROOTS, 500, 1000).path, '0/0/3');
  assert.equal(N.hitTest(ROOTS, 10, 250).path, '0/0');
  assert.equal(N.hitTest(ROOTS, 10, 2000).path, '0');
  assert.equal(N.hitTest(ROOTS, 5000, 5000), null);
  assert.equal(N.hitTest([], 1, 1), null);
  // equal rects: the later (painted on top) one wins
  const twin = [node('a', 'X', [0, 0, 10, 10]), node('b', 'X', [0, 0, 10, 10])];
  assert.equal(N.hitTest(twin, 5, 5).path, 'b');
});

test('ancestry, count and labels', () => {
  assert.deepEqual(N.ancestry(ROOTS, at('0/0/3')).map(n => n.path), ['0', '0/0', '0/0/3']);
  assert.deepEqual(N.ancestry(ROOTS, {}), []);
  assert.equal(N.count(ROOTS), 7);
  assert.equal(N.label(at('0/0/3')), '登录');
  assert.equal(N.label(at('0/0/0')), '应用图标');
  assert.equal(N.label(at('0/0/1')), 'com.demo:id/user');
  assert.equal(N.label(at('0/0')), 'LinearLayout');
  assert.equal(N.label({}), '(无名称)');
});

test('rows fold collapsed nodes and the filter keeps matches with their ancestors open', () => {
  let r = N.rows(ROOTS);
  assert.deepEqual(r.rows.map(x => [x.node.path, x.depth]), [['0', 0], ['0/0', 1], ['0/0/0', 2], ['0/0/1', 2], ['0/0/2', 2], ['0/0/3', 2], ['0/0/4', 2]]);
  assert.equal(r.rows[0].hasChildren, true); assert.equal(r.rows[2].hasChildren, false); assert.equal(r.truncated, false);
  r = N.rows(ROOTS, {collapsed: new Set(['0/0'])});
  assert.deepEqual(r.rows.map(x => x.node.path), ['0', '0/0']); assert.equal(r.rows[1].expanded, false);
  r = N.rows(ROOTS, {filter: '  登录 ', collapsed: new Set(['0', '0/0'])});
  assert.deepEqual(r.rows.map(x => [x.node.path, x.match]), [['0', false], ['0/0', false], ['0/0/3', true]]);
  assert.deepEqual(N.rows(ROOTS, {filter: 'edittext'}).rows.map(x => x.node.path), ['0', '0/0', '0/0/1']);   // class name, any case
  assert.deepEqual(N.rows(ROOTS, {filter: '请输入'}).rows.map(x => x.node.path), ['0', '0/0', '0/0/1']);    // hint
  assert.deepEqual(N.rows(ROOTS, {filter: 'nothing'}).rows, []);
  r = N.rows(ROOTS, {limit: 3}); assert.equal(r.rows.length, 3); assert.equal(r.truncated, true);
});

test('string literals escape quotes for Python and XPath', () => {
  assert.equal(N.pyStr("a'b\\c\n"), "'a\\'b\\\\c\\n'");
  assert.equal(N.xpathStr('plain'), '"plain"');
  assert.equal(N.xpathStr('say "hi"'), "'say \"hi\"'");
  assert.equal(N.xpathStr(QUOTE), 'concat("他说", \'"\', "你好", \'"\', "，\'欢迎\'")');
});

test('selector chains match the desktop inspector rules', () => {
  assert.equal(N.selectorChain(at('0/0/1')), "node.Selector().id('com.demo:id/user').clickable()");
  assert.equal(N.selectorChain(at('0/0/3')), "node.Selector().text('登录').clickable()");
  assert.equal(N.selectorChain(at('0/0/0')), "node.Selector().desc('应用图标')");
  assert.equal(N.selectorChain(at('0/0/4'), 'xs', 1), "xs.Selector(1).type('android.view.View').path('0/0/4')");
  assert.equal(N.selectorChain({}), "node.Selector().path('0')");
  assert.equal(N.nodeXPath(at('0/0/1')), '//*[@resource-id="com.demo:id/user"]');
  assert.equal(N.nodeXPath(at('0/0/3')), '//Button[@text="登录"]');
  assert.equal(N.nodeXPath(at('0/0/0')), '//ImageView[@content-desc="应用图标"]');
  assert.equal(N.nodeXPath(at('0/0/4')), '//*[@path="0/0/4"]');
  assert.equal(N.nodeXPath({}), '//*');
});

test('snippets: find, click, exists, XPath and centre tap', () => {
  const b = at('0/0/3');
  assert.deepEqual(N.snippet(b, 'find'), {imports: ['from xscript.android import node'], code: "hit = node.Selector().text('登录').clickable().find(timeout=5)"});
  assert.equal(N.snippet(b, 'click').code, "node.Selector().text('登录').clickable().click().find(timeout=5)");
  assert.equal(N.snippet(b, 'exists').code, "if node.Selector().text('登录').clickable().exists(timeout=5):\n    pass");
  assert.equal(N.snippet(b, 'xpath').code, "hit = node.Selector(xpath='//Button[@text=\"登录\"]').find(timeout=5)");
  assert.equal(N.snippet(b, 'xpath', 1).code, "hit = node.Selector(1, xpath='//Button[@text=\"登录\"]').find(timeout=5)");
  assert.deepEqual(N.snippet(b, 'tap'), {imports: ['from xscript.android import action'], code: 'action.click(540, 1045)  # 登录'});
  assert.equal(N.snippet(b, 'nope').code, N.snippet(b, 'find').code);
  assert.equal(N.fullText(N.snippet(b)), "from xscript.android import node\nhit = node.Selector().text('登录').clickable().find(timeout=5)");
  assert.deepEqual(N.KINDS.map(k => k.id), ['find', 'click', 'exists', 'xpath', 'tap']);
});

test('importEdit adds a missing import after the leading imports, once', () => {
  const L = 'from xscript.android import node';
  assert.deepEqual(N.importEdit('', L), {at: 0, text: L + '\n'});
  assert.deepEqual(N.importEdit('x = 1\n', L), {at: 0, text: L + '\n'});
  assert.deepEqual(N.importEdit('# demo\n\nx = 1\n', L), {at: 0, text: L + '\n'});
  assert.deepEqual(N.importEdit('import time\nfrom os import path\n\nx = 1\n', L), {at: 'import time\nfrom os import path\n'.length, text: L + '\n'});
  assert.equal(N.importEdit('import time\n' + L + '\n', L), null);
  assert.equal(N.importEdit('from xscript.android import action, node\n', L), null);
  assert.equal(N.importEdit('from xscript.android import (node, action)\n', L), null);
  assert.notEqual(N.importEdit('from xscript.android import node as n\n', L), null);   // aliased: `node.` would not resolve
  assert.notEqual(N.importEdit('from xscript.android import nodes\n', L), null);
});

test('attrs and the overlay box', () => {
  const rows = Object.fromEntries(N.attrs(at('0/0/1')));
  assert.equal(rows['id'], 'com.demo:id/user'); assert.equal(rows['提示 hint'], '请输入账号');
  assert.equal(rows['范围'], '[80,640][1000,760]  920×120'); assert.equal(rows['中心'], '540, 700');
  assert.equal(rows['属性'], 'clickable=是  editable=是'); assert.equal(rows['文字 text'], undefined);
  assert.equal(Object.fromEntries(N.attrs(at('0/0')))['子节点'], '5');
  assert.deepEqual(N.boxStyle({l: 108, t: 240, r: 540, b: 1200}, 1080, 2400), {left: '10%', top: '10%', width: '40%', height: '40%'});
  assert.equal(N.boxStyle(null, 1080, 2400), null); assert.equal(N.boxStyle({l: 0, t: 0, r: 1, b: 1}, 0, 0), null);
});

test('generated code finds the picked node with the real python-runtime Selector / XPath', () => {
  const cases = [];
  for (const p of ['0/0/0', '0/0/1', '0/0/2', '0/0/3', '0/0/4']) for (const kind of ['find', 'xpath', 'click', 'exists', 'tap']) cases.push({p, kind, code: N.fullText(N.snippet(at(p), kind, 1))});
  const py = `
import json, sys
from xscript.android import node as node_mod, action as action_mod
roots = json.loads(sys.argv[1]); cases = json.loads(sys.argv[2]); out = []
node_mod.dump = lambda mode=0: {"roots": roots}
for c in cases:
    log = []
    node_mod.Node.click = lambda self, log=log: log.append(self.path) or True
    action_mod.click = lambda x, y=None, dur=20, log=log: log.append((x, y)) or True
    env = {}
    exec(c["code"], env)
    hit = env.get("hit")
    out.append({"p": c["p"], "kind": c["kind"], "hit": hit.path if hit is not None else None, "log": log})
print(json.dumps(out))
`;
  const r = spawnSync(process.env.PYTHON || 'python3', ['-c', py, JSON.stringify(ROOTS), JSON.stringify(cases)],
    {cwd: path.resolve(__dirname, '../..'), env: Object.assign({}, process.env, {PYTHONPATH: path.resolve(__dirname, '../../android/python-runtime')}), encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  for (const o of JSON.parse(r.stdout)) {
    const n = at(o.p), c = N.center(n.rect);
    if (o.kind === 'find' || o.kind === 'xpath') assert.equal(o.hit, o.p, o.kind + ' ' + o.p);
    if (o.kind === 'click') assert.deepEqual(o.log, [o.p], 'click ' + o.p);
    if (o.kind === 'tap') assert.deepEqual(o.log, [[c.x, c.y]], 'tap ' + o.p);
  }
});
