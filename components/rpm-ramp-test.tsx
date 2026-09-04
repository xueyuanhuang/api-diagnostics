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
  ShieldAlert,
  ShieldCheck,
  Square,
  XCircle,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { armStageWhenReady } from '@/lib/rpm-arm';
import {
  buildRampTargets,
  RPM_FINALIZE_GRACE_MS,
  RPM_MAX_TARGET_RPM,
  RPM_REQUEST_TIMEOUT_MS,
  type RpmPreflightSummary,
  type RpmRampMode,
  type RpmRunDetail,
  type RpmRunSummary,
  type RpmStageSummary,
} from '@/lib/rpm-types';
import { deriveStageMetrics } from '@/lib/rpm-stage-metrics';

type OutcomeSummary = {
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

type LiveStage = OutcomeSummary & { dispatched: number };
type ShardStreamEvent =
  | { type: 'ready'; shardIndex: number; sequenceCount: number }
  | { type: 'dispatched'; shardIndex: number; sequence: number }
  | {
      type: 'request';
      shardIndex: number;
      sequence: number;
      summary: OutcomeSummary;
    }
  | { type: 'complete'; shardIndex: number; summary: OutcomeSummary }
  | { type: 'error'; shardIndex: number; error: string };
type ShardHandle = { complete: Promise<void> };
type RunnerPhase =
  | 'idle'
  | 'creating'
  | 'preflight'
  | 'stageStarting'
  | 'stage'
  | 'finalizing'
  | 'cooldown'
  | 'complete'
  | 'failed'
  | 'inconclusive'
  | 'cancelling'
  | 'cancelled'
  | 'attention';

type JsonErrorBody = {
  error?: string;
  activeRunId?: string | null;
  activeRunStatus?: string;
  preflightInProgress?: boolean;
  finalizationPending?: boolean;
  retryAfterMs?: number;
};
type RpmDetailWithPreflight = RpmRunDetail & {
  preflight?: RpmPreflightSummary | null;
  liveProgress?: {
    stageIndex: number;
    scheduledRequests: number;
    expectedDispatchers: number;
    readyDispatchers: number;
    verifiedDispatchStarts: number;
    evidenceRecords: number;
  } | null;
  testerDiagnostics?: Array<{
    stageIndex: number;
    sequence: number | null;
    shardIndex: number | null;
    plannedAt: number | null;
    recordedAt: number | null;
    scheduleLagMs: number | null;
    reason: string;
  }>;
};

class JsonFetchError extends Error {
  status: number;
  data: JsonErrorBody;

  constructor(status: number, data: JsonErrorBody) {
    super(data.error || `HTTP ${status}`);
    this.name = 'JsonFetchError';
    this.status = status;
    this.data = data;
  }
}

const EMPTY_LIVE: LiveStage = {
  dispatched: 0,
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
  const body = (await response.json().catch(() => ({}))) as JsonErrorBody & T;
  if (!response.ok) throw new JsonFetchError(response.status, body);
  return body;
}

function openServerShard({
  url,
  signal,
  onDispatched,
  onRequest,
}: {
  url: string;
  signal: AbortSignal;
  onDispatched: () => void;
  onRequest: (summary: OutcomeSummary) => void;
}): ShardHandle {
  let readySeen = false;
  let completeSeen = false;
  const complete = (async () => {
    const response = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as JsonErrorBody;
      throw new JsonFetchError(response.status, body);
    }
    if (!response.body)
      throw new Error('The server dispatcher returned no progress stream.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as ShardStreamEvent;
      if (event.type === 'ready') {
        readySeen = true;
      } else if (event.type === 'dispatched') {
        onDispatched();
      } else if (event.type === 'request') {
        onRequest(event.summary);
      } else if (event.type === 'complete') {
        completeSeen = true;
      } else if (event.type === 'error') {
        throw new Error(event.error);
      }
    };
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    consumeLine(buffer);
    if (!readySeen)
      throw new Error('The server dispatcher closed before it was ready.');
    if (!completeSeen)
      throw new Error(
        'The server dispatcher stream closed before it completed.',
      );
  })();
  return { complete };
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

async function finalizeStageWithBarrier(url: string, signal: AbortSignal) {
  while (true) {
    try {
      return await jsonFetch<RpmRunDetail>(url, {
        method: 'POST',
        signal,
      });
    } catch (error) {
      if (
        !(error instanceof JsonFetchError) ||
        error.status !== 409 ||
        !error.data.finalizationPending
      ) {
        throw error;
      }
      await waitUntil(
        Date.now() + Math.max(250, error.data.retryAfterMs ?? 1_000),
        signal,
      );
    }
  }
}

async function pollPersistedStageProgress({
  url,
  stageIndex,
  signal,
  shouldContinue,
  onProgress,
}: {
  url: string;
  stageIndex: number;
  signal: AbortSignal;
  shouldContinue: () => boolean;
  onProgress: (
    progress: NonNullable<RpmDetailWithPreflight['liveProgress']>,
  ) => void;
}) {
  while (!signal.aborted && shouldContinue()) {
    try {
      const detail = await jsonFetch<RpmDetailWithPreflight>(url, { signal });
      if (detail.liveProgress?.stageIndex === stageIndex) {
        onProgress(detail.liveProgress);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      // Live progress is best effort; finalization still reads canonical evidence.
    }
    if (!shouldContinue()) break;
    await waitUntil(Date.now() + 1_000, signal);
  }
}

function waitForDispatcherCompletion(
  handles: ShardHandle[],
  deadline: number,
  signal: AbortSignal,
) {
  return new Promise<{
    timedOut: boolean;
    results: PromiseSettledResult<void>[] | null;
  }>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    let timeout = 0;
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (value: {
      timedOut: boolean;
      results: PromiseSettledResult<void>[] | null;
    }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    timeout = window.setTimeout(
      () => finish({ timedOut: true, results: null }),
      Math.max(0, deadline - Date.now()),
    );
    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.allSettled(handles.map((handle) => handle.complete)).then(
      (results) => finish({ timedOut: false, results }),
    );
  });
}

function duration(value: number | null | undefined) {
  if (typeof value !== 'number') return '—';
  return value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(3)} s`;
}

function percentage(value: number | null | undefined) {
  return typeof value === 'number' ? `${value.toFixed(2)}%` : 'Not observed';
}

function clock(valueMs: number) {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1_000));
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function resolvedEndpoint(baseUrl: string, apiType: 'anthropic' | 'openai') {
  try {
    const url = new URL(baseUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    const path = url.pathname.replace(/\/+$/, '');
    const completePath =
      apiType === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
    const finalSegment =
      apiType === 'anthropic' ? '/messages' : '/chat/completions';
    if (path.endsWith(completePath)) url.pathname = path;
    else if (path.endsWith('/v1')) url.pathname = `${path}${finalSegment}`;
    else url.pathname = `${path}${completePath}`.replace(/^\/\//, '/');
    return url.toString();
  } catch {
    return 'Invalid endpoint';
  }
}

function statusBadge(status: RpmStageSummary['status']) {
  if (status === 'passed')
    return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (status === 'running' || status === 'finalizing')
    return 'border-blue-200 bg-blue-50 text-blue-800';
  if (status === 'failed') return 'border-rose-200 bg-rose-50 text-rose-800';
  if (status === 'inconclusive')
    return 'border-amber-200 bg-amber-50 text-amber-900';
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

function statusLabel(status: RpmStageSummary['status']) {
  return status === 'inconclusive' ? 'tester error' : status;
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
  const [detail, setDetail] = useState<RpmDetailWithPreflight | null>(null);
  const [live, setLive] = useState<Record<number, LiveStage>>({});
  const [message, setMessage] = useState(
    'Ready to preflight the exact load-test payload.',
  );
  const [error, setError] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [phase, setPhase] = useState<RunnerPhase>('idle');
  const [phaseStartedAt, setPhaseStartedAt] = useState<number | null>(null);
  const [phaseEndsAt, setPhaseEndsAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [preflight, setPreflight] = useState<RpmPreflightSummary | null>(null);
  const [recoverableRunId, setRecoverableRunId] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const loadedOpenedRunIdRef = useRef('');

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  const plan = useMemo(
    () => buildRampTargets(Math.max(1, targetRpm || 1), rampMode),
    [rampMode, targetRpm],
  );
  const estimatedRequests = plan.reduce(
    (total, stage) => total + stage.targetRpm,
    0,
  );
  const activeStage = detail?.stages.find((stage) =>
    ['running', 'finalizing'].includes(stage.status),
  );
  const latestStage =
    activeStage ??
    [...(detail?.stages ?? [])]
      .reverse()
      .find((stage) => !['pending', 'skipped'].includes(stage.status));
  const latestLive = latestStage ? live[latestStage.stageIndex] : undefined;
  const latestMetrics = latestStage
    ? deriveStageMetrics(latestStage, latestLive)
    : null;
  const completedNow = latestMetrics?.recorded ?? 0;
  const progress = latestStage
    ? Math.min(
        100,
        Math.round((completedNow / latestStage.scheduledCount) * 100),
      )
    : 0;

  useEffect(() => {
    if (
      !openedRunId ||
      isRunning ||
      loadedOpenedRunIdRef.current === openedRunId
    )
      return;
    let ignore = false;
    void jsonFetch<RpmDetailWithPreflight>(`/api/rpm-runs/${openedRunId}`)
      .then((data) => {
        if (ignore) return;
        loadedOpenedRunIdRef.current = openedRunId;
        setLive({});
        setPreflight(data.preflight ?? null);
        setError('');
        setDetail(data);
        activeRunIdRef.current = ['preflight', 'ready', 'running'].includes(
          data.run.status,
        )
          ? data.run.id
          : null;
        setRecoverableRunId(activeRunIdRef.current ?? '');
        setTargetRpm(data.run.targetRpm);
        setThreshold(data.run.thresholdBps / 100);
        setRampMode(data.run.rampMode);
        setPhase(
          data.run.status === 'cancelled'
            ? 'cancelled'
            : ['preflight', 'ready', 'running'].includes(data.run.status)
              ? 'attention'
              : data.run.status === 'passed'
                ? 'complete'
                : data.run.status === 'inconclusive'
                  ? 'inconclusive'
                  : 'failed',
        );
        setMessage(
          `Saved RPM run from ${new Date(data.run.createdAt).toLocaleString()}.`,
        );
        setError('');
      })
      .catch((loadError: unknown) => {
        if (ignore) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : 'Could not open the saved RPM run.',
        );
      });
    return () => {
      ignore = true;
    };
  }, [isRunning, openedRunId]);

  useEffect(() => {
    if (!user || isRunning || openedRunId || detail) return;
    let ignore = false;
    void jsonFetch<{ runs: RpmRunSummary[] }>('/api/rpm-runs')
      .then(async ({ runs }) => {
        const active = runs.find((run) =>
          ['preflight', 'ready', 'running'].includes(run.status),
        );
        if (!active) return;
        const data = await jsonFetch<RpmDetailWithPreflight>(
          `/api/rpm-runs/${active.id}`,
        );
        if (ignore) return;
        activeRunIdRef.current = active.id;
        setRecoverableRunId(active.id);
        setDetail(data);
        setPreflight(data.preflight ?? null);
        setPhase('attention');
        setMessage(
          `A previous ${active.status} run is still active. Its live dispatcher session cannot be resumed after leaving the page; cancel it before starting again.`,
        );
      })
      .catch(() => {
        // Saved-run discovery is best effort; Start still handles a 409 safely.
      });
    return () => {
      ignore = true;
    };
  }, [detail, isRunning, openedRunId, user]);

  async function cancelRun() {
    const runId = activeRunIdRef.current ?? detail?.run.id;
    if (!runId) {
      setMessage('The run is still being created. Try Stop again in a moment.');
      return;
    }
    setError('');
    setPhase('cancelling');
    setMessage(
      'Cancelling the run… in-flight provider calls may still finish.',
    );
    try {
      const cancelled = await jsonFetch<RpmRunDetail>(
        `/api/rpm-runs/${runId}/cancel`,
        { method: 'POST' },
      );
      abortRef.current?.abort();
      loadedOpenedRunIdRef.current = cancelled.run.id;
      setDetail(cancelled);
      onRunSaved(cancelled.run);
      if (cancelled.run.status === 'cancelled') {
        activeRunIdRef.current = null;
        setRecoverableRunId('');
        setPhase('cancelled');
        setMessage('Run cancelled. Its export is clearly marked as partial.');
      } else if (cancelled.run.status === 'passed') {
        activeRunIdRef.current = null;
        setRecoverableRunId('');
        setPhase('complete');
        setMessage(
          'The run finished successfully before cancellation applied.',
        );
      } else if (['failed', 'inconclusive'].includes(cancelled.run.status)) {
        activeRunIdRef.current = null;
        setRecoverableRunId('');
        setPhase(
          cancelled.run.status === 'inconclusive' ? 'inconclusive' : 'failed',
        );
        setMessage(
          cancelled.run.stopReason ??
            'The run had already finished before cancellation applied.',
        );
      } else {
        activeRunIdRef.current = cancelled.run.id;
        setRecoverableRunId(cancelled.run.id);
        setPhase('attention');
        setMessage('The run is still active. Try cancelling it again.');
      }
    } catch (cancelError) {
      abortRef.current?.abort();
      setPhase('attention');
      setMessage(
        'Local scheduling stopped, but server cancellation was not confirmed. Try Cancel active run again.',
      );
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
    if (targetRpm > RPM_MAX_TARGET_RPM)
      return setError(
        `This deployment supports targets up to ${RPM_MAX_TARGET_RPM.toLocaleString()} RPM.`,
      );
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100)
      return setError(
        'Minimum success rate must be a whole number from 1 to 100.',
      );

    const controller = new AbortController();
    abortRef.current = controller;
    setNow(Date.now());
    setIsRunning(true);
    onRunningChange(true);
    setLive({});
    setDetail(null);
    setPreflight(null);
    setRecoverableRunId('');
    activeRunIdRef.current = null;
    setPhase('creating');
    setPhaseStartedAt(Date.now());
    setPhaseEndsAt(null);
    setMessage('Creating a saved run before any provider traffic is sent…');
    try {
      const createdRun = await jsonFetch<RpmRunDetail>('/api/rpm-runs', {
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
      });
      activeRunIdRef.current = createdRun.run.id;
      loadedOpenedRunIdRef.current = createdRun.run.id;
      setRecoverableRunId(createdRun.run.id);
      setDetail(createdRun);
      onRunSaved(createdRun.run);
      setPhase('preflight');
      setPhaseStartedAt(Date.now());
      setPhaseEndsAt(Date.now() + 45_000);
      setMessage(
        'One exact load-test request was sent. Waiting for the provider response…',
      );

      const preflightRun = await jsonFetch<
        RpmRunDetail & { preflight: RpmPreflightSummary | null }
      >(`/api/rpm-runs/${createdRun.run.id}/preflight`, {
        method: 'POST',
        signal: controller.signal,
      });
      setPreflight(preflightRun.preflight);
      let current: RpmRunDetail = {
        run: preflightRun.run,
        stages: preflightRun.stages,
      };
      setDetail(current);
      onRunSaved(current.run);
      if (current.run.status !== 'ready') {
        activeRunIdRef.current = null;
        setRecoverableRunId('');
        if (current.run.status === 'cancelled') {
          setPhase('cancelled');
          setMessage('Run cancelled before ramp traffic began.');
          return;
        }
        setPhase(
          current.run.status === 'inconclusive' ? 'inconclusive' : 'failed',
        );
        setError(
          current.run.stopReason ??
            preflightRun.preflight?.error ??
            'The preflight did not pass.',
        );
        setMessage('Preflight failed — the staged load test did not begin.');
        return;
      }

      setMessage('Preflight passed. Preparing the first ramp stage…');

      for (const stage of current.stages) {
        if (controller.signal.aborted) break;
        setPhase('stageStarting');
        setPhaseStartedAt(Date.now());
        setPhaseEndsAt(null);
        setMessage(
          `Starting stage ${stage.stageIndex + 1}: ${stage.targetRpm.toLocaleString()} RPM for 60 seconds.`,
        );
        const started = await jsonFetch<{
          stage: RpmStageSummary;
          shardCount: number;
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
        setMessage(
          `Preparing ${started.shardCount} server dispatchers. No stage traffic is sent until every dispatcher is ready…`,
        );
        const shardHandles = Array.from(
          { length: started.shardCount },
          (_, shardIndex) =>
            openServerShard({
              url: `/api/rpm-runs/${current.run.id}/stages/${stage.stageIndex}/shards/${shardIndex}`,
              signal: controller.signal,
              onDispatched: () => undefined,
              onRequest: () => undefined,
            }),
        );
        let armedStage = startedStage;
        let finalizationMessage = `Finalizing stage ${stage.stageIndex + 1} from server evidence…`;
        try {
          let armed: { stage: RpmStageSummary; shardCount: number };
          try {
            armed = await armStageWhenReady({
              signal: controller.signal,
              attempt: () =>
                jsonFetch<{
                  stage: RpmStageSummary;
                  shardCount: number;
                }>(
                  `/api/rpm-runs/${current.run.id}/stages/${stage.stageIndex}/arm`,
                  { method: 'POST', signal: controller.signal },
                ),
              wait: (delayMs, signal) =>
                waitUntil(Date.now() + delayMs, signal),
            });
          } catch (armError) {
            if (controller.signal.aborted) throw armError;
            const recovered = await jsonFetch<RpmDetailWithPreflight>(
              `/api/rpm-runs/${current.run.id}`,
              { signal: controller.signal },
            );
            const recoveredStage = recovered.stages.find(
              (item) => item.stageIndex === stage.stageIndex,
            );
            if (
              recovered.run.status !== 'running' ||
              recovered.run.currentStage !== stage.stageIndex ||
              recoveredStage?.status !== 'running' ||
              recoveredStage.scheduledStartAt === null
            ) {
              throw armError;
            }
            current = recovered;
            armed = {
              stage: recoveredStage,
              shardCount: recoveredStage.batchCount,
            };
            setMessage(
              'The arm response was interrupted, but the saved server schedule was confirmed. Waiting for its results…',
            );
          }
          armedStage = armed.stage;
          setPhase('stage');
          setPhaseStartedAt(armedStage.scheduledStartAt ?? Date.now());
          setPhaseEndsAt(
            (armedStage.scheduledStartAt ?? Date.now()) +
              current.run.stageDurationSeconds * 1_000,
          );
          setDetail((existing) =>
            existing
              ? {
                  ...existing,
                  stages: existing.stages.map((item) =>
                    item.stageIndex === stage.stageIndex ? armedStage : item,
                  ),
                }
              : existing,
          );
          setMessage(
            `All ${armed.shardCount} server dispatchers are ready. The shared server schedule is now running.`,
          );
          const completionDeadline =
            armedStage.scheduledStartAt! +
            current.run.stageDurationSeconds * 1_000 +
            RPM_REQUEST_TIMEOUT_MS +
            RPM_FINALIZE_GRACE_MS;
          let progressPolling = true;
          const progressPromise = pollPersistedStageProgress({
            url: `/api/rpm-runs/${current.run.id}`,
            stageIndex: stage.stageIndex,
            signal: controller.signal,
            shouldContinue: () => progressPolling,
            onProgress: (progress) => {
              setLive((existing) => ({
                ...existing,
                [stage.stageIndex]: {
                  ...(existing[stage.stageIndex] ?? EMPTY_LIVE),
                  dispatched: progress.verifiedDispatchStarts,
                  completed: progress.evidenceRecords,
                },
              }));
              setMessage(
                `${progress.readyDispatchers}/${progress.expectedDispatchers} dispatchers ready · ${progress.verifiedDispatchStarts}/${progress.scheduledRequests} verified sends · ${progress.evidenceRecords} outcomes preserved.`,
              );
            },
          });
          const completion = await waitForDispatcherCompletion(
            shardHandles,
            completionDeadline,
            controller.signal,
          );
          progressPolling = false;
          await progressPromise.catch(() => undefined);
          if (completion.timedOut) {
            finalizationMessage =
              'The stage evidence deadline was reached. Freezing the evidence now so a stalled dispatcher cannot block this run.';
          } else if (
            completion.results?.some((result) => result.status === 'rejected')
          ) {
            finalizationMessage =
              'At least one server dispatcher stopped early. Final evidence will mark any unverified schedule slots clearly.';
          }
        } catch (dispatcherError) {
          if (controller.signal.aborted) break;
          finalizationMessage =
            dispatcherError instanceof Error
              ? `Server dispatch preparation stopped: ${dispatcherError.message}`
              : 'Server dispatch preparation stopped before the stage was armed.';
        }
        if (controller.signal.aborted) break;
        setPhase('finalizing');
        setPhaseStartedAt(Date.now());
        setPhaseEndsAt(null);
        setMessage(finalizationMessage);
        current = await finalizeStageWithBarrier(
          `/api/rpm-runs/${current.run.id}/stages/${stage.stageIndex}/finalize`,
          controller.signal,
        );
        setDetail(current);
        onRunSaved(current.run);
        const finalized = current.stages.find(
          (item) => item.stageIndex === stage.stageIndex,
        );
        if (finalized?.status !== 'passed') {
          if (current.run.status === 'inconclusive') {
            const diagnosed = await jsonFetch<RpmDetailWithPreflight>(
              `/api/rpm-runs/${current.run.id}`,
              { signal: controller.signal },
            );
            setDetail(diagnosed);
          }
          activeRunIdRef.current = null;
          setRecoverableRunId('');
          setPhase(
            current.run.status === 'inconclusive' ? 'inconclusive' : 'failed',
          );
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
            armedStage.scheduledStartAt! +
            current.run.stageDurationSeconds * 1_000 +
            60_000;
          setPhase('cooldown');
          setPhaseStartedAt(Date.now());
          setPhaseEndsAt(cooldownEnds);
          setMessage(
            'Stage passed. Waiting for the rolling one-minute window to clear before the next stage…',
          );
          await waitUntil(cooldownEnds, controller.signal);
        }
      }
      if (!controller.signal.aborted) {
        const terminalPhase: RunnerPhase =
          current.run.status === 'passed'
            ? 'complete'
            : current.run.status === 'inconclusive'
              ? 'inconclusive'
              : current.run.status === 'cancelled'
                ? 'cancelled'
                : 'failed';
        const completed = terminalPhase === 'complete';
        setPhase(terminalPhase);
        setPhaseEndsAt(null);
        activeRunIdRef.current = null;
        setRecoverableRunId('');
        setMessage(
          completed
            ? `Ramp passed through ${current.run.targetRpm.toLocaleString()} RPM.`
            : (current.run.stopReason ?? 'Ramp finished.'),
        );
      }
    } catch (runError) {
      if (!controller.signal.aborted) {
        if (
          runError instanceof JsonFetchError &&
          runError.status === 409 &&
          runError.data.activeRunId
        ) {
          const activeRunId = runError.data.activeRunId;
          activeRunIdRef.current = activeRunId;
          loadedOpenedRunIdRef.current = activeRunId;
          setRecoverableRunId(activeRunId);
          try {
            const active = await jsonFetch<RpmDetailWithPreflight>(
              `/api/rpm-runs/${activeRunId}`,
            );
            setDetail(active);
            setPreflight(active.preflight ?? null);
            onRunSaved(active.run);
          } catch {
            // The cancel control can still use the ID returned by the 409.
          }
          setPhase('attention');
          setError('');
          setMessage(
            'A previous RPM run is still active. Cancel it below before starting again.',
          );
          return;
        }
        setPhase(activeRunIdRef.current ? 'attention' : 'failed');
        setPhaseEndsAt(null);
        setError(
          runError instanceof Error ? runError.message : 'RPM run failed.',
        );
        setMessage(
          activeRunIdRef.current
            ? 'The local runner stopped while the saved run may still be active. Review it, then use Cancel active run before starting another.'
            : 'The runner stopped before an active run was created.',
        );
      }
    } finally {
      controller.abort();
      setIsRunning(false);
      onRunningChange(false);
      abortRef.current = null;
    }
  }

  const rateLimited = latestMetrics?.rateLimited ?? 0;
  const missed = latestMetrics?.testerMisses ?? 0;
  const phaseElapsedMs = phaseStartedAt ? Math.max(0, now - phaseStartedAt) : 0;
  const phaseRemainingMs = phaseEndsAt ? Math.max(0, phaseEndsAt - now) : null;
  const statusStage =
    activeStage ??
    (phase === 'stageStarting'
      ? (detail?.stages.find((stage) => stage.status === 'pending') ?? null)
      : null);
  const rampNeverStarted = Boolean(
    detail &&
    ['cancelled', 'inconclusive'].includes(detail.run.status) &&
    detail.stages.every((stage) => stage.startedAt === null),
  );

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
              Each stage schedules requests over 60 seconds. A provider
              threshold failure or incomplete tester delivery stops higher
              stages.
            </p>
            <p className="mt-2 max-w-2xl truncate font-mono text-[10px] text-muted-foreground">
              {profileName ?? 'No saved profile'} · {apiType} ·{' '}
              {model || 'No model'} · {resolvedEndpoint(baseUrl, apiType)}
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
                max={RPM_MAX_TARGET_RPM}
                step={1}
                value={targetRpm}
                disabled={isRunning}
                onChange={(event) => setTargetRpm(Number(event.target.value))}
                className="h-10 font-mono"
              />
              <span className="font-normal text-muted-foreground">
                This public runner is engineered for targets up to 1,000 RPM.
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
          <br />
          <strong>Keep this tab open:</strong> dispatch timing runs on the
          server, while this deployment keeps those workers attached through
          live progress connections. Closing the tab or losing the connection
          makes the stage inconclusive, never a provider failure.
        </div>
        {error ? (
          <Alert variant="destructive" className="mt-4">
            <AlertTriangle />
            <AlertTitle>
              {preflight && preflight.outcome !== 'success'
                ? 'Preflight failed — load test did not begin'
                : 'Could not continue the RPM test'}
            </AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {isRunning ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void cancelRun()}
              disabled={phase === 'creating' || phase === 'cancelling'}
              className="gap-2"
            >
              {phase === 'creating' ? (
                <>
                  <Activity className="size-3.5 animate-pulse motion-reduce:animate-none" />{' '}
                  Creating run…
                </>
              ) : phase === 'cancelling' ? (
                <>
                  <Square className="size-3.5 fill-current" /> Cancelling…
                </>
              ) : (
                <>
                  <Square className="size-3.5 fill-current" /> Stop and save
                  partial evidence
                </>
              )}
            </Button>
          ) : recoverableRunId ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void cancelRun()}
              disabled={phase === 'cancelling'}
              className="gap-2 border-amber-300 text-amber-950"
            >
              <Square className="size-3.5 fill-current" />
              {phase === 'cancelling' ? 'Cancelling…' : 'Cancel active run'}
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
        </div>
        <RunStatusCard
          phase={phase}
          message={message}
          elapsedMs={phaseElapsedMs}
          remainingMs={phaseRemainingMs}
          endpoint={resolvedEndpoint(
            detail?.run.baseUrl ?? baseUrl,
            detail?.run.apiType ?? apiType,
          )}
          model={detail?.run.modelName ?? model}
          preflight={preflight}
          stage={statusStage ?? latestStage ?? null}
          stageCount={detail?.stages.length ?? plan.length}
          completed={completedNow}
          sent={latestMetrics?.sent ?? 0}
        />
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          label="Scheduled"
          value={
            rampNeverStarted
              ? 'Not run'
              : latestMetrics === null
                ? 'Waiting'
                : latestMetrics.scheduled.toLocaleString()
          }
          detail={
            latestMetrics
              ? `Planned over ${detail?.run.stageDurationSeconds ?? 60} seconds`
              : 'No stage has started'
          }
          icon={Clock3}
        />
        <MetricCard
          label="Verified sends"
          value={
            rampNeverStarted
              ? 'Not run'
              : latestMetrics
                ? `${latestMetrics.sent.toLocaleString()} / ${latestMetrics.scheduled.toLocaleString()}`
                : 'Waiting'
          }
          detail={
            latestMetrics
              ? `${percentage(latestMetrics.deliveryPercent)} of scheduled load · ${latestMetrics.observed.toLocaleString()} outcomes preserved`
              : 'Verified provider attempts'
          }
          icon={RadioTower}
          tone={missed ? 'warning' : 'default'}
        />
        <MetricCard
          label="Provider success"
          value={
            rampNeverStarted
              ? 'Not run'
              : latestMetrics
                ? latestMetrics.sent
                  ? latestMetrics.observed
                    ? `${latestMetrics.succeeded.toLocaleString()} / ${latestMetrics.observed.toLocaleString()}`
                    : 'Waiting for responses'
                  : 'Not observed'
                : 'Waiting'
          }
          detail={
            latestMetrics
              ? `${percentage(latestMetrics.providerSuccessPercent)} of preserved response outcomes${latestStage?.dispatchValid === false ? ' · no provider verdict' : ''}`
              : `Pass threshold ${threshold}%`
          }
          icon={CheckCircle2}
          tone={latestStage?.status === 'failed' ? 'danger' : 'default'}
        />
        <MetricCard
          label="Unverified send slots"
          value={
            rampNeverStarted
              ? 'Not run'
              : latestMetrics
                ? latestMetrics.testerMisses.toLocaleString()
                : 'Waiting'
          }
          detail="No verified upstream dispatch start; any such slot makes the stage inconclusive."
          icon={missed ? XCircle : ShieldCheck}
          tone={missed ? 'danger' : 'default'}
        />
        <MetricCard
          label="HTTP 429"
          value={
            rampNeverStarted
              ? 'Not run'
              : latestMetrics
                ? `${rateLimited.toLocaleString()} / ${latestMetrics.observed.toLocaleString()}`
                : 'Waiting'
          }
          detail={
            latestMetrics
              ? `${percentage(latestMetrics.rateLimitPercent)} of preserved response outcomes`
              : 'Rate-limit responses are counted separately'
          }
          icon={RadioTower}
          tone={rateLimited ? 'warning' : 'default'}
        />
        <MetricCard
          label="Provider latency"
          value={
            rampNeverStarted
              ? 'Not run'
              : `P95 ${duration(latestStage?.p95LatencyMs)}`
          }
          detail={`Median ${duration(latestStage?.medianLatencyMs)} · excludes tester misses`}
          icon={Gauge}
        />
      </div>

      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_18px_50px_rgb(15_23_42/0.06)]">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">Ramp stages</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Request payload: max_tokens=8 · stream=false · no temperature,
            top_p, top_k, system, tools, cache controls, or retries · 20-second
            upstream timeout during ramp stages.
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
            const metrics = deriveStageMetrics(stage, stageLive);
            return (
              <div
                key={stage.id}
                className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(220px,1fr)_minmax(0,2fr)] lg:items-center"
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
                      {statusLabel(stage.status)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {stage.percentage}% of target · Scheduled:{' '}
                    {metrics.scheduled.toLocaleString()} requests / 60 s
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                  <StageValue
                    label="Verified sends"
                    value={`${metrics.sent.toLocaleString()}/${metrics.scheduled.toLocaleString()}`}
                  />
                  <StageValue
                    label="Provider success"
                    value={
                      metrics.providerSuccessPercent === null
                        ? 'Not observed'
                        : `${metrics.succeeded.toLocaleString()}/${metrics.observed.toLocaleString()} · ${percentage(metrics.providerSuccessPercent)}`
                    }
                  />
                  <StageValue
                    label="Unverified sends"
                    value={metrics.testerMisses.toLocaleString()}
                  />
                  <StageValue
                    label="429"
                    value={metrics.rateLimited.toLocaleString()}
                  />
                  <StageValue
                    label="P95 provider latency"
                    value={duration(stage.p95LatencyMs)}
                  />
                </div>
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

      {detail?.testerDiagnostics?.length ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-5">
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-amber-700" />
            <h3 className="text-sm font-semibold text-amber-950">
              What happened inside the tester
            </h3>
          </div>
          <p className="mt-2 text-sm leading-6 text-amber-950">
            {detail.testerDiagnostics.length.toLocaleString()} scheduled request
            {detail.testerDiagnostics.length === 1 ? ' was' : 's were'} not sent
            to the provider. These are tester-side scheduling misses, not
            provider failures.
          </p>
          <ul className="mt-3 space-y-2 text-xs leading-5 text-amber-950">
            {detail.testerDiagnostics.map((diagnostic, index) => (
              <li
                key={`${diagnostic.stageIndex}-${diagnostic.sequence}-${index}`}
                className="rounded-lg border border-amber-200 bg-white/70 px-3 py-2"
              >
                <span className="font-semibold">
                  Stage {diagnostic.stageIndex + 1}
                  {diagnostic.sequence === null
                    ? ''
                    : ` · request ${diagnostic.sequence + 1}`}
                  {diagnostic.shardIndex === null
                    ? ''
                    : ` · dispatcher ${diagnostic.shardIndex + 1}`}
                </span>
                {diagnostic.scheduleLagMs === null
                  ? ''
                  : ` · recorded ${diagnostic.scheduleLagMs.toLocaleString()} ms after its planned time`}
                <br />
                {diagnostic.reason}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-5 text-amber-900">
            The full JSON export keeps the corresponding redacted request
            evidence. No API key is included.
          </p>
        </section>
      ) : null}
    </div>
  );
}

function RunStatusCard({
  phase,
  message,
  elapsedMs,
  remainingMs,
  endpoint,
  model,
  preflight,
  stage,
  stageCount,
  completed,
  sent,
}: {
  phase: RunnerPhase;
  message: string;
  elapsedMs: number;
  remainingMs: number | null;
  endpoint: string;
  model: string;
  preflight: RpmPreflightSummary | null;
  stage: RpmStageSummary | null;
  stageCount: number;
  completed: number;
  sent: number;
}) {
  const draining =
    phase === 'stage' &&
    stage !== null &&
    remainingMs === 0 &&
    completed < stage.scheduledCount;
  const title =
    phase === 'creating'
      ? 'Step 1 of 3 · Creating saved run'
      : phase === 'preflight'
        ? 'Step 1 of 3 · Connection preflight'
        : phase === 'stageStarting' && stage
          ? `Step 2 of 3 · Starting stage ${stage.stageIndex + 1} of ${stageCount}`
          : phase === 'stage' && stage
            ? draining
              ? `Step 2 of 3 · Stage ${stage.stageIndex + 1} window ended · final evidence pending`
              : `Step 2 of 3 · Stage ${stage.stageIndex + 1} of ${stageCount} · ${stage.targetRpm.toLocaleString()} RPM`
            : phase === 'finalizing' && stage
              ? `Step 2 of 3 · Finalizing stage ${stage.stageIndex + 1} of ${stageCount}`
              : phase === 'cooldown'
                ? 'Between stages · Rolling-minute cooldown'
                : phase === 'complete'
                  ? 'Step 3 of 3 · Ramp complete'
                  : phase === 'cancelled'
                    ? 'Run cancelled'
                    : phase === 'cancelling'
                      ? 'Cancelling run…'
                      : phase === 'attention'
                        ? 'Active run needs attention'
                        : phase === 'inconclusive'
                          ? stage
                            ? `Tester could not run ${stage.targetRpm.toLocaleString()} RPM — provider not judged`
                            : 'Tester could not complete the run — provider not judged'
                          : phase === 'failed'
                            ? 'Run finished without a pass'
                            : 'Ready to start';
  const running = [
    'creating',
    'preflight',
    'stageStarting',
    'stage',
    'finalizing',
    'cooldown',
    'cancelling',
  ].includes(phase);
  const badgeLabel =
    phase === 'cancelling'
      ? 'cancelling'
      : running
        ? 'running'
        : phase === 'inconclusive'
          ? 'tester error'
          : phase;
  const tone =
    phase === 'complete'
      ? 'border-emerald-200 bg-emerald-50/70'
      : phase === 'failed'
        ? 'border-rose-200 bg-rose-50/70'
        : phase === 'attention' || phase === 'inconclusive'
          ? 'border-amber-200 bg-amber-50/70'
          : 'border-blue-200 bg-blue-50/55';

  return (
    <section
      className={`mt-4 rounded-xl border p-4 ${tone}`}
      aria-label="RPM run status"
    >
      <output className="sr-only" aria-live="polite">
        {title}. {message}
      </output>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity
            className={`size-4 ${running ? 'animate-pulse motion-reduce:animate-none' : ''}`}
          />
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        <Badge variant="outline" className="bg-white/70 font-mono uppercase">
          {badgeLabel}
        </Badge>
      </div>
      <p className="mt-2 text-sm leading-5">{message}</p>

      {phase !== 'idle' ? (
        <dl className="mt-3 grid gap-2 rounded-lg border border-black/5 bg-white/65 p-3 text-xs sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-muted-foreground">Endpoint</dt>
            <dd className="break-all font-mono">{endpoint || '—'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground">Model</dt>
            <dd className="break-all font-mono">{model || '—'}</dd>
          </div>
        </dl>
      ) : null}

      {phase === 'creating' ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No provider request has been sent yet · Elapsed {clock(elapsedMs)}
        </p>
      ) : null}
      {phase === 'preflight' ? (
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
          <StatusValue label="Planned load" value="1 preflight request" />
          <StatusValue label="Elapsed" value={clock(elapsedMs)} />
          <StatusValue
            label="Upstream timeout"
            value={
              remainingMs === 0
                ? '45 s elapsed here · awaiting result'
                : `${clock(remainingMs ?? 45_000)} remaining (+ setup/save)`
            }
          />
        </div>
      ) : null}
      {phase === 'stage' && stage ? (
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
          <StatusValue
            label="Evidence records"
            value={`${completed.toLocaleString()} / ${stage.scheduledCount.toLocaleString()}`}
          />
          <StatusValue label="Sent upstream" value={sent.toLocaleString()} />
          <StatusValue label="Elapsed" value={clock(elapsedMs)} />
          <StatusValue
            label={
              draining ? 'Unresolved schedule slots' : 'Dispatch remaining'
            }
            value={
              draining
                ? `${Math.max(0, stage.scheduledCount - completed).toLocaleString()} · awaiting response or miss classification`
                : clock(remainingMs ?? 0)
            }
          />
        </div>
      ) : null}
      {phase === 'cooldown' ? (
        <div className="mt-3 text-xs">
          <StatusValue
            label="Next stage starts in"
            value={clock(remainingMs ?? 0)}
          />
        </div>
      ) : null}

      {preflight ? (
        <div
          className={`mt-3 rounded-lg border p-3 text-xs ${preflight.outcome === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-950' : 'border-rose-200 bg-rose-50 text-rose-950'}`}
        >
          <p className="font-semibold">
            {preflight.outcome === 'success'
              ? 'Preflight passed'
              : 'Preflight failed — no ramp traffic started'}
          </p>
          <p className="mt-1 break-words font-mono leading-5">
            HTTP {preflight.httpStatus ?? '—'} · First byte{' '}
            {duration(preflight.firstByteMs)} · Total{' '}
            {duration(preflight.totalTimeMs)}
            {preflight.returnedModel
              ? ` · Model ${preflight.returnedModel}`
              : ''}
            {preflight.requestId ? ` · Request ID ${preflight.requestId}` : ''}
          </p>
          {preflight.error ? <p className="mt-1">{preflight.error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function StatusValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/5 bg-white/65 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 font-mono font-semibold">{value}</p>
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
