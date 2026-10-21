const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EditorSymbols} = require('../../android/app/src/main/assets/tools/editor-symbols.js');
const {XSDocs} = require('../../android/app/src/main/assets/tools/editor-docs.js');

const FILES = {
  '__init__.py': [
    'from xscript.android import action',          // 1
    'from xscript.android.action import click as tap',
    'import util',                                  // 3
    'from pkg.shapes import Square, area',
    'from pkg import shapes as sh',                 // 5
    'COUNT = 0',
    '',
    'def main(n):',                                 // 8
    '    global COUNT',
    '    COUNT += 1',                               // 10
    '    sq = Square(2)',
    '    total = sq.area() + area(sq) + sh.area(sq)',  // 12
    '    util.log(total, n)',
    '    action.click(1, 2)',                       // 14
    '    tap(3, 4)',
    '    names = [n for n in range(3)]',            // 16
    '    return sq.side + len(names)',
    '',
    'main(1)',                                      // 19
  ].join('\n') + '\n',
  'util.py': 'def log(*parts, sep=" "):\n    print(*parts, sep=sep)\n\nclass Base:\n    def hello(self):\n        return "hi"\n',
  'demo.py': 'from pkg.shapes import Square\nSquare(1).hello()\nb = Square(2)\nb.hello()\n',
  'pkg/__init__.py': '',
  'pkg/shapes.py': [
    'from ..util import Base',                      // 1 (relative to package; invalid at top -> unresolved)
    'from util import Base, log',                   // 2
    '',
    'class Square(Base):',                          // 4
    '    def __init__(self, side):',
    '        self.side = side',                     // 6
    '    def area(self):',
    '        log(self.side)',                       // 8
    '        return self.side * self.side',
    '',
    'def area(s):',                                 // 11
    '    def inner():',
    '        return s.area()',                      // 13
    '    return inner() + s.hello()',
  ].join('\n') + '\n',
};
const project = () => EditorSymbols.build(Object.entries(FILES).map(([path, content]) => ({path, content})), XSDocs);
const def = (p, path, line, word, nth = 0) => {
  const lines = FILES[path].split('\n'); let col = -1; for (let i = 0; i <= nth; i++) col = lines[line - 1].indexOf(word, col + 1);
  assert.ok(col >= 0, `${word} not on ${path}:${line}`);
  const r = p.definitionAt(path, line, col + 1);
  return r && (r.library ? 'lib ' + r.library : `${r.path}:${r.line}:${r.col} ${r.kind}`);
};

test('module names from project paths', () => {
  assert.equal(EditorSymbols.moduleName('main.py'), 'main');
  assert.equal(EditorSymbols.moduleName('pkg/sub/mod.py'), 'pkg.sub.mod');
  assert.equal(EditorSymbols.moduleName('pkg/__init__.py'), 'pkg');
  assert.equal(EditorSymbols.moduleName('readme.txt'), null);
});

test('go to definition across project files', () => {
  const p = project();
  assert.equal(def(p, '__init__.py', 11, 'Square'), 'pkg/shapes.py:4:6 class');            // through from-import
  assert.equal(def(p, '__init__.py', 12, 'area'), 'pkg/shapes.py:7:8 function');           // sq = Square() -> method
  assert.equal(def(p, '__init__.py', 12, 'area', 1), 'pkg/shapes.py:11:4 function');        // imported function
  assert.equal(def(p, '__init__.py', 12, 'area', 2), 'pkg/shapes.py:11:4 function');        // module alias attribute
  assert.equal(def(p, '__init__.py', 12, 'sh'), 'pkg/shapes.py:1:0 module');
  assert.equal(def(p, '__init__.py', 13, 'log'), 'util.py:1:4 function');
  assert.equal(def(p, '__init__.py', 13, 'util'), 'util.py:1:0 module');
  assert.equal(def(p, '__init__.py', 3, 'util'), 'util.py:1:0 module');                     // the import line itself
  assert.equal(def(p, '__init__.py', 4, 'area'), 'pkg/shapes.py:11:4 function');
  assert.equal(def(p, '__init__.py', 17, 'side'), 'pkg/shapes.py:6:13 attribute');          // self.side = ...
  assert.equal(def(p, '__init__.py', 10, 'COUNT'), '__init__.py:6:0 variable');             // global
  assert.equal(def(p, '__init__.py', 19, 'main'), '__init__.py:8:4 function');
  assert.equal(def(p, '__init__.py', 13, 'n'), '__init__.py:8:9 parameter');                // not the comprehension n
  assert.equal(def(p, '__init__.py', 16, 'n', 1), '__init__.py:16:19 variable');            // comprehension target
  assert.equal(def(p, 'pkg/shapes.py', 8, 'log'), 'util.py:1:4 function');
  assert.equal(def(p, 'pkg/shapes.py', 13, 's'), 'pkg/shapes.py:11:9 parameter');           // enclosing function
  assert.equal(def(p, 'pkg/shapes.py', 14, 'hello'), null);                                 // untyped parameter: not guessed
  assert.equal(def(p, 'demo.py', 2, 'hello'), 'util.py:5:8 function');                     // inherited from a project base
  assert.equal(def(p, 'demo.py', 4, 'hello'), 'util.py:5:8 function');
  assert.equal(def(p, '__init__.py', 12, 'sq', 1), '__init__.py:11:4 variable');
});

