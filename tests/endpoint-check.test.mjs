import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENDPOINTS,
  ENDPOINT_CASES,
  endpointPlan,
  endpointCheckUrl,
  endpointRequestBody,
  normalizeEndpointUsage,
  summarizeEndpointResponse,
  runEndpointRequests,
} from '../lib/endpoint-check.ts';
import { captureEndpointExchange } from '../lib/server/endpoint-check.ts';
import { HTTP_CAPTURE_LIMIT } from '../lib/server/http-exchange.ts';

const connection = {
  model: 'test-model',
  apiKey: 'test-key-123456',
  baseUrl: 'https://example.com',
  actualBaseUrl: 'https://example.com',
};
const fixtures = {
  messages: {
    type: 'message',
    model: 'test-model',
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [
      {
        type: 'thinking',
        thinking: 'internal',
        signature: 'original-signature',
      },
      { type: 'text', text: 'OK' },
    ],
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 89,
      cache_read_input_tokens: 27434,
      output_tokens: 3,
      total_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 89 },
      iterations: [{ input_tokens: 2 }],
    },
  },
  chat: {
    object: 'chat.completion',
    model: 'test-model',
    choices: [
      { message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
    ],
    usage: {
      prompt_tokens: 27525,
      prompt_tokens_details: { cached_tokens: 27523 },
      completion_tokens: 3,
      total_tokens: 27528,
    },
  },
  responses: {
    object: 'response',
    model: 'test-model',
    status: 'completed',
    error: null,
    incomplete_details: null,
    output: [
      { type: 'reasoning', summary: [] },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'OK' }],
      },
    ],
    usage: {
      input_tokens: 27525,
      input_tokens_details: { cached_tokens: 27523 },
      output_tokens: 3,
      total_tokens: 27528,
    },
  },
};

test('every root, /v1 and full endpoint resolves across all three protocols without doubling', () => {
  for (const prefix of ['', '/provider']) {
    for (const base of [
      '',
      '/v1',
      '/v1/messages',
      '/v1/chat/completions',
      '/v1/responses',
    ]) {
      for (const [protocol, endpoint] of Object.entries(ENDPOINTS)) {
        assert.equal(
          endpointCheckUrl(
            `https://example.com:8443${prefix}${base}/`,
            protocol,
          ),
          `https://example.com:8443${prefix}${endpoint.path}`,
        );
      }
    }
  }
});

test('requests use each protocol field and preserve identical prompts without injected extras', () => {
  for (const [caseId, sample] of Object.entries(ENDPOINT_CASES)) {
    for (const protocol of Object.keys(ENDPOINTS)) {
      const body = endpointRequestBody(protocol, 'test-model', caseId);
      const limit =
        protocol === 'messages'
          ? 'max_tokens'
          : protocol === 'chat'
            ? 'max_completion_tokens'
            : 'max_output_tokens';
      assert.deepEqual(body, {
        model: 'test-model',
        [limit]: sample.maxTokens,
        stream: false,
        ...(protocol === 'responses'
          ? { input: sample.prompt }
          : { messages: [{ role: 'user', content: sample.prompt }] }),
      });
    }
  }
});

test('actual WorldRouter usage shapes normalize without adding caches twice', () => {
  for (const [protocol, fixture] of Object.entries(fixtures)) {
    const result = summarizeEndpointResponse(
      JSON.stringify(fixture),
      protocol,
      'ok',
    );
    assert.equal(result.answer, 'OK');
    assert.deepEqual(result.issues, []);
    assert.equal(result.usage.totalInput, 27525);
    assert.equal(result.usage.total, 27528);
    assert.equal(result.usage.uncachedInput, 2);
    assert.ok(result.warnings.length);
    assert.deepEqual(result.rawUsage, fixture.usage);
  }
});

test('missing, negative, nonnumeric and nonfinite usage is unavailable, not zero', () => {
  for (const protocol of Object.keys(ENDPOINTS)) {
    for (const usage of [
      null,
      {},
      { input_tokens: -1 },
      { input_tokens: '23' },
      { input_tokens: Infinity },
    ]) {
      assert.equal(normalizeEndpointUsage(protocol, usage).totalInput, null);
    }
    const result = summarizeEndpointResponse(
      JSON.stringify({ ...fixtures[protocol], usage: null }),
      protocol,
      'ok',
    );
    assert.deepEqual(result.issues, []);
    assert.ok(result.warnings.some((x) => x.includes('missing')));
  }
  assert.equal(
    normalizeEndpointUsage('messages', { input_tokens: 23, output_tokens: 3 })
      .totalInput,
    23,
  );
  assert.equal(
    normalizeEndpointUsage('messages', {
      input_tokens: 23,
      cache_read_input_tokens: '10',
    }).totalInput,
    null,
  );
});

