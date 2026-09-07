// Local-only manual regression fixture: no API request leaves this module.
// Run: pnpm exec vite --config tests/navigation.vite.config.ts
// Open /tests/navigation.html, start each test, browse both kinds of history,
// switch test views, return to live progress, and Stop. Counters must continue
// while browsing, without duplicate starts or cancellation until Stop.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenCheckApp } from '../components/token-check-app';
import { NORMAL_QUESTIONS } from '../lib/questions';
import '../app/globals.css';

const config = {
  baseUrl: 'https://fixture.invalid',
  model: 'live-model',
  models: ['live-model', 'model-b', 'model-c', 'model-d', 'model-e', 'model-f'],
  hasSavedKey: true,
};
const profile = {
  id: 'fixture',
  name: 'Fixture connection',
  defaultApiType: 'anthropic',
  configs: { anthropic: config, openai: config },
  hasSavedKey: true,
};
const normal = {
  id: 'saved-normal',
  testKind: 'normal',
  profileName: 'Archived normal',
  apiType: 'anthropic',
  baseUrl: config.baseUrl,
  modelName: 'archived-model',
  createdAt: 1700000000000,
  verdict: 'normal',
  normalCount: 12,
  cacheCount: 0,
  largeCount: 0,
  errorCount: 0,
};
const result = {
  httpStatus: 200,
  inputTokens: 17,
  totalInputTokens: 17,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 3,
  returnedModel: 'live-model',
  ttftMs: 500,
  totalTimeMs: 900,
  status: 'normal',
};
const savedResults = NORMAL_QUESTIONS.map((q) => ({
  ...q,
  questionId: q.id,
  ...result,
  totalInputTokens: 777,
  returnedModel: 'archived-model',
}));
// Preview real list/detail components with mixed outcomes; no provider calls.
const mixed = {
  ...normal,
  id: 'saved-mixed',
  profileName: 'Mixed results',
  normalCount: 10,
  errorCount: 2,
  verdict: 'incomplete',
  medianTtftMs: 3382,
  medianTotalTimeMs: 6024,
  medianGenerationMs: 2642,
  medianOutputTokensPerSecond: 201.92,
};
const mixedResults = savedResults.map((item, index) => ({
  ...item,
  status: index < 10 ? 'normal' : 'error',
  httpStatus: index < 10 ? 200 : 500,
  error: index < 10 ? undefined : 'Fixture provider error',
  ttftMs: index < 10 ? 3382 : null,
  totalTimeMs: 6024,
  generationMs: index < 10 ? 2642 : null,
  outputTokensPerSecond: index < 10 ? 201.92 : null,
}));
const rpm = {
  id: 'saved-rpm',
  testKind: 'rpm',
  profileName: 'Archived RPM',
  apiType: 'openai',
  baseUrl: config.baseUrl,
  modelName: 'archived-rpm-model',
  createdAt: 1700000000000,
  targetRpm: 10,
  thresholdBps: 9000,
  rampMode: 'balanced',
  stageDurationSeconds: 60,
  status: 'passed',
  totalPlanned: 10,
  totalAttempted: 10,
  totalSucceeded: 10,
  totalRateLimited: 0,
  highestPassedRpm: 10,
  stoppedAtRpm: null,
  stopReason: null,
  currentStage: 0,
};
let active = {
  run: {
    ...rpm,
    id: 'live-rpm',
    profileName: profile.name,
    apiType: 'anthropic',
    modelName: 'live-model',
    status: 'preflight',
    totalAttempted: 0,
  },
  stages: [] as object[],
};
const counters = {
  normalRequests: 0,
  normalAborts: 0,
  normalSaves: 0,
  rpmStarts: 0,
  streams: 0,
  streamAborts: 0,
  rpmCancels: 0,
  dispatched: 0,
  unexpected: 0,
};
let finishNormal = false;
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
let stage: Record<string, unknown>;

