import assert from 'node:assert/strict';
import test from 'node:test';

import {
  maximumDispatchLagMs,
  plannedRequestAt,
  sequencesForShard,
} from '../lib/rpm-dispatch.ts';
import {
  RPM_MAX_PROVIDER_CALLS_PER_SHARD,
  rpmShardCount,
} from '../lib/rpm-types.ts';

/**
 * Deterministic capacity model for the public stage-delivery contract.
 *
 * A provider call occupies one dispatcher slot until response headers arrive,
 * exactly like the production dispatcher. A scheduled request may wait for a
 * slot only until the production no-catch-up deadline; after that it becomes a
 * missed dispatch instead of an upstream request.
 */
function simulateVerifiedDispatchStarts({
  scheduledCount,
  responseHeadersMs,
  durationSeconds = 60,
}) {
  const shardCount = rpmShardCount(scheduledCount);
  const maximumLagMs = maximumDispatchLagMs(
    scheduledCount,
    durationSeconds,
  );
  const sentSequences = [];
  const missedSequences = [];

  for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
    const slotReleaseTimes = Array(RPM_MAX_PROVIDER_CALLS_PER_SHARD).fill(0);

    for (const sequence of sequencesForShard(
      scheduledCount,
      shardIndex,
      shardCount,
    )) {
      const plannedAt = plannedRequestAt(
        0,
        sequence,
        scheduledCount,
        durationSeconds,
      );
      const nextSlotReleasedAt = Math.min(...slotReleaseTimes);
      const dispatchAt = Math.max(plannedAt, nextSlotReleasedAt);

      if (dispatchAt - plannedAt > maximumLagMs) {
        missedSequences.push(sequence);
        continue;
      }

      slotReleaseTimes[slotReleaseTimes.indexOf(nextSlotReleasedAt)] =
        dispatchAt + responseHeadersMs;
      sentSequences.push(sequence);
    }
  }

  return {
    scheduledCount,
    verifiedDispatchStarts: sentSequences.length,
    missedDispatches: missedSequences.length,
    firstMissedSequences: missedSequences.slice(0, 10),
    shardCount,
    providerSlotsPerShard: RPM_MAX_PROVIDER_CALLS_PER_SHARD,
    maximumLagMs,
  };
}

test('1,000-RPM stage verifies all 1,000 upstream starts when headers take 3 seconds', () => {
  const result = simulateVerifiedDispatchStarts({
    scheduledCount: 1_000,
    responseHeadersMs: 3_000,
  });

  assert.equal(
    result.verifiedDispatchStarts,
    result.scheduledCount,
    `The tester must deliver the entire scheduled load. Current capacity model: ${JSON.stringify(result)}`,
  );
  assert.equal(result.missedDispatches, 0);
});

test('1,000-RPM stage retains full delivery through the 20-second request timeout', () => {
  const result = simulateVerifiedDispatchStarts({
    scheduledCount: 1_000,
    responseHeadersMs: 20_000,
  });

  assert.equal(
    result.verifiedDispatchStarts,
    result.scheduledCount,
    `Every scheduled request must reach fetch before any timeout can exhaust shard capacity: ${JSON.stringify(result)}`,
  );
  assert.equal(result.missedDispatches, 0);
});