test('malformed JSON, wrong protocol, provider errors, refusal and incomplete outputs cannot pass', () => {
  for (const protocol of Object.keys(ENDPOINTS)) {
    for (const raw of [
      'bad json',
      'null',
      '{}',
      '{"error":{"message":"messages is required"}}',
    ]) {
      assert.ok(summarizeEndpointResponse(raw, protocol, 'ok').issues.length);
    }
    const error = {
      ...fixtures[protocol],
      error: { message: 'provider failed' },
    };
    assert.ok(
      summarizeEndpointResponse(JSON.stringify(error), protocol, 'ok').issues
        .length,
    );
    for (const other of Object.keys(ENDPOINTS).filter((x) => x !== protocol))
      assert.ok(
        summarizeEndpointResponse(
          JSON.stringify(fixtures[other]),
          protocol,
          'ok',
        ).issues.length,
      );
  }
  const incomplete = [
    ['messages', { ...fixtures.messages, stop_reason: 'max_tokens' }],
    [
      'chat',
      {
        ...fixtures.chat,
        choices: [
          {
            message: { role: 'assistant', content: 'OK' },
            finish_reason: 'length',
          },
        ],
      },
    ],
    ['responses', { ...fixtures.responses, status: 'incomplete' }],
    [
      'responses',
      {
        ...fixtures.responses,
        output: [{ ...fixtures.responses.output[1], status: 'in_progress' }],
      },
    ],
    [
      'responses',
      {
        ...fixtures.responses,
        incomplete_details: { reason: 'max_output_tokens' },
      },
    ],
    [
      'responses',
      {
        ...fixtures.responses,
        output: [
          {
            ...fixtures.responses.output[1],
            content: [{ type: 'refusal', refusal: 'no' }],
          },
        ],
      },
    ],
  ];
  for (const [protocol, body] of incomplete)
    assert.ok(
      summarizeEndpointResponse(JSON.stringify(body), protocol, 'ok').issues
        .length,
    );
});

test('explicit invalid cache counters get a warning even when base counters are valid', () => {
  for (const protocol of ['chat', 'responses']) {
    const field =
      protocol === 'chat' ? 'prompt_tokens_details' : 'input_tokens_details';
    for (const cached of [-1, '27523', null]) {
      const fixture = {
        ...fixtures[protocol],
        usage: {
          ...fixtures[protocol].usage,
          [field]: { cached_tokens: cached },
        },
      };
      const result = summarizeEndpointResponse(
        JSON.stringify(fixture),
        protocol,
        'ok',
      );
      assert.equal(result.usage.cacheRead, null);
      assert.ok(result.warnings.some((x) => x.includes('counter is invalid')));
    }
  }
});

