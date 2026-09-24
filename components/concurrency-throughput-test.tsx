'use client';
import { useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import type { RpmRampTest } from './rpm-ramp-test';
import type { RpmRunDetail, RpmRunSummary } from '@/lib/rpm-types';
import {
  CONCURRENCY_LEVELS,
  CONCURRENCY_RUNNER_VERSION,
  concurrencyPlan,
  concurrencyRequestBudget,
  parseConcurrencyLevels,
  type ConcurrencyMetrics,
} from '@/lib/concurrency-test';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { confirmHttpRisk, isInsecureHttp } from '@/lib/http-consent';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
  return data;
}
export function ConcurrencyThroughputTest(
  props: ComponentProps<typeof RpmRampTest>,
) {
  const [detail, setDetail] = useState<RpmRunDetail | null>(null);
  const [metrics, setMetrics] = useState<ConcurrencyMetrics | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('Ready to measure.');
  const [error, setError] = useState('');
  const [activeId, setActiveId] = useState('');
  const controller = useRef<AbortController | null>(null);
  const idRef = useRef('');
  const [clock, setClock] = useState(0);
  const [started, setStarted] = useState(0);
  const [customLevels, setCustomLevels] = useState(false);
  const [levelsText, setLevelsText] = useState('60, 61, 70');
  const levelsId = useId();
  let selectedLevels: readonly number[] = CONCURRENCY_LEVELS;
  let levelsError = '';
  if (customLevels) {
    try {
      selectedLevels = parseConcurrencyLevels(levelsText);
    } catch (e) {
      levelsError = (e as Error).message;
    }
  }
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setClock(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!props.openedRunId) return;
    json<RpmRunDetail>(`/api/rpm-runs/${props.openedRunId}`)
      .then((data) => {
        setDetail(data);
        setMetrics(data.run.concurrencyMetrics ?? null);
        setMessage(
          data.run.concurrencyMetrics
            ? `Test ${data.run.status === 'passed' ? 'finished' : data.run.status}.`
            : (data.run.stopReason ?? data.run.status),
        );
      })
      .catch((e) => setError(e.message));
  }, [props.openedRunId]);
  useEffect(() => {
    if (
      !props.user ||
      props.readOnly ||
      props.discoverActiveRun === false ||
      running
    )
      return;
    let alive = true;
    json<{ runs: RpmRunSummary[] }>('/api/rpm-runs')
      .then((data) => {
        if (!alive) return;
        const active = data.runs.find((run) =>
          ['ready', 'running', 'preflight'].includes(run.status),
        );
        if (active) {
          setActiveId(active.id);
          idRef.current = active.id;
          setMessage(
            'An earlier test is still active. Stop it before starting another.',
          );
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [Boolean(props.user), props.discoverActiveRun, props.readOnly]);
  async function refresh(id: string) {
    const data = await json<RpmRunDetail>(`/api/rpm-runs/${id}`);
    setDetail(data);
    setMetrics(data.run.concurrencyMetrics ?? null);
    props.onRunSaved?.(data.run);
    return data;
  }
  async function stop() {
    const id = idRef.current;
    if (!id) return;
    setMessage('Stopping and saving partial results…');
    try {
      await json(`/api/rpm-runs/${id}/cancel`, { method: 'POST' });
      controller.current?.abort();
      setActiveId('');
      if (!running) await refresh(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function start() {
    if (levelsError) {
      setError(levelsError);
      return;
    }
    if (!props.selectedProfileId || props.profileDirty) {
      setError('Select a saved connection with no unsaved changes.');
      return;
    }
    if (!confirmHttpRisk([props.baseUrl], (text) => window.confirm(text)))
      return;
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    props.onRunningChange?.(true);
    setMetrics(null);
    setDetail(null);
    setStarted(0);
    setError('');
    let id = '';
    try {
      setMessage('Checking the connection with one request…');
      props.onProgressChange?.('Throughput test running');
      const created = await json<RpmRunDetail>('/api/rpm-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profileId: props.selectedProfileId,
          apiType: props.apiType,
          model: props.model,
          openRouterTier: props.openRouterTier,
          allowInsecureHttp: isInsecureHttp(props.baseUrl),
          rampMode: 'concurrency',
          runnerVersion: CONCURRENCY_RUNNER_VERSION,
          concurrencyLevels: selectedLevels,
        }),
      });
      id = created.run.id;
      idRef.current = id;
      setActiveId(id);
      setDetail(created);
      props.onRunSaved?.(created.run);
      const runLevels =
        created.run.concurrencyMetrics?.levels ?? selectedLevels;
      const preflight = await json<RpmRunDetail>(
        `/api/rpm-runs/${id}/preflight`,
        { method: 'POST', signal: abort.signal },
      );
      if (preflight.run.status !== 'ready')
        throw new Error(
          preflight.run.stopReason ||
            'Connection check did not succeed. No throughput workload was started.',
        );
      setStarted(Date.now());
      setClock(Date.now());
      for (let stageIndex = 0; stageIndex < runLevels.length; stageIndex++) {
        const plan = concurrencyPlan(stageIndex, runLevels);
        setMessage(`Preparing ${plan.concurrency} concurrent requests…`);
        await json(`/api/rpm-runs/${id}/stages/${stageIndex}/start`, {
          method: 'POST',
          signal: abort.signal,
        });
        const stageAbort = new AbortController();
        const cancelStage = () => stageAbort.abort();
        abort.signal.addEventListener('abort', cancelStage, { once: true });
        if (abort.signal.aborted) stageAbort.abort();
        let completed = 0;
        let stageError: unknown = null;
        const ready: Promise<void>[] = [];
        const tasks = Array.from({ length: plan.shards }, (_, shardIndex) => {
          let resolveReady!: () => void;
          let rejectReady!: (error: unknown) => void;
          ready.push(
            new Promise<void>((resolve, reject) => {
              resolveReady = resolve;
              rejectReady = reject;
            }),
          );
          return (async () => {
            let nextChunk: number | null = 0;
            while (nextChunk !== null) {
              const chunk: number = nextChunk;
              nextChunk = null;
              const response = await fetch(
                `/api/rpm-runs/${id}/concurrency/${stageIndex}/${shardIndex}`,
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ chunk }),
                  signal: stageAbort.signal,
                },
              );
              if (!response.ok) {
                const body = (await response.json().catch(() => ({
                  error: `Tester returned HTTP ${response.status}.`,
                }))) as { error?: string };
                throw new Error(body.error || 'Dispatcher failed to start.');
              }
              const reader = response.body?.getReader();
              if (!reader) throw new Error('No progress stream received.');
              const decoder = new TextDecoder();
              let pending = '',
                terminal = false;
              while (true) {
                const part = await reader.read();
                if (part.done) break;
                pending += decoder.decode(part.value, { stream: true });
                let end;
                while ((end = pending.indexOf('\n')) >= 0) {
                  const line = pending.slice(0, end);
                  pending = pending.slice(end + 1);
                  if (!line.trim()) continue;
                  const event = JSON.parse(line);
                  if (event.type === 'ready') resolveReady();
                  if (event.type === 'request') {
                    completed++;
                    setMessage(
                      `Testing target concurrency ${plan.concurrency} · ${completed} responses captured…`,
                    );
                  }
                  if (event.type === 'continue') {
                    nextChunk = event.chunk;
                    terminal = true;
                  }
                  if (event.type === 'complete') terminal = true;
                  if (event.type === 'error') throw new Error(event.error);
                }
              }
              if (!terminal)
                throw new Error(
                  'A progress connection ended early. This level cannot establish provider capacity.',
                );
            }
          })().catch((error) => {
            rejectReady(error);
            stageError = error;
            stageAbort.abort();
          });
        });
        try {
          await Promise.all(ready);
          await json(`/api/rpm-runs/${id}/stages/${stageIndex}/arm`, {
            method: 'POST',
            signal: stageAbort.signal,
          });
          setMessage(`Testing target concurrency ${plan.concurrency}…`);
        } catch (error) {
          stageError = error;
          stageAbort.abort();
        }
        await Promise.all(tasks);
        abort.signal.removeEventListener('abort', cancelStage);
        if (abort.signal.aborted) throw new Error('Test stopped.');
        const finished = await json<RpmRunDetail>(
          `/api/rpm-runs/${id}/concurrency/${stageIndex}/finalize`,
          { method: 'POST', signal: abort.signal },
        );
        setDetail(finished);
        setMetrics(finished.run.concurrencyMetrics ?? null);
        props.onRunSaved?.(finished.run);
        if (stageError) throw stageError;
        if (finished.run.status !== 'running') {
          setMessage('Exploration finished.');
          break;
        }
      }
      await refresh(id);
      setActiveId('');
    } catch (e) {
      setMessage(abort.signal.aborted ? 'Test stopped.' : 'Test interrupted.');
      setError(
        abort.signal.aborted
          ? 'Test stopped. In-flight evidence may take a moment to appear in history.'
          : (e as Error).message,
      );
      if (id) {
        try {
          const data = await refresh(id);
          if (!['ready', 'running', 'preflight'].includes(data.run.status))
            setActiveId('');
        } catch {}
      }
    } finally {
      setRunning(false);
      props.onRunningChange?.(false);
      props.onProgressChange?.('Throughput test finished');
      controller.current = null;
    }
  }
  const number = (value: number) =>
    value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const last = metrics?.stages.at(-1);
  const shownLevels =
    props.readOnly || running
      ? (detail?.run.concurrencyMetrics?.levels ?? CONCURRENCY_LEVELS)
      : selectedLevels;
  return (
    <section className="space-y-5 rounded-2xl border border-border bg-card p-5">
      <div>
        <h2 className="text-xl font-semibold">RPM / RPS & concurrency test</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Explore automatic levels or choose exact concurrency levels to measure
          successful RPM/RPS, TTFT and errors.
        </p>
      </div>
      {!props.readOnly && (
        <div className="space-y-3">
          <label className="block text-sm font-medium">
            Concurrency levels
            <select
              className="mt-2 block h-10 w-full rounded-lg border border-input bg-background px-3 text-sm sm:max-w-sm"
              value={customLevels ? 'custom' : 'automatic'}
              disabled={running || Boolean(activeId)}
              onChange={(event) =>
                setCustomLevels(event.target.value === 'custom')
              }
            >
              <option value="automatic">Automatic levels</option>
              <option value="custom">Custom levels</option>
            </select>
          </label>
          {customLevels && (
            <div className="space-y-2">
              <label htmlFor={levelsId} className="block text-sm font-medium">
                Concurrent requests at each level
              </label>
              <Input
                id={levelsId}
                value={levelsText}
                onChange={(event) => setLevelsText(event.target.value)}
                disabled={running || Boolean(activeId)}
                placeholder="60, 61, 70"
                aria-invalid={Boolean(levelsError)}
                aria-describedby={`${levelsId}-help${levelsError ? ` ${levelsId}-error` : ''}`}
              />
              <p
                id={`${levelsId}-help`}
                className="text-sm text-muted-foreground"
              >
                Run only these levels, in increasing order. Enter up to 12 whole
                numbers from 1 to 200, separated by commas. Use one number to
                test a single level, or edit the list to add intermediate
                levels.
              </p>
              {levelsError && (
                <p
                  id={`${levelsId}-error`}
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {levelsError}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      <div className="rounded-xl bg-muted/50 p-4 text-sm leading-6">
        <strong>
          Load levels:{' '}
          {levelsError && !props.readOnly && !running
            ? 'Enter valid levels above'
            : `${shownLevels.join(' → ')} concurrent requests`}
        </strong>
        <p>
          Up to 60 seconds per level, within a total budget of{' '}
          {levelsError && !props.readOnly && !running
            ? '—'
            : concurrencyRequestBudget(shownLevels).toLocaleString()}{' '}
          requests plus one connection check. Fast responses may reach the
          request budget sooner. New requests replace completed requests; higher
          levels stop after any request failure. Each request has a 20-second
          timeout.
        </p>
        <p>
          Uses your selected connection, model and Standard/Flex resource. These
          are short “OK” requests. New runs stream the answer to measure TTFT.
          Token/s is available in Normal Token Check. Provider usage may be
          charged. Keep this tab open.
        </p>
      </div>
      {!props.readOnly && (
        <div className="flex gap-3">
          {!props.user ? (
            <a
              className="font-semibold text-primary underline"
              href={props.signInPath}
            >
              Sign in to test
            </a>
          ) : (
            <>
              <Button
                onClick={() => void start()}
                disabled={
                  running ||
                  Boolean(activeId) ||
                  props.startBlocked ||
                  !props.selectedProfileId ||
                  props.profileDirty ||
                  Boolean(levelsError)
                }
              >
                {customLevels ? 'Start custom test' : 'Start automatic test'}
              </Button>
              {activeId && (
                <Button variant="outline" onClick={() => void stop()}>
                  Stop test
                </Button>
              )}
            </>
          )}
        </div>
      )}
      <p role="status" className="text-sm">
        {message}
        {running && started
          ? ` · ${Math.floor((clock - started) / 1000)} seconds elapsed`
          : ''}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {metrics && (
        <>
          <p className="text-sm text-muted-foreground">
            Levels saved with this run:{' '}
            {(metrics.levels ?? CONCURRENCY_LEVELS).join(' → ')}
          </p>
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
            <p className="font-semibold">
              {detail &&
              ['cancelled', 'inconclusive'].includes(detail.run.status)
                ? 'Test incomplete — provider limit undetermined'
                : last?.outcome === 'no_limit_observed'
                  ? 'Limit not reached'
                  : last?.outcome === 'rate_limit_observed'
                    ? 'Rate limiting observed'
                    : last?.outcome === 'tester_incomplete'
                      ? 'Tester incomplete'
                      : 'Request failures observed'}
            </p>
            <p className="mt-1 text-sm">{metrics.conclusion}</p>
          </div>
          {last && (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border p-4">
                <p className="text-sm text-muted-foreground">
                  Successful throughput · latest level
                </p>
                <p className="text-2xl font-semibold">
                  {number(last.successfulRps * 60)} RPM
                </p>
                <p>{number(last.successfulRps)} RPS</p>
              </div>
              <div className="rounded-xl border p-4">
                <p className="text-sm text-muted-foreground">
                  Actual peak / target concurrency
                </p>
                <p className="text-2xl font-semibold">
                  {last.peakConcurrency} / {last.concurrency}
                </p>
                <p className="text-sm">
                  Average {number(last.averageConcurrency)} in flight
                </p>
              </div>
              <div className="rounded-xl border p-4">
                <p className="text-sm text-muted-foreground">TTFT · median</p>
                <p className="text-2xl font-semibold">
                  {last.medianTtftMs == null
                    ? '—'
                    : `${number(last.medianTtftMs / 1000)} s`}
                </p>
                <p className="text-sm">
                  {last.errors} errors · {last.rateLimited} HTTP 429
                </p>
              </div>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="mb-3 text-left font-semibold">
                Results by concurrency level
              </caption>
              <thead>
                <tr className="border-b">
                  {[
                    'Target / actual peak',
                    'Successful RPM / RPS',
                    'TTFT (median)',
                    'Success / attempts',
                    'Errors / 429',
                    'Observed time',
                  ].map((label) => (
                    <th className="p-2 font-medium" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.stages.map((level) => (
                  <tr key={level.stageIndex} className="border-b">
                    <td className="p-2">
                      {level.concurrency} / {level.peakConcurrency}
                    </td>
                    <td className="p-2">
                      {number(level.successfulRps * 60)} /{' '}
                      {number(level.successfulRps)}
                    </td>
                    <td className="p-2">
                      {level.medianTtftMs == null
                        ? '—'
                        : `${number(level.medianTtftMs / 1000)} s`}
                      <span className="block text-xs text-muted-foreground">
                        {level.medianTtftMs == null
                          ? 'Not recorded'
                          : `${level.ttftSamples} responses measured`}
                      </span>
                    </td>
                    <td className="p-2">
                      {level.succeeded} / {level.attempts}
                      <span className="block text-xs text-muted-foreground">
                        {level.lateResponses} after window
                      </span>
                    </td>
                    <td className="p-2">
                      {level.errors} / {level.rateLimited}
                    </td>
                    <td className="p-2">
                      {number(level.elapsedMs / 1000)} s
                      <span className="block text-xs text-muted-foreground">
                        {!level.complete
                          ? 'Incomplete'
                          : level.budgetReached
                            ? 'Budget reached'
                            : level.errors
                              ? 'Stopped after errors'
                              : 'Window ended'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-muted-foreground">
            TTFT is the median time from sending a request to receiving its
            first answer text, including network time. It uses successful
            responses completed within the observed window. Older runs and
            non-streaming responses have no recorded TTFT.
          </p>
          <p className="text-sm text-muted-foreground">
            Actual concurrency is measured from overlapping upstream request
            intervals, including network time. Throughput uses each level’s
            observed window; late completions are retained but excluded from its
            rate. A peak is not sustained capacity. No 429 means only that no
            rate-limit response was observed in this workload. Limits can depend
            on the key, route, prompt length and rolling quotas. Runner
            continuation gaps remain in the measurement.
          </p>
        </>
      )}
      {detail && (
        <a
          className="inline-block text-sm font-semibold text-primary underline"
          href={`/api/rpm-runs/${detail.run.id}/export`}
        >
          Download saved evidence
        </a>
      )}
    </section>
  );
}
