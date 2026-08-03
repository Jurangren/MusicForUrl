const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateGenerationTiming } = require('../lib/generation-estimate');

test('estimates remaining render time from uncached media work', () => {
  const now = 100_000;
  const timing = estimateGenerationTiming({
    status: 'running',
    createdAt: now - 12_000,
    workStartedAt: now - 10_000,
    workTotalSeconds: 400,
    workCompletedSeconds: 100
  }, 100, now);
  assert.deepEqual(timing, { elapsedSeconds: 12, etaSeconds: 10 });
});

test('waits for enough real progress before showing an ETA', () => {
  const now = 100_000;
  const timing = estimateGenerationTiming({
    status: 'running',
    createdAt: now - 2_000,
    workStartedAt: now - 2_000,
    workTotalSeconds: 400,
    workCompletedSeconds: 0
  }, 0.5, now);
  assert.equal(timing.elapsedSeconds, 2);
  assert.equal(timing.etaSeconds, null);
});

test('freezes elapsed time and reports zero ETA after completion', () => {
  const timing = estimateGenerationTiming({
    status: 'completed',
    createdAt: 10_000,
    finishedAt: 25_500
  }, 0, 50_000);
  assert.deepEqual(timing, { elapsedSeconds: 15, etaSeconds: 0 });
});
