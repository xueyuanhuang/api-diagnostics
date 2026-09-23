export const AUTOMATIC_CONCURRENCY = 5;
export const AUTOMATIC_DURATION_MS = 60_000;
export const AUTOMATIC_REQUEST_CAP = 300;
export type AutomaticSample = {
  outcome: string;
  error?: string | null;
  completedAt: number;
  totalTimeMs: number;
};
export type AutomaticMetrics = {
  concurrency: number;
  durationMs: number;
  requestCap: number;
  elapsedMs: number;
  sent: number;
  completed: number;
  succeeded: number;
  lateResponses: number;
  rateLimited: number;
  errors: number;
  sentRps: number;
  completedRps: number;
  successfulRps: number;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  providerResponses?: number;
  latencyScope?: 'successful_responses';
  stopReason: 'duration' | 'request_cap' | 'cancelled';
};
export async function measureAutomaticThroughput<
  T extends AutomaticSample,
>(options: {
  request: (sequence: number) => Promise<T>;
  save: (sample: T, sequence: number) => Promise<void>;
  signal: AbortSignal;
  progress?: (metrics: AutomaticMetrics) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  durationMs?: number;
  concurrency?: number;
  requestCap?: number;
  startedAt?: number;
  initialSamples?: T[];
  chunkSize?: number;
}) {
  const now = options.now ?? Date.now;
  const durationMs = options.durationMs ?? AUTOMATIC_DURATION_MS;
  const concurrency = options.concurrency ?? AUTOMATIC_CONCURRENCY;
  const requestCap = options.requestCap ?? AUTOMATIC_REQUEST_CAP;
  const start = options.startedAt ?? now();
  const deadline = start + durationMs;
  const samples: T[] = [...(options.initialSamples ?? [])];
  let sent = samples.length;
  const chunkEnd = sent + (options.chunkSize ?? requestCap);
  const metrics = (end: number): AutomaticMetrics => {
    const elapsedMs = Math.max(1, end - start);
    const measured = samples.filter((s) => s.completedAt <= end);
    const succeeded = measured.filter((s) => s.outcome === 'success').length;
    const latencies = measured
      .filter((s) => s.outcome === 'success')
      .map((s) => s.totalTimeMs)
      .sort((a, b) => a - b);
    return {
      providerResponses: measured.filter(
        (s) =>
          !['transport_error', 'timeout', 'missed_dispatch'].includes(
            s.outcome,
          ),
      ).length,
      latencyScope: 'successful_responses',
      concurrency,
      durationMs,
      requestCap,
      elapsedMs,
      sent,
      completed: measured.length,
      succeeded,
      lateResponses: samples.length - measured.length,
      rateLimited: measured.filter((s) => s.outcome === 'rate_limited').length,
      errors: measured.filter((s) => s.outcome !== 'success').length,
      sentRps: (sent * 1000) / elapsedMs,
      completedRps: (measured.length * 1000) / elapsedMs,
      successfulRps: (succeeded * 1000) / elapsedMs,
      medianLatencyMs: latencies.length
        ? latencies[Math.floor(latencies.length / 2)]
        : null,
      p95LatencyMs: latencies.length
        ? latencies[Math.ceil(latencies.length * 0.95) - 1]
        : null,
      stopReason: options.signal.aborted
        ? 'cancelled'
        : sent >= requestCap
          ? 'request_cap'
          : 'duration',
    };
  };
  const failures: unknown[] = [];
  const worker = async () => {
    try {
      while (
        !options.signal.aborted &&
        now() < deadline &&
        sent < requestCap &&
        sent < chunkEnd &&
        !failures.length
      ) {
        const sequence = sent++;
        const sample = await options.request(sequence);
        samples.push(sample);
        // A local platform limit is not a provider rejection. Stop all workers
        // rather than burning the remaining budget on immediate local failures.
        if (/too many subrequests/i.test(sample.error ?? ''))
          failures.push(
            new Error(
              'Tester hosting request limit reached; provider capacity was not measured.',
            ),
          );
        await options.save(sample, sequence);
        options.progress?.(metrics(Math.min(now(), deadline)));
        if (sample.outcome === 'rate_limited' && !options.signal.aborted)
          await (
            options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
          )(Math.min(1000, Math.max(0, deadline - now())));
      }
    } catch (error) {
      failures.push(error);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const summary = metrics(Math.min(now(), deadline));
  return {
    startedAt: start,
    continuation:
      !failures.length &&
      !options.signal.aborted &&
      now() < deadline &&
      sent < requestCap,
    metrics: summary,
    samples,
    failed: failures.length > 0,
    failureReason: failures[0] instanceof Error ? failures[0].message : null,
  };
}
