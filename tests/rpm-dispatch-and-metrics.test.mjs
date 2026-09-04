import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { plannedRequestAt, sequencesForShard } from '../lib/rpm-dispatch.ts';
import { deriveStageMetrics } from '../lib/rpm-stage-metrics.ts';
import {
  RPM_MAX_PROVIDER_CALLS_PER_SHARD,
  RPM_MAX_TARGET_RPM,
  rpmShardCount,
} from '../lib/rpm-types.ts';
import { runProviderRequest } from '../lib/server/rpm-provider.ts';

const componentPath = new URL(
  '../components/rpm-ramp-test.tsx',
  import.meta.url,
);
const shardRoutePath = new URL(
  '../app/api/rpm-runs/[id]/stages/[stage]/shards/[shard]/route.ts',
  import.meta.url,
);
const armRoutePath = new URL(
  '../app/api/rpm-runs/[id]/stages/[stage]/arm/route.ts',
  import.meta.url,
);
const startRoutePath = new URL(
  '../app/api/rpm-runs/[id]/stages/[stage]/start/route.ts',
  import.meta.url,
);
const finalizeRoutePath = new URL(
  '../app/api/rpm-runs/[id]/stages/[stage]/finalize/route.ts',
  import.meta.url,
);
const exportRoutePath = new URL(
  '../app/api/rpm-runs/[id]/export/route.ts',
  import.meta.url,
);
const runDetailRoutePath = new URL(
  '../app/api/rpm-runs/[id]/route.ts',
  import.meta.url,
);

function stage(overrides = {}) {
  return {
    status: 'inconclusive',
    scheduledCount: 75,
    attemptedCount: 70,
    successCount: 70,
    rateLimitedCount: 0,
    clientErrorCount: 0,
    serverErrorCount: 0,
    timeoutCount: 0,
    transportErrorCount: 0,
    malformedCount: 0,
    missedDispatchCount: 5,
    ...overrides,
  };
}

test('final metrics separate scheduled load, verified sends, and provider success', () => {
  const metrics = deriveStageMetrics(stage(), {
    attempted: 12,
    succeeded: 11,
    rateLimited: 1,
    missedDispatch: 0,
  });

  assert.equal(metrics.scheduled, 75);
  assert.equal(metrics.sent, 70, 'finalized database evidence must win');
  assert.equal(metrics.succeeded, 70);
  assert.equal(metrics.testerMisses, 5);
  assert.equal(metrics.deliveryPercent, (70 / 75) * 100);
  assert.equal(metrics.providerSuccessPercent, 100);
});

test('live metrics are used only while a stage is running', () => {
  const metrics = deriveStageMetrics(
    stage({ status: 'running', attemptedCount: 0, successCount: 0 }),
    {
      dispatched: 15,
      attempted: 12,
      succeeded: 11,
      rateLimited: 1,
      missedDispatch: 2,
    },
  );

  assert.equal(metrics.sent, 15);
  assert.equal(metrics.observed, 12);
  assert.equal(metrics.succeeded, 11);
  assert.equal(metrics.testerMisses, 2);
  assert.equal(metrics.recorded, 14);
  assert.equal(metrics.providerSuccessPercent, (11 / 12) * 100);
});

test('provider success is unobserved when the tester sent nothing', () => {
  const metrics = deriveStageMetrics(
    stage({ attemptedCount: 0, successCount: 0, missedDispatchCount: 75 }),
  );
  assert.equal(metrics.providerSuccessPercent, null);
  assert.equal(metrics.deliveryPercent, 0);
});

test('final metrics keep dispatch starts separate from preserved outcomes', () => {
  const metrics = deriveStageMetrics(
    stage({
      attemptedCount: 70,
      successCount: 68,
      missedDispatchCount: 5,
    }),
  );
  assert.equal(metrics.sent, 70);
  assert.equal(metrics.observed, 68);
  assert.equal(metrics.testerMisses, 5);
  assert.equal(metrics.recorded, 73);
  assert.equal(metrics.providerSuccessPercent, 100);
});

