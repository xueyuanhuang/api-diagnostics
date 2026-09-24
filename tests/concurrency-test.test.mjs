import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONCURRENCY_LEVELS,
  CONCURRENCY_REQUEST_BUDGET,
  concurrencyPlan,
  summarizeConcurrencyStage,
  concurrencyConclusion,
  runConcurrencyChunk,
} from '../lib/concurrency-test.ts';

const sample = (sequence, start, end, outcome = 'success') => ({
  sequence,
  upstreamStartedAt: start,
  completedAt: end,
  totalTimeMs: end - start,
  outcome,
});
const manifest = (samples, extra = {}) => ({
  stageIndex: 0,
  shardIndex: 0,
  complete: true,
  failed: false,
  finishedAt: 999999,
  nextChunk: null,
  samples,
  ...extra,
});
test('five-concurrent clean measurement is not reported as a provider limit', () => {
  const s = summarizeConcurrencyStage(0, 1000, [
    manifest(
      Array.from({ length: 100 }, (_, i) =>
        sample(
          i,
          1000 + Math.floor(i / 5) * 3000,
          1000 + (Math.floor(i / 5) + 1) * 3000,
        ),
      ),
    ),
  ]);
  assert.equal(s.successfulRps * 60, 100);
  assert.equal(s.peakConcurrency, 5);
  assert.equal(s.averageConcurrency, 5);
  assert.equal(s.secondsAtTarget, 60);
  assert.equal(s.outcome, 'no_limit_observed');
  assert.match(
    concurrencyConclusion([s]),
    /Limit not reached.*Higher concurrency remains untested/,
  );
});
test('late success cannot inflate throughput; late 429 still stops escalation', () => {
  const s = summarizeConcurrencyStage(0, 1000, [
    manifest([
      sample(0, 1000, 1100),
      sample(1, 60000, 63000),
      sample(2, 60000, 64000, 'rate_limited'),
    ]),
  ]);
  assert.equal(s.elapsedMs, 60000);
  assert.equal(s.succeeded, 1);
  assert.equal(s.lateResponses, 2);
  assert.equal(s.rateLimited, 1);
  assert.equal(s.outcome, 'rate_limit_observed');
  assert.match(concurrencyConclusion([s]), /not the model’s hard limit/);
});
test('empty, missing, duplicate and local-failure evidence never establishes provider capacity', () => {
  for (const data of [
    [],
    [manifest([])],
    [manifest([sample(0, 1000, 2000), sample(0, 1000, 2000)])],
    [manifest([sample(0, 1000, 2000, 'transport_error')])],
  ]) {
    const s = summarizeConcurrencyStage(0, 1000, data);
    assert.equal(s.outcome, 'tester_incomplete');
  }
  const bad = summarizeConcurrencyStage(1, 1000, [
    manifest([sample(0, 1000, 2000)], { stageIndex: 1 }),
  ]);
  assert.equal(bad.complete, false);
});
test('actual overlap and storage-independent time reveal under-delivered concurrency', () => {
  const s = summarizeConcurrencyStage(0, 1000, [
    manifest([sample(0, 1000, 2000), sample(1, 2000, 3000)]),
  ]);
  assert.equal(s.peakConcurrency, 1);
  assert.equal(s.secondsAtTarget, 0);
  assert.equal(s.elapsedMs, 2000);
  assert.equal(s.averageConcurrency, 1);
  assert.equal(s.successfulRps, 1);
  assert.match(concurrencyConclusion([s]), /actual peak 1/);
});
test('200 concurrency uses forty independent five-slot workers with bounded budgets', async () => {
  const p = concurrencyPlan(5);
  assert.equal(p.shards, 40);
  assert.equal(p.shardCap, 25);
  let active = 0,
    peak = 0;
  const start = Date.now(),
    abort = new AbortController();
  const results = await Promise.all(
    Array.from({ length: p.shards }, async (_, shard) => {
      let local = 0,
        localPeak = 0;
      const result = await runConcurrencyChunk({
        start,
        deadline: start + 60000,
        first: 0,
        count: 25,
        signal: abort.signal,
        stopped: () => false,
        request: async (ordinal) => {
          active++;
          local++;
          peak = Math.max(peak, active);
          localPeak = Math.max(localPeak, local);
          const begin = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          local--;
          return sample(shard + ordinal * p.shards, begin, Date.now());
        },
      });
      assert.equal(result.samples.length, 25);
      assert.equal(localPeak, 5);
      assert.equal(result.failed, false);
      return manifest(result.samples, { stageIndex: 5, shardIndex: shard });
    }),
  );
  assert.equal(peak, 200);
  const s = summarizeConcurrencyStage(5, start, results);
  assert.equal(s.attempts, 1000);
  assert.equal(s.peakConcurrency, 200);
  assert.ok(s.secondsAtTarget > 0);
  assert.equal(s.budgetReached, true);
  assert.equal(
    CONCURRENCY_REQUEST_BUDGET,
    CONCURRENCY_LEVELS.reduce(
      (n, _, i) => n + concurrencyPlan(i).requestCap,
      0,
    ),
  );
});
test('429, other failures, cancellation and shared stop suppress replacement requests', async () => {
  for (const outcome of [
    'rate_limited',
    'client_error',
    'server_error',
    'transport_error',
    'timeout',
  ]) {
    let calls = 0;
    const r = await runConcurrencyChunk({
      start: 0,
      deadline: 1000,
      first: 0,
      count: 25,
      signal: new AbortController().signal,
      stopped: () => false,
      now: () => 1,
      request: async (sequence) => {
        calls++;
        return sample(sequence, 0, 1, outcome);
      },
    });
    assert.ok(calls <= 5);
    assert.equal(r.observedError, true);
  }
  for (const stopped of [false, true]) {
    const abort = new AbortController();
    if (!stopped) abort.abort();
    const r = await runConcurrencyChunk({
      start: 0,
      deadline: 1000,
      first: 0,
      count: 25,
      signal: abort.signal,
      stopped: () => stopped,
      request: () => {
        throw Error('No traffic expected');
      },
    });
    assert.equal(r.samples.length, 0);
  }
});