window.fetch = async (input, init = {}) => {
  const path =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const method = init.method ?? 'GET';
  if (path === '/api/session')
    return response({
      user: { displayName: 'Fixture user', email: 'fixture@example.invalid' },
    });
  if (path === '/api/profiles') return response({ profiles: [profile] });
  if (path === '/api/runs' && method === 'GET')
    return response({ runs: [mixed, normal] });
  if (path === '/api/runs/saved-mixed')
    return response({ run: mixed, results: mixedResults });
  if (path === '/api/runs/saved-normal')
    return response({ run: normal, results: savedResults });
  if (path === '/api/runs' && method === 'POST') {
    counters.normalSaves++;
    const payload = JSON.parse(
      typeof init.body === 'string' ? init.body : '{}',
    );
    return response({
      run: {
        ...normal,
        id: `new-normal-${counters.normalSaves}`,
        modelName: payload.model,
      },
    });
  }
  if (path === '/api/test') {
    counters.normalRequests++;
    const payload = JSON.parse(
      typeof init.body === 'string' ? init.body : '{}',
    );
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (!finishNormal) return;
        clearInterval(timer);
        init.signal?.removeEventListener('abort', abort);
        resolve(response({ ...result, returnedModel: payload.model }));
      }, 100);
      function abort() {
        clearInterval(timer);
        counters.normalAborts++;
        reject(new DOMException('Aborted', 'AbortError'));
      }
      init.signal?.addEventListener('abort', abort, { once: true });
    });
  }
  if (path === '/api/rpm-runs' && method === 'GET')
    return response({ runs: [rpm] });
  if (path === '/api/rpm-runs/saved-rpm')
    return response({ run: rpm, stages: [] });
  if (path === '/api/rpm-runs' && method === 'POST') {
    counters.rpmStarts++;
    stage = {
      id: 'stage',
      runId: 'live-rpm',
      stageIndex: 0,
      percentage: 100,
      targetRpm: 100,
      scheduledCount: 100,
      batchCount: 1,
      status: 'pending',
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
    };
    active = {
      ...active,
      run: { ...active.run, status: 'preflight' },
      stages: [stage],
    };
    return response(active);
  }
  if (path.endsWith('/preflight')) {
    active.run.status = 'ready';
    return response({
      ...active,
      preflight: {
        outcome: 'success',
        httpStatus: 200,
        totalTimeMs: 10,
        requestId: 'fixture-preflight',
        returnedModel: 'live-model',
      },
    });
  }
  if (path.endsWith('/start') || path.endsWith('/arm')) {
    Object.assign(stage, {
      status: 'running',
      startedAt: Date.now(),
      scheduledStartAt: Date.now(),
    });
    active.run.status = 'running';
    return response({ stage, shardCount: 1 });
  }
  if (path.includes('/shards/')) {
    counters.streams++;
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"ready"}\n'));
        const timer = setInterval(() => {
          if (counters.dispatched >= 100) return;
          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                type: 'dispatched',
                sequence: counters.dispatched++,
              }) + '\n',
            ),
          );
        }, 500);
        init.signal?.addEventListener(
          'abort',
          () => {
            clearInterval(timer);
            counters.streamAborts++;
            controller.error(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      },
    });
    return new Response(body);
  }
  if (path === '/api/rpm-runs/live-rpm') return response(active);
  if (path.endsWith('/cancel')) {
    counters.rpmCancels++;
    active.run.status = 'cancelled';
    stage.status = 'cancelled';
    return response(active);
  }
  counters.unexpected++;
  throw new Error(`Unmocked request blocked: ${method} ${path}`);
};

function Fixture() {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <div style={{ padding: 10, background: '#fff3cd' }}>
        <strong>LOCAL MOCK — zero provider traffic</strong>
        <button
          style={{ margin: 12, border: '1px solid', padding: 5 }}
          onClick={() => {
            finishNormal = true;
          }}
        >
          Finish pending normal responses
        </button>
        <output style={{ display: 'block' }}>{JSON.stringify(counters)}</output>
      </div>
      <TokenCheckApp signInPath="#" signOutPath="#" />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
