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
  runEndpointSequence,
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
      { type: 'text', text: '46' },
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
      { message: { role: 'assistant', content: '46' }, finish_reason: 'stop' },
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
        content: [{ type: 'output_text', text: '46' }],
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
      'arithmetic',
    );
    assert.equal(result.answer, '46');
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
      'arithmetic',
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
      assert.ok(
        summarizeEndpointResponse(raw, protocol, 'arithmetic').issues.length,
      );
    }
    const error = {
      ...fixtures[protocol],
      error: { message: 'provider failed' },
    };
    assert.ok(
      summarizeEndpointResponse(JSON.stringify(error), protocol, 'arithmetic')
        .issues.length,
    );
    for (const other of Object.keys(ENDPOINTS).filter((x) => x !== protocol))
      assert.ok(
        summarizeEndpointResponse(
          JSON.stringify(fixtures[other]),
          protocol,
          'arithmetic',
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
            message: { role: 'assistant', content: '46' },
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
      summarizeEndpointResponse(JSON.stringify(body), protocol, 'arithmetic')
        .issues.length,
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
        'arithmetic',
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
      'arithmetic',
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
      endpointRequestBody(protocol, connection.model, 'arithmetic'),
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
    'arithmetic',
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
    ENDPOINT_CASES.arithmetic.prompt,
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
    'arithmetic',
    new AbortController().signal,
    async () => new Response(raw),
  );
  assert.equal(JSON.parse(result.rawResponse).debug, '[REDACTED]');
  assert.ok(!JSON.stringify(result).includes(connection.apiKey));
  const partial = await captureEndpointExchange(
    connection,
    'responses',
    'arithmetic',
    new AbortController().signal,
    async () => new Response('x'.repeat(HTTP_CAPTURE_LIMIT + 1)),
  );
  assert.equal(partial.captureComplete, false);
  assert.ok(partial.error);
  assert.equal(partial.rawResponse.length, HTTP_CAPTURE_LIMIT);
});

test('comparison plans match the six-request baseline and twelve-request repeat check', () => {
  assert.equal(endpointPlan('all', 1).length, 6);
  assert.equal(endpointPlan('all', 3).length, 12);
  assert.equal(endpointPlan('responses', 3).length, 4);
  assert.throws(() => endpointPlan('all', 99));
});

test('failures do not prevent subsequent endpoints and Stop preserves completed results', async () => {
  const tasks = endpointPlan('all', 1),
    starts = [],
    results = [];
  await runEndpointSequence({
    tasks,
    signal: new AbortController().signal,
    onStart: (i) => starts.push(i),
    onResult: (i, result, error) => results.push({ i, result, error }),
    request: async (task) => {
      if (task.protocol === 'messages') throw new Error('failure');
      return 'done';
    },
    delay: async (ms) => assert.equal(ms, 3000),
  });
  assert.equal(starts.length, 6);
  assert.equal(results.length, 6);
  assert.ok(results[0].error);
  assert.equal(results[5].result, 'done');
  const abort = new AbortController(),
    captured = [],
    called = [];
  await runEndpointSequence({
    tasks,
    signal: abort.signal,
    onStart: (i) => called.push(i),
    onResult: (i, value) => captured.push([i, value]),
    request: async (_task, signal) => {
      if (called.length === 2) {
        abort.abort();
        signal.throwIfAborted();
      }
      return 'captured';
    },
    delay: async () => {},
  });
  assert.deepEqual(called, [0, 1]);
  assert.deepEqual(captured, [[0, 'captured']]);
});
