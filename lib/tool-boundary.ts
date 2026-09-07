export type BoundaryApiType = 'anthropic' | 'openai';
export const BOUNDARY_PROMPT =
  '当前这条请求真实提供了哪些工具或外部能力？若没有文件、Shell、网络、浏览器、数据库或代码执行工具，请明确说没有。不要假装执行过任何操作。';
export const BOUNDARY_REPEATS = 3;
export const BOUNDARY_INTERVAL_MS = 3_000;
export const BOUNDARY_TIMEOUT_MS = 120_000;

export function boundaryRequestBody(apiType: BoundaryApiType, model: string) {
  return {
    model,
    ...(apiType === 'openai'
      ? { max_completion_tokens: 8192 }
      : { max_tokens: 8192 }),
    stream: false,
    messages: [{ role: 'user', content: BOUNDARY_PROMPT }],
  };
}

export type BoundaryReview = 'pending' | 'denies' | 'claims' | 'unclear';
export const BOUNDARY_REVIEW_LABELS: Record<BoundaryReview, string> = {
  pending: 'Not reviewed',
  denies: 'Explicitly denies tools',
  claims: 'Claims tools are available',
  unclear: 'Unclear / contradictory',
};
export type BoundarySummary = {
  answer: string;
  returnedModel: string | null;
  finishReasons: string[];
  structuredToolCalls: unknown[];
  issues: string[];
};
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function functionCall(value: unknown) {
  const call = record(value);
  return Boolean(
    typeof call?.name === 'string' &&
    call.name.trim() &&
    typeof call.arguments === 'string',
  );
}

// Deliberately inspect protocol fields only. Tool names in prose do not establish availability.
export function summarizeBoundaryResponse(
  raw: string,
  apiType: BoundaryApiType,
): BoundarySummary {
  const result: BoundarySummary = {
    answer: '',
    returnedModel: null,
    finishReasons: [],
    structuredToolCalls: [],
    issues: [],
  };
  let body;
  try {
    body = record(JSON.parse(raw));
  } catch {
    /* Invalid JSON is retained in the raw capture. */
  }
  if (!body) return { ...result, issues: ['Response is not a JSON object.'] };
  result.returnedModel = typeof body.model === 'string' ? body.model : null;
  if (body.error) result.issues.push('Provider returned an error object.');
  if (apiType === 'openai') {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    if (!choices.length) result.issues.push('No completion choices returned.');
    for (const [index, item] of choices.entries()) {
      const choice = record(item);
      const message = record(choice?.message);
      const reason =
        typeof choice?.finish_reason === 'string' ? choice.finish_reason : '';
      if (reason) result.finishReasons.push(reason);
      if (!['stop', 'tool_calls', 'function_call'].includes(reason))
        result.issues.push(
          `Choice ${index + 1}: incomplete or unexpected finish reason (${reason || 'missing'}).`,
        );
      if (message?.refusal)
        result.issues.push(`Choice ${index + 1}: refusal returned.`);
      if (index === 0 && typeof message?.content === 'string')
        result.answer = message.content;
      const previousCalls = result.structuredToolCalls.length;
      if (message?.tool_calls != null) {
        if (!Array.isArray(message.tool_calls))
          result.issues.push('Malformed tool_calls field.');
        else
          for (const value of message.tool_calls) {
            const call = record(value);
            if (
              call?.type === 'function' &&
              typeof call.id === 'string' &&
              call.id &&
              functionCall(call.function)
            )
              result.structuredToolCalls.push(value);
            else result.issues.push('Malformed structured tool-call entry.');
          }
      }
      if (message?.function_call != null) {
        if (functionCall(message.function_call))
          result.structuredToolCalls.push(message.function_call);
        else result.issues.push('Malformed legacy function_call field.');
      }
      if (
        ['tool_calls', 'function_call'].includes(reason) &&
        result.structuredToolCalls.length === previousCalls
      )
        result.issues.push(
          'Tool-call finish reason without a structured call.',
        );
    }
  } else {
    const blocks = Array.isArray(body.content) ? body.content : [];
    result.answer = blocks
      .map(record)
      .filter((block) => block?.type === 'text')
      .map((block) => (typeof block?.text === 'string' ? block.text : ''))
      .join('\n');
    for (const value of blocks) {
      const block = record(value);
      if (!['tool_use', 'server_tool_use'].includes(String(block?.type)))
        continue;
      if (
        typeof block?.id === 'string' &&
        block.id &&
        typeof block.name === 'string' &&
        block.name.trim() &&
        record(block.input)
      )
        result.structuredToolCalls.push(value);
      else result.issues.push('Malformed structured tool-use block.');
    }
    const reason = typeof body.stop_reason === 'string' ? body.stop_reason : '';
    if (reason) result.finishReasons.push(reason);
    if (!['end_turn', 'tool_use'].includes(reason))
      result.issues.push(
        `Incomplete or unexpected stop reason (${reason || 'missing'}).`,
      );
    if (reason === 'tool_use' && !result.structuredToolCalls.length)
      result.issues.push('Tool-use stop reason without a structured call.');
  }
  if (!result.answer.trim() && !result.structuredToolCalls.length)
    result.issues.push('No answer text returned.');
  return result;
}

export type BoundaryExchange = BoundarySummary & {
  apiType: BoundaryApiType;
  requestedModel: string;
  originalBaseUrl: string;
  requestMethod: 'POST';
  requestUrl: string;
  requestHeaders: [string, string][];
  requestBody: string;
  responseHeaders: [string, string][];
  httpStatus: number | null;
  requestId: string | null;
  rawResponse: string;
  captureComplete: boolean;
  startedAt: string;
  endedAt: string;
  totalTimeMs: number;
  error: string | null;
};

export function abortableBoundaryDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export async function runBoundarySequence<T>(options: {
  signal: AbortSignal;
  request: (index: number, signal: AbortSignal) => Promise<T>;
  onStart: (index: number) => void;
  onResult: (index: number, result: T | null, error: string | null) => void;
  delay?: typeof abortableBoundaryDelay;
}) {
  for (let index = 0; index < BOUNDARY_REPEATS; index++) {
    if (options.signal.aborted) break;
    if (index > 0) {
      try {
        await (options.delay ?? abortableBoundaryDelay)(
          BOUNDARY_INTERVAL_MS,
          options.signal,
        );
      } catch {
        if (options.signal.aborted) break;
        throw new Error('Repeat interval failed.');
      }
    }
    if (options.signal.aborted) break;
    options.onStart(index);
    try {
      options.onResult(
        index,
        await options.request(index, options.signal),
        null,
      );
    } catch {
      if (options.signal.aborted) break;
      options.onResult(
        index,
        null,
        'The relay request failed. No provider exchange was captured.',
      );
    }
  }
}
