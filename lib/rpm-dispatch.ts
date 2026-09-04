export function sequencesForShard(
  scheduledCount: number,
  shardIndex: number,
  shardCount: number,
) {
  if (
    !Number.isInteger(scheduledCount) ||
    scheduledCount < 1 ||
    !Number.isInteger(shardCount) ||
    shardCount < 1 ||
    !Number.isInteger(shardIndex) ||
    shardIndex < 0 ||
    shardIndex >= shardCount
  ) {
    return [];
  }
  const sequences: number[] = [];
  for (
    let sequence = shardIndex;
    sequence < scheduledCount;
    sequence += shardCount
  ) {
    sequences.push(sequence);
  }
  return sequences;
}

export function plannedRequestAt(
  scheduledStartAt: number,
  sequence: number,
  scheduledCount: number,
  durationSeconds = 60,
) {
  return Math.round(
    scheduledStartAt + sequence * ((durationSeconds * 1_000) / scheduledCount),
  );
}

export function recordUniqueDispatch(
  seenSequences: Set<number>,
  sequence: number,
  scheduledCount: number,
) {
  if (
    !Number.isInteger(sequence) ||
    sequence < 0 ||
    sequence >= scheduledCount ||
    seenSequences.has(sequence)
  ) {
    return null;
  }
  seenSequences.add(sequence);
  return seenSequences.size;
}

export function mergeDispatchProgress(
  currentCount: number,
  uniqueStreamCount: number,
  scheduledCount: number,
) {
  return Math.min(
    scheduledCount,
    Math.max(0, currentCount, uniqueStreamCount),
  );
}

export function maximumDispatchLagMs(
  scheduledCount: number,
  durationSeconds = 60,
) {
  const intervalMs = (durationSeconds * 1_000) / scheduledCount;
  return Math.max(1_500, Math.round(intervalMs * 3));
}
