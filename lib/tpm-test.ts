import type { HttpExchange } from './http-exchange';
import { tpmCooldownMs, tpmLimitHeaders } from './tpm-limits';

export const TPM_WINDOW_MS = 180_000;
export const TPM_TIMEOUT_MS = 45_000;
export const TPM_MAX_REQUESTS = 120;
export const TPM_TOKEN_BUDGET = 250_000;
export const TPM_LEVELS = [2, 5, 10, 20] as const;
export const TPM_STAGE_MS = 15_000;
export const TPM_MAX_COOLDOWN_MS = 60_000;
export const tpmStageBudget = (concurrency: number) =>
  Math.max(8, concurrency * 2);
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
  limitKind:
    | 'token'
    | 'request'
    | 'quota'
    | 'concurrency'
    | 'acceleration'
    | 'unspecified'
    | null;
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
      : /slow_down|acceleration|ramp.rate|increas.{0,20}(quick|fast)/i.test(
            message,
          )
        ? 'acceleration'
        : /concurren|simultaneous|in.flight/i.test(message)
          ? 'concurrency'
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
  // Stage zero is the connection/warm-up check, excluded from adaptive rates.
  stage?: number;
};
export type TpmStop =
  | 'complete'
  | 'window'
  | 'budget'
  | 'token-budget'
  | 'provider'
  | 'tester'
  | 'cancelled';
export type TpmStage = {
  id: number;
  kind: 'load' | 'confirmation';
  concurrency: number;
  startedMs: number;
  elapsedMs: number;
  peakPending: number;
  finished: boolean;
  stopReason: TpmStop | null;
};
export type TpmMeasurement = {
  workload: TpmWorkload;
  elapsedMs: number;
  stopReason: TpmStop | null;
  finished: boolean;
  rows: TpmRow[];
  method?: 'adaptive-v2';
  stages?: TpmStage[];
  phase?: 'check' | 'load' | 'cooldown' | 'confirmation' | 'finished';
  confirmationNote?: string;
  cooldownUntil?: number | null;
  reservedTokens?: number;
};

