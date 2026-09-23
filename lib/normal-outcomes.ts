export type NormalOutcomeSource = {
  normalCount: number;
  cacheCount: number;
  largeCount: number;
  errorCount: number;
  unavailableCount?: number;
};

// Stored statuses are mutually exclusive. A large cached response is counted
// once under `large`, not again under `cached`.
export function normalOutcomes(source: NormalOutcomeSource) {
  const normal = source.normalCount;
  const anomaly = source.cacheCount + source.largeCount;
  const failed = source.errorCount;
  const unknown = source.unavailableCount ?? 0;
  return {
    normal,
    anomaly,
    failed,
    unknown,
    finished: normal + anomaly + failed + unknown,
  };
}

export function normalOutcomeTitle(source: NormalOutcomeSource) {
  const counts = normalOutcomes(source);
  return `${counts.normal} normal · ${counts.anomaly} ${counts.anomaly === 1 ? 'anomaly' : 'anomalies'} · ${counts.failed} failed${counts.unknown ? ` · ${counts.unknown} unknown` : ''}`;
}
