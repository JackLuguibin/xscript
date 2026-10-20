const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EditorCheck} = require('../../android/app/src/main/assets/tools/editor-check.js');
const msgs = src => EditorCheck.check(src).map(d => `${d.line}:${d.col} ${d.message}`);
const one = src => { const r = EditorCheck.check(src); assert.equal(r.length, 1, JSON.stringify(r)); return r[0]; };

test('valid code, including modern syntax, is clean', () => {
  const ok = [
    '', 'x = 1\n', 'def f(a, *b, c=1, **d):\n    return {**d, "a": [i for i in b if i]}\n',
    'async def g():\n    async with a as b, c as d:\n        await b\n',
    'if (n := len(a)) > 1:\n    pass\nelif x:\n    pass\nelse:\n    pass\n',
    'try:\n    pass\nexcept (A, B) as e:\n    raise\nfinally:\n    pass\n',
    'x = """a\n  b\n"""\ny = f"{a!r:>{w}} {b}"\n', "s = 'it\\'s'\nt = r'\\d+'\n",
    'lam = lambda x: x + 1\nd = {1: 2, 3: 4}\nsl = a[1:2, ::3]\n',
    'x = [\n    1,\n  2,\n]\nif x: pass\nclass A: pass\n', 'a = 1 + \\\n    2\n',
    'match = 1\nprint(match)\n', '@dec\ndef f(): ...\n', 'with open("f") as fh: data = fh.read()\n',
    'x = 1\r\nif x:\r\n    y = 2\r\n', 'if x:\n\n    # comment\n\n    y = 1\n', 'def f():\n    """doc"""\n', '名字 = "中文"\nprint(名字)\n',
  ];
  for (const src of ok) assert.deepEqual(msgs(src), [], JSON.stringify(src));
});
test('unterminated strings, including triple-quoted', () => {
  assert.match(one('x = "abc\ny = 1\n').message, /字符串/);
  assert.equal(one('x = "abc\ny = 1\n').line, 1);
  const t = one('x = 1\ns = """never closed\nmore\n'); assert.match(t.message, /三引号|字符串/); assert.equal(t.line, 2);
});
test('bracket mismatch, unclosed and extra', () => {
  assert.match(one('x = (1, 2]\n').message, /括号不匹配/);
  const u = one('foo(1,\n'); assert.match(u.message, /没有闭合/); assert.equal(u.line, 1);
  assert.match(one('x = 1)\n').message, /多余/);
});
test('block statements need a colon and an indented body', () => {
  assert.match(one('if x\n    pass\n').message, /冒号|:/);
  assert.match(one('def f()\n    pass\n').message, /冒号|:/);
  assert.match(one('for i in range(3):\nprint(i)\n').message, /缩进/);
  assert.match(one('def f():\n').message, /缩进/);
});
test('indentation errors', () => {
  assert.match(one('x = 1\n    y = 2\n').message, /缩进/);
  assert.match(one('if x:\n        a = 1\n    b = 2\n').message, /缩进|对齐/);
});
test('python 2 print and invalid characters', () => {
  assert.match(one('print "hello"\n').message, /print/);
  assert.deepEqual(msgs('print("ok")\nprint\n'), []);
  assert.match(one('x = a $ b\n').message, /无效字符/);
});
test('brackets, strings and "print x" inside strings/comments are not diagnostics', () => {
  assert.deepEqual(msgs('# if x\ns = "if x\\" ("\nt = \'\'\'\nprint x\n(\n\'\'\'\n'), []);
});
test('positions are 0-based columns inside the line, with positive length', () => {
  const d = one('x = 1\nif y\n    pass\n');
  assert.equal(d.line, 2); assert.ok(d.col >= 0 && d.length > 0);
});
test('never throws and stays fast on garbage and large input', () => {
  for (const s of ['(((((', ')))))', '"""', "'''\"\"\"", '\u0000\u0001', ':\n:\n', '\t\n  \n\t  x\n', 'if\n', '\\', 'x = \\']) EditorCheck.check(s);
  const big = 'def f(a):\n    return [a, (a + 1)]\n'.repeat(5000);
  const t = Date.now(); assert.deepEqual(EditorCheck.check(big), []); assert.ok(Date.now() - t < 1500, 'took ' + (Date.now() - t));
});
test('parser-based: errors the old line scanner missed, with Chinese messages', () => {
  const cases = [
    ['f() = 1\n', 1, /函数调用/], ['f(a=1, b)\n', 1, /位置参数/], ['def f(a=1, b): pass\n', 1, /默认值/],
    ['x = 1 +\n', 1, /语法错误/], ['x = [1, 2 3]\n', 1, /逗号/], ['try:\n    pass\nx = 1\n', 3, /except|finally/],
    ['x = 1 if y\n', 1, /else/], ['x = 0x\n', 1, /数字/], ['a, b += 1\n', 1, /增强赋值/], ['del f()\n', 1, /删除/],
  ];
  for (const [src, line, re] of cases) { const d = one(src); assert.equal(d.line, line, src); assert.match(d.message, re, src); }
});
test('false-positive regression set: valid code the parser must accept', () => {
  const ok = [
    'match x:\n    case [1, *rest] if rest:\n        pass\n    case {"k": v, **kw}:\n        pass\n    case P(x=0) | Q() as q:\n        pass\n    case _:\n        pass\n',
    'match(x)\nmatch = [1]\nmatch[0] = 2\ncase = 3\n_ = case\n', 'print >> f\nx = print\nprint\n',
    'def f(a, /, b, *, c, **d) -> "T":\n    return (yield from g())\n', 'with (open(a) as f, open(b) as g):\n    pass\n',
    'x = [y := 1, y ** 2]\nif any((z := i) for i in x): pass\n', 'x = a[1:2, ::3, ...]\nb = c[:, None]\n',
    'try:\n    pass\nexcept* ValueError as e:\n    pass\n', 'class A(B, metaclass=M, **kw):\n    x: int\n    y: "str" = ""\n',
    'async def f():\n    async with a as b:\n        return [i async for i in b if await i]\n', 'x = {**a, "b": 1}\ny = {*a, 1}\n',
    'if x:\n    pass\n# comment at column 0\n    # indented comment\nelse:\n    pass\n', 'x = 1 \\\n  + 2\n', 'lambda *a, k=1, **kw: (a, k, kw)\n',
    "s = f'{x!r:>{w}}' u'u'\nb = rb'\\d' b''\n", 'del a, b[0], c.d\nglobal g\nassert x, "m"\nraise E from None\n', 'for (a, *b), c in d: pass\n',
  ];
  for (const src of ok) assert.deepEqual(msgs(src), [], JSON.stringify(src));
});
