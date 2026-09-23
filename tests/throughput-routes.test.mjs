import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRampTargets, rpmMeasurementStatus } from '../lib/rpm-types.ts';
import { runProviderRequest } from '../lib/server/rpm-provider.ts';
import { captureEndpointExchange } from '../lib/server/endpoint-check.ts';
import { captureBoundaryExchange } from '../lib/server/tool-boundary.ts';
import { checkProviderAvailability } from '../lib/server/availability-provider.ts';

test('fixed workload completes despite provider errors, but cannot disguise missing dispatch evidence', () => {
  assert.deepEqual(buildRampTargets(120, 'fixed'), [
    { percentage: 100, targetRpm: 120 },
  ]);
  assert.equal(rpmMeasurementStatus('fixed', true, 0, 120, 9000), 'passed');
  assert.equal(
    rpmMeasurementStatus('fixed', false, 120, 120, 9000),
    'inconclusive',
  );
  assert.equal(rpmMeasurementStatus('balanced', true, 0, 120, 9000), 'failed');
});
test('all provider paths send pinned Flex routing in the actual request body', async () => {
  const connection = {
    apiType: 'openai',
    model: 'openai/gpt-6-astra',
    baseUrl: 'https://openrouter.ai/api/v1',
    actualBaseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test-only-secret',
    openRouterTier: 'flex',
  };
  const bodies = [];
  const request = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({
        model: connection.model,
        choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  const signal = new AbortController().signal;
  for (const protocol of ['messages', 'chat', 'responses'])
    await captureEndpointExchange(connection, protocol, 'ok', signal, request);
  await captureBoundaryExchange(connection, signal, request);
  await checkProviderAvailability(connection, signal, request);
  const original = globalThis.fetch;
  globalThis.fetch = request;
  try {
    await runProviderRequest({
      ...connection,
      runId: 'test',
      stageIndex: 0,
      sequence: 0,
      plannedAt: Date.now(),
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(bodies.length, 6);
  for (const body of bodies) {
    assert.equal(body.service_tier, 'flex');
    assert.deepEqual(body.provider.only, ['openai/flex']);
    assert.equal(body.provider.allow_fallbacks, false);
  }
});