test('library symbols resolve to their XSDocs key', () => {
  const p = project();
  assert.equal(def(p, '__init__.py', 14, 'click'), 'lib xscript.android.action.click');
  assert.equal(def(p, '__init__.py', 14, 'action'), 'lib xscript.android.action');
  assert.equal(def(p, '__init__.py', 15, 'tap'), 'lib xscript.android.action.click');
  assert.equal(def(p, '__init__.py', 13, 'total'), '__init__.py:12:4 variable');
  assert.equal(p.definitionAt('__init__.py', 17, 22), null);   // builtin len
});

test('find references across files, grouped on one symbol', () => {
  const p = project();
  const r = p.referencesAt('pkg/shapes.py', 11, 5);   // def area(s)
  assert.equal(r.name, 'area');
  assert.deepEqual(r.refs.map(x => `${x.path}:${x.line}:${x.col}${x.def ? ' def' : ''}`),
    ['__init__.py:4:31', '__init__.py:12:24', '__init__.py:12:38', 'pkg/shapes.py:11:4 def']);
  const m = p.referencesAt('pkg/shapes.py', 7, 9);    // method area
  assert.deepEqual(m.refs.map(x => `${x.path}:${x.line}:${x.col}`), ['__init__.py:12:15', 'pkg/shapes.py:7:8']);
  assert.match(m.refs[0].text, /^total = sq\.area\(\)/);
  const side = p.referencesAt('pkg/shapes.py', 6, 14);
  assert.deepEqual(side.refs.map(x => `${x.path}:${x.line}`), ['__init__.py:17', 'pkg/shapes.py:6', 'pkg/shapes.py:8', 'pkg/shapes.py:9', 'pkg/shapes.py:9']);
  const lib = p.referencesAt('__init__.py', 15, 5);   // tap -> action.click (library) everywhere
  assert.deepEqual(lib.refs.map(x => `${x.line}:${x.col}`), ['2:35', '2:44', '14:11', '15:4']);
});

