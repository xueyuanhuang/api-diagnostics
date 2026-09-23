export type NormalOutcomeSource = {
  normalCount: number;
  cacheCount: number;
  largeCount: number;
  errorCount: number;
  unavailableCount?: number;
};

// Cache use alone is neutral. Legacy stored categories remain untouched.
export function normalOutcomes(source: NormalOutcomeSource) {
  const normal = source.normalCount + source.cacheCount;
  const anomaly = source.largeCount;
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
