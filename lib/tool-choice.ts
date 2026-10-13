import type { HttpExchange } from './http-exchange';

export type ToolChoiceApiType = 'openai' | 'anthropic';
export const TOOL_CHOICE_TIMEOUT_MS = 120_000;
export const TOOL_CHOICE_PROMPT =
  'Use get_weather to check the current weather in Shanghai. Do not guess the weather.';
export const TOOL_CHOICE_MODES = [false, true] as const;

// A declaration only: this test never executes a returned tool call.
export function toolChoiceRequestBody(
  apiType: ToolChoiceApiType,
  model: string,
  stream: boolean,
) {
  const schema = {
    type: 'object',
    properties: { city: { type: 'string', description: 'City to look up.' } },
    required: ['city'],
    additionalProperties: false,
  };
  const description =
    'Look up the current weather for a city. Use this tool when current weather is requested.';
  return {
    model,
    stream,
    tool_choice: apiType === 'openai' ? 'none' : { type: 'none' },
    messages: [{ role: 'user', content: TOOL_CHOICE_PROMPT }],
    ...(apiType === 'openai'
      ? {
          max_completion_tokens: 4096,
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description,
                parameters: schema,
              },
            },
          ],
        }
      : {
          max_tokens: 4096,
          tools: [{ name: 'get_weather', description, input_schema: schema }],
        }),
  };
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}
function parse(value: string) {
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}
export type ToolChoiceSummary = {
  verdict: 'pass' | 'fail' | 'inconclusive';
  answer: string;
  returnedModel: string | null;
  finishReasons: string[];
  toolCallEvidence: { path: string; value: unknown }[];
  issues: string[];
  responseMode: 'json' | 'sse' | 'unknown';
};
export type ToolChoiceExchange = HttpExchange & ToolChoiceSummary;

