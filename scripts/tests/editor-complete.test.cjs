const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {EditorComplete} = require('../../android/app/src/main/assets/tools/editor-complete.js');
const {XSApi} = require('../../android/app/src/main/assets/tools/editor-api.js');
const C = new EditorComplete(XSApi);
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
