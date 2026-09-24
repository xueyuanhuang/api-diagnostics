'use client';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import type { RpmRampTest } from './rpm-ramp-test';
import type { RpmRunDetail, RpmRunSummary } from '@/lib/rpm-types';
import type { AutomaticMetrics } from '@/lib/automatic-throughput';
import { Button } from './ui/button';
import { confirmHttpRisk, isInsecureHttp } from '@/lib/http-consent';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
  return data;
}
export function AutomaticThroughputTest(
  props: ComponentProps<typeof RpmRampTest>,
) {
  const [detail, setDetail] = useState<RpmRunDetail | null>(null);
  const [metrics, setMetrics] = useState<AutomaticMetrics | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('Ready to measure.');
  const [error, setError] = useState('');
  const [activeId, setActiveId] = useState('');
  const controller = useRef<AbortController | null>(null);
  const idRef = useRef('');
  const transportFailures =
    detail?.stages.reduce((sum, stage) => sum + stage.transportErrorCount, 0) ??
    0;
  const [clock, setClock] = useState(0);
  const [started, setStarted] = useState(0);
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
        setMetrics(data.run.automaticMetrics ?? null);
        setMessage(data.run.stopReason ?? data.run.status);
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
    setMetrics(data.run.automaticMetrics ?? null);
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
          rampMode: 'automatic',
          runnerVersion: 2,
        }),
      });
      id = created.run.id;
      idRef.current = id;
      setActiveId(id);
      setDetail(created);
      props.onRunSaved?.(created.run);
      const preflight = await json<RpmRunDetail>(
        `/api/rpm-runs/${id}/preflight`,
        { method: 'POST', signal: abort.signal },
      );
      if (preflight.run.status !== 'ready')
        throw new Error(
          preflight.run.stopReason ||
            'Connection check did not succeed. No throughput workload was started.',
        );
      setMessage('Measuring automatically…');
      let nextChunk: number | null = 0;
      while (nextChunk !== null) {
        const chunk: number = nextChunk;
        nextChunk = null;
        const response = await fetch(`/api/rpm-runs/${id}/measure`, {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chunk }),
          method: 'POST',
          signal: abort.signal,
        });
        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
          throw new Error(body.error || 'Measurement could not start.');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('No measurement stream received.');
        const decoder = new TextDecoder();
        let pending = '';
        let done = false;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          pending += decoder.decode(part.value, { stream: true });
          let lineEnd;
          while ((lineEnd = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, lineEnd);
            pending = pending.slice(lineEnd + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            if (event.type === 'started') {
              setStarted(event.startedAt);
              setClock(Date.now());
            }
            if (event.metrics) setMetrics(event.metrics);
            if (event.type === 'continue') {
              nextChunk = event.chunk;
              done = true;
            }
            if (event.type === 'done') {
              done = true;
              setMessage(event.reason);
            }
            if (event.type === 'error') throw new Error(event.error);
          }
        }
        if (!done)
          throw new Error(
            'Progress connection ended before the result was confirmed. Check saved history.',
          );
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
  const progress = started
    ? Math.min(60, Math.max(0, (clock - started) / 1000))
    : 0;
  return (
    <section className="space-y-5 rounded-2xl border border-border bg-card p-5">
      <div>
        <h2 className="text-xl font-semibold">Automatic RPM / RPS test</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Click Start to measure throughput. No rate or concurrency setup
          needed.
        </p>
      </div>
      <div className="rounded-xl bg-muted/50 p-4 text-sm leading-6">
        <strong>Built-in test conditions</strong>
        <p>
          Five requests in flight · 60-second measurement · up to 300 requests,
          plus one connection check. Each request has a 20-second timeout. A new
          request starts when one finishes; rate-limit responses pause that
          worker briefly.
        </p>
        <p>
          Uses your selected connection, model and Standard/Flex resource.
          Provider usage may be charged. Keep this tab open; switching sections
          within this website is supported.
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
                  props.profileDirty
                }
              >
                Start automatic test
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
          ? ` ${Math.floor(progress)} / 60 seconds${progress >= 60 ? ' · waiting for final responses' : ''}`
          : ''}
      </p>
      {transportFailures > 0 && (
        <p role="alert" className="text-sm text-amber-800">
          {transportFailures} attempts failed without a complete provider
          response (transport errors). These are not HTTP 429 responses. Attempt
          counts do not prove delivery to the provider; this run cannot
          establish provider capacity.{' '}
          {metrics?.latencyScope !== 'successful_responses'
            ? 'This older run includes failed attempts in latency.'
            : ''}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
          {error.includes('out of date') && (
            <button type="button" className="ml-2 underline" onClick={() => window.location.reload()}>Refresh page</button>
          )}
        </p>
      )}
      {metrics && (
        <>
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm">
            <strong>Provider limit not established</strong>
            <p>This older test used a fixed limit of {metrics.concurrency} concurrent requests. {number(metrics.successfulRps * 60)} RPM is its measured throughput, not the model’s maximum. {metrics.rateLimited === 0 ? 'No HTTP 429 was observed; higher load was not tested.' : 'Rate limiting was observed, but its cause and the sustainable limit need further testing.'}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ['Completed attempts', metrics.completedRps],
              ['Successful requests', metrics.successfulRps],
              ['Request attempts', metrics.sentRps],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl border p-4">
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="text-2xl font-semibold">
                  {number(Number(value) * 60)} RPM
                </p>
                <p>{number(Number(value))} RPS</p>
              </div>
            ))}
          </div>
          <p className="text-sm">
            {metrics.providerResponses !== undefined &&
              `${metrics.providerResponses} provider responses · `}
            {metrics.sent} attempts · {metrics.completed} completed in the
            window · {metrics.succeeded} successful · {metrics.errors} errors
            (including {metrics.rateLimited} rate-limit responses) ·{' '}
            {metrics.lateResponses} responses after the window.
          </p>
          <p className="text-sm">
            Observed window: {number(metrics.elapsedMs / 1000)} seconds · Median
            latency (
            {metrics.latencyScope === 'successful_responses'
              ? 'successful responses'
              : 'all attempts'}
            ): {metrics.medianLatencyMs ?? '—'} ms · P95 (
            {metrics.latencyScope === 'successful_responses'
              ? 'successful responses'
              : 'all attempts'}
            ): {metrics.p95LatencyMs ?? '—'} ms.
          </p>
          <p className="text-sm text-muted-foreground">
            Rates use the actual observed window. Late responses remain in the
            evidence but do not inflate completion rates. This measures
            performance with five concurrent requests, including tester
            overhead; it does not establish a provider’s maximum capacity.
            {metrics.stopReason === 'request_cap'
              ? ' The request budget shortened this run.'
              : ''}
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
