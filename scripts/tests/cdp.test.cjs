/* cdp.launch() when Chrome fails to start: every failed start is killed and its profile removed before the retry,
 * so a hung Chrome cannot keep `node --test` alive until the CI job limit. A fake "Chrome" (a shell script that
 * logs its pid and profile, then hangs or exits) stands in for the browser. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cdp = require('./cdp.cjs');

function fakeChrome(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-fake-chrome-'));
  const log = path.join(dir, 'starts.log');
  const bin = path.join(dir, 'chrome');
  fs.writeFileSync(bin, '#!/bin/sh\nfor a in "$@"; do case "$a" in --user-data-dir=*) p="${a#--user-data-dir=}";; esac; done\n' +
    'echo "$$ $p" >> "' + log + '"\n' + body + '\n', {mode: 0o755});
  // no log yet = no fake got as far as its first line (it can be killed at the startup deadline before that)
  const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []).map(l => { const [pid, profile] = l.split(' '); return {pid: Number(pid), profile}; });
  return {bin, starts, cleanup: () => fs.rmSync(dir, {recursive: true, force: true})};
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a Chrome that never reports its DevTools socket is killed and retried once', {skip: process.platform === 'win32'}, async () => {
  const fake = fakeChrome('exec sleep 600');
  const spawned = [];
  try {
    const t0 = Date.now();
    await assert.rejects(cdp.launch(fake.bin, {startupMs: 1000, onStart: (child, profile) => spawned.push({pid: child.pid, profile})}),
      /Chrome startup timed out/);
    assert.ok(Date.now() - t0 < 10000, 'both attempts end promptly');
    // Counted at spawn time: under load a fake can be killed at the deadline before its shell logs anything.
    assert.equal(spawned.length, 2, 'one retry');
    for (const s of spawned) {
      assert.equal(alive(s.pid), false, 'Chrome ' + s.pid + ' was killed');
      assert.equal(fs.existsSync(s.profile), false, 'profile ' + s.profile + ' was removed');
    }
    assert.notEqual(spawned[0].profile, spawned[1].profile, 'the retry gets a fresh profile');
    for (const s of fake.starts()) assert.ok(spawned.some(x => x.pid === s.pid && x.profile === s.profile), 'every start that logged was one of ours');
  } finally { fake.cleanup(); }
});

test('a Chrome that exits during startup is retried, then the exit is reported', {skip: process.platform === 'win32'}, async () => {
  const fake = fakeChrome('echo "no display" >&2\nexit 3');
  try {
    await assert.rejects(cdp.launch(fake.bin, {startupMs: 5000, attempts: 3}), /Chrome exited 3: no display/);
    const starts = fake.starts();
    assert.equal(starts.length, 3);
    for (const s of starts) assert.equal(fs.existsSync(s.profile), false);
  } finally { fake.cleanup(); }
});
