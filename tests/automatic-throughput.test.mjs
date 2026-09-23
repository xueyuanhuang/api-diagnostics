import assert from 'node:assert/strict';
import test from 'node:test';
import { measureAutomaticThroughput } from '../lib/automatic-throughput.ts';

test('automatic work keeps bounded concurrency, measures completions and honors request budget', async () => {
  let inflight = 0,
    peak = 0;
  const saved = [];
  const result = await measureAutomaticThroughput({
    signal: new AbortController().signal,
    concurrency: 3,
    requestCap: 12,
    durationMs: 1000,
    request: async (sequence) => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 2));
      inflight--;
      return {
        outcome: sequence % 3 ? 'success' : 'server_error',
        completedAt: Date.now(),
        totalTimeMs: 2,
      };
    },
    save: async (sample, sequence) => {
      saved.push(sequence);
    },
  });
  assert.equal(peak, 3);
  assert.equal(result.metrics.sent, 12);
  assert.equal(result.metrics.completed, 12);
  assert.equal(result.metrics.succeeded, 8);
  assert.equal(result.metrics.stopReason, 'request_cap');
  assert.equal(saved.length, 12);
  assert.equal(
    result.metrics.successfulRps,
    (result.metrics.succeeded * 1000) / result.metrics.elapsedMs,
  );
});
test('responses arriving after the observation window are retained but excluded from measured completions', async () => {
  let clock = 0;
  const result = await measureAutomaticThroughput({
    now: () => clock,
    signal: new AbortController().signal,
    concurrency: 1,
    requestCap: 20,
    durationMs: 10,
    request: async () => {
      clock += 7;
      return { outcome: 'success', completedAt: clock, totalTimeMs: 7 };
    },
    save: async () => {},
  });
  assert.equal(result.metrics.sent, 2);
  assert.equal(result.metrics.completed, 1);
  assert.equal(result.metrics.lateResponses, 1);
  assert.equal(result.metrics.elapsedMs, 10);
  assert.equal(result.metrics.successfulRps, 100);
});
test('cancel and evidence failure prevent additional automatic requests', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await measureAutomaticThroughput({
    signal: controller.signal,
    concurrency: 1,
    request: async () => {
      calls++;
      controller.abort();
      return { outcome: 'success', completedAt: Date.now(), totalTimeMs: 1 };
    },
    save: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(result.metrics.stopReason, 'cancelled');
  calls = 0;
  const failed = await measureAutomaticThroughput({
    signal: new AbortController().signal,
    concurrency: 1,
    request: async () => {
      calls++;
      return { outcome: 'success', completedAt: Date.now(), totalTimeMs: 1 };
    },
    save: async () => {
      throw new Error('storage unavailable');
    },
  });
  assert.equal(calls, 1);
  assert.equal(failed.failed, true);
});
test('rate limiting pauses workers instead of hammering the provider', async () => {
  let clock = 0;
  const pauses = [];
  const result = await measureAutomaticThroughput({
    now: () => clock,
    signal: new AbortController().signal,
    concurrency: 1,
    durationMs: 2000,
    requestCap: 20,
    request: async () => ({
      outcome: 'rate_limited',
      completedAt: clock,
      totalTimeMs: 0,
    }),
    save: async () => {},
    sleep: async (ms) => {
      pauses.push(ms);
      clock += ms;
    },
  });
  assert.deepEqual(pauses, [1000, 1000]);
  assert.equal(result.metrics.sent, 2);
  assert.equal(result.metrics.successfulRps, 0);
});

 test('hosting request exhaustion stops the run and preserves its reason', async () => {
  let calls = 0;
  const result = await measureAutomaticThroughput({
    signal: new AbortController().signal,
    concurrency: 1,
    request: async () => {
      calls++;
      return { outcome: 'transport_error', error: 'Too many subrequests by single Worker invocation.', completedAt: Date.now(), totalTimeMs: 0 };
    },
    save: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(result.failed, true);
  assert.match(result.failureReason, /hosting request limit/);
 });
