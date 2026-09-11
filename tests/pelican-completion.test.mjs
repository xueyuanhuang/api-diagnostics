import test from 'node:test';
import assert from 'node:assert/strict';
import { readProviderStream } from '../lib/server/provider-stream.ts';
import { animationWarning, extractAnimationHtml, pelicanOutputLimit } from '../lib/pelican-test.ts';

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
  for (const limit of [8192, 16384, 32768]) assert.equal(pelicanOutputLimit(limit), limit);
  for (const limit of [null, '32768', -1, 0, 1000000, NaN]) assert.equal(pelicanOutputLimit(limit), null);
});
