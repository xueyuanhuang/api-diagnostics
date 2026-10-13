import assert from 'node:assert/strict';
import test from 'node:test';
import { assessToolChoice, toolChoiceRequestBody } from '../lib/tool-choice.ts';
import { captureToolChoiceExchange } from '../lib/server/tool-choice.ts';
import { validateDiagnosticRun } from '../lib/server/diagnostic-store.ts';
import { diagnosticSummary, diagnosticExport } from '../lib/diagnostic-runs.ts';

const call = {
  id: 'call_1',
  type: 'function',
  function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' },
};
const chat = (extra = {}, reason = 'stop') => ({
  object: 'chat.completion',
  model: 'test',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'I cannot check live weather.',
        ...extra,
      },
      finish_reason: reason,
    },
  ],
});
const message = (
  content = [{ type: 'text', text: 'No live weather lookup.' }],
  stop_reason = 'end_turn',
) => ({
  type: 'message',
  role: 'assistant',
  model: 'test',
  content,
  stop_reason,
});
const sse = (...events) =>
  events
    .map(
      (event) =>
        `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`,
    )
    .join('');
const chunk = (delta, finish_reason = null) => ({
  object: 'chat.completion.chunk',
  model: 'test',
  choices: [{ index: 0, delta, finish_reason }],
});
const chatStream = () =>
  sse(
    chunk({ role: 'assistant', content: 'No lookup.' }),
    chunk({}, 'stop'),
    '[DONE]',
  );
const messageEvents = () => [
  { type: 'message_start', message: message([]) },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'No lookup.' },
  },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
];
function exchange(raw, apiType = 'openai', stream = false, overrides = {}) {
  return {
    requestedModel: 'test',
    originalBaseUrl: 'https://fixture.invalid',
    requestMethod: 'POST',
    requestUrl: `https://fixture.invalid/v1/${apiType === 'openai' ? 'chat/completions' : 'messages'}`,
    requestHeaders: [['authorization', 'Bearer $API_KEY']],
    requestBody: JSON.stringify(toolChoiceRequestBody(apiType, 'test', stream)),
    responseHeaders: [],
    httpStatus: 200,
    requestId: 'fixture',
    rawResponse: typeof raw === 'string' ? raw : JSON.stringify(raw),
    captureComplete: true,
    startedAt: '2026-10-14T00:00:00Z',
    endedAt: '2026-10-14T00:00:01Z',
    totalTimeMs: 1000,
    error: null,
    ...overrides,
  };
}
const assess = (raw, apiType = 'openai', stream = false, overrides) =>
  assessToolChoice(exchange(raw, apiType, stream, overrides), apiType, stream);