test('hover descriptions: signatures, docstrings and inferred types', () => {
  const files = [
    {path: 'lib.py', content: '"""Helpers."""\nclass Square:\n    """A square.\n\n    Sides are equal.\n    """\n    def __init__(self, side: int = 2):\n        self.side = side\n        self.tags = []\n        self.name: str = "sq"\n    def area(self, scale=1.5, *rest, **opts) -> float:\n        return 1.0\n'},
    {path: 'main.py', content: 'import lib\nfrom lib import Square as Sq\nfrom xscript.android import action\nCOUNT = 0\nratio = 3 / 2\nsq = Sq(4)\ntotal = sq.area() + COUNT\nlabel = f"x{COUNT}"\nn = len([1])\nok = COUNT > 1\nb = b"raw"\ndef run(x, y=None, *a, **k):\n    return x\nr = run(1)\n'}];
  const p = EditorSymbols.build(files, XSDocs);
  const h = (path, line, word) => { const l = files.find(f => f.path === path).content.split('\n')[line - 1]; const c = l.indexOf(word); assert.ok(c >= 0, word); const r = p.describeAt(path, line, c + 1); return r && [r.head, r.where, r.doc]; };
  assert.deepEqual(h('main.py', 1, 'lib'), ['module lib', 'lib.py', 'Helpers.']);
  assert.deepEqual(h('main.py', 2, 'Sq'), ['class Square', 'lib.py:2', 'A square.\n\nSides are equal.']);
  assert.deepEqual(h('main.py', 7, 'area'), ['def Square.area(self, scale=1.5, *rest, **opts) -> float', 'lib.py:11', '']);
  assert.deepEqual(h('main.py', 12, 'run'), ['def run(x, y=None, *a, **k)', 'main.py:12', '']);
  const head = (path, line, word) => h(path, line, word)[0];
  assert.equal(head('main.py', 4, 'COUNT'), '(变量) COUNT: int');
  assert.equal(head('main.py', 5, 'ratio'), '(变量) ratio: float');
  assert.equal(head('main.py', 6, 'sq'), '(变量) sq: Square');
  assert.equal(head('main.py', 7, 'total'), '(变量) total: float');                // method return annotation + int
  assert.equal(head('main.py', 8, 'label'), '(变量) label: str');
  assert.equal(head('main.py', 9, 'n'), '(变量) n: int');                         // len()
  assert.equal(head('main.py', 10, 'ok'), '(变量) ok: bool');
  assert.equal(head('main.py', 11, 'b'), '(变量) b: bytes');
  assert.equal(head('main.py', 14, 'r'), '(变量) r');                             // unknown: no type
  assert.equal(head('main.py', 12, 'y'), '(参数) y = None');
  assert.equal(head('main.py', 12, 'a'), '(参数) *a: tuple');
  assert.equal(head('lib.py', 11, 'scale'), '(参数) scale: float = 1.5');
  assert.equal(head('lib.py', 7, 'side'), '(参数) side: int = 2');
  assert.equal(head('lib.py', 8, 'side'), '(属性) Square.side: int');             // self.side = <int parameter>
  assert.equal(head('lib.py', 9, 'tags'), '(属性) Square.tags: list');
  assert.equal(head('lib.py', 10, 'name'), '(属性) Square.name: str');            // annotated
  assert.equal(h('main.py', 3, 'action'), null, 'library symbols use the library hover');
  assert.equal(p.describeAt('main.py', 4, 8), null, 'nothing on a number');
});

test('rename symbol: every occurrence of the same definition, with safety checks', () => {
  const p = project();
  const at = (path, line, word, nth = 0) => { const l = FILES[path].split('\n')[line - 1]; let c = -1; for (let i = 0; i <= nth; i++) c = l.indexOf(word, c + 1); assert.ok(c >= 0); return [path, line, c + 1]; };
  const places = r => r.edits.map(e => `${e.path}:${e.line}:${e.col}`);
  assert.deepEqual(p.renameAt(...at('__init__.py', 13, 'log')), {name: 'log'});                  // probe only
  const r = p.renameAt(...at('__init__.py', 13, 'log'), 'write');                              // util.log -> def in util.py
  assert.deepEqual([r.name, r.newName, r.files], ['log', 'write', 3]);
  assert.deepEqual(places(r), ['__init__.py:13:9', 'pkg/shapes.py:2:23', 'pkg/shapes.py:8:8', 'util.py:1:4']);
  // an attribute: self.side everywhere, but not the same-named parameter side
  assert.deepEqual(places(p.renameAt(...at('__init__.py', 17, 'side'), 'size')),
    ['__init__.py:17:14', 'pkg/shapes.py:6:13', 'pkg/shapes.py:8:17', 'pkg/shapes.py:9:20', 'pkg/shapes.py:9:32']);
  assert.match(p.renameAt(...at('__init__.py', 14, 'click'), 'x').error, /库符号 xscript\.android\.action\.click 不能重命名/);
  assert.match(p.renameAt(...at('__init__.py', 12, 'sh'), 'x').error, /模块名/);
  assert.match(p.renameAt(...at('__init__.py', 10, 'COUNT'), 'main').error, /main 在同一作用域里已经有定义/);
  assert.match(p.renameAt(...at('__init__.py', 10, 'COUNT'), 'class').error, /不是合法的 Python 名字/);
  assert.match(p.renameAt(...at('__init__.py', 10, 'COUNT'), '2x').error, /不是合法的 Python 名字/);
  assert.match(p.renameAt(...at('__init__.py', 10, 'COUNT'), 'COUNT').error, /和原来一样/);
  assert.match(p.renameAt('__init__.py', 7, 0, 'x').error, /没有可重命名的名字/);
  // an `as` alias keeps its own name; the imported name on the import line is renamed
  const q = EditorSymbols.build([{path: 'a.py', content: 'def f():\n    pass\n'}, {path: 'b.py', content: 'from a import f as g\ng()\nfrom a import f\nf()\n'}]);
  assert.deepEqual(places(q.renameAt('b.py', 4, 0, 'h')), ['a.py:1:4', 'b.py:1:14', 'b.py:3:14', 'b.py:4:0']);
});

