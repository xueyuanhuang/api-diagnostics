import { Button } from '@/components/ui/button';
import { isQueueActive, type QueuePhase } from '@/lib/normal-test-queue';

type QueueRow = {
  id: string;
  phase: QueuePhase;
  context: {
    id?: string | null;
    modelName: string;
    profileName?: string | null;
  };
  message: string;
  results: {
    status: string;
    ttftMs?: number | null;
    totalTimeMs?: number | null;
  }[];
};
function medianLabel(values: (number | null | undefined)[]) {
  const sorted = values
    .filter(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value),
    )
    .sort((a, b) => a - b);
  if (!sorted.length) return '—';
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  return `${(value / 1000).toFixed(3)} s`;
}
export function ModelTestQueue({
  jobs,
  selectedId,
  onView,
  onStop,
  onStopAll,
  onHistory,
}: {
  jobs: QueueRow[];
  selectedId?: string;
  onView: (id: string) => void;
  onStop: (id: string) => void;
  onStopAll: () => void;
  onHistory: (id: string) => void;
}) {
  if (!jobs.length) return null;
  const active = jobs.filter((job) => isQueueActive(job.phase));
  return (
    <section
      className="overflow-hidden rounded-2xl border border-border bg-card"
      aria-label="Model test queue"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div>
          <h2 className="text-base font-semibold">Model test queue</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {jobs.filter((j) => j.phase === 'complete').length} completed ·{' '}
            {
              jobs.filter(
                (j) => j.phase === 'running' || j.phase === 'stopping',
              ).length
            }{' '}
            running · {jobs.filter((j) => j.phase === 'queued').length} queued ·{' '}
            {jobs.filter((j) => j.phase === 'saving').length} saving ·{' '}
            {jobs.filter((j) => j.phase === 'stopped').length} stopped
          </p>
        </div>
        {active.some((job) => job.phase !== 'saving') ? (
          <Button type="button" variant="outline" onClick={onStopAll}>
            Stop all models
          </Button>
        ) : null}
      </div>
      <div className="divide-y divide-border">
        {jobs.map((job) => {
          const normal = job.results.filter(
            (r) => r.status === 'normal',
          ).length;
          const anomaly = job.results.filter(
            (r) => r.status === 'large' || r.status === 'cached',
          ).length;
          const failed = job.results.filter((r) => r.status === 'error').length;
          const unknown = job.results.filter(
            (r) => r.status === 'unavailable',
          ).length;
          const finished = normal + anomaly + failed + unknown;
          return (
            <div
              key={job.id}
              className={`flex flex-wrap items-center justify-between gap-3 p-4 ${selectedId === job.id ? 'bg-blue-50/60' : ''}`}
            >
              <div className="min-w-0 flex-1 basis-64">
                <p className="break-all font-mono text-sm font-semibold">
                  {job.context.modelName}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {job.context.profileName ?? 'One-time connection'} ·{' '}
                  <span className="capitalize">{job.phase}</span> · {finished}
                  /12 finished
                </p>
                <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm font-medium">
                  <span className="text-emerald-700">Normal {normal}</span>
                  <span className="text-amber-800">Anomaly {anomaly}</span>
                  <span className="text-rose-700">Failed {failed}</span>
                  {unknown ? <span>Unknown {unknown}</span> : null}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Median TTFT {medianLabel(job.results.map((r) => r.ttftMs))} ·
                  Median total{' '}
                  {medianLabel(job.results.map((r) => r.totalTimeMs))}
                </p>
                {['complete', 'stopped'].includes(job.phase) ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {job.message}
                  </p>
                ) : null}
              </div>
              <div className="flex gap-2">
                {job.context.id ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onHistory(job.id)}
                  >
                    View in history
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`View ${job.context.modelName}`}
                  aria-pressed={selectedId === job.id}
                  onClick={() => onView(job.id)}
                >
                  View
                </Button>
                {isQueueActive(job.phase) && job.phase !== 'saving' ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Stop ${job.context.modelName}`}
                    disabled={job.phase === 'stopping'}
                    onClick={() => onStop(job.id)}
                  >
                    {job.phase === 'queued'
                      ? 'Cancel'
                      : job.phase === 'stopping'
                        ? 'Stopping…'
                        : 'Stop'}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
