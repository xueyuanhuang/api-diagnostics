'use client';
import { useEffect, useRef, useState } from 'react';
import {
  DiagnosticSaveQueue,
  type DiagnosticSaveStatus,
} from '@/lib/diagnostic-save-queue';
import type {
  DiagnosticRun,
  DiagnosticRunSummary,
} from '@/lib/diagnostic-runs';
import { Button } from '@/components/ui/button';

export function useDiagnosticHistory(
  runs: DiagnosticRun[],
  enabled: boolean,
  onSaved?: (run: DiagnosticRunSummary) => void,
) {
  const [statuses, setStatuses] = useState<
    Record<string, DiagnosticSaveStatus>
  >({});
  const callback = useRef(onSaved);
  callback.current = onSaved;
  const queue = useRef<DiagnosticSaveQueue | null>(null);
  if (!queue.current)
    queue.current = new DiagnosticSaveQueue(
      async (document, revision) => {
        const response = await fetch('/api/diagnostic-runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ document, revision }),
          signal: AbortSignal.timeout(60000),
        });
        const data = (await response.json()) as {
          run?: DiagnosticRunSummary;
          error?: string;
        };
        if (!response.ok || !data.run)
          throw new Error(data.error || 'Could not save this run.');
        return data.run;
      },
      (id, status) => setStatuses((all) => ({ ...all, [id]: status })),
      (run) => callback.current?.(run),
    );
  useEffect(() => {
    if (enabled) runs.forEach((run) => queue.current!.update(run));
  }, [runs, enabled]);
  return { statuses, retry: (id: string) => queue.current?.retry(id) };
}

export function DiagnosticHistorySave({
  signedIn,
  status,
  retry,
}: {
  signedIn: boolean;
  status?: DiagnosticSaveStatus;
  retry: () => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      aria-live="polite"
    >
      {!signedIn ? (
        'Sign in to keep this run in Saved runs.'
      ) : status?.state === 'saved' ? (
        'Saved to your history.'
      ) : status?.state === 'saving' ? (
        'Saving to your history…'
      ) : status?.state === 'error' ? (
        <>
          <span role="alert">
            Not saved: {status.message} Your results remain in this tab.
          </span>
          <Button type="button" size="sm" variant="outline" onClick={retry}>
            Retry save
          </Button>
        </>
      ) : (
        'Results will save when this run finishes or stops.'
      )}
    </div>
  );
}
