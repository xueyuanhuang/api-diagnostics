import test from 'node:test';
import assert from 'node:assert/strict';
import { readProviderStream, ANIMATION_MAX_RESPONSE_BYTES, ProviderResponseSizeError } from '../lib/server/provider-stream.ts';
import { animationWarning, extractAnimationHtml, pelicanOutputLimit, adjustPelicanOutputLimit } from '../lib/pelican-test.ts';

const event = data => `data: ${JSON.stringify(data)}\n\n`;
const read = (body, apiType) => readProviderStream(new Response(body), apiType, '', performance.now());
const completeHtml = '<!doctype html><html><body><svg><circle r="3"/></svg></body></html>';

test('Anthropic stream preserves long visible output and distinguishes a token-limit stop from thinking', async () => {
  const text = completeHtml.repeat(200);
  const output = await read([
    event({ type: 'message_start', message: { model: 'fixture', usage: { input_tokens: 51 } } }),
    event({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private reasoning' } }),
    event({ type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(0, 1938) } }),
    event({ type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(1938) } }),
    event({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 8192 } }),
  ].join(''), 'anthropic');
  assert.equal(output.answer, text);
  assert.equal(output.finishReason, 'max_tokens');
  assert.equal(output.usage.output_tokens, 8192);
});

test('OpenAI finish reason survives a following usage-only stream event', async () => {
  const output = await read(event({ choices: [{ delta: { content: completeHtml }, finish_reason: 'length' }] }) + event({ choices: [], usage: { completion_tokens: 16384 } }), 'openai');
  assert.equal(output.finishReason, 'length');
  assert.equal(output.answer, completeHtml);
  assert.match(animationWarning(output.answer, { ...output, maxOutputTokens: 16384 }), /16,384-token/);
});

test('JSON fallback records completion reasons for both API formats', async () => {
  const anthropic = await read(JSON.stringify({ content: [{ type: 'text', text: completeHtml }], stop_reason: 'end_turn' }), 'anthropic');
  const openai = await read(JSON.stringify({ choices: [{ message: { content: completeHtml }, finish_reason: 'stop' }] }), 'openai');
  assert.equal(anthropic.finishReason, 'end_turn');
  assert.equal(openai.finishReason, 'stop');
  assert.equal(animationWarning(anthropic.answer, { finishReason: anthropic.finishReason, outputTokens: 8192 }), null);
});

test('the original clipped SVG is flagged when reopening an old saved result', () => {
  const html = extractAnimationHtml('```html\n<!doctype html><html><body><svg><defs><linearGradient x2="0');
  assert.match(animationWarning(html, { outputTokens: 8192 }), /8,192-token.*HTML\/SVG is unfinished/);
  assert.match(animationWarning(html, { finishReason: 'end_turn' }), /appears unfinished/);
  assert.equal(animationWarning(completeHtml, { outputTokens: 12 }), null);
});

test('output budgets are bounded and invalid values cannot silently change the request', () => {
  assert.equal(pelicanOutputLimit(undefined), 32768);
  for (const limit of [1, 12000, 8192, 16384, 32768, 40960, 1000000]) assert.equal(pelicanOutputLimit(limit), limit);
  for (const limit of [null, '32768', -1, 0, 1.5, Infinity, 2147483648, NaN]) assert.equal(pelicanOutputLimit(limit), null);
});

test('percentage adjustments use the current value and round to whole tokens', () => {
  assert.equal(adjustPelicanOutputLimit(32768, 25), 40960);
  assert.equal(adjustPelicanOutputLimit(40960, -25), 30720);
  assert.equal(adjustPelicanOutputLimit(12001, 10), 13201);
  assert.equal(adjustPelicanOutputLimit(1, -50), 1);
});

test('animation streams over the former 1 MB cap complete with usage and token finish reason intact', async () => {
  const text = '<svg>' + 'x'.repeat(1_100_000) + '</svg>';
  const body = event({choices:[{delta:{content:text},finish_reason:'stop'}]}) + event({choices:[],usage:{completion_tokens:1234}});
  const result = await readProviderStream(new Response(body), 'openai', '', performance.now(), ANIMATION_MAX_RESPONSE_BYTES);
  assert.equal(result.answer, text);
  assert.equal(result.usage.completion_tokens, 1234);
  assert.equal(result.finishReason, 'stop');
});

test('response-size errors cancel streams and distinguish byte limits from tokens', async () => {
  let cancelled = false;
  const body = new ReadableStream({start(c) {c.enqueue(new Uint8Array(101));}, cancel() {cancelled = true;}});
  await assert.rejects(readProviderStream(new Response(body), 'openai', '', performance.now(), 100), e => e instanceof ProviderResponseSizeError && /separate from the output-token limit/.test(e.message));
  assert.equal(cancelled, true);
  assert.match(new ProviderResponseSizeError(ANIMATION_MAX_RESPONSE_BYTES).message, /32 MiB/);
  await assert.rejects(readProviderStream(new Response('x', {headers:{'content-length':'101'}}), 'openai', '', performance.now(), 100), ProviderResponseSizeError);
});
