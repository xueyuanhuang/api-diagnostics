import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { armStageWhenReady } from '../lib/rpm-arm.ts';

const componentPath = new URL(
  '../components/rpm-ramp-test.tsx',
  import.meta.url,
);

test('arming polls saved server readiness instead of waiting for a streamed ready chunk', async () => {
  const controller = new AbortController();
  let attempts = 0;
  let waits = 0;
  const armed = await armStageWhenReady({
    signal: controller.signal,
    attempt: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw {
          status: 409,
          data: {
            error:
              'Server dispatchers are not ready (0/1). No stage traffic was armed.',
          },
        };
      }
      return { stage: { scheduledStartAt: 12345 }, shardCount: 1 };
    },
    wait: async () => {
      waits += 1;
    },
    timeoutMs: 30_000,
  });

  assert.equal(attempts, 3);
  assert.equal(waits, 2);
  assert.equal(armed.stage.scheduledStartAt, 12345);
});

test('the RPM UI no longer gates arming on browser delivery of ready events', () => {
  const component = readFileSync(componentPath, 'utf8');
  assert.match(component, /armStageWhenReady\s*\(/);
  assert.doesNotMatch(component, /waitForDispatcherReadiness\s*\(/);
});
