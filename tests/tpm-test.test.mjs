import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessTpm,
  tpmMetrics,
  tpmVerdict,
  tpmRequestBody,
  runTpmMeasurement,
  TPM_MAX_REQUESTS,
  TPM_TOKEN_BUDGET,
  tpmStageMetrics,
} from '../lib/tpm-test.ts';
import {
  tpmLimitHeaders,
  tpmCooldownMs,
  parseResetMs,
} from '../lib/tpm-limits.ts';
import { captureTpmExchange } from '../lib/server/tpm-test.ts';
import { validateDiagnosticRun } from '../lib/server/diagnostic-store.ts';
import {
  diagnosticFinished,
  diagnosticSummary,
  diagnosticExport,
} from '../lib/diagnostic-runs.ts';

function exchange(
  usage = { prompt_tokens: 1000, completion_tokens: 200 },
  overrides = {},
  apiType = 'openai',
) {
  const e = {
    requestedModel: 'fixture',
    originalBaseUrl: 'https://fixture.invalid/v1',
    requestMethod: 'POST',
    requestUrl: 'https://fixture.invalid/v1/chat/completions',
    requestHeaders: [['authorization', 'Bearer $API_KEY']],
    requestBody: JSON.stringify(
      tpmRequestBody(apiType, 'fixture', 'balanced', 'test-1'),
    ),
    responseHeaders: [],
    httpStatus: 200,
    requestId: 'fixture',
    captureComplete: true,
    startedAt: '2026-10-15T00:00:00Z',
    endedAt: '2026-10-15T00:00:01Z',
    totalTimeMs: 1000,
    error: null,
    rawResponse: JSON.stringify(
      apiType === 'openai'
        ? {
            choices: [
              {
                message: { content: 'Planning guide.' },
                finish_reason: 'length',
              },
            ],
            usage,
          }
        : {
            type: 'message',
            content: [{ type: 'text', text: 'Planning guide.' }],
            stop_reason: 'max_tokens',
            usage,
          },
    ),
    ...overrides,
  };
  return { ...e, ...assessTpm(e, apiType) };
}
const measurement = (rows, extra = {}) => ({
  workload: 'balanced',
  rows: rows.map((e, index) => ({
    sequence: index + 1,
    exchange: e,
    status: e.success ? 'pass' : 'issue',
    error: null,
  })),
  elapsedMs: 60000,
  finished: true,
  stopReason: 'window',
  ...extra,
});

