/* Web IDE typing benchmark: headless Chrome against scripts/mock_device.py with a generated Python file.
 *
 *   node scripts/bench/webide_typing.cjs [--lines 2000] [--check]
 *
 * Measures opening the file (page load -> text in the editor -> 2 frames) and 40 keystrokes typed mid-file
 * (input handler + next frame, ~16 keys/s), counting long tasks (>50 ms) while typing.
 * --check compares with the soft budgets below: over budget prints a GitHub "::warning::" (and a line in the job
 * summary) but still exits 0, so a slow runner never blocks a merge; only a crash exits 1.
 * Budgets are set for the GitHub ubuntu runner (much slower than a Mac): at 2 000 lines main measured a keystroke
 * median of 96-115 ms with 67-82 long tasks; the editor from before #337 measured 303 ms and 172 long tasks there.
 * The budgets sit between the two. (On a Mac: ~38 ms / 0 long tasks now, ~66 ms / ~25 before #337.) */
const path = require('node:path'), fs = require('node:fs'), {spawn} = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const cdp = require(path.join(repo, 'scripts/tests/cdp.cjs'));
const args = process.argv.slice(2);
const lines = args.includes('--lines') ? Number(args[args.indexOf('--lines') + 1]) : 2000;
const check = args.includes('--check');
const BUDGET = {keyMedianMs: 180, keyP90Ms: 250, longTasksWhileTyping: 130};

/** Over-budget messages for one result (exported shape for the unit test). */
function overBudget(r, budget = BUDGET) {
  const out = [];
  if (r.median > budget.keyMedianMs) out.push(`keystroke median ${r.median} ms > ${budget.keyMedianMs} ms`);
  if (r.p90 > budget.keyP90Ms) out.push(`keystroke p90 ${r.p90} ms > ${budget.keyP90Ms} ms`);
  if (r.longDuring.length > budget.longTasksWhileTyping) out.push(`${r.longDuring.length} long tasks while typing > ${budget.longTasksWhileTyping}`);
  return out;
}
module.exports = {overBudget, BUDGET};

async function main() {
  const chrome = cdp.find();
  if (!chrome) { console.log('webide_typing: no Chrome found ($CHROME or ~/.cache/puppeteer); skipped'); return; }
  const child = spawn(process.env.PYTHON || 'python3', ['-u', '-c', 'import sys,threading;sys.path.insert(0,"scripts");from mock_device import serve;s=serve();print(s.server_address[1],flush=True);threading.Event().wait()'], {cwd: repo, stdio: ['ignore', 'pipe', 'inherit']});
  const port = await new Promise(r => child.stdout.once('data', b => r(Number(String(b).trim()))));
  const base = 'http://127.0.0.1:' + port;
  const api = (m, u, body) => fetch(base + u, {method: m, headers: {'Content-Type': 'application/json'}, body: body && JSON.stringify(body)}).then(r => r.json());
  const big = Array.from({length: lines}, (_, i) => i % 50 === 0 ? `def f${i}(x, y=1):\n    return x + y  # line ${i}` : `value_${i} = f${i - i % 50}(${i}, y=2)  # some text ${i}`).join('\n') + '\n';
  await api('POST', '/projects/bench', {});
  await api('PUT', '/projects/bench/files', {files: [{path: '__init__.py', content: big}]});
  const b = await cdp.launch(chrome);
  try {
    const opens = [];
    for (let k = 0; k < 3; k++) {
      const t0 = Date.now();
      await b.goto(base + '/tools/ui/editor.html?project=bench');
      await b.waitFor(n => document.getElementById('editor').value.length === n && !document.getElementById('editor').disabled, 60000, big.length);
      await b.eval(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      opens.push(Date.now() - t0);
    }
    const r = await b.eval(async () => {
      const long = []; new PerformanceObserver(l => l.getEntries().forEach(e => long.push(Math.round(e.duration)))).observe({type: 'longtask', buffered: false});
      const e = document.getElementById('editor'); e.focus();
      const at = Math.floor(e.value.length / 2); e.setSelectionRange(at, at);
      const times = [];
      for (let i = 0; i < 40; i++) {
        const t = performance.now();
        e.setRangeText('x', e.selectionStart, e.selectionEnd, 'end'); e.dispatchEvent(new InputEvent('input', {inputType: 'insertText', data: 'x'}));
        await new Promise(res => requestAnimationFrame(() => setTimeout(res, 0)));
        times.push(performance.now() - t);
        await new Promise(res => setTimeout(res, 60));
      }
      times.sort((x, y) => x - y);
      return {median: Math.round(times[20]), p90: Math.round(times[36]), max: Math.round(times[39]), longDuring: long.slice()};
    });
    const line = `Web IDE typing, ${lines} lines: open ${opens.join('/')} ms; keystroke median ${r.median} p90 ${r.p90} max ${r.max} ms; long tasks while typing ${r.longDuring.length}`;
    console.log(line);
    if (!check) return;
    const over = overBudget(r);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) fs.appendFileSync(summary, `- ${line}${over.length ? ' — **over soft budget**: ' + over.join('; ') : ' (within budget)'}\n`);
    for (const m of over) console.log(`::warning title=Web IDE typing benchmark::${m} (${lines} lines; soft budget, see scripts/bench/webide_typing.cjs)`);
    if (!over.length) console.log('within soft budget', JSON.stringify(BUDGET));
  } finally { child.kill(); await Promise.race([b.close(), new Promise(res => setTimeout(res, 5000))]); }
}
if (require.main === module) main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
