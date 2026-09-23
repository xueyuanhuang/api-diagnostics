export const ENDPOINTS = {
  messages: { label: 'Messages', path: '/v1/messages' },
  chat: { label: 'Chat Completions', path: '/v1/chat/completions' },
  responses: { label: 'Responses', path: '/v1/responses' },
} as const;
export type EndpointProtocol = keyof typeof ENDPOINTS;
export type EndpointSelection = EndpointProtocol | 'all';
export const ENDPOINT_CASES = {
  ok: { label: 'OK', prompt: '只回复 OK。', expected: 'OK', maxTokens: 4096 },
} as const;
export type EndpointCase = keyof typeof ENDPOINT_CASES;
export type EndpointTask = {
  protocol: EndpointProtocol;
  caseId: EndpointCase;
  repeat: number;
};
export const ENDPOINT_TIMEOUT_MS = 120_000;

export function isEndpointProtocol(value: unknown): value is EndpointProtocol {
  return typeof value === 'string' && Object.hasOwn(ENDPOINTS, value);
}
export function isEndpointCase(value: unknown): value is EndpointCase {
  return typeof value === 'string' && Object.hasOwn(ENDPOINT_CASES, value);
}

// Accept a provider root, /v1, or any of the three complete endpoints.
export function endpointCheckUrl(baseUrl: string, protocol: EndpointProtocol) {
  const url = new URL(baseUrl);
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(?:messages|chat\/completions|responses)$/, '');
  url.pathname = `${path.endsWith('/v1') ? path.slice(0, -3) : path}${ENDPOINTS[protocol].path}`;
  return url.href;
}

export function endpointRequestBody(
  protocol: EndpointProtocol,
  model: string,
  caseId: EndpointCase,
) {
  const sample = ENDPOINT_CASES[caseId];
  if (protocol === 'responses')
    return {
      model,
      max_output_tokens: sample.maxTokens,
      store: false,
      stream: false,
      input: sample.prompt,
    };
  return {
    model,
    ...(protocol === 'messages'
      ? { max_tokens: sample.maxTokens }
      : { max_completion_tokens: sample.maxTokens }),
    stream: false,
    messages: [{ role: 'user', content: sample.prompt }],
  };
}

