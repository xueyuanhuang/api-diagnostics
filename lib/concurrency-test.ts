// Bounded exploration of concurrency, not a claim about a provider's hard limit.
export const CONCURRENCY_LEVELS = [5, 10, 25, 50, 100, 200] as const;
export const CONCURRENCY_WINDOW_MS = 60_000;
export const CONCURRENCY_CHUNK_SIZE = 25;
export const CONCURRENCY_RUNNER_VERSION = 2;
export function concurrencyUsesStreaming(metricsJson: string | null) {
  if (!metricsJson) return false;
  try {
    return JSON.parse(metricsJson).version === 2;
  } catch {
    return false;
  }
}
export function concurrencyPlan(index: number) {
  const concurrency = CONCURRENCY_LEVELS[index];
  if (!concurrency) throw new Error('Invalid concurrency level.');
  const shards = concurrency / 5;
  const requestCap = Math.max(100, concurrency * 5);
  return { concurrency, shards, requestCap, shardCap: requestCap / shards };
}
export const CONCURRENCY_REQUEST_BUDGET = CONCURRENCY_LEVELS.reduce(
  (n, _, i) => n + concurrencyPlan(i).requestCap,
  0,
);
export type ConcurrencySample = {
  sequence: number;
  upstreamStartedAt: number | null;
  completedAt: number;
  totalTimeMs: number;
  ttftMs?: number | null;
  outcome: string;
  error?: string | null;
};
export type ConcurrencyManifest = {
  stageIndex: number;
  shardIndex: number;
  complete: boolean;
  failed: boolean;
  finishedAt: number;
  nextChunk: number | null;
  samples: ConcurrencySample[];
};
export type ConcurrencyStageMetrics = {
  stageIndex: number;
  concurrency: number;
  peakConcurrency: number;
  averageConcurrency: number;
  secondsAtTarget: number;
  elapsedMs: number;
  attempts: number;
  responses: number;
  succeeded: number;
  errors: number;
  rateLimited: number;
  lateResponses: number;
  successfulRps: number;
  p95LatencyMs: number | null;
  medianLatencyMs: number | null;
  medianTtftMs?: number | null;
  ttftSamples?: number;
  complete: boolean;
  budgetReached: boolean;
  outcome:
    | 'no_limit_observed'
    | 'rate_limit_observed'
    | 'request_failures'
    | 'tester_incomplete';
};
export type ConcurrencyMetrics = {
  version: 1 | 2;
  stages: ConcurrencyStageMetrics[];
  conclusion: string;
};
export function summarizeConcurrencyStage(
  stageIndex: number,
  start: number,
  manifests: ConcurrencyManifest[],
): ConcurrencyStageMetrics {
  const plan = concurrencyPlan(stageIndex);
  const valid =
    manifests.length === plan.shards &&
    new Set(manifests.map((m) => m.shardIndex)).size === plan.shards &&
    manifests.every(
      (m) =>
        m.stageIndex === stageIndex &&
        m.shardIndex >= 0 &&
        m.shardIndex < plan.shards &&
        m.complete &&
        !m.failed,
    );
  const samples = manifests.flatMap((m) => m.samples);
  const unique =
    new Set(samples.map((s) => s.sequence)).size === samples.length;
  const complete =
    valid &&
    unique &&
    samples.length > 0 &&
    !samples.some(
      (s) => s.outcome === 'transport_error' || s.outcome === 'missed_dispatch',
    );
  // Stop the denominator at the last request completion (or the window end),
  // not at the later time that evidence was uploaded or the browser finalized.
  const end = Math.min(
    start + CONCURRENCY_WINDOW_MS,
    Math.max(start + 1, ...samples.map((s) => s.completedAt)),
  );
  const elapsedMs = end - start;
  const measured = samples.filter(
    (s) => s.completedAt >= start && s.completedAt <= end,
  );
  const success = measured.filter((s) => s.outcome === 'success');
  const latency = success.map((s) => s.totalTimeMs).sort((a, b) => a - b);
  const ttft = success
    .map((s) => s.ttftMs)
    .filter(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0,
    )
    .sort((a, b) => a - b);
  const points: { at: number; delta: number }[] = [];
  for (const sample of samples) {
    if (
      sample.upstreamStartedAt === null ||
      sample.upstreamStartedAt >= end ||
      sample.completedAt <= start
    )
      continue;
    points.push(
      { at: Math.max(start, sample.upstreamStartedAt), delta: 1 },
      { at: Math.min(end, sample.completedAt), delta: -1 },
    );
  }
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0,
    peak = 0,
    area = 0,
    targetMs = 0,
    previous = start;
  for (const point of points) {
    const duration = point.at - previous;
    area += current * duration;
    if (current >= plan.concurrency) targetMs += duration;
    current += point.delta;
    peak = Math.max(peak, current);
    previous = point.at;
  }
  const errors = samples.filter((s) => s.outcome !== 'success').length;
  const rateLimited = samples.filter(
    (s) => s.outcome === 'rate_limited',
  ).length;
  return {
    stageIndex,
    concurrency: plan.concurrency,
    peakConcurrency: peak,
    averageConcurrency: area / elapsedMs,
    secondsAtTarget: targetMs / 1000,
    elapsedMs,
    attempts: samples.length,
    responses: samples.filter(
      (s) =>
        !['transport_error', 'timeout', 'missed_dispatch'].includes(s.outcome),
    ).length,
    succeeded: success.length,
    errors,
    rateLimited,
    lateResponses: samples.filter((s) => s.completedAt > end).length,
    successfulRps: (success.length * 1000) / elapsedMs,
    p95LatencyMs: latency.length
      ? latency[Math.ceil(latency.length * 0.95) - 1]
      : null,
    medianLatencyMs: latency.length
      ? latency[Math.floor(latency.length / 2)]
      : null,
    medianTtftMs: ttft.length
      ? (ttft[Math.floor((ttft.length - 1) / 2)] +
          ttft[Math.floor(ttft.length / 2)]) /
        2
      : null,
    ttftSamples: ttft.length,
    complete,
    budgetReached: samples.length >= plan.requestCap,
    outcome: !complete
      ? 'tester_incomplete'
      : rateLimited
        ? 'rate_limit_observed'
        : errors
          ? 'request_failures'
          : 'no_limit_observed',
  };
}
export function concurrencyConclusion(stages: ConcurrencyStageMetrics[]) {
  const last = stages.at(-1);
  if (!last) return 'No concurrency measurement yet.';
  if (last.outcome === 'tester_incomplete')
    return 'Tester interrupted or could not deliver the workload. Provider limit undetermined.';
  if (last.outcome === 'rate_limit_observed')
    return `HTTP 429 observed at target concurrency ${last.concurrency}. Higher load was stopped. The rate limit may depend on this key, route, token quota or a rolling window; this is not the model’s hard limit.`;
  if (last.outcome === 'request_failures')
    return `Request failures observed at target concurrency ${last.concurrency}. Higher load was stopped; the cause and a sustainable limit are not established.`;
  return `Limit not reached: no request failures observed through target concurrency ${last.concurrency} (actual peak ${last.peakConcurrency}). ${last.peakConcurrency < last.concurrency ? 'The runner did not achieve the requested overlap. ' : ''}${last.budgetReached ? 'The request budget shortened this level. ' : ''}${stages.length === CONCURRENCY_LEVELS.length ? 'The tester’s concurrency ceiling was reached.' : 'Higher concurrency remains untested.'} This is a short-workload result, not a maximum-capacity claim.`;
}
// One invocation uses at most 25 provider calls and five simultaneous fetches.
// Saving happens after the bounded chunk, outside the request replacement path.
export async function runConcurrencyChunk<
  T extends ConcurrencySample,
>(options: {
  start: number;
  deadline: number;
  first: number;
  count: number;
  signal: AbortSignal;
  stopped: () => boolean;
  request: (ordinal: number) => Promise<T>;
  onResult?: (sample: T) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let next = options.first,
    failed = false,
    observedError = false;
  const samples: T[] = [];
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      try {
        while (
          !failed &&
          !observedError &&
          !options.signal.aborted &&
          !options.stopped() &&
          now() < options.deadline &&
          next < options.first + options.count
        ) {
          const sample = await options.request(next++);
          samples.push(sample);
          if (sample.outcome !== 'success') observedError = true;
          options.onResult?.(sample);
        }
      } catch {
        failed = true;
      }
    }),
  );
  return { samples, failed: failed || options.signal.aborted, observedError };
}
