import assert from 'node:assert/strict';
import test from 'node:test';
import { normalOutcomes, normalOutcomeTitle } from '../lib/normal-outcomes.ts';

const clean = { normalCount: 12, cacheCount: 0, largeCount: 0, errorCount: 0 };

test('finished includes failures without treating them as normal', () => {
  const mixed = { ...clean, normalCount: 10, errorCount: 2 };
  assert.deepEqual(normalOutcomes(mixed), {
    normal: 10,
    anomaly: 0,
    failed: 2,
    unknown: 0,
    finished: 12,
  });
  assert.equal(normalOutcomeTitle(mixed), '10 normal · 0 anomalies · 2 failed');
});

test('cache observations are neutral; elevated input remains a finding', () => {
  const mixed = {
    ...clean,
    normalCount: 7,
    cacheCount: 2,
    largeCount: 2,
    errorCount: 1,
  };
  assert.deepEqual(normalOutcomes(mixed), {
    normal: 9,
    anomaly: 2,
    failed: 1,
    unknown: 0,
    finished: 12,
  });
  assert.equal(
    normalOutcomeTitle({ ...clean, normalCount: 11, cacheCount: 1 }),
    '12 normal · 0 anomalies · 0 failed',
  );
});

test('missing usage is separate, optional for older saved runs', () => {
  assert.equal(normalOutcomes(clean).unknown, 0);
  const missing = { ...clean, normalCount: 10, unavailableCount: 2 };
  assert.deepEqual(normalOutcomes(missing), {
    normal: 10,
    anomaly: 0,
    failed: 0,
    unknown: 2,
    finished: 12,
  });
  assert.equal(
    normalOutcomeTitle(missing),
    '10 normal · 0 anomalies · 0 failed · 2 unknown',
  );
});

test('unsent or still running requests are not fabricated as failures', () => {
  assert.equal(normalOutcomes({ ...clean, normalCount: 0 }).finished, 0);
  const partial = normalOutcomes({ ...clean, normalCount: 3, errorCount: 1 });
  assert.equal(partial.finished, 4);
  assert.equal(partial.failed, 1);
});