// Inspect protocol fields, never prose. Even a partial tool-call delta violates none;
// absence is only a pass after a complete, valid response in the requested mode.
export function assessToolChoice(
  exchange: HttpExchange,
  apiType: ToolChoiceApiType,
  stream: boolean,
): ToolChoiceSummary {
  const result: ToolChoiceSummary = {
    verdict: 'inconclusive',
    answer: '',
    returnedModel: null,
    finishReasons: [],
    toolCallEvidence: [],
    issues: [],
    responseMode: 'unknown',
  };
  const issue = (message: string) => {
    if (!result.issues.includes(message)) result.issues.push(message);
  };
  const requested = parse(exchange.requestBody);
  const requestedNone =
    apiType === 'openai'
      ? requested?.tool_choice === 'none'
      : record(requested?.tool_choice)?.type === 'none';
  const validRequest =
    requestedNone &&
    requested?.stream === stream &&
    Array.isArray(requested?.tools) &&
    requested.tools.length > 0;
  if (!validRequest)
    issue(
      'Captured request does not establish tools with tool_choice none in the selected mode.',
    );
  if (!exchange.captureComplete) issue('Response capture is incomplete.');
  if (exchange.error) issue(exchange.error);
  if (
    exchange.httpStatus === null ||
    exchange.httpStatus < 200 ||
    exchange.httpStatus >= 300
  )
    issue(
      `Provider returned ${exchange.httpStatus === null ? 'no HTTP response' : `HTTP ${exchange.httpStatus}`}.`,
    );

  const evidence = (path: string, value: unknown) =>
    result.toolCallEvidence.push({ path, value });
  const reason = (value: unknown) => {
    if (typeof value === 'string' && !result.finishReasons.includes(value))
      result.finishReasons.push(value);
  };
  const model = (value: unknown) => {
    if (typeof value === 'string') result.returnedModel = value;
  };
  const providerError = (body: RecordValue) => {
    if (body.error != null || body.type === 'error') {
      const error = record(body.error);
      issue(
        `Provider error: ${typeof error?.message === 'string' ? error.message : typeof body.error === 'string' ? body.error : 'see raw response'}`,
      );
    }
  };
  const chatCalls = (message: RecordValue, path: string) => {
    if (message.tool_calls != null) {
      if (!Array.isArray(message.tool_calls))
        issue('Malformed tool_calls field.');
      else
        message.tool_calls.forEach((call, index) => {
          const c = record(call);
          if (
            c &&
            (typeof c.type === 'string' ||
              typeof c.id === 'string' ||
              record(c.function) ||
              record(c.custom) ||
              Number.isInteger(c.index))
          )
            evidence(`${path}.tool_calls[${index}]`, call);
          else issue('Malformed tool-call entry.');
        });
    }
    if (message.function_call != null) {
      const call = record(message.function_call);
      if (
        call &&
        (typeof call.name === 'string' || typeof call.arguments === 'string')
      )
        evidence(`${path}.function_call`, call);
      else issue('Malformed legacy function_call field.');
    }
    if (message.refusal)
      issue('Provider refused the prompt; compliance was not fully tested.');
  };
  const block = (value: unknown, path: string) => {
    const b = record(value);
    if (!b) {
      issue('Malformed content block.');
      return;
    }
    if (b.type === 'tool_use' || b.type === 'server_tool_use')
      evidence(path, b);
    if (b.type === 'text' && typeof b.text === 'string')
      result.answer += b.text;
    if (b.type === 'refusal')
      issue('Provider refused the prompt; compliance was not fully tested.');
  };
  const inspectJson = (body: RecordValue) => {
    providerError(body);
    model(body.model);
    if (apiType === 'openai') {
      if (
        body.object !== 'chat.completion' ||
        !Array.isArray(body.choices) ||
        body.choices.length !== 1
      )
        issue('Response does not match the requested Chat Completions format.');
      for (const [i, value] of (Array.isArray(body.choices)
        ? body.choices
        : []
      ).entries()) {
        const choice = record(value);
        const message = record(choice?.message);
        if (!message || message.role !== 'assistant')
          issue('Missing assistant response.');
        if (message) {
          chatCalls(message, `choices[${i}].message`);
          if (typeof message.content === 'string')
            result.answer += message.content;
        }
        reason(choice?.finish_reason);
        if (choice?.finish_reason !== 'stop')
          issue(
            `Unexpected finish reason for none (${typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'missing or invalid finish reason'}).`,
          );
      }
    } else {
      if (
        body.type !== 'message' ||
        body.role !== 'assistant' ||
        !Array.isArray(body.content)
      )
        issue('Response does not match the requested Messages format.');
      (Array.isArray(body.content) ? body.content : []).forEach((value, i) =>
        block(value, `content[${i}]`),
      );
      reason(body.stop_reason);
      if (body.stop_reason !== 'end_turn')
        issue(
          `Unexpected finish reason for none (${typeof body.stop_reason === 'string' ? body.stop_reason : 'missing or invalid stop reason'}).`,
        );
    }
  };

  const raw = exchange.rawResponse
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const json = parse(raw);
  if (json) {
    result.responseMode = 'json';
    inspectJson(json);
    if (stream)
      issue(
        'Streaming was requested, but the provider returned JSON; streaming compliance is unverified.',
      );
  } else if (/^data:/m.test(raw)) {
    result.responseMode = 'sse';
    if (!stream)
      issue(
        'Non-streaming was requested, but the provider returned an event stream.',
      );
    let ended = false;
    let started = false;
    let chatChunks = 0;
    let finished = false;
    const openBlocks = new Set<number>();
    const frames = raw.split('\n\n');
    for (const [frameIndex, frame] of frames.entries()) {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      if (frameIndex === frames.length - 1 && frame.trim())
        issue('The last stream event is incomplete.');
      if (ended) issue('Data arrived after the stream completion signal.');
      if (data === '[DONE]') {
        if (apiType === 'openai') ended = true;
        else
          issue(
            'Unexpected Chat Completions completion signal in Messages stream.',
          );
        continue;
      }
      const event = parse(data);
      if (!event) {
        issue('Invalid JSON in the event stream.');
        continue;
      }
      providerError(event);
      if (apiType === 'openai') {
        if (
          event.object !== 'chat.completion.chunk' ||
          !Array.isArray(event.choices)
        )
          issue('Event does not match the requested Chat Completions stream.');
        model(event.model);
        for (const [i, value] of (Array.isArray(event.choices)
          ? event.choices
          : []
        ).entries()) {
          const choice = record(value);
          const delta = record(choice?.delta);
          if (choice?.index !== 0 || !delta)
            issue('Invalid completion choice in stream.');
          if (delta) {
            chatChunks++;
            chatCalls(delta, `event[${frameIndex}].choices[${i}].delta`);
            if (typeof delta.content === 'string')
              result.answer += delta.content;
          }
          reason(choice?.finish_reason);
          if (
            [
              'stop',
              'tool_calls',
              'function_call',
              'length',
              'content_filter',
            ].includes(String(choice?.finish_reason))
          )
            finished = true;
          if (choice?.finish_reason != null && choice.finish_reason !== 'stop')
            issue(
              `Unexpected stream finish reason for none (${typeof choice.finish_reason === 'string' ? choice.finish_reason : 'invalid finish reason'}).`,
            );
        }
      } else {
        if (event.type === 'message_start') {
          const message = record(event.message);
          if (
            started ||
            message?.type !== 'message' ||
            message?.role !== 'assistant'
          )
            issue('Invalid message_start event.');
          started = true;
          model(message?.model);
          if (Array.isArray(message?.content))
            message.content.forEach((b, i) =>
              block(b, `event[${frameIndex}].message.content[${i}]`),
            );
        } else if (event.type === 'content_block_start') {
          if (
            !started ||
            !Number.isInteger(event.index) ||
            openBlocks.has(Number(event.index))
          )
            issue('Invalid content block start.');
          openBlocks.add(Number(event.index));
          block(event.content_block, `event[${frameIndex}].content_block`);
        } else if (event.type === 'content_block_delta') {
          const delta = record(event.delta);
          if (!started || !openBlocks.has(Number(event.index)) || !delta)
            issue('Content delta without an open block.');
          if (delta?.type === 'text_delta' && typeof delta.text === 'string')
            result.answer += delta.text;
          if (delta?.type === 'input_json_delta')
            evidence(`event[${frameIndex}].delta`, delta);
        } else if (event.type === 'content_block_stop') {
          if (!openBlocks.delete(Number(event.index)))
            issue('Content block stop without a matching start.');
        } else if (event.type === 'message_delta') {
          const delta = record(event.delta);
          reason(delta?.stop_reason);
          if (
            [
              'end_turn',
              'tool_use',
              'max_tokens',
              'stop_sequence',
              'refusal',
              'pause_turn',
            ].includes(String(delta?.stop_reason))
          )
            finished = true;
          if (delta?.stop_reason != null && delta.stop_reason !== 'end_turn')
            issue(
              `Unexpected stream finish reason for none (${typeof delta.stop_reason === 'string' ? delta.stop_reason : 'invalid stop reason'}).`,
            );
        } else if (event.type === 'message_stop') {
          ended = true;
        } else if (!['ping', 'error'].includes(String(event.type)))
          issue('Unrecognized Messages stream event.');
      }
    }
    if (
      !ended ||
      !finished ||
      (apiType === 'openai' ? !chatChunks : !started || openBlocks.size > 0)
    )
      issue('Stream completion was not confirmed.');
  } else issue('Response is neither valid JSON nor a recognized event stream.');

  if (!result.answer.trim() && !result.toolCallEvidence.length)
    issue('No answer text returned.');
  result.verdict =
    validRequest && result.toolCallEvidence.length
      ? 'fail'
      : result.issues.length
        ? 'inconclusive'
        : 'pass';
  return result;
}