test('broken files still index up to the error; non-Python files are ignored', () => {
  const p = EditorSymbols.build([{path: 'a.py', content: 'def ok():\n    pass\nx = (\n'}, {path: 'b.py', content: 'from a import ok\nok()\n'}, {path: 'n.txt', content: 'x'}]);
  assert.deepEqual(p.definitionAt('b.py', 2, 0), {path: 'a.py', line: 1, col: 4, name: 'ok', kind: 'function'});
  assert.equal(p.files.has('n.txt'), false);
  assert.equal(p.definitionAt('b.py', 9, 0), null);
});

test('a real package (backend/xscript_server): every occurrence resolves without throwing, references stay fast', () => {
  const fs = require('node:fs'), path = require('node:path');
  const base = path.join(__dirname, '../../backend'), files = [];
  const walk = d => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.py')) files.push({path: path.relative(base, f), content: fs.readFileSync(f, 'utf8')}); } };
  walk(path.join(base, 'xscript_server'));
  const t0 = Date.now(), p = EditorSymbols.build(files, XSDocs);
  let n = 0, resolved = 0;
  for (const f of p.files.values()) for (const o of f.occ) { n++; if (p.resolveOcc(o)) resolved++; }
  assert.ok(n > 5000 && resolved / n > 0.4, `${resolved}/${n}`);
  const t1 = Date.now(), r = p.referencesAt('xscript_server/settlement.py', ...(() => { const ls = files.find(f => f.path === 'xscript_server/settlement.py').content.split('\n'); const i = ls.findIndex(l => /^def /.test(l)); return [i + 1, 5]; })());
  assert.ok(r && r.refs.some(x => x.def), JSON.stringify(r));
  assert.ok(Date.now() - t1 < (process.env.CI ? 3000 : 1000), `references took ${Date.now() - t1} ms (index ${t1 - t0} ms)`);
});

test('basic checks: undefined names and call arguments of project functions and classes', () => {
  const lib = 'class Sq:\n    def __init__(self, side, *, unit="px"):\n        self.side = side\n    def area(self, k):\n        return self.side * k\n' +
    '    @classmethod\n    def make(cls, n):\n        return cls(n)\n    @staticmethod\n    def unit(x):\n        return x\n' +
    '    @property\n    def p(self):\n        return 1\ndef f(a, b=1):\n    pass\ndef g(*a, **kw):\n    pass\n';
  const main = [
    'import os', 'from lib import Sq, f, g', 'from nowhere import thing', 's = Sq()',          // 4
    's.area()', 'Sq.make(1, 2)', 'f(1, 2, 3)', 'f(1, c=2)', 'f(1, a=2)',                       // 9
    'print(undefined_x, len(os.sep), thing, __name__)',                                         // 10
    'try:', '    pass', 'except ValueError as err:', '    print(err)',                           // 14
    'for i in range(3): print(i)', 's2 = Sq(1, unit="m")', 's2.area(2)', '[y for y in range(2)]', 'print(y)',   // 19
    'g(1, 2, x=3)', 'f(*[1, 2, 3])', 'f(**{})', 'Sq.area(s2, 2)', 'Sq.unit(1)', 'Sq.unit()',      // 25
    'def h():', '    global later', '    later = 1', 'print(later)', 'lambda q: q + zz', ''].join('\n');
  const p = EditorSymbols.build([{path: 'lib.py', content: lib}, {path: '__init__.py', content: main}], XSDocs);
  assert.deepEqual(p.problemsIn('__init__.py').map(w => [w.line, w.col, w.length, w.message, w.severity]), [
    [4, 4, 2, 'Sq() 缺少参数 side', 'warning'],
    [5, 2, 4, 'Sq.area() 缺少参数 k', 'warning'],
    [6, 3, 4, 'Sq.make() 最多接受 1 个位置参数，这里传了 2 个', 'warning'],
    [7, 0, 1, 'f() 最多接受 2 个位置参数，这里传了 3 个', 'warning'],
    [8, 0, 1, 'f() 没有名为 c 的参数', 'warning'],
    [9, 0, 1, 'f() 的参数 a 传了两次', 'warning'],
    [10, 6, 11, '未定义的名字 undefined_x', 'warning'],
    [19, 6, 1, '未定义的名字 y', 'warning'],
    [25, 3, 4, 'Sq.unit() 缺少参数 x', 'warning'],
    [30, 14, 2, '未定义的名字 zz', 'warning'],
  ]);
  assert.deepEqual(p.problemsIn('lib.py'), []);
  // star imports make every name possibly defined
  const star = EditorSymbols.build([{path: 'a.py', content: 'from somewhere import *\nprint(anything)\n'}], XSDocs);
  assert.deepEqual(star.problemsIn('a.py'), []);
});

