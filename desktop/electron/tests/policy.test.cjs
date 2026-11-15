const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { rendererRequest, trusted, staticPath } = require('../policy.cjs');

test('renderer cannot inject native or host envelopes', () => {
  assert.deepEqual(rendererRequest(JSON.stringify({ id: 1, method: 'app.ping', params: {}, _host: 'resource', nativeResult: '1' })), { id: 1, method: 'app.ping', params: {} });
  for (const raw of ['null', '[]', '{}', '"text"', '{']) assert.throws(() => rendererRequest(raw));
  assert.throws(() => rendererRequest(' '.repeat(4 * 1024 * 1024 + 1)));
});
test('only the application or explicit dev origin is trusted', () => {
  assert.equal(trusted('xsapp://app/index.html'), true);
  for (const url of ['https://evil.test', 'xsapp://evil/index.html', 'file:///tmp/index.html']) assert.equal(trusted(url), false);
  assert.equal(trusted('http://localhost:5173/', 'http://localhost:5173'), true);
  assert.equal(trusted('http://localhost:5174/', 'http://localhost:5173'), false);
});
test('static resources reject traversal and symlink escapes', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xscript-policy-'));
  try {
    const root = path.join(temp, 'web');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'index.html'), 'ok');
    await fs.writeFile(path.join(temp, 'secret'), 'secret');
    try { await fs.symlink(path.join(temp, 'secret'), path.join(root, 'escape')); }
    catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      t.diagnostic('Runner cannot create symlinks; traversal checks still run');
    }
    assert.equal(await staticPath(root, '/'), await fs.realpath(path.join(root, 'index.html')));
    for (const url of ['/../secret', '/%2e%2e/secret', '/escape', '/a%00', '/a%5cb']) assert.equal(await staticPath(root, url), null);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
