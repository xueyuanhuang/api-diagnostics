import assert from 'node:assert/strict';
import test from 'node:test';
import { openRouterRoute, routeEvidence, isOpenRouter } from '../lib/openrouter.ts';

test('pins standard and flex with no fallback and identical reasoning', () => {
  for (const tier of ['default', 'flex']) {
    const route = openRouterRoute('https://openrouter.ai/api/v1', 'openai', 'openai/gpt-6-astra', tier);
    assert.equal(route.service_tier, tier);
    assert.deepEqual(route.provider.only, [tier === 'flex' ? 'openai/flex' : 'openai']);
    assert.equal(route.provider.allow_fallbacks, false);
    assert.equal(route.reasoning.effort, 'low');
  }
  assert.equal(openRouterRoute('https://example.com', 'openai', 'x', undefined), null);
  assert.equal(isOpenRouter('https://openrouter.ai.evil.test'), false);
  assert.throws(() => openRouterRoute('https://example.com', 'openai', 'openai/gpt-6-astra', 'flex'));
  assert.throws(() => openRouterRoute('https://openrouter.ai/api/v1', 'openai', 'anthropic/claude', 'flex'));
  assert.throws(() => openRouterRoute('https://openrouter.ai/api/v1', 'openai', 'openai/gpt-6-astra', 'priority'));
});

test('restores reported tier and cost from saved streaming evidence without assuming the requested tier', () => {
  const request = JSON.stringify({ service_tier: 'flex' });
  assert.equal(routeEvidence(request, 'data: [DONE]').served, null);
  const result = routeEvidence(request, 'data: {"provider":"OpenAI","service_tier":"default"}\n\ndata: {"usage":{"cost":0.001}}\n\ndata: [DONE]');
  assert.deepEqual(result, { requested: 'flex', served: 'default', provider: 'OpenAI', cost: 0.001 });
  assert.equal(routeEvidence(request, '{"service_tier":"flex","usage":{"cost":0}}').cost, 0);
});