test('basic checks: no warnings on the repository\'s own Python sources', () => {
  const {execSync} = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path');
  const root = path.join(__dirname, '..', '..');
  const files = execSync('git ls-files "*.py"', {cwd: root}).toString().trim().split('\n').filter(Boolean)
    .map(p => ({path: p, content: fs.readFileSync(path.join(root, p), 'utf8')}));
  assert.ok(files.length > 100);
  const p = EditorSymbols.build(files, XSDocs), found = [];
  for (const f of files) for (const w of p.problemsIn(f.path)) found.push(f.path + ':' + w.line + ' ' + w.message);
  assert.deepEqual(found, []);
});

test('basic checks: unknown attributes of project classes and instances', () => {
  const lib = [
    'from elsewhere import Unknown, decorate', 'class Base:', '    LIMIT = 3', '    def ping(self):', '        return self.pong()',            // 5: Base is subclassed: self.pong not reported
    'class Shape(Base):', '    def __init__(self, side):', '        self.side = side',
    '    def area(self):', '        return self.side * self.sid',                                  // 10: typo
    '    @staticmethod', '    def unit(other):', '        return other.whatever',                  // 12: static: not self
    'class Loose(Unknown):', '    def m(self):', '        return self.anything',                   // 15: unknown base
    '@decorate', 'class Deco:', '    def m(self):', '        return self.anything',                // 19: decorated
    ''].join('\n');
  const main = [
    'from lib import Shape, Base', 's = Shape(2)', 's.area()', 's.areaa()', 's.LIMIT', 's.ping()',   // 4: areaa
    'Shape.unit(1)', 'Shape.nope', 's.__class__', 's.extra = 1', 's.extra', 'other = Shape(1)', 'other.extra',  // 8: nope
    'b = Base()', 'b.pong', ''].join('\n');                                                          // 15: pong
  const p = EditorSymbols.build([{path: 'lib.py', content: lib}, {path: '__init__.py', content: main}], XSDocs);
  const msgs = path => p.problemsIn(path).map(w => [w.line, w.col, w.message]);
  assert.deepEqual(msgs('lib.py'), [[10, 32, 'Shape 没有属性或方法 sid（是不是 side？Ctrl+. 改正）']]);
  assert.deepEqual(msgs('__init__.py'), [[4, 2, 'Shape 没有属性或方法 areaa（是不是 area？Ctrl+. 改正）'], [8, 6, 'Shape 没有属性或方法 nope'], [15, 2, 'Base 没有属性或方法 pong（是不是 ping？Ctrl+. 改正）']]);
  // setattr / __getattr__ in the file make attributes dynamic: nothing reported
  const dyn = EditorSymbols.build([{path: 'a.py', content: 'class A:\n    def __getattr__(self, n):\n        return 1\na = A()\na.anything\n'}], XSDocs);
  assert.deepEqual(dyn.problemsIn('a.py'), []);
});

