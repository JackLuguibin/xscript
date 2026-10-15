const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EditorSearch: S} = require('../../android/app/src/main/assets/tools/editor-search.js');
const {EditorModel} = require('../../android/app/src/main/assets/tools/editor-model.js');

test('literal search is case-insensitive by default and escapes regex characters', () => {
  const text = 'Foo.bar(1)\nfoo+bar(1)\nFOO.BAR(1)\n';
  assert.equal(S.find(text, S.compile('foo.bar(1)')).length, 2);
  assert.equal(S.find(text, S.compile('foo.bar(1)', {caseSensitive: true})).length, 0);
  assert.equal(S.find(text, S.compile('Foo.bar(1)', {caseSensitive: true})).length, 1);
});
test('matches carry 1-based line, 0-based column, offsets and a preview', () => {
  const [m] = S.find('a = 1\n    name = "x"\n', S.compile('name'));
  assert.equal(m.line, 2); assert.equal(m.col, 4); assert.equal(m.length, 4); assert.equal(m.index, 10);
  assert.equal(m.before, '    '); assert.equal(m.match, 'name'); assert.equal(m.after, ' = "x"');
});
test('long lines are trimmed around the match and CRLF is tolerated', () => {
  const [m] = S.find('x'.repeat(100) + 'NEEDLE' + 'y'.repeat(200) + '\r\nz\r\n', S.compile('needle'));
  assert.ok(m.before.startsWith('…')); assert.ok(m.before.length <= 31); assert.equal(m.after.length, 80);
  assert.equal(S.find('a\r\nb\r\n', S.compile('b'))[0].line, 2);
});
test('whole word, including non-ASCII words', () => {
  const re = S.compile('run', {word: true});
  assert.deepEqual(S.find('run runner _run run2 run()', re).map(m => m.col), [0, 21]);
  assert.equal(S.find('中文 点击 点击一下', S.compile('点击', {word: true})).length, 1);
});
test('regex mode, groups, anchors per line, invalid and empty-matching patterns', () => {
  assert.equal(S.find('a1\nb22\nc\n', S.compile('^\\w\\d+$', {regex: true})).length, 2);
  assert.throws(() => S.compile('(', {regex: true}), /正则表达式无效/);
  assert.throws(() => S.compile('a*', {regex: true}), /空字符串/);
  assert.throws(() => S.compile('^', {regex: true}), /空字符串/);
  assert.throws(() => S.compile(''), /请输入/);
  assert.equal(S.find('a-b', S.compile('a\\-b', {regex: true})).length, 1);   // escape that is invalid under the u flag still works
});
test('multi-line regex matches report the first line only in the preview', () => {
  const [m] = S.find('def f():\n    pass\n', S.compile('def f\\(\\):\\n\\s+pass', {regex: true}));
  assert.equal(m.line, 1); assert.equal(m.match, 'def f():');
});
test('per-file limit stops the scan', () => {
  assert.equal(S.find('a\n'.repeat(1000), S.compile('a'), 5).length, 5);
});
test('literal replace never interprets $ sequences; regex replace expands them', () => {
  assert.deepEqual(S.replaceAll('x x', S.compile('x'), '$&$1$$'), {text: '$&$1$$ $&$1$$', count: 2});
  const re = S.compile('(\\w+)=(?<v>\\d+)', {regex: true});
  assert.equal(S.replaceAll('a=1 b=22', re, '$<v>:$1:$&:$$:$9', {regex: true}).text, '1:a:a=1:$:$9 22:b:b=22:$:$9');
  assert.equal(S.replaceAll('aaa', S.compile('a'), '').text, '');
  assert.equal(S.replaceAll('nothing', S.compile('zzz'), 'y').count, 0);
});
test('replace keeps unrelated text byte for byte, including line endings', () => {
  assert.equal(S.replaceAll('a\r\nfoo\r\n', S.compile('foo'), 'bar').text, 'a\r\nbar\r\n');
});
test('glob filter: names anywhere, folders, **, exclusions', () => {
  const f = S.globFilter('*.py, lib/**, !tests/**');
  assert.equal(f('a.py'), true); assert.equal(f('x/y/a.py'), true); assert.equal(f('lib/z.txt'), true); assert.equal(f('lib/a/b.txt'), true);
  assert.equal(f('notes.txt'), false); assert.equal(f('tests/t.py'), false);
  assert.equal(S.globFilter('')('anything/at/all'), true);
  assert.equal(S.globFilter('res/')('res/img/a.png'), true);
  assert.equal(S.globFilter('?.py')('a.py'), true); assert.equal(S.globFilter('?.py')('ab.py'), false);
});
test('binary extensions and huge files are skipped', () => {
  assert.equal(S.isSearchable('res/img/a.png', 10), false); assert.equal(S.isSearchable('a.py', 10), true);
  assert.equal(S.isSearchable('a.py', S.MAX_FILE + 1), false);
});