test('both protocols declare a tool while explicitly forbidding it, in each response mode', () => {
  for (const stream of [false, true]) {
    const a = toolChoiceRequestBody('openai', 'test', stream);
    assert.equal(a.tool_choice, 'none');
    assert.equal(a.tools[0].function.name, 'get_weather');
    assert.equal(a.stream, stream);
    const b = toolChoiceRequestBody('anthropic', 'test', stream);
    assert.deepEqual(b.tool_choice, { type: 'none' });
    assert.equal(b.tools[0].name, 'get_weather');
    assert.deepEqual(b.tools[0].input_schema, a.tools[0].function.parameters);
    assert.deepEqual(b.messages, a.messages);
  }
});
test('HTTP 200 with a structured tool call fails; prose that mentions tools does not', () => {
  const result = assess(
    chat({ content: null, tool_calls: [call] }, 'tool_calls'),
  );
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.toolCallEvidence, [
    { path: 'choices[0].message.tool_calls[0]', value: call },
  ]);
  assert.equal(
    assess(
      chat({ content: 'Example: {"tool_calls":[{"name":"get_weather"}]}' }),
    ).verdict,
    'pass',
  );
  assert.equal(
    assess(chat({ tool_calls: [], function_call: null })).verdict,
    'pass',
  );
  assert.equal(assess(chat({ function_call: call.function })).verdict, 'fail');
});
test('Messages tool_use and server_tool_use are violations, independent of ordinary text', () => {
  assert.equal(assess(message(), 'anthropic').verdict, 'pass');
  for (const type of ['tool_use', 'server_tool_use']) {
    assert.equal(
      assess(
        message(
          [
            {
              type,
              id: 'tool_1',
              name: 'get_weather',
              input: { city: 'Shanghai' },
            },
          ],
          'tool_use',
        ),
        'anthropic',
      ).verdict,
      'fail',
    );
  }
});
test('clean streams require normal finish and protocol completion signals', () => {
  assert.equal(assess(chatStream(), 'openai', true).verdict, 'pass');
  assert.equal(
    assess(sse(...messageEvents()), 'anthropic', true).verdict,
    'pass',
  );
  assert.equal(
    assess(chatStream().replace('data: [DONE]\n\n', ''), 'openai', true)
      .verdict,
    'inconclusive',
  );
  assert.equal(
    assess(sse(chunk({ content: 'Hi' }), '[DONE]'), 'openai', true).verdict,
    'inconclusive',
  );
  assert.equal(
    assess(sse(...messageEvents().slice(0, -1)), 'anthropic', true).verdict,
    'inconclusive',
  );
  assert.equal(
    assess(
      sse(...messageEvents().filter((e) => e.type !== 'content_block_stop')),
      'anthropic',
      true,
    ).verdict,
    'inconclusive',
  );
});
test('tool-call deltas fail even when interrupted before arguments or stream completion', () => {
  const raw = sse(
    chunk({
      tool_calls: [
        {
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '' },
        },
      ],
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
  );
  const result = assess(raw, 'openai', true, {
    captureComplete: false,
    error: 'Interrupted',
  });
  assert.equal(result.verdict, 'fail');
  assert.equal(result.toolCallEvidence.length, 2);
  assert.ok(result.issues.includes('Interrupted'));
  assert.equal(
    assess(
      sse(
        { type: 'message_start', message: message([]) },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'a',
            name: 'get_weather',
            input: {},
          },
        },
      ),
      'anthropic',
      true,
    ).verdict,
    'fail',
  );
});
test('JSON fallback for a streaming request cannot pass; a returned tool call still fails', () => {
  assert.equal(assess(chat(), 'openai', true).verdict, 'inconclusive');
  assert.equal(
    assess(chat({ tool_calls: [call] }), 'openai', true).verdict,
    'fail',
  );
  assert.equal(assess(chatStream(), 'openai', false).verdict, 'inconclusive');
});
test('HTTP errors, embedded errors, empty, refused and truncated responses never pass', () => {
  for (const override of [
    { httpStatus: 400 },
    { httpStatus: null },
    { captureComplete: false },
    { error: 'Timeout' },
  ])
    assert.equal(
      assess(chat(), 'openai', false, override).verdict,
      'inconclusive',
    );
  for (const raw of [
    '',
    '<html>Error</html>',
    {},
    { error: { message: 'Bad parameter' } },
    chat({ content: '' }),
    chat({}, 'length'),
    chat({ refusal: 'No' }),
    { ...chat(), error: { message: 'late error' } },
  ])
    assert.equal(assess(raw).verdict, 'inconclusive');
  assert.equal(
    assess(
      chatStream().replace(
        'data: [DONE]',
        'data: {"error":{"message":"late error"}}\n\ndata: [DONE]',
      ),
      'openai',
      true,
    ).verdict,
    'inconclusive',
  );
});
test('malformed tool fields and finish reasons alone do not establish a tool call', () => {
  assert.equal(
    assess(chat({ tool_calls: 'not-an-array' })).verdict,
    'inconclusive',
  );
  assert.equal(
    assess(chat({ tool_calls: [] }, 'tool_calls')).verdict,
    'inconclusive',
  );
  assert.equal(assess(chat({ tool_calls: [{}] })).verdict, 'inconclusive');
});
test('SSE comments, CRLF, and multi-line JSON data are handled; invalid or trailing events cannot pass', () => {
  assert.equal(
    assess(
      `: keepalive\r\n\r\n${chatStream().replaceAll('\n', '\r\n')}`,
      'openai',
      true,
    ).verdict,
    'pass',
  );
  const multi = chatStream().replace(
    '"model":"test",',
    '"model":"test",\ndata: ',
  );
  assert.equal(assess(multi, 'openai', true).verdict, 'pass');
  assert.equal(
    assess(chatStream() + 'data: {bad}\n\n', 'openai', true).verdict,
    'inconclusive',
  );
  assert.equal(
    assess(chatStream().trimEnd(), 'openai', true).verdict,
    'inconclusive',
  );
});
test('without the captured none request, tool presence cannot be called a none violation', () => {
  assert.equal(
    assess(chat({ tool_calls: [call] }), 'openai', false, {
      requestBody: JSON.stringify({
        ...toolChoiceRequestBody('openai', 'test', false),
        tool_choice: 'auto',
      }),
    }).verdict,
    'inconclusive',
  );
});
test('server capture sends the tool and none, preserves raw SSE and redacts credentials', async () => {
  for (const apiType of ['openai', 'anthropic'])
    for (const stream of [false, true]) {
      const key = 'fixture-key-never-expose';
      const raw = stream
        ? apiType === 'openai'
          ? chatStream()
          : sse(...messageEvents())
        : JSON.stringify(apiType === 'openai' ? chat() : message());
      let count = 0;
      const result = await captureToolChoiceExchange(
        {
          apiType,
          model: 'test',
          baseUrl: 'https://fixture.invalid',
          actualBaseUrl: 'https://mapped.invalid',
          apiKey: key,
        },
        stream,
        new AbortController().signal,
        async (url, options) => {
          count++;
          assert.match(url, /mapped.invalid/);
          assert.deepEqual(
            JSON.parse(options.body),
            toolChoiceRequestBody(apiType, 'test', stream),
          );
          assert.equal(
            options.headers[
              apiType === 'openai' ? 'authorization' : 'x-api-key'
            ],
            apiType === 'openai' ? `Bearer ${key}` : key,
          );
          return new Response(raw, {
            headers: {
              'content-type': stream ? 'text/event-stream' : 'application/json',
              'set-cookie': key,
            },
          });
        },
      );
      assert.equal(count, 1);
      assert.equal(result.verdict, 'pass');
      assert.equal(result.rawResponse, raw);
      assert.ok(!JSON.stringify(result).includes(key));
    }
});
test('selected OpenRouter tier remains pinned without altering none or tools', async () => {
  await captureToolChoiceExchange(
    {
      apiType: 'openai',
      model: 'openai/test',
      baseUrl: 'https://openrouter.ai/api/v1',
      actualBaseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'fixture',
      openRouterTier: 'flex',
    },
    false,
    new AbortController().signal,
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.tool_choice, 'none');
      assert.equal(body.tools[0].function.name, 'get_weather');
      assert.equal(body.service_tier, 'flex');
      assert.equal(body.provider.allow_fallbacks, false);
      return new Response(JSON.stringify(chat()));
    },
  );
});
function run() {
  return {
    id: 'ab1cec03-078c-4cc4-8001-b37c44c42d39',
    label: 'Fixture',
    profileId: 'fixture',
    model: 'test',
    apiType: 'openai',
    baseUrl: 'https://fixture.invalid',
    createdAt: '2026-10-14T00:00:00Z',
    testKind: 'tool-choice',
    rows: [false, true].map((stream) => ({
      stream,
      status: 'pass',
      error: null,
      exchange: exchange(
        stream ? chatStream() : chat({ tool_calls: [call] }),
        'openai',
        stream,
      ),
    })),
  };
}
test('saved runs recompute verdicts and preserve both response modes in summaries and export', () => {
  const data = run();
  data.rows[0].exchange.verdict = 'pass'; // A supplied summary cannot conceal the actual violation.
  const valid = validateDiagnosticRun(data);
  assert.equal(valid.rows[0].status, 'issue');
  assert.equal(valid.rows[0].exchange.verdict, 'fail');
  assert.equal(valid.rows[1].exchange.verdict, 'pass');
  const summary = diagnosticSummary(valid);
  assert.equal(summary.testKind, 'tool-choice');
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.inconclusiveCount, 0);
  assert.equal(summary.status, 'issues');
  assert.equal(diagnosticExport(valid).format, 'tool-choice-none-v1');
  assert.equal(
    diagnosticExport(valid).rows[1].exchange.rawResponse,
    chatStream(),
  );
  data.rows[1].stream = false;
  assert.throws(() => validateDiagnosticRun(data), /Invalid finished/);
});
test('stopped and missing evidence can be saved without manufacturing a pass', () => {
  const data = run();
  data.rows[0] = {
    stream: false,
    status: 'issue',
    exchange: null,
    error: 'Tester unavailable',
  };
  data.rows[1] = {
    stream: true,
    status: 'stopped',
    exchange: null,
    error: 'Stopped before request',
  };
  const summary = diagnosticSummary(validateDiagnosticRun(data));
  assert.equal(summary.status, 'stopped');
  assert.equal(summary.inconclusiveCount, 1);
  assert.equal(summary.failedCount, 0);
});

test('garbage inside tool-call fields is inconclusive and a finished tool stream is not mislabeled interrupted', () => {
  assert.equal(
    assess(chat({ tool_calls: [{ unrelated: true }] })).verdict,
    'inconclusive',
  );
  assert.equal(
    assess(chat({ function_call: { unrelated: true } })).verdict,
    'inconclusive',
  );
  const result = assess(
    sse(
      chunk({ tool_calls: [{ index: 0, ...call }] }),
      chunk({}, 'tool_calls'),
      '[DONE]',
    ),
    'openai',
    true,
  );
  assert.equal(result.verdict, 'fail');
  assert.ok(!result.issues.includes('Stream completion was not confirmed.'));
});
