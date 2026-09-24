import assert from 'node:assert/strict';
import test from 'node:test';
import {
  connectionSelection,
  rememberConnectionSelection,
} from '../lib/saved-connections.ts';

const profile = (id) => ({
  id,
  name: id,
  defaultApiType: 'anthropic',
  configs: {
    anthropic: {
      baseUrl: 'https://messages.test',
      model: 'claude-default',
      models: ['claude-default', 'gpt-default', 'custom-61'],
      hasSavedKey: true,
    },
    openai: {
      baseUrl: 'https://chat.test',
      model: 'gpt-default',
      models: ['claude-default', 'gpt-default', 'custom-61'],
      hasSavedKey: true,
    },
  },
});
const key = (id) => `api-diagnostics:connection-selection:v1:${id}`;
function storage(t) {
  const values = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
  return values;
}

test('the last selected model and API format survive profile reloads without changing connection defaults', (t) => {
  const values = storage(t);
  const first = profile('a');
  const before = structuredClone(first);
  assert.deepEqual(connectionSelection(first), {
    apiType: 'anthropic',
    model: 'claude-default',
  });
  rememberConnectionSelection('a', {
    apiType: 'openai',
    model: 'custom-61',
    apiKey: 'must-not-be-stored',
  });
  for (let i = 0; i < 3; i++)
    assert.deepEqual(connectionSelection(structuredClone(first)), {
      apiType: 'openai',
      model: 'custom-61',
    });
  assert.deepEqual(first, before);
  assert.equal(
    values.get(key('a')),
    '{"apiType":"openai","model":"custom-61"}',
  );
});
test('connections retain independent choices and the latest change is visible to either test page', (t) => {
  storage(t);
  rememberConnectionSelection('a', { apiType: 'openai', model: 'custom-61' });
  rememberConnectionSelection('b', {
    apiType: 'anthropic',
    model: 'gpt-default',
  });
  assert.deepEqual(connectionSelection(profile('a')), {
    apiType: 'openai',
    model: 'custom-61',
  });
  assert.deepEqual(connectionSelection(profile('b')), {
    apiType: 'anthropic',
    model: 'gpt-default',
  });
  rememberConnectionSelection('a', {
    apiType: 'anthropic',
    model: 'custom-61',
  });
  assert.deepEqual(connectionSelection(profile('a')), {
    apiType: 'anthropic',
    model: 'custom-61',
  });
});
test('removed models and malformed preferences safely fall back to an available model', (t) => {
  const values = storage(t);
  rememberConnectionSelection('a', { apiType: 'openai', model: 'removed' });
  assert.deepEqual(connectionSelection(profile('a')), {
    apiType: 'openai',
    model: 'gpt-default',
  });
  for (const bad of ['{', 'null', 'true', '{"apiType":"invalid","model":33}']) {
    values.set(key('a'), bad);
    assert.deepEqual(connectionSelection(profile('a')), {
      apiType: 'anthropic',
      model: 'claude-default',
    });
  }
});
test('empty selections and blocked storage do not prevent testing', (t) => {
  const values = storage(t);
  rememberConnectionSelection('', { apiType: 'openai', model: 'custom-61' });
  rememberConnectionSelection('a', { apiType: 'openai', model: '' });
  assert.equal(values.size, 0);
  globalThis.localStorage.getItem = () => {
    throw Error('Storage blocked');
  };
  globalThis.localStorage.setItem = () => {
    throw Error('Storage blocked');
  };
  assert.doesNotThrow(() =>
    rememberConnectionSelection('a', { apiType: 'openai', model: 'custom-61' }),
  );
  assert.deepEqual(connectionSelection(profile('a')), {
    apiType: 'anthropic',
    model: 'claude-default',
  });
});
