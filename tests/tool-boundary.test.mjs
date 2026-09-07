import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundaryRequestBody,
  BOUNDARY_PROMPT,
  runBoundarySequence,
  summarizeBoundaryResponse,
  abortableBoundaryDelay,
} from '../lib/tool-boundary.ts';
import {
  captureBoundaryExchange,
  BOUNDARY_CAPTURE_LIMIT,
} from '../lib/server/tool-boundary.ts';

const connection = {
  apiType: 'openai',
  model: 'test-model',
  apiKey: 'test-key-123456',
  baseUrl: 'https://example.com',
  actualBaseUrl: 'https://example.com',
};
const chat = (content, extra = {}, reason = 'stop') =>
  JSON.stringify({
    model: 'returned-model',
    choices: [
      {
        finish_reason: reason,
        message: { role: 'assistant', content, ...extra },
      },
    ],
  });

test('clean requests match the original comparison and contain no tools, instructions or sampling overrides', () => {
  assert.deepEqual(boundaryRequestBody('openai', 'test-model'), {
    model: 'test-model',
    max_completion_tokens: 8192,
    stream: false,
    messages: [{ role: 'user', content: BOUNDARY_PROMPT }],
  });
  assert.deepEqual(boundaryRequestBody('anthropic', 'test-model'), {
    model: 'test-model',
    max_tokens: 8192,
    stream: false,
    messages: [{ role: 'user', content: BOUNDARY_PROMPT }],
  });
});

test('denials, hypothetical tools and capability claims all remain prose for manual review', () => {
  for (const answer of [
    '没有 web_search，不能执行 Shell。',
    '如果接入浏览器才可以搜索。',
    '我有 web_search，可以搜索。',
    '搜索完成。示例：{"tool_calls": [{"name":"web_search"}]}',
  ]) {
    const result = summarizeBoundaryResponse(chat(answer), 'openai');
    assert.equal(result.answer, answer);
    assert.deepEqual(result.structuredToolCalls, []);
    assert.deepEqual(result.issues, []);
    assert.equal('verdict' in result, false);
  }
});

test('structured calls are distinguished from text across Chat, legacy functions and Messages', () => {
  const call = {
    id: 'call-1',
    type: 'function',
    function: { name: 'web_search', arguments: '{}' },
  };
  assert.deepEqual(
    summarizeBoundaryResponse(
      chat(null, { tool_calls: [call] }, 'tool_calls'),
      'openai',
    ).structuredToolCalls,
    [call],
  );
  assert.deepEqual(
    summarizeBoundaryResponse(
      chat(null, { function_call: call.function }, 'function_call'),
      'openai',
    ).structuredToolCalls,
    [call.function],
  );
  const blocks = [
    { type: 'text', text: 'Searching' },
    { type: 'server_tool_use', id: 'tool-1', name: 'web_search', input: {} },
  ];
  assert.deepEqual(
    summarizeBoundaryResponse(
      JSON.stringify({ content: blocks, stop_reason: 'tool_use' }),
      'anthropic',
    ).structuredToolCalls,
    [blocks[1]],
  );
});

test('empty, invalid, truncated, refused and error responses cannot become successful denials', () => {
  for (const raw of [
    '',
    '{}',
    'null',
    chat(''),
    chat('没有工具', {}, 'length'),
    chat(null, { refusal: 'Refused' }),
    '{"error":{"message":"unavailable"}}',
    chat(null, {}, 'tool_calls'),
  ]) {
    assert.ok(summarizeBoundaryResponse(raw, 'openai').issues.length, raw);
  }
  assert.ok(
    summarizeBoundaryResponse(
      '{"content":[],"stop_reason":"max_tokens"}',
      'anthropic',
    ).issues.length,
  );
});

test('capture keeps full raw signatures and unknown fields, while credentials never reach evidence', async () => {
  const signature = 'aB9+/='.repeat(12000);
  const raw = chat('没有工具', {
    reasoning_content: '',
    thinking_blocks: [{ signature }],
    provider_specific_fields: { thinking_blocks: [{ signature }] },
    debug: connection.apiKey,
  });
  let sent;
  const result = await captureBoundaryExchange(
    connection,
    new AbortController().signal,
    async (url, init) => {
      sent = { url, ...init };
      return new Response(raw, {
        headers: {
          'x-request-id': 'req-123',
          'set-cookie': 'session=private',
          'x-debug': connection.apiKey,
        },
      });
    },
  );
  assert.equal(sent.url, 'https://example.com/v1/chat/completions');
  assert.equal(sent.headers.authorization, `Bearer ${connection.apiKey}`);
  assert.equal(
    sent.body,
    JSON.stringify(boundaryRequestBody('openai', 'test-model')),
  );
  assert.equal(sent.redirect, 'manual');
  assert.equal(
    result.rawResponse,
    raw.replace(connection.apiKey, '[REDACTED]'),
  );
  assert.equal(
    JSON.parse(result.rawResponse).choices[0].message.thinking_blocks[0]
      .signature,
    signature,
  );
  assert.ok(!JSON.stringify(result).includes(connection.apiKey));
  assert.ok(!JSON.stringify(result).includes('session=private'));
  assert.equal(result.requestId, 'req-123');
  assert.equal(result.captureComplete, true);
  assert.equal(result.httpStatus, 200);
});

