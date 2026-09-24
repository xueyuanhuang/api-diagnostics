import { asc, eq } from 'drizzle-orm';

import { getDb } from '@/db';
import { rpmRuns, rpmStages } from '@/db/schema';
import type {
  RpmRunDetail,
  RpmRunSummary,
  RpmStageSummary,
} from '@/lib/rpm-types';

type RunRow = typeof rpmRuns.$inferSelect;
type StageRow = typeof rpmStages.$inferSelect;

export function runSummary(row: RunRow): RpmRunSummary {
  return {
    testKind: 'rpm',
    concurrencyMetrics: row.rampMode === 'concurrency' && row.automaticMetricsJson ? JSON.parse(row.automaticMetricsJson) : null,
    automaticMetrics: row.rampMode !== 'concurrency' && row.automaticMetricsJson ? JSON.parse(row.automaticMetricsJson) : null,
    id: row.id,
    profileId: row.profileId,
    profileName: row.profileName,
    apiType: row.apiType,
    baseUrl: row.baseUrl,
    modelName: row.modelName,
    openRouterTier: row.openRouterTier,
    rampMode: row.rampMode,
    targetRpm: row.targetRpm,
    stageDurationSeconds: row.stageDurationSeconds,
    thresholdBps: row.thresholdBps,
    status: row.status as RpmRunSummary['status'],
    currentStage: row.currentStage,
    highestPassedRpm: row.highestPassedRpm,
    stoppedAtRpm: row.stoppedAtRpm,
    stopReason: row.stopReason,
    totalPlanned: row.totalPlanned,
    totalAttempted: row.totalAttempted,
    totalSucceeded: row.totalSucceeded,
    totalRateLimited: row.totalRateLimited,
    medianLatencyMs: row.medianLatencyMs,
    p95LatencyMs: row.p95LatencyMs,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

export function stageSummary(row: StageRow): RpmStageSummary {
  return {
    id: row.id,
    runId: row.runId,
    stageIndex: row.stageIndex,
    percentage: row.percentage,
    targetRpm: row.targetRpm,
    scheduledCount: row.scheduledCount,
    batchCount: row.batchCount,
    status: row.status as RpmStageSummary['status'],
    scheduledStartAt: row.scheduledStartAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    attemptedCount: row.attemptedCount,
    successCount: row.successCount,
    rateLimitedCount: row.rateLimitedCount,
    clientErrorCount: row.clientErrorCount,
    serverErrorCount: row.serverErrorCount,
    timeoutCount: row.timeoutCount,
    transportErrorCount: row.transportErrorCount,
    malformedCount: row.malformedCount,
    missedDispatchCount: row.missedDispatchCount,
    successRateBps: row.successRateBps,
    dispatchValid: row.dispatchValid,
    medianLatencyMs: row.medianLatencyMs,
    p95LatencyMs: row.p95LatencyMs,
    p95ScheduleLagMs: row.p95ScheduleLagMs,
  };
}

export async function runDetail(row: RunRow): Promise<RpmRunDetail> {
  const stages = await getDb()
    .select()
    .from(rpmStages)
    .where(eq(rpmStages.runId, row.id))
    .orderBy(asc(rpmStages.stageIndex));
  return { run: runSummary(row), stages: stages.map(stageSummary) };
}

export async function listR2Keys(bucket: R2Bucket, prefix: string) {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1_000 });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

export function percentile(values: number[], percentileValue: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(percentileValue * sorted.length) - 1),
  );
  return Math.round(sorted[index]);
}

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(
    sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2,
  );
}
