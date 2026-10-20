const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {EditorComplete} = require('../../android/app/src/main/assets/tools/editor-complete.js');
const {XSApi} = require('../../android/app/src/main/assets/tools/editor-api.js');
const {XSDocs} = require('../../android/app/src/main/assets/tools/editor-docs.js');
const C = new EditorComplete(XSApi, XSDocs);
// suggest at the "|" marker
const at = (src, opts) => { const pos = src.indexOf('|'); const r = C.suggest(src.replace('|', ''), pos, opts); return r && {...r, labels: r.items.map(i => i.label)}; };

test('generated API index covers xscript and ascript and has signatures and docs', () => {
  assert.ok(Object.keys(XSApi.modules).length > 30);
  assert.ok(XSApi.modules['xscript.android.action']);
  assert.ok(XSApi.modules['ascript.android.screen']);
  const click = XSApi.modules['xscript.android.action'].m.click;
  assert.equal(click.k, 'f'); assert.match(click.s, /^\(/);
  assert.ok(!Object.keys(XSApi.modules).some(k => /(^|\.)(runtime|_)/.test(k)), 'no runtime/private modules');
});
test('the generated file is current (gen_completions.py --check)', () => {
  const root = path.join(__dirname, '..', '..');
  const venv = ['.venv-rt', '.venv'].map(d => path.join(root, d, 'bin', 'python')).find(p => fs.existsSync(p));
  const r = spawnSync(venv || 'python3', [path.join(root, 'scripts', 'gen_completions.py'), '--check'], {encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr + r.stdout);
});
test('module attribute completion after an import alias', () => {
  const r = at('from xscript.android import action\naction.cl|');
  assert.ok(r.labels.includes('click')); assert.equal(r.from, r.to - 2);
  assert.ok(r.items.find(i => i.label === 'click').detail.startsWith('('));
});
test('import paths complete module segments', () => {
  assert.ok(at('import xscript.android.sc|').labels.includes('screen'));
  assert.ok(at('import xs|').labels.includes('xscript'));
  assert.ok(at('from ascript.android import |', {force: true}).labels.includes('action'));
});
test('from X import completes members of the module', () => {
  const r = at('from xscript.android.action import |');
  assert.ok(r.labels.includes('click'));
  const r2 = at('from xscript.android.action import click, sw|');
  assert.ok(r2.labels.includes('swipe'));
});
test('classes: instance members follow x = Class(...)', () => {
  const cls = Object.entries(XSApi.modules).flatMap(([mod, v]) => Object.entries(v.m).filter(([, m]) => m.k === 'c' && m.m && Object.keys(m.m).length).map(([n, m]) => ({mod, n, m})))[0];
  const member = Object.keys(cls.m.m).find(k => !k.startsWith('_')) || Object.keys(cls.m.m)[0];
  const src = `from ${cls.mod} import ${cls.n}\nobj = ${cls.n}()\nobj.${member.slice(0, 2)}|`;
  assert.ok(at(src).labels.includes(member), member);
});
test('names in scope, builtins, keywords and file words', () => {
  const r = at('import os\ndef helper_function(): pass\nvalue_one = 1\nhel|');
  assert.equal(r.labels[0], 'helper_function');
  assert.ok(at('pri|').labels.includes('print'));
  assert.ok(at('whi|').labels.includes('while'));
  assert.ok(at('x = my_long_identifier\nmy_|').labels.includes('my_long_identifier'));
});
test('no popup inside strings, comments, numbers or after unknown values', () => {
  assert.equal(at('x = "act|'), null);
  assert.equal(at('# print|'), null);
  assert.equal(at('s = """\nprin|\n"""'), null);
  assert.equal(at('x = 12|'), null);
  assert.equal(at('foo().ba|'), null);
  assert.equal(at('unknown.attr|'), null);
  assert.equal(at('x = 1\n|'), null, 'nothing typed, nothing suggested');
});
test('the typed word itself is not suggested; ranking prefers prefix matches', () => {
  const r = at('prin|'); assert.ok(!r.labels.includes('prin')); assert.equal(r.labels[0], 'print');
});
test('huge files and bad positions are ignored', () => {
  assert.equal(C.suggest('x'.repeat(500000), 10), null);
  assert.equal(C.suggest('abc', 99), null);
});
test('every module and member in the index can be reached by completion (smoke)', () => {
  for (const [mod, v] of Object.entries(XSApi.modules)) {
    const alias = 'm_' + Math.abs([...mod].reduce((h, c) => h * 31 + c.charCodeAt(0) | 0, 7));
    const names = Object.keys(v.m); if (!names.length) continue;
    const src = `import ${mod} as ${alias}\n${alias}.|`;
    const r = at(src);
    assert.ok(r && names.every(n => r.labels.includes(n)), mod);
  }
});

// ---- hover docs and signature help (editor-docs.js from ide/python-stubs) ----
const hover = src => { const pos = src.indexOf('|'); return C.symbolAt(src.replace('|', ''), pos); };
const sig = src => { const pos = src.indexOf('|'); return C.callAt(src.replace('|', ''), pos); };

test('editor-docs.js is current (gen_editor_docs.py --check) and has signatures and full docstrings from the stubs', () => {
  const root = path.join(__dirname, '..', '..');
  const venv = ['.venv-rt', '.venv'].map(d => path.join(root, d, 'bin', 'python')).find(p => fs.existsSync(p));
  const r = spawnSync(venv || 'python3', [path.join(root, 'scripts', 'gen_editor_docs.py'), '--check'], {encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(XSDocs['xscript.android.action.click'].slice(0, 1), ['(x, y=None, dur=20)']);
  assert.match(XSDocs['xscript.android.action.gesture'][1], /\n/, 'multi-line docstring kept whole');
  assert.equal(XSDocs['xscript.android.action'][0], '');                       // a module: doc only
  assert.ok(XSDocs['xscript.android.action.Touch.down'], 'class members');
  assert.ok(!Object.keys(XSDocs).some(k => /(^|\.)(_|runtime\b)/.test(k)), 'no private / runtime names');
});
test('hover: module members, aliases, from-imports, instances, module paths; nothing in strings or comments', () => {
  let h = hover('from xscript.android import action\naction.cli|ck(1, 2)');
  assert.equal(h.key, 'xscript.android.action.click'); assert.equal(h.label, 'click'); assert.equal(h.sig, '(x, y=None, dur=20)');
  assert.match(h.doc, /^Tap/);
  assert.equal(hover('from xscript.android import action as a\na.cli|ck(1)').key, 'xscript.android.action.click');
  assert.equal(hover('from xscript.android import act|ion').key, 'xscript.android.action');
  assert.equal(hover('from xscript.android.action import cl|ick').key, 'xscript.android.action.click');
  assert.equal(hover('import xscript.android.act|ion').key, 'xscript.android.action');
  assert.equal(hover('from xscript.android import act|ion\n').key, 'xscript.android.action');
  assert.equal(hover('from xscript.android import action\nact|ion.click').key, 'xscript.android.action', 'the word under the pointer, not the whole chain');
  assert.equal(hover('import xscript.android.action\nxscript.android.action.cl|ick(1, 2)').key, 'xscript.android.action.click');
  assert.equal(hover('from xscript.android.action import Touch\nTouch.do|wn(1, 2)').key, 'xscript.android.action.Touch.down');
  assert.equal(hover('from xscript.android import action\nx = "action.cl|ick"'), null);
  assert.equal(hover('from xscript.android import action\n# action.cl|ick'), null);
  assert.equal(hover('pri|nt(1)'), null);
  assert.equal(hover('x = 12|3'), null);
});
test('signature help: active parameter by position, keyword and *args; nested and unknown calls; strings', () => {
  let s = sig('from xscript.android import action\naction.click(|');
  assert.equal(s.key, 'xscript.android.action.click'); assert.equal(s.index, 0); assert.equal(s.active, 0);
  assert.equal(sig('from xscript.android import action\naction.click(1, |').active, 1);
  s = sig('from xscript.android import action\naction.click(1, dur=|');
  assert.equal(s.keyword, 'dur'); assert.equal(EditorComplete.params(s.sig)[s.active].name, 'dur');
  assert.equal(sig('from xscript.android import action\naction.click((1, 2), |').active, 1, 'commas inside a tuple do not count');
  assert.equal(sig('from xscript.android import action\naction.click(str(1|').key, 'xscript.android.action.click', 'unknown inner call: the outer one');
  assert.equal(sig('from xscript.android import action\naction.click(1, "a,|'), null, 'inside a string');
  assert.equal(sig('from xscript.android import action\naction.click(1, 2)|'), null, 'after the call');
  assert.equal(sig('from xscript.android import action\naction.click(\n    1,\n    |').active, 1, 'multi-line call');
  assert.equal(sig('print(|'), null);
  assert.equal(sig('from xscript.android import action\n# action.click(|'), null);
});
test('params splits signatures with offsets; *args absorbs extra positionals; keyword-only after *', () => {
  const sigText = "(x, y=(1, 2), *args, k='a,b', **kw) -> R";
  const ps = EditorComplete.params(sigText);
  assert.deepEqual(ps.map(p => p.text), ['x', 'y=(1, 2)', '*args', "k='a,b'", '**kw']);
  for (const p of ps) assert.equal(sigText.slice(p.start, p.end), p.text);
  assert.deepEqual(ps.map(p => p.kwOnly), [false, false, false, true, false]);
  assert.deepEqual(EditorComplete.params('()'), []);
  const C2 = new EditorComplete({modules: {m: {d: '', m: {f: {k: 'f', s: '(a, *rest)', d: ''}}}}}, {'m.f': ['(a, *rest)', ''], m: ['', '']});
  const r = C2.callAt('from m import f\nf(1, 2, 3, |', 'from m import f\nf(1, 2, 3, '.length);
  assert.equal(EditorComplete.params(r.sig)[r.active].name, 'rest');
});