function rowMetrics(rows: TpmRow[], elapsedMs: number) {
  const successes = rows.filter((row) => row.exchange?.success);
  const covered = successes.filter(
    (row) =>
      row.exchange?.inputTokens != null && row.exchange?.outputTokens != null,
  );
  const input = covered.reduce((n, r) => n + r.exchange!.inputTokens!, 0);
  const output = covered.reduce((n, r) => n + r.exchange!.outputTokens!, 0);
  const rate = (tokens: number) =>
    covered.length && elapsedMs > 0 ? (tokens * 60_000) / elapsedMs : null;
  const cacheRows = covered.filter((r) => r.exchange!.cacheReadTokens !== null);
  const uncached = cacheRows.reduce(
    (n, r) => n + r.exchange!.inputTokens! - r.exchange!.cacheReadTokens!,
    0,
  );
  return {
    attempts: rows.length,
    succeeded: successes.length,
    coverage: covered.length,
    errors: rows.filter((r) => r.status === 'issue' && !r.exchange?.success)
      .length,
    http429: rows.filter((r) => r.exchange?.httpStatus === 429).length,
    missingUsage: successes.length - covered.length,
    input,
    output,
    inputTpm: rate(input),
    outputTpm: rate(output),
    totalTpm: rate(input + output),
    cacheRead: cacheRows.reduce((n, r) => n + r.exchange!.cacheReadTokens!, 0),
    cacheWrite: covered.reduce(
      (n, r) => n + (r.exchange!.cacheWriteTokens ?? 0),
      0,
    ),
    cacheWriteReported: covered.filter(
      (r) => r.exchange!.cacheWriteTokens !== null,
    ).length,
    cacheReadReported: cacheRows.length,
    // Unknown cache usage never becomes zero uncached tokens.
    uncachedInputTpm:
      cacheRows.length && elapsedMs > 0
        ? (uncached * 60_000) / elapsedMs
        : null,
    tokenLimit: rows.some((r) => r.exchange?.limitKind === 'token'),
    limitObserved: rows.some((r) => r.exchange?.limitKind != null),
  };
}
export function tpmStageMetrics(run: TpmMeasurement) {
  return (run.stages ?? []).map((stage) => {
    const rows = run.rows.filter((r) => r.stage === stage.id);
    const metrics = rowMetrics(rows, stage.elapsedMs);
    return {
      ...stage,
      ...metrics,
      clean:
        stage.finished &&
        stage.stopReason === 'complete' &&
        metrics.coverage === rows.length &&
        rows.length >= stage.concurrency &&
        !rows.some((r) => r.status !== 'pass'),
    };
  });
}
export function tpmMetrics(run: TpmMeasurement) {
  const adaptive = run.method === 'adaptive-v2';
  const stages = tpmStageMetrics(run);
  const measuredMs = adaptive
    ? stages.reduce((n, s) => n + s.elapsedMs, 0)
    : run.elapsedMs;
  const rows = adaptive ? run.rows.filter((r) => (r.stage ?? 0) > 0) : run.rows;
  const measured = rowMetrics(rows, measuredMs);
  const all = rowMetrics(run.rows, run.elapsedMs);
  const key =
    run.workload === 'input'
      ? 'inputTpm'
      : run.workload === 'output'
        ? 'outputTpm'
        : 'totalTpm';
  const best = stages
    .filter((s) => s.clean && s.kind === 'load')
    .sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0))[0];
  const confirmation = stages.find((s) => s.kind === 'confirmation');
  const verification = !confirmation
    ? 'not-run'
    : !confirmation.finished
      ? 'running'
      : confirmation.tokenLimit
        ? 'repeated'
        : confirmation.clean
          ? 'not-repeated'
          : 'inconclusive';
  return {
    ...measured,
    attempts: all.attempts,
    errors: all.errors,
    http429: all.http429,
    tokenLimit: all.tokenLimit,
    limitObserved: all.limitObserved,
    totalSucceeded: all.succeeded,
    measuredMs,
    verification,
    best: best
      ? {
          concurrency: best.concurrency,
          inputTpm: best.inputTpm,
          outputTpm: best.outputTpm,
          totalTpm: best.totalTpm,
          elapsedMs: best.elapsedMs,
        }
      : null,
    reportedLimits: run.rows.flatMap((r) =>
      r.exchange
        ? tpmLimitHeaders(r.exchange).map((h) => ({
            ...h,
            sequence: r.sequence,
          }))
        : [],
    ),
  };
}
export function tpmVerdict(run: TpmMeasurement) {
  const m = tpmMetrics(run);
  if (!run.finished)
    return run.phase === 'cooldown'
      ? 'Waiting for provider cooldown'
      : 'Measuring';
  if (m.verification === 'repeated')
    return 'Token throttling repeated after cooldown';
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

const waitForCooldown = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Stopped'));
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(new Error('Stopped'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });

// Separate invocations avoid a per-invocation subrequest ceiling. A stage drains
// before the next starts. Saving is outside the load loop; no failed-call replay.
export async function runTpmMeasurement(options: {
  workload: TpmWorkload;
  signal: AbortSignal;
  request: (sequence: number) => Promise<TpmExchange>;
  publish: (run: TpmMeasurement) => void;
  now?: () => number;
  wallNow?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? Date.now;
  const started = now();
  const rows: TpmRow[] = [];
  const stages: TpmStage[] = [];
  const receivedAt = new Map<number, number>();
  let stopReason: TpmStop | null = null;
  let phase: TpmMeasurement['phase'] = 'check';
  let confirmationNote = '';
  let cooldownUntil: number | null = null;
  let reservedTokens = 0;
  let perRequestReservation = 0;
  const elapsed = () => Math.max(1, now() - started);
  const publish = (finished = false) =>
    options.publish({
      method: 'adaptive-v2',
      workload: options.workload,
      elapsedMs: elapsed(),
      stopReason,
      finished,
      phase: finished ? 'finished' : phase,
      confirmationNote,
      cooldownUntil,
      reservedTokens,
      rows: rows.map((r) => ({ ...r })),
      stages: stages.map((s) => ({ ...s })),
    });
  const guard = (): TpmStop | null =>
    options.signal.aborted
      ? 'cancelled'
      : elapsed() >= TPM_WINDOW_MS
        ? 'window'
        : rows.length >= TPM_MAX_REQUESTS
          ? 'budget'
          : reservedTokens + perRequestReservation > TPM_TOKEN_BUDGET
            ? 'token-budget'
            : null;

  async function send(stage: number) {
    const row: TpmRow = {
      sequence: rows.length + 1,
      stage,
      status: 'running',
      exchange: null,
      error: null,
    };
    rows.push(row);
    reservedTokens += perRequestReservation;
    publish();
    try {
      row.exchange = await options.request(row.sequence);
      receivedAt.set(row.sequence, now());
      row.status = row.exchange.success ? 'pass' : 'issue';
    } catch (error) {
      row.status = options.signal.aborted ? 'stopped' : 'issue';
      row.error =
        error instanceof Error
          ? error.message
          : 'Tester did not capture a provider response.';
    }
    publish();
    return row;
  }
  const failure = (row: TpmRow): TpmStop | null =>
    options.signal.aborted
      ? 'cancelled'
      : !row.exchange || row.exchange.httpStatus === null
        ? 'tester'
        : !row.exchange.success ||
            row.exchange.inputTokens === null ||
            row.exchange.outputTokens === null
          ? 'provider'
          : null;

  async function runStage(concurrency: number, kind: TpmStage['kind']) {
    phase = kind === 'load' ? 'load' : 'confirmation';
    const stage: TpmStage = {
      id: stages.length + 1,
      kind,
      concurrency,
      startedMs: elapsed(),
      elapsedMs: 0,
      peakPending: 0,
      finished: false,
      stopReason: null,
    };
    stages.push(stage);
    const stageStarted = now();
    const firstIndex = rows.length;
    let active = 0;
    async function worker() {
      while (!stage.stopReason) {
        const stopped = guard();
        if (stopped) {
          stage.stopReason = stopped;
          break;
        }
        if (
          now() - stageStarted >= TPM_STAGE_MS ||
          rows.length - firstIndex >= tpmStageBudget(concurrency)
        )
          break;
        active++;
        stage.peakPending = Math.max(stage.peakPending, active);
        const row = await send(stage.id);
        active--;
        const failed = failure(row);
        // A failure from an in-flight request takes precedence over budget/time.
        if (failed) stage.stopReason = failed;
        stage.elapsedMs = Math.max(1, now() - stageStarted);
        publish();
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    stage.stopReason = options.signal.aborted
      ? 'cancelled'
      : (stage.stopReason ?? 'complete');
    stage.elapsedMs = Math.max(1, now() - stageStarted);
    stage.finished = true;
    publish();
    return stage;
  }

  if (!options.signal.aborted) {
    const check = await send(0);
    stopReason = failure(check);
    if (!stopReason && check.exchange) {
      // A planning guard, not a billing guarantee: calibrated input + 10% and
      // full output allowance reserved before dispatch. Reservations never refunded.
      perRequestReservation =
        Math.ceil(check.exchange.inputTokens! * 1.1) +
        TPM_WORKLOADS[options.workload].outputLimit;
      reservedTokens = perRequestReservation;
      for (const concurrency of TPM_LEVELS) {
        stopReason = guard();
        if (stopReason) break;
        const stage = await runStage(concurrency, 'load');
        if (stage.stopReason !== 'complete') {
          stopReason = stage.stopReason;
          break;
        }
      }
      const last = stages.at(-1);
      const failures = last
        ? rows.filter((r) => r.stage === last.id && failure(r))
        : [];
      const tokenFailures = failures.filter(
        (r) => r.exchange?.limitKind === 'token',
      );
      if (tokenFailures.length && !options.signal.aborted) {
        if (failures.length !== tokenFailures.length)
          confirmationNote =
            'Not repeated: other request or tester failures also occurred.';
        else {
          const waits = tokenFailures.map((r) => {
            const delay = tpmCooldownMs(r.exchange!);
            return delay === null
              ? null
              : Math.max(
                  0,
                  delay -
                    Math.max(0, now() - (receivedAt.get(r.sequence) ?? now())),
                );
          });
          const waitMs = waits.some((w) => w === null)
            ? null
            : Math.max(...(waits as number[])) + 1000;
          const repeatBudget = tpmStageBudget(last!.concurrency);
          if (waitMs === null)
            confirmationNote =
              'Not repeated: the provider supplied no usable cooldown or token-reset time.';
          else if (
            !Number.isFinite(waitMs) ||
            waitMs > TPM_MAX_COOLDOWN_MS ||
            elapsed() + waitMs + TPM_STAGE_MS >= TPM_WINDOW_MS
          )
            confirmationNote =
              'Not repeated: the provider cooldown exceeds the remaining test time.';
          else if (
            rows.length + repeatBudget > TPM_MAX_REQUESTS ||
            reservedTokens + perRequestReservation * repeatBudget >
              TPM_TOKEN_BUDGET
          )
            confirmationNote =
              'Not repeated: insufficient request or estimated-token budget for the same load.';
          else {
            phase = 'cooldown';
            cooldownUntil = wallNow() + waitMs;
            confirmationNote =
              'Waiting, then repeating the same load once. This checks repeatability, not an exact numeric TPM boundary.';
            publish();
            try {
              await (options.wait ?? waitForCooldown)(waitMs, options.signal);
            } catch {
              stopReason = options.signal.aborted ? 'cancelled' : 'tester';
            }
            cooldownUntil = null;
            if (
              !options.signal.aborted &&
              phase === 'cooldown' &&
              stopReason !== 'tester'
            ) {
              const repeat = await runStage(last!.concurrency, 'confirmation');
              stopReason =
                repeat.stopReason === 'complete'
                  ? 'provider'
                  : repeat.stopReason;
              confirmationNote =
                'Repeated the same load after the reported cooldown. Other account traffic and rolling quotas may still affect the result.';
            }
          }
        }
      }
    }
  }
  if (options.signal.aborted) stopReason = 'cancelled';
  stopReason ??= 'complete';
  publish(true);
}
