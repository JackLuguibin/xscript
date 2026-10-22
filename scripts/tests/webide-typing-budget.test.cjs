/* scripts/bench/webide_typing.cjs soft budget: which results warn (the CI step never fails on them). */
const test = require('node:test'), assert = require('node:assert/strict');
const {overBudget, BUDGET} = require('../bench/webide_typing.cjs');

test('typing benchmark budget: within, slow keys, long tasks', () => {
  assert.deepEqual(overBudget({median: 38, p90: 44, longDuring: []}), []);
  // before #337 at 2 000 lines on a Mac: ~66 ms per key but ~30 long tasks; the long-task budget catches it
  assert.deepEqual(overBudget({median: 66, p90: 84, longDuring: Array(30).fill(60)}), [`30 long tasks while typing > ${BUDGET.longTasksWhileTyping}`]);
  assert.equal(overBudget({median: BUDGET.keyMedianMs + 1, p90: BUDGET.keyP90Ms + 1, longDuring: []}).length, 2);
});
