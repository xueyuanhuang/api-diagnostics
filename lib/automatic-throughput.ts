export const AUTOMATIC_CONCURRENCY = 5;
export const AUTOMATIC_DURATION_MS = 60_000;
export const AUTOMATIC_REQUEST_CAP = 300;
export type AutomaticSample = {
  outcome: string;
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
}) {
  const now = options.now ?? Date.now;
  const durationMs = options.durationMs ?? AUTOMATIC_DURATION_MS;
  const concurrency = options.concurrency ?? AUTOMATIC_CONCURRENCY;
  const requestCap = options.requestCap ?? AUTOMATIC_REQUEST_CAP;
  const start = now();
  const deadline = start + durationMs;
  let sent = 0;
  const samples: T[] = [];
  const metrics = (end: number): AutomaticMetrics => {
    const elapsedMs = Math.max(1, end - start);
    const measured = samples.filter((s) => s.completedAt <= end);
    const succeeded = measured.filter((s) => s.outcome === 'success').length;
    const latencies = samples.map((s) => s.totalTimeMs).sort((a, b) => a - b);
    return {
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
        !failures.length
      ) {
        const sequence = sent++;
        const sample = await options.request(sequence);
        samples.push(sample);
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
  return { metrics: summary, samples, failed: failures.length > 0 };
}