test('quick fix: import candidates for undefined names and where the import goes', () => {
  const main = '"""Doc."""\nimport os\nfrom x import (y,\n    z)\n\nhelper()\nprint(TOP, _hidden, nothing)\n';
  const p = EditorSymbols.build([
    {path: 'a.py', content: 'def helper():\n    pass\nTOP = 1\n_hidden = 2\n'},
    {path: 'pkg/b.py', content: 'class helper:\n    pass\nfrom a import TOP\n'},
    {path: '__init__.py', content: main}], XSDocs);
  assert.deepEqual(p.problemsIn('__init__.py').map(w => [w.line, w.message, w.fix]), [
    [6, '未定义的名字 helper（Ctrl+. 选择要导入的模块）', ['a', 'pkg.b']],
    [7, '未定义的名字 TOP（Ctrl+. 从 a 导入）', ['a']],          // pkg.b only re-imports it
    [7, '未定义的名字 _hidden', undefined],
    [7, '未定义的名字 nothing', undefined],
  ]);
  assert.equal(p.importLine('__init__.py'), 6);
  const only = EditorSymbols.build([{path: 'm.py', content: 'import os'}, {path: 'n.py', content: '"""d"""\nx = 1\n'}, {path: 'e.py', content: ''}], XSDocs);
  assert.equal(only.importLine('m.py'), 2); assert.equal(only.importLine('n.py'), 2); assert.equal(only.importLine('e.py'), 1);
});

test('unused imports and local variables, and removing an import', () => {
  const main = [
    'from __future__ import annotations', 'import os', 'import sys, json', 'from lib import a, b as bb, c',   // 4
    'import noisy  # noqa: F401', 'from .pkg import again', 'import used_in_fstring',                       // 7
    'print(sys.argv, a, c, f"{used_in_fstring.x}")',
    'def f(n):', '    total = n * 2', '    x, y = 1, 2', '    for i in range(3): pass', '    _skip = 1',         // 13
    '    kept = 1', '    print(kept)', '    import inner', '    return n', ''].join('\n');
  const p = EditorSymbols.build([{path: 'lib.py', content: 'a = b = c = 1\n'}, {path: 'main.py', content: main}], XSDocs);
  assert.deepEqual(p.unusedIn('main.py').map(w => [w.line, w.col, w.kind, w.name, w.message, w.names]), [
    [2, 7, 'import', 'os', '未使用的 import os（Ctrl+. 删除）', 1],
    [3, 12, 'import', 'json', '未使用的 import json（Ctrl+. 删除）', 2],
    [4, 24, 'import', 'bb', '未使用的 import bb（Ctrl+. 删除）', 3],
    [10, 4, 'variable', 'total', '未使用的变量 total', undefined],
    [16, 11, 'import', 'inner', '未使用的 import inner（Ctrl+. 删除）', 1],
  ]);
  // re-exports: package __init__, __all__, a module made only of imports, names other files import from it
  const re = EditorSymbols.build([
    {path: 'pkg/__init__.py', content: 'from os import path\n'}, {path: 'facade.py', content: 'from os import sep\n'},
    {path: 'withall.py', content: 'from os import sep\n__all__ = ["sep"]\n'},
    {path: 'mod.py', content: 'from os import sep\ndef g():\n    return 1\n'}, {path: 'user.py', content: 'from mod import sep\nprint(sep)\n'},
    {path: 'dyn.py', content: 'def h():\n    v = 1\n    return locals()\n'}], XSDocs);
  for (const path of ['pkg/__init__.py', 'facade.py', 'withall.py', 'mod.py', 'dyn.py']) assert.deepEqual(re.unusedIn(path), [], path);
  const entry = EditorSymbols.build([{path: '__init__.py', content: 'import os\nprint(1)\n'}], XSDocs);
  assert.deepEqual(entry.unusedIn('__init__.py').map(w => w.name), ['os'], 'the entry script is not a re-exporting package');
  const t = 'import os\nfrom a import (x,\n    y, z)  # c\nimport p.q, r as rr\nfrom b import u as uu, v\nprint(1)\n';
  const apply = (l, n, c) => { const r = EditorSymbols.removeImport(t, l, n, c); return t.slice(0, r.from) + r.text + t.slice(r.to); };
  assert.equal(apply(1, 'os', 1), t.replace('import os\n', ''));
  assert.equal(apply(2, 'x', 3), t.replace('(x,\n    y, z)', '(y, z)'));
  assert.equal(apply(2, 'z', 3), t.replace('y, z)', 'y)'));
  assert.equal(apply(4, 'p', 2), t.replace('import p.q, r as rr', 'import r as rr'));
  assert.equal(apply(4, 'rr', 2), t.replace('import p.q, r as rr', 'import p.q'));
  assert.equal(apply(5, 'uu', 2), t.replace('u as uu, v', 'v'));
  assert.equal(EditorSymbols.removeImport(t, 6, 'x', 2), null);
});