// ---- model: searching and replacing across a fake device ----
function fakeDevice(files) {
  const disk = new Map(Object.entries(files)), writes = [];
  const api = async (method, url, body) => {
    const u = new URL('http://x' + url);
    if (method === 'GET' && u.pathname === '/projects/p/files') return {files: [...disk].map(([path, c]) => ({path, size: c.length})), dirs: []};
    if (method === 'GET' && u.pathname === '/projects/p/file') {
      const p = u.searchParams.get('path'); if (!disk.has(p)) throw new Error('missing file');
      return p.endsWith('.bin') ? {path: p, encoding: 'base64', content: 'AAEC'} : {path: p, encoding: 'utf-8', content: disk.get(p)};
    }
    if (method === 'PUT' && u.pathname === '/projects/p/files') { disk.set(body.path, body.content); writes.push(body.path); return {ok: true}; }
    throw new Error('unexpected ' + method + ' ' + url);
  };
  return {api, disk, writes};
}
test('searchProject: filters, binary skipped, open unsaved documents win, results sorted', async () => {
  const d = fakeDevice({'__init__.py': 'import util\nutil.go()\n', 'util.py': 'def go(): pass\n', 'lib/a.py': 'go = 1\n# GO\n', 'img.bin': 'go', 'notes.txt': 'go\n'});
  const model = new EditorModel(d.api); model.project = 'p';
  let r = await model.searchProject('go', {word: true});
  assert.deepEqual(r.results.map(x => x.path), ['__init__.py', 'lib/a.py', 'notes.txt', 'util.py']);
  assert.equal(r.matches, 5); assert.equal(r.skipped, 1);
  r = await model.searchProject('go', {word: true, include: '*.py, !lib/**'});
  assert.deepEqual(r.results.map(x => x.path), ['__init__.py', 'util.py']);
  const doc = await model.open('util.py'); model.edit(doc, 'nothing here\n');
  r = await model.searchProject('go', {word: true, include: 'util.py'});
  assert.equal(r.matches, 0, 'unsaved content is what is searched');
  await assert.rejects(model.searchProject('(', {regex: true}), /正则/);
});
test('replaceInFiles: saves clean files, leaves unsaved ones dirty, reports counts', async () => {
  const d = fakeDevice({'a.py': 'x = old\nold()\n', 'b.py': 'old\n', 'c.py': 'keep\n'});
  const model = new EditorModel(d.api); model.project = 'p';
  const b = await model.open('b.py'); model.edit(b, 'old # mine\n');
  const r = await model.replaceInFiles(['a.py', 'b.py', 'c.py'], 'old', 'new', {word: true});
  assert.deepEqual({files: r.files, count: r.count, unsaved: r.unsaved}, {files: 2, count: 3, unsaved: ['b.py']});
  assert.equal(d.disk.get('a.py'), 'x = new\nnew()\n'); assert.deepEqual(d.writes, ['a.py']);
  assert.equal(d.disk.get('b.py'), 'old\n', 'disk untouched for a file with unsaved edits'); assert.equal(b.content, 'new # mine\n'); assert.ok(model.dirty(b));
  assert.equal(d.disk.get('c.py'), 'keep\n');
});
test('tab helpers: which tabs close and which becomes active', () => {
  const t = ['a', 'b', 'c', 'd'].map(n => ({path: n}));
  const dirty = x => x.path === 'b';
  const paths = list => list.map(x => x.path).join('');
  assert.equal(paths(EditorModel.tabsToClose(t, t[1], 'one', dirty)), 'b');
  assert.equal(paths(EditorModel.tabsToClose(t, t[1], 'others', dirty)), 'acd');
  assert.equal(paths(EditorModel.tabsToClose(t, t[1], 'right', dirty)), 'cd');
  assert.equal(paths(EditorModel.tabsToClose(t, t[1], 'saved', dirty)), 'acd');
  assert.equal(paths(EditorModel.tabsToClose(t, t[1], 'all', dirty)), 'abcd');
  assert.equal(EditorModel.nextTab(t, t[1], [t[1]]).path, 'a');
  assert.equal(EditorModel.nextTab(t, t[0], [t[0]]).path, 'b');
  assert.equal(EditorModel.nextTab(t, t[2], [t[2], t[1]]).path, 'a');
  assert.equal(EditorModel.nextTab(t, t[1], t), null);
  assert.equal(EditorModel.nextTab(t, t[0], [t[2]]), t[0], 'closing another tab keeps the active one');
});
