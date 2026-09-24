import assert from 'node:assert/strict';
import test from 'node:test';
import { runProviderRequest } from '../lib/server/rpm-provider.ts';

const input = {
  apiType: 'openai',
  baseUrl: 'https://example.com/v1',
  apiKey: 'test-only-secret',
  model: 'test-model',
  runId: 'test',
  stageIndex: 0,
  sequence: 0,
  plannedAt: 1000,
  stream: true,
};
const event = (value) => `data: ${JSON.stringify(value)}\r\n\r\n`;
async function capture(t, chunks, options = {}) {
  let clock = 1000,
    index = 0,
    calls = 0;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.equal(body.stream, options.stream ?? true);
    if (options.openRouterTier) {
      assert.equal(body.service_tier, 'flex');
      assert.deepEqual(body.provider.only, ['openai/flex']);
      assert.equal(body.provider.allow_fallbacks, false);
    }
    clock = 1010;
    return new Response(
      new ReadableStream(
        {
          pull(controller) {
            const next = chunks[index++];
            if (!next) {
              clock += 50;
              controller.close();
              return;
            }
            clock = next.at;
            if (next.error) controller.error(next.error);
            else controller.enqueue(new TextEncoder().encode(next.text));
          },
        },
        { highWaterMark: 0 },
      ),
      {
        status: options.status ?? 200,
        headers: { 'content-type': options.contentType ?? 'text/event-stream' },
      },
    );
  });
  const result = await runProviderRequest({ ...input, ...options });
  assert.equal(calls, 1, 'never retry a paid request to obtain TTFT');
  return result;
}

test('streaming TTFT ignores metadata and reasoning, handles fragmented events, and waits for the complete answer', async (t) => {
  const answer = event({ choices: [{ delta: { content: 'OK' } }] });
  const result = await capture(
    t,
    [
      { at: 1020, text: ': keepalive\r\n\r\n' },
      {
        at: 1040,
        text: event({
          model: 'test-model',
          choices: [{ delta: { role: 'assistant', content: '' } }],
        }),
      },
      {
        at: 1060,
        text: event({
          choices: [{ delta: { reasoning_content: 'thinking' } }],
        }),
      },
      { at: 1100, text: answer.slice(0, 15) },
      { at: 1200, text: answer.slice(15) },
      {
        at: 1500,
        text:
          event({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
          event({ usage: { completion_tokens: 2 } }) +
          'data: [DONE]\r\n\r\n',
      },
    ],
    {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-6-astra',
      openRouterTier: 'flex',
    },
  );
  assert.equal(result.ttftMs, 200);
  assert.equal(result.firstByteMs, 20);
  assert.equal(result.totalTimeMs, 550);
  assert.equal(result.outcome, 'success');
  assert.equal(result.response.usage.completion_tokens, 2);
  assert.equal(result.response.returnedModel, 'test-model');
});

test('Anthropic TTFT ignores ping and thinking events and retains final usage', async (t) => {
  const result = await capture(
    t,
    [
      {
        at: 1020,
        text: event({
          type: 'message_start',
          message: { model: 'claude-test', usage: { input_tokens: 12 } },
        }),
      },
      {
        at: 1040,
        text:
          event({ type: 'ping' }) +
          event({
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: 'thinking' },
          }),
      },
      {
        at: 1200,
        text: event({
          type: 'content_block_start',
          content_block: { type: 'text', text: '' },
        }),
      },
      {
        at: 1300,
        text: event({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'OK' },
        }),
      },
      {
        at: 1800,
        text:
          event({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 2 },
          }) + event({ type: 'message_stop' }),
      },
    ],
    { apiType: 'anthropic' },
  );
  assert.equal(result.ttftMs, 300);
  assert.equal(result.totalTimeMs, 850);
  assert.equal(result.outcome, 'success');
  assert.deepEqual(result.response.usage, {
    input_tokens: 12,
    output_tokens: 2,
  });
});

test('a provider ignoring stream:true can succeed but cannot invent TTFT', async (t) => {
  const result = await capture(
    t,
    [
      {
        at: 1300,
        text: JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
      },
    ],
    { contentType: 'application/json' },
  );
  assert.equal(result.outcome, 'success');
  assert.equal(result.ttftMs, null);
});

test('legacy requests retain their non-streaming workload and no TTFT', async (t) => {
  const result = await capture(
    t,
    [
      {
        at: 1300,
        text: JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
      },
    ],
    { stream: false },
  );
  assert.equal(result.outcome, 'success');
  assert.equal(result.ttftMs, null);
});

test('an answer without a completion signal is not a successful request', async (t) => {
  const result = await capture(t, [
    { at: 1300, text: event({ choices: [{ delta: { content: 'OK' } }] }) },
  ]);
  assert.equal(result.ttftMs, 300);
  assert.equal(result.outcome, 'malformed');
  assert.match(result.error, /before completion/);
});

test('HTTP 200 streaming errors override received text and redact secrets', async (t) => {
  const result = await capture(t, [
    { at: 1200, text: event({ choices: [{ delta: { content: 'O' } }] }) },
    {
      at: 1300,
      text: event({
        error: { code: 429, message: 'Rate limited test-only-secret' },
      }),
    },
  ]);
  assert.equal(result.outcome, 'rate_limited');
  assert.equal(result.response.status, 200);
  assert.equal(result.ttftMs, 200);
  assert.match(result.error, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result), /test-only-secret/);
});

test('a timed-out stream retains partial text and TTFT without counting success', async (t) => {
  const error = new Error('timed out');
  error.name = 'TimeoutError';
  const result = await capture(t, [
    { at: 1300, text: event({ choices: [{ delta: { content: 'O' } }] }) },
    { at: 1500, error },
  ]);
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.ttftMs, 300);
  assert.equal(result.response.bodyComplete, false);
  assert.match(result.response.body, /content/);
});

test('metadata-only streams do not produce TTFT or count as a completed answer', async (t) => {
  const result = await capture(t, [
    {
      at: 1300,
      text:
        event({
          choices: [{ delta: { role: 'assistant' }, finish_reason: 'stop' }],
        }) + 'data: [DONE]\n\n',
    },
  ]);
  assert.equal(result.ttftMs, null);
  assert.equal(result.outcome, 'malformed');
});
