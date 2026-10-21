const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const FILE = path.join(__dirname, '../../android/app/src/main/assets/tools/editor-parse.js');
const {EditorParse} = require(FILE);
const ROOT = path.join(__dirname, '../..');

test('error lines match CPython ast.parse on the fixture samples', () => {
  // fixtures/python-syntax.json is checked against CPython by test_python_syntax.py
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/python-syntax.json'), 'utf8'));
  const bad = [];
  for (const c of cases) {
    const r = EditorParse.parse(c.src);
    const line = r.error ? r.error.line : null;
    if (line !== c.line) bad.push(`${JSON.stringify(c.src)}: python ${c.line}, ours ${line} ${r.error ? r.error.message : ''}`);
    if (r.error) assert.ok(r.error.col >= 0 && r.error.length > 0 && r.error.message, JSON.stringify(r.error));
  }
  assert.deepEqual(bad, []);
});

test('every Python file in the repository parses without errors', () => {
  const files = execFileSync('git', ['ls-files', '*.py'], {cwd: ROOT, encoding: 'utf8'}).split('\n').filter(Boolean);
  assert.ok(files.length > 100);
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (src.length > 400000) continue;
    const r = EditorParse.parse(src);
    if (r.error) bad.push(`${f}:${r.error.line}:${r.error.col} ${r.error.message}`);
  }
  assert.deepEqual(bad, []);
});

test('the AST carries positioned definitions, imports and stores', () => {
  const src = 'import os, a.b as ab\nfrom .m import (x as y, z)\n\n@dec\nclass C(Base):\n    attr: int = 1\n    def m(self, p, *a, k=1, **kw):\n        q = p\n        for i, (j, *k2) in enumerate(a):\n            pass\n        return lambda t: t\n\nasync def g():\n    with open("f") as fh:\n        pass\n    try:\n        pass\n    except E as err:\n        pass\n    if (n := 1):\n        pass\n    match q:\n        case [first, *rest] if first:\n            pass\n        case {"k": v, **others}:\n            pass\n        case P(x=px) | Q() as pq:\n            pass\n';
  const {ast, error} = EditorParse.parse(src);
  assert.equal(error, null);
  const defs = [], stores = [], imports = [];
  EditorParse.walk(ast, n => {
    if (n.type === 'FunctionDef' || n.type === 'ClassDef') defs.push(`${n.name}@${n.nameLine}:${n.nameCol}`);
    if (n.type === 'Name' && n.ctx === 'store') stores.push(`${n.id}@${n.line}:${n.col}`);
    if (n.type === 'arg') stores.push(`${n.arg}@${n.line}:${n.col}`);
    if (n.type === 'alias') imports.push(`${n.asname || n.name}@${n.bindLine}:${n.bindCol}`);
  });
  assert.deepEqual(defs, ['C@5:6', 'm@7:8', 'g@13:10']);
  assert.deepEqual(imports, ['os@1:7', 'ab@1:18', 'y@2:21', 'z@2:24']);
  for (const s of ['attr@6:4', 'self@7:10', 'p@7:16', 'a@7:20', 'k@7:23', 'kw@7:30', 'q@8:8', 'i@9:12', 'j@9:16', 'k2@9:20', 't@11:22',
    'fh@14:22', 'err@18:16', 'n@20:8', 'first@23:14', 'rest@23:22', 'v@25:19', 'others@25:24', 'px@27:17', 'pq@27:30'])
    assert.ok(stores.includes(s), s + ' not in ' + stores.join(' '));
});

test('garbage never throws; deep nesting is reported, not a crash', () => {
  for (const s of ['(((((', ')))))', '"""', "'''\"\"\"", '\u0000\u0001', ':\n:\n', '\t\n  \n\t  x\n', 'if\n', '\\', 'x = \\', '@', 'match', 'case x:', 'lambda', '*', '**', 'f(**)', '\ud800', '😀 = 1']) {
    const r = EditorParse.parse(s); assert.ok(r.ast);
  }
  const deep = EditorParse.parse('x = ' + '('.repeat(20000) + ')'.repeat(20000) + '\n');
  assert.ok(deep.error && deep.error.message);
});

test('a 400 KB file parses fast and the parser stays small', () => {
  const unit = fs.readFileSync(path.join(ROOT, 'scripts/mock_device.py'), 'utf8');
  // whole copies only: cutting at an arbitrary line could end on a `def …:` and make the file invalid Python
  let big = ''; while (big.length < 400000) big += unit + '\n';
  EditorParse.parse(big);  // warm up the JIT
  // Best of 5 runs: the fastest run measures the parser, not other test files competing for the CPU when
  // `node --test` runs them in parallel (a single run used to exceed the budget now and then).
  let r = null, ms = Infinity;
  for (let i = 0; i < 5; i++) {
    const t = process.hrtime.bigint(); r = EditorParse.parse(big); ms = Math.min(ms, Number(process.hrtime.bigint() - t) / 1e6);
    assert.equal(r.error, null);
  }
  assert.ok(ms < (process.env.CI ? 500 : 150), `fastest of 5 took ${ms} ms`);  // typically ~40-60 ms locally; loose on shared CI runners
  assert.ok(fs.statSync(FILE).size < 60000, 'editor-parse.js must stay under 60 KB');
});