test('workloads have bounded payloads and unique prefixes in both protocols', () => {
  for (const mode of ['input', 'output', 'balanced']) {
    const a = tpmRequestBody('openai', 'fixture', mode, 'first');
    const b = tpmRequestBody('anthropic', 'fixture', mode, 'second');
    assert.equal(a.stream, false);
    assert.equal(b.stream, false);
    assert.equal(a.max_completion_tokens, b.max_tokens);
    assert.ok(a.max_completion_tokens <= 2048);
    assert.ok(a.messages[0].content.length < 17000);
    assert.notEqual(a.messages[0].content, b.messages[0].content);
  }
});
test('cache and reasoning accounting avoids double-counting across protocols', () => {
  const a = exchange({
    prompt_tokens: 1000,
    completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 700 },
    completion_tokens_details: { reasoning_tokens: 150 },
  });
  assert.deepEqual(
    [a.inputTokens, a.outputTokens, a.cacheReadTokens, a.reasoningTokens],
    [1000, 200, 700, 150],
  );
  const b = exchange(
    {
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 600,
    },
    {},
    'anthropic',
  );
  assert.equal(b.inputTokens, 1000);
  const m = tpmMetrics(measurement([a, b], { elapsedMs: 30000 }));
  assert.equal(m.inputTpm, 4000);
  assert.equal(m.outputTpm, 800);
  assert.equal(m.totalTpm, 4800);
});
test('missing, negative, string, and inconsistent usage stays unknown rather than zero', () => {
  for (const usage of [
    null,
    {},
    { prompt_tokens: -1, completion_tokens: 20 },
    { prompt_tokens: '1000', completion_tokens: 20 },
    {
      prompt_tokens: 5,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 10 },
    },
  ]) {
    const e = exchange(usage);
    assert.equal(e.success, true);
    assert.equal(tpmMetrics(measurement([e])).totalTpm, null);
    assert.equal(tpmVerdict(measurement([e])), 'Incomplete measurement');
  }
  const m = tpmMetrics(measurement([exchange(), exchange(null)]));
  assert.equal(m.coverage, 1);
  assert.equal(m.missingUsage, 1);
  assert.equal(m.totalTpm, 1200);
});
test('TPM, RPM, quota and ambiguous 429 errors remain distinct', () => {
  for (const [message, kind] of [
    ['tokens per minute exceeded', 'token'],
    ['requests per minute exceeded', 'request'],
    ['insufficient_quota', 'quota'],
    ['Too many requests', 'unspecified'],
    ['slow_down: token rate increasing too quickly', 'acceleration'],
    ['Maximum concurrent requests exceeded', 'concurrency'],
  ]) {
    const e = exchange(null, {
      httpStatus: 429,
      rawResponse: JSON.stringify({ error: { message } }),
    });
    assert.equal(e.success, false);
    assert.equal(e.limitKind, kind);
  }
  const hidden = exchange(null, {
    rawResponse: JSON.stringify({
      error: { message: 'TPM exceeded', code: 'rate_limit_exceeded' },
    }),
  });
  assert.equal(hidden.success, false);
  assert.equal(hidden.limitKind, 'token');
});
test('HTTP 200 does not count malformed, incomplete, or error results as token throughput', () => {
  for (const extra of [
    { captureComplete: false },
    { error: 'Timed out' },
    { rawResponse: '<html>Bad gateway</html>' },
    {
      rawResponse: JSON.stringify({
        usage: { prompt_tokens: 1000, completion_tokens: 200 },
      }),
    },
    {
      rawResponse: JSON.stringify({
        error: { message: 'failed' },
        usage: { prompt_tokens: 1000, completion_tokens: 200 },
      }),
    },
  ]) {
    const e = exchange(undefined, extra);
    assert.equal(e.success, false);
    assert.equal(tpmMetrics(measurement([e])).totalTpm, null);
  }
});
test('adaptive runner increases load, excludes calibration and drains each level', async () => {
  let active = 0,
    peak = 0,
    calls = 0,
    clock = 0,
    final;
  await runTpmMeasurement({
    workload: 'balanced',
    signal: new AbortController().signal,
    now: () => clock,
    publish: (r) => {
      final = r;
    },
    request: async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      clock += 100;
      return exchange();
    },
  });
  assert.equal(calls, 79);
  assert.ok(calls <= TPM_MAX_REQUESTS);
  assert.deepEqual(
    final.stages.map((s) => s.concurrency),
    [2, 5, 10, 20],
  );
  assert.ok(tpmStageMetrics(final).every((s) => s.clean));
  assert.equal(peak, 20);
  assert.equal(active, 0);
  assert.equal(final.finished, true);
  assert.equal(final.stopReason, 'complete');
  assert.equal(final.elapsedMs, 7900);
  assert.equal(tpmMetrics(final).measuredMs, 7800);
  assert.equal(tpmMetrics(final).coverage, 78);
});
test('failed first check or missing usage prevents load fan-out', async () => {
  for (const result of [exchange(null, { httpStatus: 403 }), exchange(null)]) {
    let calls = 0,
      final;
    await runTpmMeasurement({
      workload: 'input',
      signal: new AbortController().signal,
      publish: (r) => {
        final = r;
      },
      request: async () => {
        calls++;
        return result;
      },
    });
    assert.equal(calls, 1);
    assert.equal(final.stopReason, 'provider');
    assert.equal(final.finished, true);
  }
});
test('sending deadline includes initial request, final drain is measured, failures do not retry', async () => {
  let clock = 0,
    calls = 0,
    final;
  await runTpmMeasurement({
    workload: 'output',
    signal: new AbortController().signal,
    now: () => clock,
    publish: (r) => {
      final = r;
    },
    request: async () => {
      calls++;
      clock += 45000;
      return exchange();
    },
  });
  assert.ok(calls <= 7);
  assert.equal(final.stopReason, 'window');
  assert.ok(final.elapsedMs >= 180000);
  let failures = 0;
  await runTpmMeasurement({
    workload: 'output',
    signal: new AbortController().signal,
    publish: (r) => {
      final = r;
    },
    request: async () => {
      failures++;
      throw new Error('Tester unreachable');
    },
  });
  assert.equal(failures, 1);
  assert.equal(final.stopReason, 'tester');
  assert.equal(tpmVerdict(final), 'Incomplete measurement');
});
test('cancellation stops sending and preserves finished evidence', async () => {
  const controller = new AbortController();
  let calls = 0,
    final;
  await runTpmMeasurement({
    workload: 'balanced',
    signal: controller.signal,
    publish: (r) => {
      final = r;
    },
    request: async () => {
      calls++;
      controller.abort();
      return exchange();
    },
  });
  assert.equal(calls, 1);
  assert.equal(final.stopReason, 'cancelled');
  assert.equal(final.rows.length, 1);
  assert.equal(tpmVerdict(final), 'Incomplete measurement');
});
test('server capture pins OpenRouter tier, uses one request and redacts secrets', async () => {
  let calls = 0;
  const e = await captureTpmExchange(
    {
      apiType: 'openai',
      model: 'openai/gpt-6-astra',
      apiKey: 'fixture-secret',
      baseUrl: 'https://openrouter.ai/api/v1',
      actualBaseUrl: 'https://openrouter.ai/api/v1',
      openRouterTier: 'flex',
    },
    'balanced',
    'fixture-1',
    new AbortController().signal,
    async (url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      assert.equal(body.service_tier, 'flex');
      assert.equal(body.provider.allow_fallbacks, false);
      assert.equal(body.max_completion_tokens, 1024);
      return new Response(exchange().rawResponse, {
        headers: {
          'x-test': 'fixture-secret',
          'x-ratelimit-remaining-tokens': '20',
        },
      });
    },
  );
  assert.equal(calls, 1);
  assert.equal(e.success, true);
  assert.ok(!JSON.stringify(e).includes('fixture-secret'));
  assert.ok(JSON.stringify(e).includes('x-ratelimit-remaining-tokens'));
});
test('saved TPM runs rederive usage and verdicts from raw evidence, preserving measured duration', () => {
  const run = {
    ...measurement([exchange()]),
    testKind: 'tpm',
    id: '00000000-0000-4000-8000-000000000001',
    label: 'fixture',
    model: 'fixture',
    apiType: 'openai',
    baseUrl: 'https://fixture.invalid',
    profileId: null,
    createdAt: '2026-10-15T00:00:00Z',
  };
  run.rows[0].exchange.inputTokens = 999999;
  const saved = validateDiagnosticRun(run);
  assert.equal(saved.rows[0].exchange.inputTokens, 1000);
  assert.equal(diagnosticSummary(saved).tpm.inputTpm, 1000);
  assert.equal(diagnosticExport(saved).format, 'tpm-throughput-v1');
  assert.equal(diagnosticFinished(saved), true);
  assert.equal(diagnosticFinished({ ...saved, finished: false }), false);
  assert.throws(() => validateDiagnosticRun({ ...run, elapsedMs: -1 }));
  assert.throws(() => validateDiagnosticRun({ ...run, workload: 'unbounded' }));
  assert.throws(() =>
    validateDiagnosticRun({ ...run, rows: Array(31).fill(run.rows[0]) }),
  );
});

