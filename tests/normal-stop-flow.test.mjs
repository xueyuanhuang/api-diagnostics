import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { executeNormalTestRun } from '../lib/normal-test-runner.ts';
import { combinedRequestSignal } from '../lib/server/abort-signals.ts';

const componentPath = new URL(
  '../components/token-check-app.tsx',
  import.meta.url,
);
const routePath = new URL('../app/api/test/route.ts', import.meta.url);

test('stopping aborts the active request, preserves completed evidence, and stops every unfinished row', async () => {
  const controller = new AbortController();
  const calls = [];
  const snapshots = [];
  let releaseSecond;
  const secondStarted = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  const completedEvidence = {
    requestId: 'request-one',
    totalInputTokens: 7,
    rawResponse: '{"answer":"Paris"}',
  };

  const running = executeNormalTestRun({
    questions: [
      { id: 'one', category: 'fact', prompt: 'First' },
      { id: 'two', category: 'fact', prompt: 'Second' },
      { id: 'three', category: 'fact', prompt: 'Third' },
    ],
    signal: controller.signal,
    request: async (_question, index, signal) => {
      calls.push(index);
      if (index === 0) return completedEvidence;
      releaseSecond();
      return await new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    },
    classify: () => 'normal',
    publish: (results) => snapshots.push(results),
  });

  await secondStarted;
  controller.abort();
  const outcome = await running;

  assert.deepEqual(calls, [0, 1], 'no later question may start after Stop');
  assert.equal(outcome.stopped, true);
  assert.deepEqual(outcome.results[0], {
    id: 'one',
    category: 'fact',
    prompt: 'First',
    status: 'normal',
    ...completedEvidence,
  });
  assert.deepEqual(
    outcome.results.slice(1).map((result) => result.status),
    ['stopped', 'stopped'],
  );
  assert.deepEqual(
    snapshots.at(-1).map((result) => result.status),
    ['normal', 'stopped', 'stopped'],
  );
  assert.equal(
    snapshots
      .at(-1)
      .some((result) => ['waiting', 'running'].includes(result.status)),
    false,
  );
});

test('the relay signal aborts when the browser request is cancelled', () => {
  const browserRequest = new AbortController();
  const upstreamSignal = combinedRequestSignal(browserRequest.signal, 45_000);
  assert.equal(upstreamSignal.aborted, false);
  browserRequest.abort();
  assert.equal(upstreamSignal.aborted, true);
});

test('the production component and route use the cancellation seams', () => {
  const component = readFileSync(componentPath, 'utf8');
  const route = readFileSync(routePath, 'utf8');
  assert.match(component, /executeNormalTestRun(?:<[^>]+>)?\s*\(/);
  assert.match(component, /normalPhase\s*===\s*'stopping'/);
  assert.match(component, /\|\s*'stopped'/);
  assert.match(component, /key="normal-stop"/);
  assert.match(component, /const controller = abortRef\.current/);
  assert.match(component, /controller\.signal\.aborted/);
  assert.match(route, /combinedRequestSignal\s*\(request\.signal/);
});
