'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  Gauge,
  LogIn,
  Play,
  RadioTower,
  ShieldCheck,
  Square,
  XCircle,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  buildRampTargets,
  type RpmRampMode,
  type RpmRunDetail,
  type RpmRunSummary,
  type RpmStageSummary,
} from '@/lib/rpm-types';

type BatchSummary = {
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

type LiveStage = BatchSummary & { returnedBatches: number };

const EMPTY_LIVE: LiveStage = {
  returnedBatches: 0,
  completed: 0,
  attempted: 0,
  succeeded: 0,
  rateLimited: 0,
  clientErrors: 0,
  serverErrors: 0,
  timeouts: 0,
  transportErrors: 0,
  malformed: 0,
  missedDispatch: 0,
};

async function jsonFetch<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, cache: 'no-store' });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & T;
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function waitUntil(timestamp: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted)
      return reject(new DOMException('Aborted', 'AbortError'));
    const timeout = window.setTimeout(
      resolve,
      Math.max(0, timestamp - Date.now()),
    );
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function duration(value: number | null | undefined) {
  if (typeof value !== 'number') return '—';
  return value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(3)} s`;
}

function statusBadge(status: RpmStageSummary['status']) {
  if (status === 'passed')
    return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (status === 'running') return 'border-blue-200 bg-blue-50 text-blue-800';
  if (status === 'failed' || status === 'inconclusive')
    return 'border-rose-200 bg-rose-50 text-rose-800';
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

export function RpmRampTest({
  user,
  signInPath,
  selectedProfileId,
  profileName,
  apiType,
  baseUrl,
  model,
  profileDirty,
  openedRunId,
  onRunningChange,
  onRunSaved,
}: {
  user: { displayName: string; email: string } | null;
  signInPath: string;
  selectedProfileId: string;
  profileName: string | null;
  apiType: 'anthropic' | 'openai';
  baseUrl: string;
  model: string;
  profileDirty: boolean;
  openedRunId: string;
  onRunningChange: (running: boolean) => void;
  onRunSaved: (run: RpmRunSummary) => void;
}) {
  const [targetRpm, setTargetRpm] = useState(1_000);
  const [threshold, setThreshold] = useState(90);
  const [rampMode, setRampMode] = useState<RpmRampMode>('balanced');
  const [detail, setDetail] = useState<RpmRunDetail | null>(null);
  const [live, setLive] = useState<Record<number, LiveStage>>({});
  const [message, setMessage] = useState(
    'Ready to preflight the exact load-test payload.',
  );
  const [error, setError] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const plan = useMemo(
    () => buildRampTargets(Math.max(1, targetRpm || 1), rampMode),
    [rampMode, targetRpm],
  );
  const estimatedRequests = plan.reduce(
    (total, stage) => total + stage.targetRpm,
    0,
  );
  const activeStage = detail?.stages.find(
    (stage) => stage.status === 'running',
  );
  const latestStage =
    activeStage ??
    [...(detail?.stages ?? [])]
      .reverse()
      .find((stage) => !['pending', 'skipped'].includes(stage.status));
  const latestLive = latestStage ? live[latestStage.stageIndex] : undefined;
  const completedNow = latestStage
    ? (latestLive?.completed ??
      latestStage.attemptedCount + latestStage.missedDispatchCount)
    : 0;
  const progress = latestStage
    ? Math.min(
        100,
        Math.round((completedNow / latestStage.scheduledCount) * 100),
      )
    : 0;

  useEffect(() => {
    if (!openedRunId || isRunning) return;
    void jsonFetch<RpmRunDetail>(`/api/rpm-runs/${openedRunId}`)
      .then((data) => {
        setDetail(data);
        setTargetRpm(data.run.targetRpm);
        setThreshold(data.run.thresholdBps / 100);
        setRampMode(data.run.rampMode);
        setMessage(
          `Saved RPM run from ${new Date(data.run.createdAt).toLocaleString()}.`,
        );
        setError('');
      })
      .catch((loadError: unknown) =>
        setError(
          loadError instanceof Error
            ? loadError.message
            : 'Could not open the saved RPM run.',
        ),
      );
  }, [isRunning, openedRunId]);

  function mergeBatch(stageIndex: number, summary: BatchSummary) {
    setLive((current) => {
      const previous = current[stageIndex] ?? EMPTY_LIVE;
      return {
        ...current,
        [stageIndex]: {
          returnedBatches: previous.returnedBatches + 1,
          completed: previous.completed + summary.completed,
          attempted: previous.attempted + summary.attempted,
          succeeded: previous.succeeded + summary.succeeded,
          rateLimited: previous.rateLimited + summary.rateLimited,
          clientErrors: previous.clientErrors + summary.clientErrors,
          serverErrors: previous.serverErrors + summary.serverErrors,
          timeouts: previous.timeouts + summary.timeouts,
          transportErrors: previous.transportErrors + summary.transportErrors,
          malformed: previous.malformed + summary.malformed,
          missedDispatch: previous.missedDispatch + summary.missedDispatch,
        },
      };
    });
  }

  async function cancelRun() {
    abortRef.current?.abort();
    const runId = detail?.run.id;
    if (!runId) return;
    setMessage(
      'Cancelling the run… in-flight provider calls may still finish.',
    );
    try {
      const cancelled = await jsonFetch<RpmRunDetail>(
        `/api/rpm-runs/${runId}/cancel`,
        { method: 'POST' },
      );
      setDetail(cancelled);
      onRunSaved(cancelled.run);
      setMessage('Run cancelled. Its export is clearly marked as partial.');
    } catch (cancelError) {
      setError(
        cancelError instanceof Error
          ? cancelError.message
          : 'Could not cancel the run.',
      );
    }
  }

  async function runRamp() {
    if (isRunning) return;
    setError('');
    if (!user) return setError('Sign in before running an RPM load test.');
    if (!selectedProfileId)
      return setError('Save or select a connection profile first.');
    if (profileDirty)
      return setError(
        'Save your profile changes before starting the RPM test.',
      );
    if (!model.trim()) return setError('Choose a model.');
    if (!Number.isInteger(targetRpm) || targetRpm < 1)
      return setError('Target RPM must be a positive whole number.');
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100)
      return setError(
        'Minimum success rate must be a whole number from 1 to 100.',
      );

    const controller = new AbortController();
    abortRef.current = controller;
    setIsRunning(true);
    onRunningChange(true);
    setLive({});
    setDetail(null);
    setMessage('Running one exact-payload preflight before load begins…');
    try {
      const startedRun = await jsonFetch<
        RpmRunDetail & { preflight: { outcome: string; error: string | null } }
      >('/api/rpm-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profileId: selectedProfileId,
          apiType,
          model: model.trim(),
          targetRpm,
          thresholdPercent: threshold,
          rampMode,
        }),
        signal: controller.signal,
      });
      let current: RpmRunDetail = startedRun;
      setDetail(startedRun);
      onRunSaved(startedRun.run);
      if (startedRun.run.status !== 'ready') {
        setMessage(
          `Preflight stopped the run: ${startedRun.run.stopReason ?? startedRun.preflight.error ?? startedRun.preflight.outcome}.`,
        );
        return;
      }

      for (const stage of current.stages) {
        if (controller.signal.aborted) break;
        setMessage(
          `Starting stage ${stage.stageIndex + 1}: ${stage.targetRpm.toLocaleString()} RPM for 60 seconds.`,
        );
        const started = await jsonFetch<{
          stage: RpmStageSummary;
          batchSize: number;
        }>(`/api/rpm-runs/${current.run.id}/stages/${stage.stageIndex}/start`, {
          method: 'POST',
          signal: controller.signal,
        });
        const startedStage = started.stage;
        setDetail((existing) =>
          existing
            ? {
                ...existing,
                run: {
                  ...existing.run,
                  status: 'running',
                  currentStage: stage.stageIndex,
                },
                stages: existing.stages.map((item) =>
                  item.stageIndex === stage.stageIndex ? startedStage : item,
                ),
              }
            : existing,
        );
        const intervalMs =
          (current.run.stageDurationSeconds * 1_000) /
          startedStage.scheduledCount;
        const batchPromises = Array.from(
          { length: startedStage.batchCount },
          async (_, batchIndex) => {
            const firstSequence = batchIndex * started.batchSize;
            const dispatchAt = Math.round(
              startedStage.scheduledStartAt! + firstSequence * intervalMs - 250,
            );
            await waitUntil(dispatchAt, controller.signal);
            const data = await jsonFetch<{
              batchIndex: number;
              summary: BatchSummary;
            }>(
              `/api/rpm-runs/${current.run.id}/stages/${stage.stageIndex}/batch`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ batchIndex }),
                signal: controller.signal,
              },
            );
            mergeBatch(stage.stageIndex, data.summary);
          },
        );
        await Promise.allSettled(batchPromises);
        if (controller.signal.aborted) break;
        setMessage(
          `Finalizing stage ${stage.stageIndex + 1} from server evidence…`,
        );
        current = await jsonFetch<RpmRunDetail>(
          `/api/rpm-runs/${current.run.id}/stages/${stage.stageIndex}/finalize`,
          { method: 'POST', signal: controller.signal },
        );
        setDetail(current);
        onRunSaved(current.run);
        const finalized = current.stages.find(
          (item) => item.stageIndex === stage.stageIndex,
        );
        if (finalized?.status !== 'passed') {
          setMessage(
            current.run.stopReason ??
              'This stage did not pass, so higher stages were skipped.',
          );
          break;
        }
        const nextStage = current.stages.find(
          (item) => item.stageIndex === stage.stageIndex + 1,
        );
        if (nextStage) {
          const cooldownEnds =
            startedStage.scheduledStartAt! +
            current.run.stageDurationSeconds * 1_000 +
            60_000;
          setMessage(
            'Stage passed. Waiting for the rolling one-minute window to clear before the next stage…',
          );
          await waitUntil(cooldownEnds, controller.signal);
        }
      }
      if (!controller.signal.aborted) {
        setMessage(
          current.run.status === 'passed'
            ? `Ramp passed through ${current.run.targetRpm.toLocaleString()} RPM.`
            : (current.run.stopReason ?? 'Ramp finished.'),
        );
      }
    } catch (runError) {
      if (!controller.signal.aborted) {
        setError(
          runError instanceof Error ? runError.message : 'RPM run failed.',
        );
        setMessage(
          'The runner stopped. If a run was created, its saved export shows the evidence preserved so far.',
        );
      }
    } finally {
      setIsRunning(false);
      onRunningChange(false);
      abortRef.current = null;
    }
  }

  const runTone = detail?.run.status;
  const reliabilitySuccess = latestStage
    ? (latestLive?.succeeded ?? latestStage.successCount)
    : 0;
  const reliabilityRate = latestStage
    ? (reliabilitySuccess / latestStage.scheduledCount) * 100
    : null;
  const rateLimited = latestStage
    ? (latestLive?.rateLimited ?? latestStage.rateLimitedCount)
    : 0;
  const missed = latestStage
    ? (latestLive?.missedDispatch ?? latestStage.missedDispatchCount)
    : 0;

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-border bg-card p-5 shadow-[0_18px_50px_rgb(15_23_42/0.06)]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              RPM ramp settings
            </p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight">
              Staged request-rate test
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              Each stage runs once for 60 seconds. The first stage below your
              success requirement stops every higher stage.
            </p>
            <p className="mt-2 max-w-2xl truncate font-mono text-[10px] text-muted-foreground">
              {profileName ?? 'No saved profile'} · {apiType} · {model || 'No model'} ·{' '}
              {baseUrl || 'No base URL'}
            </p>
          </div>
          {detail?.run.id ? (
            <a
              href={`/api/rpm-runs/${detail.run.id}/export`}
              className="inline-flex h-8 items-center justify-center gap-2 rounded-lg border border-border bg-background px-2.5 text-xs font-medium shadow-xs hover:bg-muted"
            >
              <Download className="size-3.5" /> Export full JSON
            </a>
          ) : null}
        </div>

        {!user ? (
          <div className="mt-5 rounded-xl border border-blue-200 bg-blue-50/70 p-4 text-sm text-blue-950">
            RPM testing creates real provider load and is available only after
            sign-in.{' '}
            <a
              href={signInPath}
              target="_top"
              className="font-semibold underline"
            >
              <LogIn className="mr-1 inline size-4" /> Sign in with ChatGPT
            </a>
          </div>
        ) : (
          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            <label
              htmlFor="rpm-target"
              className="grid gap-1.5 text-xs font-medium"
            >
              Target RPM
              <Input
                id="rpm-target"
                type="number"
                min={1}
                step={1}
                value={targetRpm}
                disabled={isRunning}
                onChange={(event) => setTargetRpm(Number(event.target.value))}
                className="h-10 font-mono"
              />
              <span className="font-normal text-muted-foreground">
                No 1,000-RPM product cap; a deployment safety budget still
                applies.
              </span>
            </label>
            <label
              htmlFor="rpm-threshold"
              className="grid gap-1.5 text-xs font-medium"
            >
              Minimum success rate
              <div className="relative">
                <Input
                  id="rpm-threshold"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={threshold}
                  disabled={isRunning}
                  onChange={(event) => setThreshold(Number(event.target.value))}
                  className="h-10 pr-8 font-mono"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  %
                </span>
              </div>
              <span className="font-normal text-muted-foreground">
                Default 90%. Exactly 90.00% passes.
              </span>
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Ramp detail
              <select
                value={rampMode}
                disabled={isRunning}
                onChange={(event) =>
                  setRampMode(event.target.value as RpmRampMode)
                }
                className="h-10 rounded-lg border border-input bg-background px-3 text-sm shadow-xs outline-none focus:ring-2 focus:ring-ring/30"
              >
                <option value="balanced">Balanced · 5 stages</option>
                <option value="detailed">Detailed · 10% steps</option>
              </select>
              <span className="font-normal text-muted-foreground">
                Balanced: 10%, 25%, 50%, 75%, 100%.
              </span>
            </label>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {plan.map((stage) => (
            <Badge
              key={`${stage.percentage}-${stage.targetRpm}`}
              variant="outline"
            >
              {stage.percentage}% · {stage.targetRpm.toLocaleString()} RPM
            </Badge>
          ))}
        </div>
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/75 p-3 text-xs leading-5 text-amber-950">
          <strong>Planned load:</strong> about{' '}
          {estimatedRequests.toLocaleString()} paid API requests, plus one
          preflight. A 60-second quiet window separates stages so rolling-minute
          limits do not overlap.
        </div>
        {error ? (
          <Alert variant="destructive" className="mt-4">
            <AlertTriangle />
            <AlertTitle>RPM test stopped</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {isRunning ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void cancelRun()}
              className="gap-2"
            >
              <Square className="size-3.5 fill-current" /> Stop and save partial
              evidence
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void runRamp()}
              disabled={!user || !selectedProfileId || profileDirty}
              className="gap-2 bg-[#f3a712] text-[#172033] hover:bg-[#e99a02]"
            >
              <Play className="size-4 fill-current" /> Start RPM ramp
            </Button>
          )}
          <span className="text-xs text-muted-foreground">{message}</span>
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Reliability"
          value={
            reliabilityRate === null
              ? 'Waiting'
              : `${reliabilityRate.toFixed(2)}%`
          }
          detail={
            latestStage
              ? `${reliabilitySuccess} successful of ${latestStage.scheduledCount} planned`
              : `Pass threshold ${threshold}%`
          }
          icon={runTone === 'passed' ? CheckCircle2 : Activity}
          tone={runTone === 'failed' ? 'danger' : 'default'}
        />
        <MetricCard
          label="Rate limit"
          value={latestStage ? rateLimited.toLocaleString() : 'Waiting'}
          detail="HTTP 429 is counted separately; it affects reliability like any failed request."
          icon={RadioTower}
          tone={rateLimited ? 'warning' : 'default'}
        />
        <MetricCard
          label="Dispatch validity"
          value={
            latestStage?.dispatchValid === false || missed
              ? 'Invalid'
              : latestStage?.dispatchValid === true
                ? 'Valid'
                : isRunning
                  ? 'Measuring'
                  : 'Waiting'
          }
          detail={`${missed} missed or late dispatches in the current stage`}
          icon={missed ? XCircle : ShieldCheck}
          tone={missed ? 'danger' : 'default'}
        />
        <MetricCard
          label="Performance"
          value={duration(latestStage?.p95LatencyMs)}
          detail={`Median ${duration(latestStage?.medianLatencyMs)} · P95 total latency`}
          icon={Gauge}
        />
      </div>

      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_18px_50px_rgb(15_23_42/0.06)]">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">Ramp stages</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Request payload: max_tokens=8 · stream=false · no temperature,
            top_p, top_k, system, tools, cache controls, or retries.
          </p>
          {activeStage ? (
            <Progress
              value={progress}
              className="mt-4"
              aria-label={`${progress}% complete`}
            />
          ) : null}
        </div>
        <div className="divide-y divide-border">
          {(
            detail?.stages ??
            plan.map((stage, stageIndex) => ({
              id: `plan-${stageIndex}`,
              runId: '',
              stageIndex,
              percentage: stage.percentage,
              targetRpm: stage.targetRpm,
              scheduledCount: stage.targetRpm,
              batchCount: 0,
              status: 'pending' as const,
              scheduledStartAt: null,
              startedAt: null,
              finishedAt: null,
              attemptedCount: 0,
              successCount: 0,
              rateLimitedCount: 0,
              clientErrorCount: 0,
              serverErrorCount: 0,
              timeoutCount: 0,
              transportErrorCount: 0,
              malformedCount: 0,
              missedDispatchCount: 0,
              successRateBps: null,
              dispatchValid: null,
              medianLatencyMs: null,
              p95LatencyMs: null,
              p95ScheduleLagMs: null,
            }))
          ).map((stage) => {
            const stageLive = live[stage.stageIndex];
            const successes = stageLive?.succeeded ?? stage.successCount;
            const completed =
              stageLive?.completed ??
              stage.attemptedCount + stage.missedDispatchCount;
            return (
              <div
                key={stage.id}
                className="grid gap-3 px-5 py-4 md:grid-cols-[1fr_repeat(4,110px)] md:items-center"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="grid size-7 place-items-center rounded-md bg-muted font-mono text-[10px] text-muted-foreground">
                      {String(stage.stageIndex + 1).padStart(2, '0')}
                    </span>
                    <span className="font-semibold">
                      {stage.targetRpm.toLocaleString()} RPM
                    </span>
                    <Badge
                      variant="outline"
                      className={statusBadge(stage.status)}
                    >
                      {stage.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {stage.percentage}% of target ·{' '}
                    {stage.scheduledCount.toLocaleString()} requests / 60 s
                  </p>
                </div>
                <StageValue
                  label="Complete"
                  value={`${completed}/${stage.scheduledCount}`}
                />
                <StageValue
                  label="Success"
                  value={
                    stage.successRateBps === null
                      ? successes.toLocaleString()
                      : `${(stage.successRateBps / 100).toFixed(2)}%`
                  }
                />
                <StageValue
                  label="429"
                  value={(
                    stageLive?.rateLimited ?? stage.rateLimitedCount
                  ).toLocaleString()}
                />
                <StageValue
                  label="P95 latency"
                  value={duration(stage.p95LatencyMs)}
                />
              </div>
            );
          })}
        </div>
      </section>

      {detail?.run.stopReason ? (
        <p className="px-1 text-xs leading-5 text-muted-foreground">
          <Clock3 className="mr-1 inline size-3" /> {detail.run.stopReason}
        </p>
      ) : null}
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Activity;
  tone?: 'default' | 'warning' | 'danger';
}) {
  return (
    <section
      className={`rounded-2xl border p-4 ${tone === 'danger' ? 'border-rose-200 bg-rose-50/70' : tone === 'warning' ? 'border-amber-200 bg-amber-50/70' : 'border-border bg-card'}`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {label}
        </p>
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <p className="mt-2 font-mono text-xl font-semibold">{value}</p>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
        {detail}
      </p>
    </section>
  );
}

function StageValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="md:text-right">
      <p className="font-mono text-xs font-semibold">{value}</p>
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
    </div>
  );
}