test('HTTP failure evidence retains the original body and mapped request URL', async () => {
  const result = await captureBoundaryExchange(
    { ...connection, actualBaseUrl: 'https://mapped.example.com:8443/prefix' },
    new AbortController().signal,
    async () => new Response('upstream unavailable', { status: 503 }),
  );
  assert.equal(
    result.requestUrl,
    'https://mapped.example.com:8443/prefix/v1/chat/completions',
  );
  assert.equal(result.originalBaseUrl, connection.baseUrl);
  assert.equal(result.rawResponse, 'upstream unavailable');
  assert.equal(result.httpStatus, 503);
  assert.match(result.error, /503/);
  assert.equal(result.captureComplete, true);
});

test('oversized and interrupted responses keep partial evidence and are explicitly marked incomplete', async () => {
  const over = await captureBoundaryExchange(
    connection,
    new AbortController().signal,
    async () => new Response('x'.repeat(BOUNDARY_CAPTURE_LIMIT + 1)),
  );
  assert.equal(over.rawResponse.length, BOUNDARY_CAPTURE_LIMIT);
  assert.equal(over.captureComplete, false);
  assert.match(over.error, /partial/);
  let pulled = false;
  const broken = new ReadableStream({
    pull(controller) {
      if (pulled) controller.error(new Error('closed'));
      else {
        pulled = true;
        controller.enqueue(new TextEncoder().encode('partial response'));
      }
    },
  });
  const interrupted = await captureBoundaryExchange(
    connection,
    new AbortController().signal,
    async () =>
      new Response(broken, { headers: { 'x-request-id': 'partial-id' } }),
  );
  assert.equal(interrupted.rawResponse, 'partial response');
  assert.equal(interrupted.requestId, 'partial-id');
  assert.equal(interrupted.captureComplete, false);
  assert.ok(interrupted.error);
});

test('three serial repeats wait three seconds after completion, including a failed request', async () => {
  const order = [];
  const results = [];
  await runBoundarySequence({
    signal: new AbortController().signal,
    onStart: (i) => order.push(`start${i}`),
    request: async (i) => {
      order.push(`end${i}`);
      if (i === 1) throw new Error('network');
      return i;
    },
    onResult: (i, result, error) => results.push({ i, result, error }),
    delay: async (ms) => {
      assert.equal(ms, 3000);
      order.push('wait');
    },
  });
  assert.deepEqual(order, [
    'start0',
    'end0',
    'wait',
    'start1',
    'end1',
    'wait',
    'start2',
    'end2',
  ]);
  assert.equal(results.length, 3);
  assert.ok(results[1].error);
  assert.equal(results[2].result, 2);
});

test('Stop cancels an active request and prevents later repeats, preserving completed evidence', async () => {
  const abort = new AbortController();
  const results = [];
  const calls = [];
  await runBoundarySequence({
    signal: abort.signal,
    onStart: (i) => calls.push(i),
    request: async (i, signal) => {
      if (i === 1) {
        abort.abort();
        signal.throwIfAborted();
      }
      return 'captured';
    },
    onResult: (i, result) => results.push([i, result]),
    delay: async () => {},
  });
  assert.deepEqual(calls, [0, 1]);
  assert.deepEqual(results, [[0, 'captured']]);
  const waiting = new AbortController();
  const delay = abortableBoundaryDelay(3000, waiting.signal);
  waiting.abort();
  await assert.rejects(delay);
});

test('malformed call fields are anomalies, never structured-call evidence', () => {
  for (const extra of [
    { tool_calls: [null] },
    { tool_calls: 'web_search' },
    { function_call: true },
    { tool_calls: [{ type: 'function', function: {} }] },
  ]) {
    const result = summarizeBoundaryResponse(chat('No tools', extra), 'openai');
    assert.deepEqual(result.structuredToolCalls, []);
    assert.ok(result.issues.length);
  }
  const messages = summarizeBoundaryResponse(
    JSON.stringify({
      content: [{ type: 'tool_use', name: 'web_search' }],
      stop_reason: 'tool_use',
    }),
    'anthropic',
  );
  assert.deepEqual(messages.structuredToolCalls, []);
  assert.ok(messages.issues.length);
});

test('JSON-escaped credential echoes are redacted before both display and download', async () => {
  const escaped = connection.apiKey
    .split('')
    .map((char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
    .join('');
  const raw = chat('echo: SECRET').replace('SECRET', escaped);
  const result = await captureBoundaryExchange(
    connection,
    new AbortController().signal,
    async () => new Response(raw),
  );
  assert.equal(result.answer, 'echo: [REDACTED]');
  assert.equal(
    JSON.parse(result.rawResponse).choices[0].message.content,
    'echo: [REDACTED]',
  );
  assert.ok(!JSON.stringify(result).includes(connection.apiKey));
  assert.ok(!result.rawResponse.includes(escaped));
});
