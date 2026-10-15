import type { HttpExchange } from './http-exchange';

export const TPM_WINDOW_MS = 60_000;
export const TPM_TIMEOUT_MS = 45_000;
export const TPM_MAX_REQUESTS = 30;
export const TPM_CONCURRENCY = 5;
export const TPM_WORKLOADS = {
  input: { label: 'Input-heavy', characters: 16_000, outputLimit: 128 },
  output: { label: 'Output-heavy', characters: 0, outputLimit: 2048 },
  balanced: { label: 'Balanced', characters: 4000, outputLimit: 1024 },
} as const;
export type TpmWorkload = keyof typeof TPM_WORKLOADS;
export const isTpmWorkload = (value: unknown): value is TpmWorkload =>
  typeof value === 'string' && Object.hasOwn(TPM_WORKLOADS, value);

export function tpmRequestBody(
  apiType: 'openai' | 'anthropic',
  model: string,
  workload: TpmWorkload,
  nonce: string,
) {
  const config = TPM_WORKLOADS[workload];
  // Put a unique marker first to reduce shared-prefix caching; actual cache usage
  // is still measured, never assumed to be zero.
  const context =
    'A coastal city is planning public transport, energy storage, libraries, parks, flood protection, and accessible housing. Each plan needs a budget, a schedule, and a way to measure its results. ';
  const prompt = `Measurement ${nonce}.\n${context.repeat(Math.ceil(config.characters / context.length)).slice(0, config.characters)}\n${workload === 'input' ? 'Read the planning notes and reply with one short sentence summarizing their purpose.' : 'Write a detailed, original planning guide for a coastal city. Include concrete examples, tradeoffs, and implementation steps for transport, energy, libraries, parks, flood protection, and housing. Aim for at least 2000 words. Continue until the response limit; do not summarize early.'}`;
  return {
    model,
    stream: false,
    messages: [{ role: 'user', content: prompt }],
    ...(apiType === 'openai'
      ? { max_completion_tokens: config.outputLimit }
      : { max_tokens: config.outputLimit }),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
const tokenCount = (n: unknown) =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
export type TpmAssessment = {
  success: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  limitKind: 'token' | 'request' | 'quota' | 'unspecified' | null;
  finishReason: string | null;
  issues: string[];
};
export type TpmExchange = HttpExchange & TpmAssessment;

export function assessTpm(
  exchange: HttpExchange,
  apiType: 'openai' | 'anthropic',
): TpmAssessment {
  let body: Record<string, unknown> | null = null;
  try {
    body = object(JSON.parse(exchange.rawResponse));
  } catch {
    /* Kept as raw evidence. */
  }
  const usage = object(body?.usage);
  const error = object(body?.error);
  const message = [
    error?.message,
    error?.code,
    error?.type,
    object(error?.details)?.error_code,
  ]
    .filter((v) => typeof v === 'string')
    .join(' ');
  const first = Array.isArray(body?.choices) ? object(body.choices[0]) : null;
  const finish =
    apiType === 'openai' ? first?.finish_reason : body?.stop_reason;
  const finishReason = typeof finish === 'string' ? finish : null;
  const issues: string[] = [];
  if (exchange.error) issues.push(exchange.error);
  if (!exchange.captureComplete) issues.push('Incomplete response capture.');
  if (
    !exchange.httpStatus ||
    exchange.httpStatus < 200 ||
    exchange.httpStatus >= 300
  )
    issues.push(`HTTP ${exchange.httpStatus ?? 'unknown'}.`);
  if (!body) issues.push('Response is not a JSON object.');
  if (body?.error || body?.type === 'error')
    issues.push(message || 'Provider returned an error inside the response.');
  const validShape =
    apiType === 'openai'
      ? object(first?.message) !== null
      : body?.type === 'message' && Array.isArray(body.content);
  if (
    !validShape ||
    !(
      apiType === 'openai'
        ? ['stop', 'length']
        : ['end_turn', 'max_tokens', 'stop_sequence']
    ).includes(finishReason ?? '')
  )
    issues.push('Expected a completed text-generation response.');
  const cacheReadTokens =
    apiType === 'openai'
      ? tokenCount(object(usage?.prompt_tokens_details)?.cached_tokens)
      : tokenCount(usage?.cache_read_input_tokens);
  const cacheWriteTokens =
    apiType === 'anthropic'
      ? tokenCount(usage?.cache_creation_input_tokens)
      : null;
  const rawInput = tokenCount(
    apiType === 'openai' ? usage?.prompt_tokens : usage?.input_tokens,
  );
  // Anthropic cache counts are additive; OpenAI cached counts are a subset.
  let inputTokens =
    rawInput === null
      ? null
      : rawInput +
        (apiType === 'anthropic'
          ? (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
          : 0);
  let outputTokens = tokenCount(
    apiType === 'openai' ? usage?.completion_tokens : usage?.output_tokens,
  );
  const reasoningTokens = tokenCount(
    object(usage?.completion_tokens_details)?.reasoning_tokens,
  );
  if (
    (apiType === 'anthropic' &&
      ((usage?.cache_read_input_tokens != null && cacheReadTokens === null) ||
        (usage?.cache_creation_input_tokens != null &&
          cacheWriteTokens === null))) ||
    (cacheReadTokens !== null &&
      inputTokens !== null &&
      cacheReadTokens > inputTokens)
  )
    inputTokens = null;
  if (
    reasoningTokens !== null &&
    outputTokens !== null &&
    reasoningTokens > outputTokens
  )
    outputTokens = null;
  if (inputTokens === null || outputTokens === null)
    issues.push(
      'Token usage is missing or invalid; unreported tokens are not treated as zero.',
    );
  let limitKind: TpmAssessment['limitKind'] = null;
  // A 429 is not automatically a TPM limit. Classify only explicit provider evidence.
  if (
    exchange.httpStatus === 429 ||
    /rate_limit|quota|spend_limit/i.test(message)
  ) {
    limitKind = /insufficient_quota|billing|credit|spend|monthly|balance/i.test(
      message,
    )
      ? 'quota'
      : /tokens? per min|\b[io]?tpm\b|token.{0,25}(rate|limit)|rate.{0,25}token/i.test(
            message,
          )
        ? 'token'
        : /requests? per min|\brpm\b|request.{0,25}rate/i.test(message)
          ? 'request'
          : 'unspecified';
  }
  // Successful transport and protocol can coexist with missing usage.
  const success = !issues.some((issue) => !issue.startsWith('Token usage'));
  return {
    success,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    limitKind,
    finishReason,
    issues,
  };
}

export type TpmRow = {
  sequence: number;
  status: 'running' | 'pass' | 'issue' | 'stopped';
  exchange: TpmExchange | null;
  error: string | null;
};
export type TpmMeasurement = {
  workload: TpmWorkload;
  elapsedMs: number;
  stopReason: 'window' | 'budget' | 'provider' | 'tester' | 'cancelled' | null;
  finished: boolean;
  rows: TpmRow[];
};
export function tpmMetrics(run: TpmMeasurement) {
  const successes = run.rows.filter((row) => row.exchange?.success);
  const covered = successes.filter(
    (row) =>
      row.exchange?.inputTokens !== null && row.exchange?.outputTokens !== null,
  );
  const input = covered.reduce((n, r) => n + r.exchange!.inputTokens!, 0);
  const output = covered.reduce((n, r) => n + r.exchange!.outputTokens!, 0);
  const rate = (tokens: number) =>
    covered.length && run.elapsedMs > 0
      ? (tokens * 60_000) / run.elapsedMs
      : null;
  return {
    attempts: run.rows.length,
    succeeded: successes.length,
    coverage: covered.length,
    errors: run.rows.filter(
      (row) => row.status === 'issue' && !row.exchange?.success,
    ).length,
    http429: run.rows.filter((row) => row.exchange?.httpStatus === 429).length,
    missingUsage: successes.length - covered.length,
    input,
    output,
    inputTpm: rate(input),
    outputTpm: rate(output),
    totalTpm: rate(input + output),
    cacheRead: covered.reduce(
      (n, r) => n + (r.exchange!.cacheReadTokens ?? 0),
      0,
    ),
    cacheReadReported: covered.filter(
      (r) => r.exchange!.cacheReadTokens !== null,
    ).length,
    tokenLimit: run.rows.some((row) => row.exchange?.limitKind === 'token'),
    limitObserved: run.rows.some(
      (row) =>
        row.exchange?.limitKind !== null &&
        row.exchange?.limitKind !== undefined,
    ),
  };
}
export function tpmVerdict(run: TpmMeasurement) {
  const m = tpmMetrics(run);
  if (!run.finished) return 'Measuring';
  if (m.tokenLimit) return 'Provider reports a token limit';
  if (m.limitObserved) return 'Other or unspecified limit';
  if (
    run.stopReason === 'cancelled' ||
    run.stopReason === 'tester' ||
    m.errors ||
    m.missingUsage ||
    !m.coverage
  )
    return 'Incomplete measurement';
  return 'Measured · limit not reached';
}

// Each request has its own server invocation. Evidence saving never blocks a
// worker. The measured period includes browser/relay overhead and final drain.
export async function runTpmMeasurement(options: {
  workload: TpmWorkload;
  signal: AbortSignal;
  request: (sequence: number) => Promise<TpmExchange>;
  publish: (run: TpmMeasurement) => void;
  now?: () => number;
}) {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const rows: TpmRow[] = [];
  let stopReason: TpmMeasurement['stopReason'] = null;
  const publish = (finished = false) =>
    options.publish({
      workload: options.workload,
      elapsedMs: Math.max(1, now() - started),
      stopReason,
      finished,
      rows: rows.map((r) => ({ ...r })),
    });
  async function worker() {
    while (
      !options.signal.aborted &&
      !stopReason &&
      now() - started < TPM_WINDOW_MS &&
      rows.length < TPM_MAX_REQUESTS
    ) {
      const row: TpmRow = {
        sequence: rows.length + 1,
        status: 'running',
        exchange: null,
        error: null,
      };
      rows.push(row);
      publish();
      try {
        row.exchange = await options.request(row.sequence);
        row.status = row.exchange.success ? 'pass' : 'issue';
        if (
          !row.exchange.success ||
          row.exchange.inputTokens === null ||
          row.exchange.outputTokens === null
        )
          stopReason ??= 'provider';
        if (rows.length >= TPM_MAX_REQUESTS) stopReason ??= 'budget';
        if (now() - started >= TPM_WINDOW_MS) stopReason ??= 'window';
      } catch (error) {
        row.status = options.signal.aborted ? 'stopped' : 'issue';
        row.error =
          error instanceof Error
            ? error.message
            : 'Tester did not capture a provider response.';
        stopReason ??= 'tester';
      }
      publish();
    }
  }
  // First request is part of the measurement and budget, and prevents fanning
  // out an invalid connection/payload. No hidden preflight or automatic retries.
  const first: TpmRow = {
    sequence: 1,
    status: 'running',
    exchange: null,
    error: null,
  };
  if (!options.signal.aborted) {
    rows.push(first);
    publish();
    try {
      first.exchange = await options.request(1);
      first.status = first.exchange.success ? 'pass' : 'issue';
      if (
        !first.exchange.success ||
        first.exchange.inputTokens === null ||
        first.exchange.outputTokens === null
      )
        stopReason = 'provider';
    } catch (error) {
      first.status = options.signal.aborted ? 'stopped' : 'issue';
      first.error =
        error instanceof Error ? error.message : 'Tester request failed.';
      stopReason = 'tester';
    }
    publish();
    if (!stopReason)
      await Promise.all(Array.from({ length: TPM_CONCURRENCY }, worker));
  }
  if (options.signal.aborted) stopReason = 'cancelled';
  stopReason ??= now() - started >= TPM_WINDOW_MS ? 'window' : 'budget';
  publish(true);
}
