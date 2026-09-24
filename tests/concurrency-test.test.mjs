import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONCURRENCY_LEVELS,
  CONCURRENCY_REQUEST_BUDGET,
  concurrencyPlan,
  summarizeConcurrencyStage,
  concurrencyConclusion,
  runConcurrencyChunk,
  concurrencyUsesStreaming,
  concurrencyLevelsForRun,
  parseConcurrencyLevels,
  validateConcurrencyLevels,
  concurrencyRequestBudget,
} from '../lib/concurrency-test.ts';

const sample = (sequence, start, end, outcome = 'success') => ({
  sequence,
  upstreamStartedAt: start,
  completedAt: end,
  totalTimeMs: end - start,
  outcome,
});
test('TTFT median excludes missing, invalid, failed and late samples without reusing completion latency', () => {
  const withTtft = (sequence, ttftMs, outcome = 'success', end = 2000) => ({
    ...sample(sequence, 1000, end, outcome),
    ttftMs,
  });
  const s = summarizeConcurrencyStage(0, 1000, [
    manifest([
      withTtft(0, 100),
      withTtft(1, 300),
      withTtft(2, null),
      withTtft(3, 10000, 'rate_limited'),
      withTtft(4, 999, 'success', 62000),
      withTtft(5, NaN),
      withTtft(6, -1),
      withTtft(7, Infinity),
    ]),
  ]);
  assert.equal(s.medianTtftMs, 200);
  assert.equal(s.ttftSamples, 2);
  const old = summarizeConcurrencyStage(0, 1000, [
    manifest([sample(0, 1000, 3000)]),
  ]);
  assert.equal(old.medianTtftMs, null);
  assert.equal(old.ttftSamples, 0);
  assert.equal(concurrencyUsesStreaming(null), false);
  assert.equal(concurrencyUsesStreaming(JSON.stringify({ version: 1 })), false);
  assert.equal(concurrencyUsesStreaming(JSON.stringify({ version: 2 })), true);
  assert.equal(concurrencyUsesStreaming(JSON.stringify({ version: 3 })), true);
});
test('custom levels validate exact integers and retain historical default plans', () => {
  assert.deepEqual(parseConcurrencyLevels('60, 61, 70'), [60, 61, 70]);
  assert.deepEqual(parseConcurrencyLevels('60，61 70'), [60, 61, 70]);
  assert.deepEqual(parseConcurrencyLevels('61'), [61]);
  assert.deepEqual(concurrencyLevelsForRun(null), [...CONCURRENCY_LEVELS]);
  assert.deepEqual(concurrencyLevelsForRun('{"version":2,"stages":[]}'), [
    ...CONCURRENCY_LEVELS,
  ]);
  assert.deepEqual(
    concurrencyLevelsForRun('{"version":3,"levels":[60,61,70]}'),
    [60, 61, 70],
  );
  for (const input of [
    '',
    '60.5',
    '0',
    '-1',
    '201',
    '1e2',
    '61,60',
    '60,60',
    '60,abc',
    '1,2,3,4,5,6,7,8,9,10,11,12,13',
  ])
    assert.throws(() => parseConcurrencyLevels(input), input);
  for (const input of [null, [], ['61'], [Infinity], [NaN], [true]])
    assert.throws(() => validateConcurrencyLevels(input));
  assert.throws(() => concurrencyLevelsForRun('{"version":3,"levels":[201]}'));
});
test('custom plans allocate exactly the requested slots and budget, including a one-slot remainder at 61', () => {
  for (let target = 1; target <= 200; target++) {
    const plan = concurrencyPlan(0, [target]);
    assert.equal(
      plan.shardPlans.reduce((n, shard) => n + shard.concurrency, 0),
      target,
    );
    assert.equal(
      plan.shardPlans.reduce((n, shard) => n + shard.requestCap, 0),
      plan.requestCap,
    );
    assert.ok(
      plan.shardPlans.every(
        (shard) =>
          shard.concurrency >= 1 &&
          shard.concurrency <= 5 &&
          Number.isInteger(shard.requestCap),
      ),
    );
  }
  const plan = concurrencyPlan(1, [60, 61, 70]);
  assert.equal(plan.shards, 13);
  assert.deepEqual(plan.shardPlans.at(-1), { concurrency: 1, requestCap: 5 });
  assert.equal(concurrencyRequestBudget([60, 61, 70]), 955);
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
