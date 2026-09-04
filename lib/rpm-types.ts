export type RpmRampMode = 'balanced' | 'detailed';

export type RpmRunStatus =
  | 'preflight'
  | 'ready'
  | 'running'
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'cancelled';

export type RpmStageStatus =
  | 'pending'
  | 'running'
  | 'finalizing'
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'skipped'
  | 'cancelled';

export type RpmRunSummary = {
  testKind: 'rpm';
  id: string;
  profileId: string | null;
  profileName: string | null;
  apiType: 'anthropic' | 'openai';
  baseUrl: string;
  modelName: string;
  rampMode: RpmRampMode;
  targetRpm: number;
  stageDurationSeconds: number;
  thresholdBps: number;
  status: RpmRunStatus;
  currentStage: number | null;
  highestPassedRpm: number | null;
  stoppedAtRpm: number | null;
  stopReason: string | null;
  totalPlanned: number;
  totalAttempted: number;
  totalSucceeded: number;
  totalRateLimited: number;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  createdAt: number;
  finishedAt: number | null;
};

export type RpmStageSummary = {
  id: string;
  runId: string;
  stageIndex: number;
  percentage: number;
  targetRpm: number;
  scheduledCount: number;
  batchCount: number;
  status: RpmStageStatus;
  scheduledStartAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  attemptedCount: number;
  successCount: number;
  rateLimitedCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  timeoutCount: number;
  transportErrorCount: number;
  malformedCount: number;
  missedDispatchCount: number;
  successRateBps: number | null;
  dispatchValid: boolean | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  p95ScheduleLagMs: number | null;
};

export type RpmRunDetail = {
  run: RpmRunSummary;
  stages: RpmStageSummary[];
};

export type RpmPreflightSummary = {
  outcome:
    | 'success'
    | 'rate_limited'
    | 'client_error'
    | 'server_error'
    | 'timeout'
    | 'transport_error'
    | 'malformed'
    | 'missed_dispatch';
  httpStatus: number | null;
  firstByteMs: number | null;
  totalTimeMs: number;
  requestId: string | null;
  returnedModel: string | null;
  error: string | null;
};

export function rampPercentages(mode: RpmRampMode) {
  return mode === 'detailed'
    ? [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    : [10, 25, 50, 75, 100];
}

export function buildRampTargets(targetRpm: number, mode: RpmRampMode) {
  const values = rampPercentages(mode).map((percentage) => ({
    percentage,
    targetRpm: Math.max(1, Math.round((targetRpm * percentage) / 100)),
  }));
  return values.reduce<typeof values>((deduplicated, value) => {
    const previous = deduplicated.at(-1);
    if (previous?.targetRpm === value.targetRpm) {
      deduplicated[deduplicated.length - 1] = value;
    } else {
      deduplicated.push(value);
    }
    return deduplicated;
  }, []);
}

export function rpmBatchSize(scheduledCount: number, durationSeconds = 60) {
  const intervalMs = (durationSeconds * 1_000) / scheduledCount;
  return Math.max(1, Math.min(5, Math.floor(2_000 / intervalMs) + 1));
}

export const RPM_MAX_DISPATCH_SHARDS = 96;
export const RPM_MAX_TARGET_RPM = 1_000;
export const RPM_REQUEST_TIMEOUT_MS = 20_000;
export const RPM_FINALIZE_GRACE_MS = 5_000;
export const RPM_FINALIZE_SETTLE_MS = 1_000;

/**
 * Split one stage across a bounded number of long-lived Worker invocations.
 * Each shard owns interleaved sequence numbers and performs their timing on
 * the server. At the supported 1,000-RPM target, eleven slots per shard plus
 * the 20-second upstream timeout keeps provider calls below the Worker's
 * simultaneous outgoing-connection ceiling. The browser establishes at most
 * 96 observation streams before arming.
 */
export function rpmShardCount(scheduledCount: number) {
  return Math.max(
    1,
    Math.min(RPM_MAX_DISPATCH_SHARDS, Math.ceil(scheduledCount / 11)),
  );
}
