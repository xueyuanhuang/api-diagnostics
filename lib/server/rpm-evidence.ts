import type { RpmRequestEvidence } from '@/lib/server/rpm-provider';

export type RpmOutcomeSummary = {
  completed: number;
  attempted: number;
  succeeded: number;
  rateLimited: number;
  clientErrors: number;
  serverErrors: number;
  timeouts: number;
  transportErrors: number;
  malformed: number;
  missedDispatch: number;
};

export function countRpmOutcomes(
  results: Array<Pick<RpmRequestEvidence, 'outcome'>>,
): RpmOutcomeSummary {
  const count = (outcome: RpmRequestEvidence['outcome']) =>
    results.filter((result) => result.outcome === outcome).length;
  return {
    completed: results.length,
    attempted: results.length - count('missed_dispatch'),
    succeeded: count('success'),
    rateLimited: count('rate_limited'),
    clientErrors: count('client_error'),
    serverErrors: count('server_error'),
    timeouts: count('timeout'),
    transportErrors: count('transport_error'),
    malformed: count('malformed'),
    missedDispatch: count('missed_dispatch'),
  };
}