test('unused: only pyflakes-confirmed findings on the repository\'s own Python sources', () => {
  // Every finding here was checked against pyflakes (F401 / F841) when this check was added. Removing one of these
  // from the code is fine; a new finding must be a real unused import / variable (fix it) or a false positive (fix the check).
  const KNOWN = new Set([
    'android/python-runtime/tests/test_gp_compat.py:9 cv2', 'android/python-runtime/tests/test_gp_legacy.py:2 json',
    'desktop/app/tests/test_errors_matrix.py:31 orig', 'desktop/app/tests/test_windows_sim.py:13 adb_mod',
    'desktop/app/xscript_desktop/rpc.py:18 Awaitable', 'desktop/app/xscript_desktop/scheme.py:8 urlsplit',
    'desktop/app/xscript_desktop/services/adb.py:21 field', 'desktop/app/xscript_desktop/services/device_manager.py:15 httpx']);
  const {execSync} = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path');
  const root = path.join(__dirname, '..', '..');
  const files = execSync('git ls-files "*.py"', {cwd: root}).toString().trim().split('\n').filter(Boolean)
    .map(p => ({path: p, content: fs.readFileSync(path.join(root, p), 'utf8')}));
  const p = EditorSymbols.build(files, XSDocs), found = [];
  for (const f of files) for (const w of p.unusedIn(f.path)) { const k = f.path + ':' + w.line + ' ' + w.name; if (!KNOWN.has(k)) found.push(k); }
  assert.deepEqual(found, []);
});

test('basic checks: literal arguments that do not match a simple annotation', () => {
  const lib = 'def f(n: int, x: float = 1.0, s: str = "", o: int = None, *, l: list = None):\n    pass\n' +
    'class Box:\n    def __init__(self, w: int):\n        self.w = w\n    def scale(self, k: float):\n        return self.w * k\n' +
    'def g(v: "int", u: list[int], q: Optional, z):\n    pass\n';
  const main = [
    'from lib import f, Box, g', 'f("3")', 'f(1, 2)', 'f(True, s=5)', 'f(1, o=None, l=[1])', 'f(1.5, l={})',   // 6
    'f(n=f"x{1}")', 'b = Box("2")', 'b.scale(2)', 'b.scale("x")', 'g("a", "b", 1, 2)', 'f(len("x"))', ''].join('\n');
  const p = EditorSymbols.build([{path: 'lib.py', content: lib}, {path: 'main.py', content: main}], XSDocs);
  assert.deepEqual(p.problemsIn('main.py').map(w => [w.line, w.col, w.length, w.message]), [
    [2, 2, 3, 'f() 的参数 n 应为 int，这里传了 str'],
    [4, 10, 1, 'f() 的参数 s 应为 str，这里传了 int'],
    [6, 2, 3, 'f() 的参数 n 应为 int，这里传了 float'],
    [6, 9, 1, 'f() 的参数 l 应为 list，这里传了 dict'],
    [7, 4, 2, 'f() 的参数 n 应为 int，这里传了 str'],
    [8, 8, 3, 'Box() 的参数 w 应为 int，这里传了 str'],
    [10, 8, 3, 'Box.scale() 的参数 k 应为 float，这里传了 str'],
  ]);
  // a project class named like a builtin shadows it: no judgement
  const shadow = EditorSymbols.build([{path: 'm.py', content: 'class str:\n    pass\ndef h(s: str):\n    pass\nh(1)\n'}], XSDocs);
  assert.deepEqual(shadow.problemsIn('m.py'), []);
});