test('redirect responses cannot pass and derived response fields are redacted', async () => {
  const originalFetch = globalThis.fetch;
  const apiKey = 'test-only-secret-value';
  let providerSlotReleases = 0;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        model: apiKey,
        content: [{ type: 'text', text: 'OK' }],
        usage: { nested: { reflected: apiKey } },
      }),
      {
        status: 302,
        headers: { 'x-request-id': apiKey, [apiKey]: 'reflected-name' },
      },
    );
  try {
    const evidence = await runProviderRequest({
      apiType: 'anthropic',
      baseUrl: 'https://provider.example',
      apiKey,
      model: 'test-model',
      runId: 'test-run',
      stageIndex: 0,
      sequence: 0,
      plannedAt: Date.now(),
      onProviderSlotReleased: () => {
        providerSlotReleases += 1;
      },
    });
    assert.equal(evidence.outcome, 'client_error');
    assert.equal(JSON.stringify(evidence).includes(apiKey), false);
    assert.equal(evidence.response.requestId, '[REDACTED]');
    assert.equal(evidence.response.returnedModel, '[REDACTED]');
    assert.deepEqual(evidence.response.usage, {
      nested: { reflected: '[REDACTED]' },
    });
    assert.equal(
      evidence.response.headers.some(([name]) => name === '[REDACTED]'),
      true,
    );
    assert.equal(providerSlotReleases, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('server shards cover every sequence exactly once at 1,000 RPM', () => {
  assert.equal(RPM_MAX_TARGET_RPM, 1_000);
  const scheduledCount = 1_000;
  const shardCount = rpmShardCount(scheduledCount);
  const sequences = Array.from({ length: shardCount }, (_, shardIndex) =>
    sequencesForShard(scheduledCount, shardIndex, shardCount),
  ).flat();

  assert.ok(shardCount > 1);
  assert.equal(shardCount, 72);
  assert.ok(shardCount <= 72);
  assert.equal(sequences.length, scheduledCount);
  assert.deepEqual(
    [...sequences].sort((left, right) => left - right),
    Array.from({ length: scheduledCount }, (_, index) => index),
  );
  assert.equal(new Set(sequences).size, scheduledCount);
});

test('all shards share one authoritative server schedule', () => {
  assert.equal(plannedRequestAt(10_000, 0, 1_000, 60), 10_000);
  assert.equal(plannedRequestAt(10_000, 1, 1_000, 60), 10_060);
  assert.equal(plannedRequestAt(10_000, 999, 1_000, 60), 69_940);
});

test('dispatcher topology supplies enough independent provider-header capacity', () => {
  assert.equal(rpmShardCount(10), 1);
  assert.equal(rpmShardCount(25), 2);
  assert.equal(rpmShardCount(50), 4);
  assert.equal(rpmShardCount(75), 6);
  assert.equal(rpmShardCount(1_000), 72);
  assert.equal(
    RPM_MAX_PROVIDER_CALLS_PER_SHARD,
    5,
    'five provider header waits leave one Worker connection for evidence operations',
  );
});

test('the browser starts server dispatchers but does not time request batches', () => {
  assert.equal(existsSync(shardRoutePath), true);
  assert.equal(existsSync(armRoutePath), true);
  const component = readFileSync(componentPath, 'utf8');
  const shardRoute = readFileSync(shardRoutePath, 'utf8');
  assert.doesNotMatch(component, /\/stages\/\$\{stage\.stageIndex\}\/batch/);
  assert.doesNotMatch(component, /waitUntil\(dispatchAt/);
  assert.match(component, /\/shards\/\$\{shardIndex\}/);
  assert.match(component, /\/arm/);
  assert.match(shardRoute, /scheduler\.wait/);
});

test('server dispatch has frozen shard ownership, a storage-free timed path, and a completion barrier', () => {
  const component = readFileSync(componentPath, 'utf8');
  const shardRoute = readFileSync(shardRoutePath, 'utf8');
  const armRoute = readFileSync(armRoutePath, 'utf8');
  const startRoute = readFileSync(startRoutePath, 'utf8');
  const finalizeRoute = readFileSync(finalizeRoutePath, 'utf8');
  const exportRoute = readFileSync(exportRoutePath, 'utf8');

  assert.match(startRoute, /shardCount: rows\[0\]\.batchCount/);
  assert.match(armRoute, /const shardCount = stageRow\.batchCount/);
  assert.match(shardRoute, /const shardCount = stageRow\.batchCount/);
  assert.match(shardRoute, /\/claims\/s/);
  assert.doesNotMatch(shardRoute, /upstream-claims/);
  assert.match(shardRoute, /dispatch-starts/);
  assert.match(shardRoute, /current_stage/);
  assert.match(shardRoute, /RPM_REQUEST_TIMEOUT_MS/);
  assert.match(
    shardRoute,
    /reservedProviderSlots >= RPM_MAX_PROVIDER_CALLS_PER_SHARD/,
  );
  assert.match(
    shardRoute,
    /while \(\s*reservedProviderSlots >= RPM_MAX_PROVIDER_CALLS_PER_SHARD\s*\)/,
  );
  assert.match(shardRoute, /Waiting briefly for dispatcher capacity/);
  assert.match(shardRoute, /onProviderSlotReleased: releaseProviderSlot/);
  assert.match(shardRoute, /dispatcherErrorMessage/);
  assert.match(shardRoute, /verdictEligible/);
  const timedPath = shardRoute.slice(
    shardRoute.indexOf('const schedulerWokeAt'),
    shardRoute.indexOf('const result = await runProviderRequest'),
  );
  assert.doesNotMatch(timedPath, /env\.(?:DB|EVIDENCE)/);
  assert.match(finalizeRoute, /dispatchers\/s/);
  assert.match(finalizeRoute, /finalizationPending: true/);
  assert.match(finalizeRoute, /status = 'finalizing'/);
  assert.match(finalizeRoute, /finished_at = \?/);
  assert.match(finalizeRoute, /settleRemainingMs/);
  assert.match(finalizeRoute, /return noStore\(await runDetail\(run\)\)/);
  assert.match(component, /finalizeStageWithBarrier/);
  assert.match(component, /waitForDispatcherCompletion/);
  assert.match(component, /stage evidence deadline was reached/i);
  assert.match(component, /Keep this tab open/);
  assert.match(component, /window ended · final evidence pending/);
  assert.match(exportRoute, /controlClaims/);
  assert.match(exportRoute, /"dispatchers"/);
});

test('RPM UI names the separate evidence dimensions', () => {
  const component = readFileSync(componentPath, 'utf8');
  for (const label of [
    'Scheduled',
    'Sent upstream',
    'Provider success',
    'Unverified send slots',
    'HTTP 429',
    'Provider latency',
  ]) {
    assert.match(component, new RegExp(label));
  }
  assert.doesNotMatch(component, /label="Reliability"/);
});

test('tester-side delivery failures explain the failed lifecycle boundary', () => {
  const component = readFileSync(componentPath, 'utf8');
  const finalizeRoute = readFileSync(finalizeRoutePath, 'utf8');
  const exportRoute = readFileSync(exportRoutePath, 'utf8');

  assert.match(component, /Verified sends/);
  assert.match(component, /Tester could not run/);
  assert.match(component, /provider not judged/i);
  assert.match(finalizeRoute, /readyDispatcherCount/);
  assert.match(finalizeRoute, /dispatcherErrorMessages/);
  assert.match(finalizeRoute, /stage was never armed/i);
  assert.match(exportRoute, /diagnosticSummary/);
});

test('live UI polls persisted server evidence instead of relying on buffered streams', () => {
  const component = readFileSync(componentPath, 'utf8');
  const runDetailRoute = readFileSync(runDetailRoutePath, 'utf8');

  assert.match(component, /pollPersistedStageProgress/);
  assert.match(component, /verifiedDispatchStarts/);
  assert.match(component, /liveDispatchedSequences\.has\(sequence\)/);
  assert.match(component, /liveDispatchedSequences\.size/);
  assert.match(runDetailRoute, /liveProgress/);
  assert.match(runDetailRoute, /dispatch-starts/);
  assert.match(runDetailRoute, /evidenceRecords/);
});

test('tester misses expose a compact under-the-hood explanation', () => {
  const component = readFileSync(componentPath, 'utf8');
  const runDetailRoute = readFileSync(runDetailRoutePath, 'utf8');
  const shardRoute = readFileSync(shardRoutePath, 'utf8');

  assert.match(shardRoute, /tester-diagnostics/);
  assert.match(runDetailRoute, /storedTesterDiagnostics/);
  assert.match(runDetailRoute, /diagnosticFromEvidence/);
  assert.match(component, /What happened inside the tester/);
  assert.match(component, /tester-side scheduling misses/);
  assert.match(component, /diagnostic\.reason/);
});
