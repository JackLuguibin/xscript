const {test} = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../android/app/src/main/assets/tools/editor-syntax.js');
const kinds = (src, type) => S.tokenizePython(src).filter(t => t.type === type).map(t => t.text);

test('tokens always reproduce the source exactly (overlay alignment)', () => {
  const samples = ['', '\n', 'x = 1\n\n', 'def f():\n\treturn "a\\"b"  # 中文\n', "s = '''open\nnever closed", 'x = "unterminated\ny = 2', '@a.b(1)\nclass C: pass', 'π = 3.14j; λ = 1e-3', '\r\nprint(1)\r\n'];
  for (const src of samples) assert.equal(S.tokenizePython(src).map(t => t.text).join(''), src, JSON.stringify(src));
});
test('keywords, builtins, definitions, self and decorators are classified', () => {
  const src = '@retry(times=3)\nasync def tap(self, name):\n    if name is None and not True:\n        print(len(name))\nclass Bot(object): pass\n';
  assert.deepEqual(kinds(src, 'keyword'), ['async', 'def', 'if', 'is', 'None', 'and', 'not', 'True', 'class', 'pass']);
  assert.deepEqual(kinds(src, 'function'), ['tap']);
  assert.deepEqual(kinds(src, 'class'), ['Bot']);
  assert.deepEqual(kinds(src, 'builtin'), ['print', 'len', 'object']);
  assert.deepEqual(kinds(src, 'self'), ['self']);
  assert.deepEqual(kinds(src, 'decorator'), ['@retry']);
});
test('strings and comments hide keywords inside them; prefixes and triple quotes work', () => {
  const src = 'a = "if def"  # return class\nb = f"{x!r}" + rb\'\\x00\' + """multi\nline if"""\nrb = 1\n';
  assert.deepEqual(kinds(src, 'string'), ['"if def"', 'f"{x!r}"', "rb'\\x00'", '"""multi\nline if"""']);
  assert.deepEqual(kinds(src, 'comment'), ['# return class']);
  assert.deepEqual(kinds(src, 'keyword'), []);
  assert.ok(S.tokenizePython(src).some(t => t.type === 'plain' && t.text.includes('rb')), 'bare rb is an identifier');
});
test('numbers in common Python forms', () => {
  assert.deepEqual(kinds('a = [0x1F, 0o17, 0b10, 1_000, 3.5, .5, 2e10, 1j, x1]', 'number'), ['0x1F', '0o17', '0b10', '1_000', '3.5', '.5', '2e10', '1j']);
});
test('HTML is escaped and only .py files are highlighted', () => {
  const html = S.highlight('main.py', 'x = "<b>&"\n');
  assert.match(html, /<span class="tok-string">"&lt;b&gt;&amp;"<\/span>/);
  assert.doesNotMatch(html, /<b>/);
  assert.equal(S.highlight('data.json', '{"if": 1}<'), '{"if": 1}&lt;');
  assert.equal(S.highlight('big.py', 'def x', 3), 'def x');
  assert.match(S.highlight('Tool.PYW', 'def x'), /tok-keyword/);
});
test('large files tokenize quickly', () => {
  const src = 'def f(x):\n    return x + 1  # c\n'.repeat(5000);
  const t = Date.now(); S.highlight('a.py', src); assert.ok(Date.now() - t < 1500);
});