test('estimated-token reservation stops new dispatch without dropping in-flight evidence', async () => {
  let final;
  await runTpmMeasurement({
    workload: 'balanced',
    signal: new AbortController().signal,
    publish: (r) => {
      final = r;
    },
    request: async () =>
      exchange({ prompt_tokens: 100000, completion_tokens: 200 }),
  });
  assert.equal(final.stopReason, 'token-budget');
  assert.equal(final.rows.length, 2);
  assert.ok(final.reservedTokens <= TPM_TOKEN_BUDGET);
  assert.equal(final.rows.filter((r) => r.status === 'running').length, 0);
  assert.equal(tpmMetrics(final).best, null);
});

test('provider headers preserve scopes, parse reset times and never turn a configured limit into a reached limit', () => {
  const e = exchange(undefined, {
    endedAt: '2026-10-16T00:00:00Z',
    responseHeaders: [
      ['X-RateLimit-Limit-Tokens', '100000'],
      ['x-ratelimit-remaining-tokens', '0'],
      ['x-ratelimit-reset-tokens', '1m2.5s'],
      ['retry-after', '2'],
      ['anthropic-ratelimit-input-tokens-limit', '50000'],
      ['anthropic-ratelimit-input-tokens-reset', '2026-10-16T00:00:03Z'],
      ['x-ratelimit-limit-project-tokens', '20000'],
    ],
  });
  assert.equal(tpmLimitHeaders(e).length, 3);
  assert.equal(tpmLimitHeaders(e)[0].resetMs, 62500);
  assert.equal(tpmCooldownMs(e), 62500);
  assert.equal(tpmMetrics(measurement([e])).tokenLimit, false);
  assert.equal(parseResetMs('nonsense', Date.now()), null);
  assert.equal(parseResetMs('1s500ms', Date.now()), 1500);
  assert.equal(
    parseResetMs(
      'Fri, 16 Oct 2026 00:00:10 GMT',
      Date.parse('2026-10-16T00:00:00Z'),
    ),
    10000,
  );
});

