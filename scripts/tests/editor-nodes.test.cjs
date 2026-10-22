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

const runPy = (roots, cases) => {
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
  const r = spawnSync(process.env.PYTHON || 'python3', ['-c', py, JSON.stringify(roots), JSON.stringify(cases)],
    {cwd: path.resolve(__dirname, '../..'), env: Object.assign({}, process.env, {PYTHONPATH: path.resolve(__dirname, '../../android/python-runtime')}), encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

// A settings-style list: every row's title shares one resource id, two rows even share their text.
const LIST = [node('0', 'android.widget.FrameLayout', [0, 0, 1080, 2400], [
  node('0/0', 'android.widget.TextView', [0, 100, 1080, 200], [], {id: 'android:id/title', text: 'Network & internet'}),
  node('0/1', 'android.widget.TextView', [0, 200, 1080, 300], [], {id: 'android:id/title', text: 'Apps'}),
  node('0/2', 'android.widget.TextView', [0, 300, 1080, 400], [], {id: 'android:id/title', text: 'Battery'}),
  node('0/3', 'android.widget.TextView', [0, 400, 1080, 500], [], {id: 'android:id/title', text: 'Battery'}),
  node('0/4', 'android.widget.ImageView', [0, 500, 100, 600], [], {id: 'android:id/icon', desc: 'Wi-Fi'}),
  node('0/5', 'android.widget.ImageView', [100, 500, 200, 600], [], {id: 'android:id/icon', desc: 'Bluetooth'}),
  node('0/6', 'android.widget.Button', [0, 700, 1080, 800], [], {id: 'com.demo:id/ok', text: 'OK', clickable: true}),
])];
const atIn = (roots, p) => { let hit = null; const walk = l => l.forEach(n => { if (n.path === p) hit = n; walk(n.children); }); walk(roots); return hit; };

test('a resource id shared by several nodes gets text / desc / path added until the selector is unique', () => {
  const sel = p => N.selectorChain(atIn(LIST, p), 'node', 0, LIST);
  assert.equal(sel('0/1'), "node.Selector().id('android:id/title').text('Apps')");
  assert.equal(sel('0/3'), "node.Selector().id('android:id/title').text('Battery').path('0/3')");
  assert.equal(sel('0/5'), "node.Selector().id('android:id/icon').desc('Bluetooth')");
  assert.equal(sel('0/6'), "node.Selector().id('com.demo:id/ok').clickable()", 'a unique id stays alone');
  assert.equal(N.selectorChain(atIn(LIST, '0/1')), "node.Selector().id('android:id/title')", 'no tree: unchanged');
  const xp = p => N.nodeXPath(atIn(LIST, p), LIST);
  assert.equal(xp('0/1'), '//*[@resource-id="android:id/title"][@text="Apps"]');
  assert.equal(xp('0/3'), '//*[@resource-id="android:id/title"][@text="Battery"][@path="0/3"]');
  assert.equal(xp('0/6'), '//*[@resource-id="com.demo:id/ok"]');
  // code that only the path can pin says so; a unique id / text does not
  assert.equal(N.snippet(atIn(LIST, '0/3'), 'find', 0, LIST).code, N.FRAGILE + "hit = node.Selector().id('android:id/title').text('Battery').path('0/3').find(timeout=5)");
  assert.equal(N.snippet(atIn(LIST, '0/3'), 'exists', 0, LIST).code, N.FRAGILE + "if node.Selector().id('android:id/title').text('Battery').path('0/3').exists(timeout=5):\n    pass");
  assert.ok(N.snippet(atIn(LIST, '0/3'), 'xpath', 0, LIST).code.startsWith(N.FRAGILE));
  assert.ok(!N.snippet(atIn(LIST, '0/1'), 'find', 0, LIST).code.includes('#'));
  const CLOCKS = [node('0', 'android.widget.FrameLayout', [0, 0, 1080, 130], [
    node('0/0', 'android.widget.TextView', [50, 1, 136, 128], [], {id: 'com.android.systemui:id/clock', text: '1:57', desc: '1:57 AM'}),
    node('0/1', 'android.widget.TextView', [500, 1, 600, 128], [], {id: 'com.android.systemui:id/clock', text: '1:57', desc: '1:57 AM'}),
  ])];
  assert.equal(N.selectorChain(atIn(CLOCKS, '0/1'), 'node', 0, CLOCKS), "node.Selector().id('com.android.systemui:id/clock').path('0/1')", 'clock text is never used');
  const cases = [];
  for (const p of ['0/0', '0/1', '0/2', '0/3', '0/4', '0/5', '0/6']) for (const kind of ['find', 'xpath', 'click'])
    cases.push({p, kind, code: N.fullText(N.snippet(atIn(LIST, p), kind, 1, LIST))});
  for (const o of runPy(LIST, cases)) {
    if (o.kind === 'click') assert.deepEqual(o.log, [o.p], 'click ' + o.p);
    else assert.equal(o.hit, o.p, o.kind + ' ' + o.p);
  }
});

test('试一下 code lists every match on the phone without acting, and the verdict reads it', () => {
  const at = p => atIn(LIST, p);
  assert.equal(N.tryCode(at('0/3'), 'tap'), null);
  const cases = [];
  for (const p of ['0/1', '0/3', '0/6']) for (const kind of ['find', 'click', 'exists', 'xpath']) cases.push({p, kind, code: N.tryCode(at(p), kind, 0, LIST)});
  for (const c of cases) assert.ok(!/\.click\(\)|\.input\(|\.scroll\(/.test(c.code), c.code);
  cases.push({p: '0/3', kind: 'id-only', code: N.tryCode(at('0/3'), 'find')});   // without the tree: the id alone, every row matches
  const py = `
import json, sys
from xscript.android import node as node_mod
roots = json.loads(sys.argv[1]); cases = json.loads(sys.argv[2]); out = []
node_mod.dump = lambda mode=0: {"roots": roots}
node_mod.Node.click = lambda self: (_ for _ in ()).throw(AssertionError("clicked"))
for c in cases:
    env = {}
    exec(c["code"], env)
    out.append(env["_result"])
print(json.dumps(out))
`;
  const r = spawnSync(process.env.PYTHON || 'python3', ['-c', py, JSON.stringify(LIST), JSON.stringify(cases)],
    {env: Object.assign({}, process.env, {PYTHONPATH: path.resolve(__dirname, '../../android/python-runtime')}), encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  cases.forEach((c, i) => {
    if (c.kind === 'id-only') {
      assert.deepEqual(out[i].map(h => h[0]), ['0/0', '0/1', '0/2', '0/3']);
      assert.equal(N.tryVerdict(JSON.stringify(out[i]), at('0/3')).text, '试一下：找到 4 个，第一个不是选中的节点（路径 0/0）');
    } else {
      assert.deepEqual(out[i].map(h => h[0]), [c.p], c.kind + ' ' + c.p);
      assert.deepEqual(N.tryVerdict(JSON.stringify(out[i]), at(c.p)), {ok: true, hits: [{path: c.p, rect: at(c.p).rect ? {l: at(c.p).rect.l, t: at(c.p).rect.t, r: at(c.p).rect.r, b: at(c.p).rect.b} : {l: 0, t: 0, r: 0, b: 0}}], text: '试一下：找到 1 个，就是选中的节点'});
    }
  });
  assert.equal(N.tryVerdict('[]', at('0/1')).ok, false);
  assert.equal(N.tryVerdict('not json', at('0/1')).text, '试一下：没找到。界面可能变了，点「重新获取」再试');
  const twenty = JSON.stringify(Array.from({length: 20}, () => ['0/1', 0, 0, 1, 1]));
  assert.equal(N.tryVerdict(twenty, at('0/1')).text, '试一下：找到 20 个及以上，第一个是选中的节点（.find 用第一个）');
});

test('在手机上运行 code really runs the inserted snippet and answers in _result', () => {
  const at = p => atIn(LIST, p);
  const cases = [];
  for (const kind of ['find', 'xpath', 'click', 'exists', 'tap']) cases.push({p: '0/1', kind, code: N.runCode(at('0/1'), kind, 0, LIST)});
  cases.push({p: '0/3', kind: 'click', code: N.runCode(at('0/3'), 'click', 0, LIST)});                       // with the path warning above
  const gone = Object.assign({}, at('0/1'), {text: 'Gone', id: 'com.demo:id/gone'});
  for (const kind of ['find', 'exists']) cases.push({p: 'gone', kind, code: N.runCode(gone, kind).replace(/timeout=5/g, 'timeout=0')});
  const py = `
import json, sys
from xscript.android import node as node_mod, action as action_mod
roots = json.loads(sys.argv[1]); cases = json.loads(sys.argv[2]); out = []
node_mod.dump = lambda mode=0: {"roots": roots}
for c in cases:
    log = []
    node_mod.Node.click = lambda self, log=log: log.append(self.path) or True
    action_mod.click = lambda x, y=None, dur=20, log=log: log.append([x, y]) or True
    env = {"_result": None}
    exec(c["code"], env)
    out.append([env["_result"], log])
print(json.dumps(out, ensure_ascii=False))
`;
  const r = spawnSync(process.env.PYTHON || 'python3', ['-c', py, JSON.stringify(LIST), JSON.stringify(cases)],
    {env: Object.assign({}, process.env, {PYTHONPATH: path.resolve(__dirname, '../../android/python-runtime')}), encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const nodeRepr = "Node(text='Apps', id='android:id/title', type='TextView', path='0/1')";
  assert.deepEqual(out, [
    ['找到 ' + nodeRepr, []], ['找到 ' + nodeRepr, []], ['已点击 ' + nodeRepr, ['0/1']], ['条件成立：找到了', []],
    ['已点击坐标', [[540, 250]]],
    ["已点击 Node(text='Battery', id='android:id/title', type='TextView', path='0/3')", ['0/3']],
    ['没找到（5 秒内）', []], ['条件不成立：5 秒内没找到', []],
  ]);
});

test('最近选过: newest first without duplicates, found again by path or (if it moved) by its values', () => {
  const at = p => atIn(LIST, p);
  let list = [];
  for (const p of ['0/1', '0/2', '0/1', '0/6']) list = N.pushRecent(list, N.recentEntry(at(p)));
  assert.deepEqual(list.map(e => e.path), ['0/6', '0/1', '0/2']);
  assert.deepEqual(N.recentEntry(at('0/5')), {path: '0/5', id: 'android:id/icon', text: '', desc: 'Bluetooth', type: 'android.widget.ImageView', label: 'Bluetooth'});
  for (let i = 0; i < 12; i++) list = N.pushRecent(list, {path: 'x/' + i, id: '', text: 't' + i, desc: '', type: '', label: 't' + i});
  assert.equal(list.length, 8);
  assert.equal(N.findRecent(LIST, N.recentEntry(at('0/1'))), at('0/1'));
  // moved: another path, same values, only one such node → found
  assert.equal(N.findRecent(LIST, Object.assign(N.recentEntry(at('0/1')), {path: '7/7'})), at('0/1'));
  // moved, but two rows look like it (Battery twice) → not guessed
  assert.equal(N.findRecent(LIST, Object.assign(N.recentEntry(at('0/3')), {path: '7/7'})), null);
  // a bare layout node is only known by its path
  assert.equal(N.findRecent(LIST, {path: '7/7', id: '', text: '', desc: '', type: 'android.widget.FrameLayout', label: 'FrameLayout'}), null);
  assert.equal(N.findRecent(LIST, {path: '0', id: '', text: '', desc: '', type: 'android.widget.FrameLayout', label: 'FrameLayout'}), LIST[0]);
  assert.equal(N.findRecent(LIST, {path: '0/1', id: 'android:id/title', text: 'Gone', desc: '', type: 'android.widget.TextView', label: 'Gone'}), null);
});

test('a node only its path can pin gets a stable child or parent to switch to, never a sibling', () => {
  const T = [node('0', 'android.widget.FrameLayout', [0, 0, 1080, 2400], [
    node('0/0', 'android.widget.LinearLayout', [0, 0, 1080, 200], [                       // a list row: no id, no text
      node('0/0/0', 'android.widget.ImageView', [0, 0, 100, 200]),
      node('0/0/1', 'android.widget.RelativeLayout', [100, 0, 1080, 200], [node('0/0/1/0', 'android.widget.TextView', [100, 0, 1080, 100], [], {text: 'Display'})]),
    ], {clickable: true}),
    node('0/1', 'android.widget.Button', [0, 300, 200, 400], [node('0/1/0', 'android.widget.ImageView', [0, 300, 200, 400])], {id: 'com.demo:id/share', clickable: true}),
    node('0/2', 'android.widget.TextView', [0, 500, 1080, 600], [], {text: 'Same'}),
    node('0/3', 'android.widget.TextView', [0, 600, 1080, 700], [], {text: 'Same'}),
  ])];
  const alt = p => { const r = N.stableAlternative(atIn(T, p), T); return r && r.rel + ' ' + r.node.path; };
  assert.equal(alt('0/0'), '子节点 0/0/1/0', 'the row: its title, two levels down');
  assert.equal(alt('0/1/0'), '父节点 0/1', 'the icon: the button around it');
  assert.equal(alt('0/3'), null, 'a duplicated text: the other one is a sibling, not offered');
  assert.equal(alt('0/1'), null, 'already stable');
  assert.equal(N.stableAlternative(atIn(T, '0/0')), null, 'no tree: nothing to compare');
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
