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
test('renameInFiles: exact positions, all-or-nothing when stale, undoable like a replace', async () => {
  const d = fakeDevice({'a.py': 'def f():\n    return f_x\n', 'b.py': 'from a import f\nf()\n'});
  const model = new EditorModel(d.api); model.project = 'p';
  const edits = [{path: 'a.py', line: 1, col: 4, length: 1}, {path: 'b.py', line: 1, col: 14, length: 1}, {path: 'b.py', line: 2, col: 0, length: 1}];
  const r = await model.renameInFiles(edits, 'f', 'go');
  assert.deepEqual({files: r.files, count: r.count, unsaved: r.unsaved, undoable: r.undoable}, {files: 2, count: 3, unsaved: [], undoable: true});
  assert.equal(d.disk.get('a.py'), 'def go():\n    return f_x\n', 'f_x is not touched');
  assert.equal(d.disk.get('b.py'), 'from a import go\ngo()\n');
  await model.undoReplace();
  assert.equal(d.disk.get('a.py'), 'def f():\n    return f_x\n'); assert.equal(d.disk.get('b.py'), 'from a import f\nf()\n');
  // a file changed since the analysis: nothing is written anywhere
  const b = await model.open('b.py'); model.edit(b, '\nfrom a import f\nf()\n');
  await assert.rejects(model.renameInFiles(edits, 'f', 'go'), /b\.py 在分析之后改过/);
  assert.equal(d.disk.get('a.py'), 'def f():\n    return f_x\n');
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

// ---- ReDoS guard (static part; the worker timeout is exercised in the browser test) ----
test('riskyRegex flags nested unbounded repeats and over-long patterns, not ordinary ones', () => {
  for (const bad of ['(a+)+', '(\\w*)*', '(.+)*', '(?:[ab]+){2,}', '(a+)+b', '(?<n>x*)*', '(\\d+)+$']) assert.ok(S.riskyRegex(bad), bad);
  for (const ok of ['(\\d+\\.)*', '(foo|bar)+', '([a-z]+)\\s', '(?=a+)+', '\\(a+\\)+', '[(a+)+]', '(a+){1,5}', 'a+b*', '(a|aa)+', '(x)+', '(?:ab)+']) assert.equal(S.riskyRegex(ok), '', ok);
  assert.match(S.riskyRegex('a'.repeat(S.MAX_PATTERN + 1)), /太长/);
});
test('compile rejects risky regexes only in regex mode', () => {
  assert.throws(() => S.compile('(a+)+$', {regex: true}), /嵌套的无限重复/);
  assert.equal(S.find('(a+)+$ here', S.compile('(a+)+$')).length, 1, 'literal mode escapes it');
  assert.doesNotThrow(() => S.compile('(foo|bar)+', {regex: true}));
});
test('guard runs inline outside a browser and behaves like find / replaceAll', async () => {
  const g = S.guard({regex: true});
  assert.equal(g.worker, false);
  assert.equal((await g.find('a1 b22', S.compile('\\w\\d+', {regex: true}), 10)).length, 2);
  assert.deepEqual(await g.replaceAll('a=1', S.compile('(\\w)=(\\d)', {regex: true}), '$2=$1', {regex: true}), {text: '1=a', count: 1});
  g.dispose();
});

// ---- model: one-step undo of a replace ----
test('undoReplace restores written files and edited-only files, and leaves files changed since alone', async () => {
  const d = fakeDevice({'a.py': 'x = old\nold()\n', 'b.py': 'old\n', 'c.py': 'old\n', 'd.py': 'keep\n'});
  const model = new EditorModel(d.api); model.project = 'p';
  const b = await model.open('b.py'); model.edit(b, 'old # mine\n');          // unsaved edit: replace only changes the editor
  const r = await model.replaceInFiles(['a.py', 'b.py', 'c.py', 'd.py'], 'old', 'new', {word: true});
  assert.equal(r.undoable, true);
  assert.equal(d.disk.get('a.py'), 'x = new\nnew()\n');
  const c = await model.open('c.py'); model.edit(c, 'new + mine\n');          // edited after the replace
  const u = await model.undoReplace();
  assert.deepEqual(u.restored.sort(), ['a.py', 'b.py']);
  assert.deepEqual(u.skipped, [{path: 'c.py', reason: '替换之后又被修改过'}]);
  assert.equal(d.disk.get('a.py'), 'x = old\nold()\n', 'written back to the device');
  assert.equal(b.content, 'old # mine\n'); assert.ok(model.dirty(b), 'still unsaved: it was unsaved before');
  assert.equal(d.disk.get('b.py'), 'old\n'); assert.equal(c.content, 'new + mine\n');
  assert.equal(d.disk.get('d.py'), 'keep\n');
  assert.ok(model.lastReplace && model.lastReplace.changes.length === 1, 'the skipped file stays undoable');
  await model.undoReplace().then(x => assert.equal(x.restored.length, 0));
});
test('undoReplace is one step: a new replace forgets the old one; nothing to undo throws; missing file is skipped', async () => {
  const d = fakeDevice({'a.py': 'one\n', 'b.py': 'one\n'});
  const model = new EditorModel(d.api); model.project = 'p';
  await assert.rejects(model.undoReplace(), /没有可撤销/);
  await model.replaceInFiles(['a.py'], 'one', 'two');
  await model.replaceInFiles(['b.py'], 'one', 'three');
  assert.deepEqual(model.lastReplace.changes.map(c => c.path), ['b.py'], 'only the latest replace is kept');
  d.disk.delete('b.py'); model.documents.clear();
  const u = await model.undoReplace();
  assert.deepEqual(u, {restored: [], skipped: [{path: 'b.py', reason: '文件已不存在'}]});
  assert.equal(model.lastReplace, null);
  assert.equal(d.disk.get('a.py'), 'two\n', 'the earlier replace is not undone');
});
test('a replace that changed nothing keeps the previous undo; an oversized one is not remembered', async () => {
  const d = fakeDevice({'a.py': 'one\n'});
  const model = new EditorModel(d.api); model.project = 'p';
  await model.replaceInFiles(['a.py'], 'one', 'two');
  const keep = model.lastReplace;
  const r = await model.replaceInFiles(['a.py'], 'zzz', 'y');
  assert.equal(r.files, 0);
  assert.equal(model.lastReplace, keep, 'a replace that matched nothing leaves the undo slot alone');
  model.rememberReplace('p', [{path: 'big', before: 'x'.repeat(EditorModel.MAX_UNDO_CHARS), after: 'y', saved: true}]);
  assert.equal(model.lastReplace, null);
  assert.ok(keep);
});