test('unknown attributes: "did you mean" suggestion for a close member name', () => {
  const lib = 'class Base:\n    def area(self):\n        return 1\nclass Shape(Base):\n    def __init__(self):\n        self.side = 1\n        self.color = 2\n        self.colour = 3\n        self.ab = 4\n        self.ac = 5\n';
  const main = 'from lib import Shape\ns = Shape()\nprint(s.sid, s.aera, s.Side, s.xyz, s.colr, s.ad)\n';
  const p = EditorSymbols.build([{path: 'lib.py', content: lib}, {path: 'main.py', content: main}], XSDocs);
  assert.deepEqual(p.problemsIn('main.py').map(w => [w.col, w.message, w.suggest]), [
    [8, 'Shape 没有属性或方法 sid（是不是 side？Ctrl+. 改正）', 'side'],
    [15, 'Shape 没有属性或方法 aera（是不是 area？Ctrl+. 改正）', 'area'],     // transposition, inherited
    [23, 'Shape 没有属性或方法 Side（是不是 side？Ctrl+. 改正）', 'side'],     // case only
    [31, 'Shape 没有属性或方法 xyz', undefined],                                // nothing close
    [38, 'Shape 没有属性或方法 colr（是不是 color？Ctrl+. 改正）', 'color'],   // color (1) beats colour (2)
    [46, 'Shape 没有属性或方法 ad', undefined],                                 // ab / ac tie: no guess
  ]);
});

test('undefined names: "did you mean" a close visible name (locals, enclosing, module, builtins)', () => {
  const main = [
    'total = 1', 'class K:', '    hidden = 1', '    def m(self):', '        return hiddn',   // 5: class body not visible
    'def f(count):', '    return cuont + totl + lenn([]) + prnt + Total + qq', 'print(f(1))', ''].join('\n');
  const p = EditorSymbols.build([{path: '__init__.py', content: main}, {path: 'lib.py', content: 'def helper():\n    pass\n'}], XSDocs);
  assert.deepEqual(p.problemsIn('__init__.py').map(w => [w.line, w.col, w.message, w.suggest]), [
    [5, 15, '未定义的名字 hiddn', undefined],
    [7, 11, '未定义的名字 cuont（是不是 count？Ctrl+. 改正）', 'count'],
    [7, 19, '未定义的名字 totl（是不是 total？Ctrl+. 改正）', 'total'],
    [7, 26, '未定义的名字 lenn（是不是 len？Ctrl+. 改正）', 'len'],
    [7, 37, '未定义的名字 prnt（是不是 print？Ctrl+. 改正）', 'print'],
    [7, 44, '未定义的名字 Total（是不是 total？Ctrl+. 改正）', 'total'],
    [7, 52, '未定义的名字 qq', undefined],
  ]);
  // an import fix wins over a guess
  const q = EditorSymbols.build([{path: '__init__.py', content: 'helpr = 1\nhelper()\n'}, {path: 'lib.py', content: 'def helper():\n    pass\n'}], XSDocs);
  assert.deepEqual(q.problemsIn('__init__.py').map(w => [w.message, w.suggest, w.fix]), [['未定义的名字 helper（Ctrl+. 从 lib 导入）', undefined, ['lib']]]);
});

test('argument types: variables bound once to a literal count like the literal', () => {
  const src = [
    'def wait(s: float, label: str = ""):', '    pass', 'd = "2"', 'n = 3',
    'wait(d)', 'wait(n, label=n)',                               // 5, 6
    'x = y = "a"', 'wait(x)',                                     // chained: skipped
    'z = "a"', 'z = 1', 'wait(z)',                                // rebound: skipped
    'def f(p="s"):', '    wait(d)', '    wait(p)',                // 13: module variable; parameter skipped
    'for i in ["a"]:', '    wait(i)',                            // loop target: skipped
    'a, b = "1", "2"', 'wait(a)',                                 // unpacking: skipped
    'def g():', '    global n2', '    n2 = "x"', 'n2 = 1', 'wait(n2)',   // global rebinding: skipped
    'k: str = "1"', 'wait(k)', ''].join('\n');                  // annotated: skipped
  const p = EditorSymbols.build([{path: 'm.py', content: src}], XSDocs);
  assert.deepEqual(p.problemsIn('m.py').map(w => [w.line, w.col, w.length, w.message]), [
    [5, 5, 1, 'wait() 的参数 s 应为 float，这里传了 str'],
    [6, 14, 1, 'wait() 的参数 label 应为 str，这里传了 int'],
    [13, 9, 1, 'wait() 的参数 s 应为 float，这里传了 str'],
  ]);
});