async function limitRun({
  repeated = true,
  headers = [['retry-after', '2']],
  abortDuringWait = false,
  missingDuringRepeat = false,
} = {}) {
  let clock = 0,
    waited = 0,
    final,
    repeating = false;
  const controller = new AbortController();
  const base = Date.parse('2026-10-16T00:00:00Z');
  await runTpmMeasurement({
    workload: 'balanced',
    signal: controller.signal,
    now: () => clock,
    wallNow: () => base + clock,
    publish: (r) => {
      final = r;
    },
    wait: async (ms) => {
      waited += ms;
      clock += ms;
      repeating = true;
      if (abortDuringWait) controller.abort();
    },
    request: async (seq) => {
      await new Promise((resolve) => setImmediate(resolve));
      clock += 100;
      if (seq < 10 || (repeating && !repeated))
        return exchange(missingDuringRepeat && repeating ? null : undefined);
      return exchange(null, {
        httpStatus: 429,
        endedAt: new Date(base + clock).toISOString(),
        responseHeaders: headers,
        rawResponse: JSON.stringify({
          error: { message: 'tokens per minute limit exceeded' },
        }),
      });
    },
  });
  return { final, waited };
}

test('token throttling repeats the same load once after the complete cooldown; cooldown is excluded from rates', async () => {
  const { final, waited } = await limitRun();
  assert.equal(waited, 3000);
  assert.deepEqual(
    final.stages.map((s) => [s.concurrency, s.kind]),
    [
      [2, 'load'],
      [5, 'load'],
      [5, 'confirmation'],
    ],
  );
  assert.equal(tpmMetrics(final).verification, 'repeated');
  assert.equal(tpmVerdict(final), 'Token throttling repeated after cooldown');
  assert.ok(final.rows.length <= TPM_MAX_REQUESTS);
  assert.equal(final.elapsedMs - tpmMetrics(final).measuredMs, waited + 100);
});

test('clean repeat, missing usage and cancellation produce distinct verification results', async () => {
  const clean = await limitRun({ repeated: false });
  assert.equal(tpmMetrics(clean.final).verification, 'not-repeated');
  assert.equal(tpmVerdict(clean.final), 'Provider reports a token limit');
  const missing = await limitRun({
    repeated: false,
    missingDuringRepeat: true,
  });
  assert.equal(tpmMetrics(missing.final).verification, 'inconclusive');
  const cancelled = await limitRun({ abortDuringWait: true });
  assert.equal(cancelled.final.stopReason, 'cancelled');
  assert.equal(cancelled.final.stages.length, 2);
});

test('missing or excessive cooldown never triggers a speculative retry', async () => {
  for (const headers of [
    [],
    [['retry-after', '120']],
    [['retry-after', 'bogus']],
  ]) {
    const { final, waited } = await limitRun({ headers });
    assert.equal(waited, 0);
    assert.equal(final.stages.length, 2);
    assert.match(final.confirmationNote, /Not repeated/);
  }
});

test('adaptive history preserves stages and recomputes verification from raw responses', async () => {
  const { final } = await limitRun();
  const data = {
    ...final,
    testKind: 'tpm',
    id: '00000000-0000-4000-8000-000000000001',
    label: 'fixture',
    model: 'fixture',
    apiType: 'openai',
    baseUrl: 'https://fixture.invalid',
    profileId: null,
    createdAt: '2026-10-16T00:00:00Z',
  };
  const saved = validateDiagnosticRun(data);
  assert.deepEqual(saved.stages, final.stages);
  assert.equal(diagnosticSummary(saved).tpm.verification, 'repeated');
  assert.equal(diagnosticExport(saved).format, 'tpm-adaptive-v2');
  assert.throws(() =>
    validateDiagnosticRun({
      ...data,
      stages: [{ ...data.stages[0], concurrency: 999 }],
    }),
  );
  assert.throws(() =>
    validateDiagnosticRun({ ...data, rows: [{ ...data.rows[0], stage: 2 }] }),
  );
});