test('capture sends correct authentication and keeps raw response including signature and null fields', async () => {
  for (const [protocol, body] of Object.entries(fixtures)) {
    const raw = JSON.stringify(body);
    let sent;
    const exchange = await captureEndpointExchange(
      connection,
      protocol,
      'ok',
      new AbortController().signal,
      async (url, init) => {
        sent = { url, ...init };
        return new Response(raw, {
          headers: {
            'x-request-id': 'req-123',
            'set-cookie': 'secret-session',
          },
        });
      },
    );
    assert.equal(sent.url, `https://example.com${ENDPOINTS[protocol].path}`);
    assert.equal(
      sent.headers[protocol === 'messages' ? 'x-api-key' : 'authorization'],
      protocol === 'messages'
        ? connection.apiKey
        : `Bearer ${connection.apiKey}`,
    );
    if (protocol === 'messages')
      assert.equal(sent.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(
      JSON.parse(sent.body),
      endpointRequestBody(protocol, connection.model, 'ok'),
    );
    assert.equal(sent.redirect, 'manual');
    assert.equal(exchange.rawResponse, raw);
    assert.equal(exchange.httpStatus, 200);
    assert.equal(exchange.requestId, 'req-123');
    assert.equal(exchange.captureComplete, true);
    assert.ok(!JSON.stringify(exchange).includes(connection.apiKey));
    assert.ok(!JSON.stringify(exchange).includes('secret-session'));
  }
});

test('Responses missing messages HTTP 500 remains visible with unchanged valid input request', async () => {
  const raw = '{"error":{"message":"缺少 messages"}}';
  const exchange = await captureEndpointExchange(
    connection,
    'responses',
    'ok',
    new AbortController().signal,
    async () => new Response(raw, { status: 500 }),
  );
  assert.equal(exchange.rawResponse, raw);
  assert.equal(exchange.httpStatus, 500);
  assert.match(exchange.error, /500/);
  assert.ok(exchange.issues.some((x) => x.includes('缺少 messages')));
  assert.equal('messages' in JSON.parse(exchange.requestBody), false);
  assert.equal(
    JSON.parse(exchange.requestBody).input,
    ENDPOINT_CASES.ok.prompt,
  );
});

test('partial capture and escaped key echoes cannot expose a credential or pass as complete', async () => {
  const escaped = [...connection.apiKey]
    .map((char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
    .join('');
  const raw = JSON.stringify({
    ...fixtures.responses,
    debug: 'SECRET',
  }).replace('SECRET', escaped);
  const result = await captureEndpointExchange(
    connection,
    'responses',
    'ok',
    new AbortController().signal,
    async () => new Response(raw),
  );
  assert.equal(JSON.parse(result.rawResponse).debug, '[REDACTED]');
  assert.ok(!JSON.stringify(result).includes(connection.apiKey));
  const partial = await captureEndpointExchange(
    connection,
    'responses',
    'ok',
    new AbortController().signal,
    async () => new Response('x'.repeat(HTTP_CAPTURE_LIMIT + 1)),
  );
  assert.equal(partial.captureComplete, false);
  assert.ok(partial.error);
  assert.equal(partial.rawResponse.length, HTTP_CAPTURE_LIMIT);
});

test('one OK request per selected endpoint, with no repeats', () => {
  assert.deepEqual(endpointPlan('all'), [
    { protocol: 'messages', caseId: 'ok', repeat: 1 },
    { protocol: 'chat', caseId: 'ok', repeat: 1 },
    { protocol: 'responses', caseId: 'ok', repeat: 1 },
  ]);
  for (const protocol of Object.keys(ENDPOINTS)) {
    assert.deepEqual(endpointPlan(protocol), [
      { protocol, caseId: 'ok', repeat: 1 },
    ]);
  }
  assert.deepEqual(Object.keys(ENDPOINT_CASES), ['ok']);
  assert.throws(() => endpointPlan('unknown'));
});

test('all selected endpoints start before any response completes and finish independently', async () => {
  const starts = [],
    results = [],
    pending = new Map();
  let finished = false;
  const running = runEndpointRequests({
    tasks: endpointPlan('all'),
    signal: new AbortController().signal,
    onStart: (i) => starts.push(i),
    onResult: (i, result, error) => results.push({ i, result, error }),
    request: (task) =>
      new Promise((resolve, reject) =>
        pending.set(task.protocol, { resolve, reject }),
      ),
  }).then(() => {
    finished = true;
  });
  assert.deepEqual(
    starts,
    [0, 1, 2],
    'dispatch must not wait for an earlier endpoint',
  );
  assert.equal(pending.size, 3);
  assert.equal(results.length, 0);
  pending.get('responses').resolve('responses done');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(results, [{ i: 2, result: 'responses done', error: null }]);
  assert.equal(
    finished,
    false,
    'running state remains active until every request settles',
  );
  pending.get('messages').reject(new Error('unavailable'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    finished,
    false,
    'one failed endpoint does not release the remaining request',
  );
  pending.get('chat').resolve('chat done');
  await running;
  assert.equal(starts.length, 3, 'failures must not create retries');
  assert.equal(results.length, 3);
  assert.ok(results.find((item) => item.i === 0).error);
  assert.equal(results.find((item) => item.i === 1).result, 'chat done');
});

test('Stop cancels every in-flight request while preserving completed results', async () => {
  const abort = new AbortController(),
    starts = [],
    cancelled = [],
    results = [];
  const running = runEndpointRequests({
    tasks: endpointPlan('all'),
    signal: abort.signal,
    onStart: (i) => starts.push(i),
    onResult: (i, value) => results.push([i, value]),
    request: (task, signal) =>
      task.protocol === 'messages'
        ? Promise.resolve('captured')
        : new Promise((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => {
                cancelled.push(task.protocol);
                reject(signal.reason);
              },
              { once: true },
            ),
          ),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0, 1, 2]);
  assert.deepEqual(results, [[0, 'captured']]);
  abort.abort();
  await running;
  assert.deepEqual(cancelled, ['chat', 'responses']);
  assert.deepEqual(results, [[0, 'captured']]);
});

test('an already stopped run sends nothing and a single selection sends exactly one request', async () => {
  const abort = new AbortController();
  abort.abort();
  const starts = [],
    results = [];
  await runEndpointRequests({
    tasks: endpointPlan('all'),
    signal: abort.signal,
    onStart: (i) => starts.push(i),
    onResult: () => assert.fail('No result should be emitted'),
    request: () => assert.fail('No request should be sent'),
  });
  assert.deepEqual(starts, []);
  await runEndpointRequests({
    tasks: endpointPlan('responses'),
    signal: new AbortController().signal,
    onStart: (i) => starts.push(i),
    onResult: (_i, value) => results.push(value),
    request: async (task) => {
      assert.equal(task.protocol, 'responses');
      return 'OK';
    },
  });
  assert.deepEqual(starts, [0]);
  assert.deepEqual(results, ['OK']);
});
