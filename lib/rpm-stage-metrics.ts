type PersistedStageCounters = {
  status: string;
  scheduledCount: number;
  attemptedCount: number;
  successCount: number;
  rateLimitedCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  timeoutCount: number;
  transportErrorCount: number;
  malformedCount: number;
  missedDispatchCount: number;
};

type LiveStageCounters = {
  completed?: number;
  dispatched?: number;
  attempted: number;
  succeeded: number;
  rateLimited: number;
  missedDispatch: number;
};

export function deriveStageMetrics(
  stage: PersistedStageCounters,
  live?: LiveStageCounters,
) {
  // R2/D1 evidence is authoritative after finalization. A browser can miss a
  // progress event even when the server safely preserved its result.
  const source =
    ['running', 'finalizing'].includes(stage.status) && live ? live : null;
  const scheduled = stage.scheduledCount;
  const observed =
    source?.attempted ??
    stage.successCount +
      stage.rateLimitedCount +
      stage.clientErrorCount +
      stage.serverErrorCount +
      stage.timeoutCount +
      stage.transportErrorCount +
      stage.malformedCount;
  const sent = source?.dispatched ?? stage.attemptedCount;
  const succeeded = source?.succeeded ?? stage.successCount;
  const rateLimited = source?.rateLimited ?? stage.rateLimitedCount;
  const testerMisses = source?.missedDispatch ?? stage.missedDispatchCount;
  const recorded = source?.completed ?? observed + testerMisses;

  return {
    scheduled,
    sent,
    succeeded,
    rateLimited,
    testerMisses,
    recorded,
    deliveryPercent: scheduled > 0 ? (sent / scheduled) * 100 : null,
    observed,
    providerSuccessPercent: observed > 0 ? (succeeded / observed) * 100 : null,
    rateLimitPercent: observed > 0 ? (rateLimited / observed) * 100 : null,
  };
}
