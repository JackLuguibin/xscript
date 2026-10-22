/* scripts/bench/webide_typing.cjs soft budget: which results warn (the CI step never fails on them). */
const test = require('node:test'), assert = require('node:assert/strict');
const {overBudget, BUDGET} = require('../bench/webide_typing.cjs');

test('typing benchmark budget: within, slow keys, long tasks', () => {
  // GitHub runner, 2 000 lines: main now passes, the editor from before #337 warns on all three
  assert.deepEqual(overBudget({median: 115, p90: 140, longDuring: Array(82).fill(60)}), []);
  assert.equal(overBudget({median: 303, p90: 346, longDuring: Array(172).fill(60)}).length, 3);
  assert.equal(overBudget({median: BUDGET.keyMedianMs + 1, p90: BUDGET.keyP90Ms + 1, longDuring: []}).length, 2);
});