export function endpointPlan(selection: EndpointSelection): EndpointTask[] {
  if (selection !== 'all' && !isEndpointProtocol(selection))
    throw new Error('Invalid endpoint selection.');
  const protocols =
    selection === 'all'
      ? (Object.keys(ENDPOINTS) as EndpointProtocol[])
      : [selection];
  return protocols.map((protocol) => ({ protocol, caseId: 'ok', repeat: 1 }));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
export type EndpointUsage = {
  totalInput: number | null;
  uncachedInput: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  total: number | null;
};

export function normalizeEndpointUsage(
  protocol: EndpointProtocol,
  raw: unknown,
): EndpointUsage {
  const u = record(raw);
  const input = count(protocol === 'chat' ? u?.prompt_tokens : u?.input_tokens);
  const output = count(
    protocol === 'chat' ? u?.completion_tokens : u?.output_tokens,
  );
  const cacheRead = count(
    protocol === 'messages'
      ? u?.cache_read_input_tokens
      : record(
          protocol === 'chat'
            ? u?.prompt_tokens_details
            : u?.input_tokens_details,
        )?.cached_tokens,
  );
  const cacheWrite = count(
    protocol === 'messages' ? u?.cache_creation_input_tokens : undefined,
  );
  // Anthropic cache fields are optional additions. OpenAI input counters already include cache hits.
  const invalidCache =
    protocol === 'messages' &&
    ((u?.cache_read_input_tokens != null && cacheRead === null) ||
      (u?.cache_creation_input_tokens != null && cacheWrite === null));
  const totalInput =
    input === null || invalidCache
      ? null
      : protocol === 'messages'
        ? input + (cacheRead ?? 0) + (cacheWrite ?? 0)
        : input;
  return {
    totalInput,
    output,
    cacheRead,
    cacheWrite,
    uncachedInput:
      protocol === 'messages'
        ? input
        : input !== null && cacheRead !== null && cacheRead <= input
          ? input - cacheRead
          : null,
    total: totalInput !== null && output !== null ? totalInput + output : null,
  };
}

export type EndpointSummary = {
  answer: string;
  returnedModel: string | null;
  finishReason: string | null;
  issues: string[];
  warnings: string[];
  usage: EndpointUsage;
  rawUsage: unknown;
};
export function summarizeEndpointResponse(
  raw: string,
  protocol: EndpointProtocol,
  caseId: EndpointCase,
): EndpointSummary {
  let body: Record<string, unknown> | null = null;
  try {
    body = record(JSON.parse(raw));
  } catch {
    /* Preserve invalid text in the capture. */
  }
  const result: EndpointSummary = {
    answer: '',
    returnedModel: typeof body?.model === 'string' ? body.model : null,
    finishReason: null,
    issues: [],
    warnings: [],
    rawUsage: body?.usage ?? null,
    usage: normalizeEndpointUsage(protocol, body?.usage),
  };
  if (!body) {
    result.issues.push('Response is not a JSON object.');
    return result;
  }
  if (body.error != null) {
    const error = record(body.error);
    result.issues.push(
      `Provider error: ${typeof error?.message === 'string' ? error.message : typeof body.error === 'string' ? body.error : 'see raw response'}`,
    );
  }
  if (protocol === 'messages') {
    if (
      body.type !== 'message' ||
      body.role !== 'assistant' ||
      !Array.isArray(body.content)
    )
      result.issues.push('Response does not match the Messages format.');
    const blocks = Array.isArray(body.content) ? body.content.map(record) : [];
    result.answer = blocks
      .filter((b) => b?.type === 'text')
      .map((b) => (typeof b?.text === 'string' ? b.text : ''))
      .join('\n');
    result.finishReason =
      typeof body.stop_reason === 'string' ? body.stop_reason : null;
    if (result.finishReason !== 'end_turn')
      result.issues.push('Messages did not finish with end_turn.');
    if (
      blocks.some(
        (b) => b?.type === 'tool_use' || b?.type === 'server_tool_use',
      )
    )
      result.issues.push('Unexpected tool call in a request without tools.');
  } else if (protocol === 'chat') {
    const choices = Array.isArray(body.choices) ? body.choices.map(record) : [];
    const message = record(choices[0]?.message);
    if (
      body.object !== 'chat.completion' ||
      choices.length !== 1 ||
      message?.role !== 'assistant'
    )
      result.issues.push(
        'Response does not match the Chat Completions format.',
      );
    result.answer = typeof message?.content === 'string' ? message.content : '';
    result.finishReason =
      typeof choices[0]?.finish_reason === 'string'
        ? choices[0].finish_reason
        : null;
    if (result.finishReason !== 'stop')
      result.issues.push('Chat Completions did not finish with stop.');
    if (message?.refusal) result.issues.push('Provider refused the prompt.');
    if (
      message?.function_call != null ||
      (message?.tool_calls != null &&
        (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0))
    )
      result.issues.push('Unexpected tool call in a request without tools.');
  } else {
    if (body.object !== 'response' || !Array.isArray(body.output))
      result.issues.push('Response does not match the Responses format.');
    result.finishReason = typeof body.status === 'string' ? body.status : null;
    if (body.status !== 'completed' || body.incomplete_details != null)
      result.issues.push('Responses did not complete successfully.');
    const output = Array.isArray(body.output) ? body.output.map(record) : [];
    const messages = output.filter((item) => item?.type === 'message');
    if (
      !messages.length ||
      messages.some(
        (item) =>
          item?.role !== 'assistant' ||
          item.status !== 'completed' ||
          !Array.isArray(item.content),
      )
    )
      result.issues.push('Missing or incomplete assistant output message.');
    const content = messages.flatMap((item) =>
      Array.isArray(item?.content) ? item.content.map(record) : [],
    );
    result.answer = content
      .filter((b) => b?.type === 'output_text')
      .map((b) => (typeof b?.text === 'string' ? b.text : ''))
      .join('\n');
    if (content.some((b) => b?.type === 'refusal'))
      result.issues.push('Provider refused the prompt.');
    if (
      output.some(
        (item) => !['message', 'reasoning'].includes(String(item?.type)),
      )
    )
      result.issues.push('Unexpected output item in a request without tools.');
  }
  if (result.answer.trim() !== ENDPOINT_CASES[caseId].expected)
    result.issues.push(
      `Expected exactly ${ENDPOINT_CASES[caseId].expected}; received ${result.answer.trim() ? 'a different answer' : 'no answer text'}.`,
    );
  const { totalInput, output, cacheRead, cacheWrite } = result.usage;
  const usage = record(body.usage);
  const cacheFields =
    protocol === 'messages'
      ? ['cache_read_input_tokens', 'cache_creation_input_tokens']
      : ['cached_tokens'];
  const detailsField =
    protocol === 'chat' ? 'prompt_tokens_details' : 'input_tokens_details';
  const cacheContainer =
    protocol === 'messages' ? usage : record(usage?.[detailsField]);
  if (
    (protocol !== 'messages' &&
      usage?.[detailsField] != null &&
      !cacheContainer) ||
    cacheFields.some(
      (field) =>
        cacheContainer &&
        Object.hasOwn(cacheContainer, field) &&
        count(cacheContainer[field]) === null,
    )
  )
    result.warnings.push(
      'A reported cache counter is invalid; inspect the original usage fields.',
    );
  if (totalInput === null || output === null)
    result.warnings.push('Input or output token usage is missing or invalid.');
  if (totalInput !== null && totalInput > 1000)
    result.warnings.push(
      'More than 1,000 input tokens reported for this short prompt.',
    );
  if ((cacheRead ?? 0) > 0 || (cacheWrite ?? 0) > 0)
    result.warnings.push(
      'Cache usage reported without explicit caching in this request.',
    );
  if (
    protocol !== 'messages' &&
    cacheRead !== null &&
    totalInput !== null &&
    cacheRead > totalInput
  )
    result.warnings.push('Cached tokens exceed the reported total input.');
  return result;
}

export async function runEndpointRequests<T>(options: {
  tasks: EndpointTask[];
  signal: AbortSignal;
  request: (task: EndpointTask, signal: AbortSignal) => Promise<T>;
  onStart: (index: number) => void;
  onResult: (index: number, result: T | null, error: string | null) => void;
}) {
  await Promise.all(
    options.tasks.map(async (task, index) => {
      if (options.signal.aborted) return;
      options.onStart(index);
      try {
        options.onResult(
          index,
          await options.request(task, options.signal),
          null,
        );
      } catch {
        if (options.signal.aborted) return;
        options.onResult(
          index,
          null,
          'The relay request failed. No provider exchange was captured.',
        );
      }
    }),
  );
}
