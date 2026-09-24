import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as concurrency from '../lib/concurrency-test.ts';
const readCode = (path) =>
  ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
const shardCode = readCode(
  '../app/api/rpm-runs/[id]/concurrency/[stage]/[shard]/route.ts',
);
const finalCode = readCode(
  '../app/api/rpm-runs/[id]/concurrency/[stage]/finalize/route.ts',
);
function fixture({
  user = { userId: 'owner' },
  found = true,
  index = 0,
  outcome = 'success',
  failSave = false,
  streaming = true,
  levels,
  mode,
} = {}) {
  const objects = new Map(),
    writes = [];
  let calls = 0,
    active = 0,
    peak = 0;
  const run = {
    id: 'run',
    userId: 'owner',
    rampMode: 'concurrency',
    status: 'running',
    currentStage: index,
    stopReason: null,
    automaticMetricsJson: streaming
      ? JSON.stringify({
          version: mode ? 4 : levels ? 3 : 2,
          ...(mode ? { mode } : {}),
          ...(levels ? { levels } : {}),
          stages: [],
          conclusion: '',
        })
      : null,
    baseUrl: 'https://openrouter.ai/api/v1',
    apiType: 'openai',
    modelName: 'openai/gpt-6-astra',
    openRouterTier: 'flex',
  };
  const stage = {
    status: 'running',
    stageIndex: index,
    scheduledStartAt: Date.now() - 1,
  };
  const plan = concurrency.concurrencyPlan(index, levels);
  const env = {
    EVIDENCE: {
      async get(key) {
        const val = objects.get(key);
        return val
          ? { json: async () => JSON.parse(val), text: async () => val }
          : null;
      },
      async put(key, body, opts) {
        if (failSave && key.includes('/results/')) throw Error('storage down');
        if (opts?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key))
          return null;
        objects.set(key, body);
        return { etag: 'saved' };
      },
    },
    DB: {
      prepare(sql) {
        let args = [];
        return {
          bind(...v) {
            assert.equal(
              v.length,
              (sql.match(/\?/g) ?? []).length,
              'SQL binding count: ' + sql,
            );
            args = v;
            return this;
          },
          async first() {
            return {
              run_status: run.status,
              stop_reason: run.stopReason,
              stage_status: stage.status,
              scheduled_start_at: stage.scheduledStartAt,
            };
          },
          async run() {
            writes.push({ sql, args });
            if (sql.includes('SET stop_reason=?')) run.stopReason = args[0];
            return { meta: { changes: 1 } };
          },
          sql,
          get args() {
            return args;
          },
        };
      },
      async batch(items) {
        for (const q of items) {
          writes.push({ sql: q.sql, args: q.args });
          if (q.sql.startsWith('UPDATE rpm_runs SET automatic_metrics_json')) {
            run.automaticMetricsJson = q.args[0];
            run.status = q.args[1];
            run.stopReason = q.args[2];
          }
        }
        return items.map(() => ({ meta: { changes: 1 } }));
      },
    },
  };
  const schema = {
    rpmRuns: { id: 'run.id', userId: 'run.userId' },
    rpmStages: { runId: 'stage.runId', stageIndex: 'stage.index' },
    rpmRunSecrets: { runId: 'secret.runId' },
  };
  const modules = {
    'cloudflare:workers': { env },
    'drizzle-orm': { and: (...v) => v, eq: (...v) => v },
    '@/app/chatgpt-auth': { getChatGPTUser: async () => user },
    '@/db/schema': schema,
    '@/db': {
      getDb: () => ({
        select(selection) {
          const q = {
            from() {
              return q;
            },
            innerJoin() {
              return q;
            },
            where() {
              return q;
            },
            async limit() {
              return found
                ? [
                    selection
                      ? {
                          run,
                          stage,
                          secret: { encryptedApiKey: 'enc', keyIv: 'iv' },
                        }
                      : run,
                  ]
                : [];
            },
          };
          return q;
        },
      }),
    },
    '@/lib/concurrency-test': concurrency,
    '@/lib/server/encryption': { decryptApiKey: async () => 'dummy-test-key' },
    '@/lib/server/hosted-ip-mapping': {
      loadRpmConnection: async () => ({
        actualBaseUrl: 'https://openrouter.ai/api/v1',
      }),
    },
    '@/lib/server/rpm-provider': {
      async runProviderRequest(input) {
        calls++;
        active++;
        peak = Math.max(active, peak);
        assert.equal(input.openRouterTier, 'flex');
        assert.equal(input.model, 'openai/gpt-6-astra');
        assert.equal(input.timeoutMs, 20000);
        assert.equal(input.stream, streaming);
        const begin = Date.now();
        await new Promise((r) => setTimeout(r, 2));
        active--;
        return {
          sequence: input.sequence,
          upstreamStartedAt: begin,
          completedAt: Date.now(),
          totalTimeMs: Date.now() - begin,
          ttftMs: streaming ? 1 : null,
          outcome: typeof outcome === 'function' ? outcome(input) : outcome,
          response: { status: outcome === 'success' ? 200 : 429 },
          request: { headers: { authorization: '$API_KEY' } },
        };
      },
    },
    '@/lib/server/http': {
      noStore: (v, i) => Response.json(v, i),
      serverError: (e) => Response.json({ error: e.message }, { status: 500 }),
    },
    '@/lib/server/rpm-store': {
      runDetail: async (row) => ({
        run: {
          ...row,
          concurrencyMetrics: row.automaticMetricsJson
            ? JSON.parse(row.automaticMetricsJson)
            : null,
        },
        stages: [],
      }),
    },
  };
  const load = (code) => {
    const scope = {
      exports: {},
      require: (name) => {
        assert.ok(modules[name], name);
        return modules[name];
      },
      Response,
      ReadableStream,
      TextEncoder,
      AbortController,
      Date,
      URL,
      setInterval,
      clearInterval,
      scheduler: {
        wait: (ms, { signal }) =>
          new Promise((resolve, reject) => {
            if (signal.aborted) return reject(Error('aborted'));
            const timer = setTimeout(resolve, ms);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(Error('aborted'));
              },
              { once: true },
            );
          }),
      },
    };
    vm.runInNewContext(code, scope);
    return scope.exports.POST;
  };
  return {
    post: load(shardCode),
    finalize: load(finalCode),
    objects,
    writes,
    run,
    stage,
    plan,
    calls: () => calls,
    peak: () => peak,
  };
}
const req = (chunk = 0, origin = 'https://test.local') =>
  new Request('https://test.local/api/rpm-runs/run/concurrency/0/0', {
    method: 'POST',
    headers: { origin },
    body: JSON.stringify({ chunk }),
  });
const ctx = (index = 0, shard = 0) => ({
  params: Promise.resolve({
    id: 'run',
    stage: String(index),
    shard: String(shard),
  }),
});
const events = async (response) =>
  (await response.text()).trim().split('\n').map(JSON.parse);
test('concurrency dispatch rejects invalid access, unsupported chunks, stale levels and duplicate claims before provider use', async () => {
  for (const [config, origin, status] of [
    [{ user: null }, 'https://test.local', 401],
    [{}, 'https://evil.test', 403],
    [{ found: false }, 'https://test.local', 404],
  ]) {
    const f = fixture(config);
    assert.equal((await f.post(req(0, origin), ctx())).status, status);
    assert.equal(f.calls(), 0);
  }
  const f = fixture();
  assert.equal((await f.post(req(4), ctx())).status, 400);
  assert.equal((await f.post(req(1), ctx())).status, 409);
  assert.equal(f.calls(), 0);
  await events(await f.post(req(), ctx()));
  assert.equal((await f.post(req(), ctx())).status, 409);
  assert.equal(f.calls(), 25);
  f.run.rampMode = 'automatic';
  assert.equal((await f.post(req(1), ctx())).status, 409);
  assert.equal(f.calls(), 25);
});
test('real shard route carries 100 requests over four bounded invocations, saves canonical evidence and finalizes a next level', async () => {
  const f = fixture();
  for (let chunk = 0; chunk < 4; chunk++) {
    const e = await events(await f.post(req(chunk), ctx()));
    assert.equal(e.at(-1).type, chunk === 3 ? 'complete' : 'continue');
    assert.equal(f.calls(), 25 * (chunk + 1));
  }
  const raw = [...f.objects]
    .filter(([key]) => key.includes('/results/'))
    .flatMap(([, value]) => JSON.parse(value).requests);
  assert.equal(raw.length, 100);
  assert.equal(new Set(raw.map((x) => x.sequence)).size, 100);
  const response = await f.finalize(req(), ctx());
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.run.status, 'running');
  assert.equal(detail.run.concurrencyMetrics.stages[0].attempts, 100);
  assert.equal(detail.run.concurrencyMetrics.version, 2);
  assert.equal(detail.run.concurrencyMetrics.stages[0].medianTtftMs, 1);
  assert.equal(detail.run.concurrencyMetrics.stages[0].ttftSamples, 100);
  assert.match(detail.run.concurrencyMetrics.conclusion, /Limit not reached/);
  assert.equal(
    f.writes.some((q) => q.sql.startsWith('DELETE FROM rpm_run_secrets')),
    false,
  );
});
test('in-progress legacy runs retain non-streaming requests and missing TTFT', async () => {
  const f = fixture({ streaming: false });
  for (let chunk = 0; chunk < 4; chunk++)
    await events(await f.post(req(chunk), ctx()));
  const detail = await (await f.finalize(req(), ctx())).json();
  assert.equal(detail.run.concurrencyMetrics.version, 1);
  assert.equal(detail.run.concurrencyMetrics.stages[0].medianTtftMs, null);
});
test('forty real dispatcher routes overlap 200 simulated requests and stop at the bounded ceiling', async () => {
  const f = fixture({ index: 5 });
  const result = await Promise.all(
    Array.from({ length: 40 }, (_, i) => f.post(req(), ctx(5, i)).then(events)),
  );
  assert.ok(result.every((e) => e.at(-1).type === 'complete'));
  assert.equal(f.calls(), 1000);
  assert.equal(f.peak(), 200);
  // Populate earlier levels for a final-level conclusion without rerunning paid work.
  f.run.automaticMetricsJson = JSON.stringify({
    version: 1,
    stages: Array.from({ length: 5 }, (_, stageIndex) => ({
      stageIndex,
      attempts: 0,
      succeeded: 0,
      rateLimited: 0,
    })),
    conclusion: '',
  });
  const detail = await (await f.finalize(req(), ctx(5))).json();
  assert.equal(detail.run.status, 'passed');
  const m = detail.run.concurrencyMetrics.stages.at(-1);
  assert.equal(m.peakConcurrency, 200);
  assert.equal(m.attempts, 1000);
  assert.equal(m.outcome, 'no_limit_observed');
  assert.match(
    detail.run.concurrencyMetrics.conclusion,
    /tester’s concurrency ceiling/,
  );
  assert.ok(
    f.writes.some((q) => q.sql.startsWith('DELETE FROM rpm_run_secrets')),
  );
});
test('429 stops replacement requests and higher levels; evidence write failure is tester-incomplete', async () => {
  const f = fixture({ outcome: 'rate_limited' });
  await events(await f.post(req(), ctx()));
  assert.ok(f.calls() <= 5);
  const detail = await (await f.finalize(req(), ctx())).json();
  assert.equal(detail.run.status, 'passed');
  assert.equal(
    detail.run.concurrencyMetrics.stages[0].outcome,
    'rate_limit_observed',
  );
  const broken = fixture({ failSave: true });
  const e = await events(await broken.post(req(), ctx()));
  assert.equal(e.at(-1).type, 'error');
  const failed = await (await broken.finalize(req(), ctx())).json();
  assert.equal(failed.run.status, 'inconclusive');
  assert.equal(
    failed.run.concurrencyMetrics.stages[0].outcome,
    'tester_incomplete',
  );
});
test('finalizer refuses unauthenticated and cross-origin access and marks missing dispatchers incomplete', async () => {
  const f = fixture({ user: null });
  assert.equal((await f.finalize(req(), ctx())).status, 401);
  const g = fixture();
  assert.equal(
    (await g.finalize(req(0, 'https://evil.test'), ctx())).status,
    403,
  );
  const detail = await (await g.finalize(req(), ctx())).json();
  assert.equal(detail.run.status, 'inconclusive');
});
test('custom 60, 61 and 70 levels deliver exact overlap, exact budgets and retain their plan when finalized', async () => {
  const levels = [60, 61, 70];
  for (let index = 0; index < levels.length; index++) {
    const f = fixture({ index, levels });
    await Promise.all(
      f.plan.shardPlans.map(async (shard, shardIndex) => {
        for (let chunk = 0; chunk < Math.ceil(shard.requestCap / 25); chunk++)
          await events(await f.post(req(chunk), ctx(index, shardIndex)));
      }),
    );
    assert.equal(f.peak(), levels[index]);
    assert.equal(f.calls(), levels[index] * 5);
    const raw = [...f.objects]
      .filter(([key]) => key.includes('/results/'))
      .flatMap(([, value]) => JSON.parse(value).requests);
    assert.equal(new Set(raw.map((sample) => sample.sequence)).size, f.calls());
    const detail = await (await f.finalize(req(), ctx(index))).json();
    const metrics = detail.run.concurrencyMetrics;
    assert.deepEqual(metrics.levels, levels);
    assert.equal(metrics.version, 3);
    assert.equal(metrics.stages.at(-1).concurrency, levels[index]);
    assert.equal(metrics.stages.at(-1).peakConcurrency, levels[index]);
    assert.equal(metrics.stages.at(-1).attempts, levels[index] * 5);
    assert.equal(detail.run.status, index === 2 ? 'passed' : 'running');
    assert.doesNotMatch(metrics.conclusion, /tester’s concurrency ceiling/);
  }
});
test('a seventh custom level is runnable, and single-level tests finish at their own boundary', async () => {
  for (const levels of [[61], [1, 2, 3, 4, 5, 60, 61]]) {
    const index = levels.length - 1;
    const f = fixture({ index, levels });
    await Promise.all(
      f.plan.shardPlans.map((_, shard) =>
        f.post(req(), ctx(index, shard)).then(events),
      ),
    );
    assert.equal(f.peak(), 61);
    const detail = await (await f.finalize(req(), ctx(index))).json();
    assert.equal(detail.run.status, 'passed');
    assert.equal(detail.run.concurrencyMetrics.stages.at(-1).concurrency, 61);
  }
});
test('partial dispatchers cannot exceed their saved budget and legacy custom failures retain their original stop behavior', async () => {
  const f = fixture({ levels: [61, 70], outcome: 'rate_limited' });
  assert.equal((await f.post(req(1), ctx(0, 12))).status, 400);
  assert.equal((await f.post(req(), ctx(0, 13))).status, 400);
  assert.equal(f.calls(), 0);
  await Promise.all(
    f.plan.shardPlans.map((_, shard) =>
      f.post(req(), ctx(0, shard)).then(events),
    ),
  );
  assert.ok(f.calls() <= 61);
  const detail = await (await f.finalize(req(), ctx())).json();
  assert.equal(detail.run.status, 'passed');
  assert.equal(
    detail.run.concurrencyMetrics.stages.at(-1).outcome,
    'rate_limit_observed',
  );
  assert.match(
    detail.run.concurrencyMetrics.conclusion,
    /concurrency 61.*Higher load was stopped/,
  );
  assert.ok(f.writes.some((q) => q.sql.includes("status='skipped'")));
});

test('custom run finishes 50, 60 and 65 despite timeouts and 429s, retaining earlier errors when the final level is clean', async () => {
  const levels = [50, 60, 65];
  const f = fixture({
    levels,
    mode: 'custom',
    outcome: (input) =>
      input.sequence % 19
        ? 'success'
        : ['timeout', 'rate_limited', 'success'][input.stageIndex],
  });
  let expected = 0;
  for (let index = 0; index < levels.length; index++) {
    f.run.currentStage = index;
    f.stage.stageIndex = index;
    f.stage.scheduledStartAt = Date.now() - 1;
    const plan = concurrency.concurrencyPlan(index, levels);
    await Promise.all(
      plan.shardPlans.map(async (shard, shardIndex) => {
        for (let chunk = 0; chunk < Math.ceil(shard.requestCap / 25); chunk++)
          await events(await f.post(req(chunk), ctx(index, shardIndex)));
      }),
    );
    expected += plan.requestCap;
    assert.equal(f.calls(), expected);
    assert.equal(f.run.stopReason, null);
    const detail = await (await f.finalize(req(), ctx(index))).json();
    const metrics = detail.run.concurrencyMetrics;
    assert.equal(metrics.mode, 'custom');
    assert.equal(metrics.stages.length, index + 1);
    assert.equal(metrics.stages.at(-1).attempts, plan.requestCap);
    assert.equal(metrics.stages.at(-1).budgetReached, true);
    assert.equal(detail.run.status, index === 2 ? 'passed' : 'running');
    assert.doesNotMatch(
      metrics.conclusion,
      /Higher load was stopped|no request failures observed through/,
    );
    if (index < 2) {
      assert.ok(metrics.stages.at(-1).errors > 0);
      assert.ok(
        !f.writes.some((q) => q.sql.includes('DELETE FROM rpm_run_secrets')),
      );
    } else {
      assert.equal(metrics.stages.at(-1).errors, 0);
      assert.match(
        metrics.conclusion,
        /All selected levels were tested.*50, 60/,
      );
    }
  }
});

test('custom error continuation crosses chunk boundaries but still stops when evidence storage fails', async () => {
  const f = fixture({ levels: [5, 10], mode: 'custom', outcome: 'timeout' });
  for (let chunk = 0; chunk < 4; chunk++) {
    const stream = await events(await f.post(req(chunk), ctx()));
    assert.equal(stream.at(-1).type, chunk < 3 ? 'continue' : 'complete');
  }
  assert.equal(f.calls(), 100);
  assert.equal(
    (await (await f.finalize(req(), ctx())).json()).run.status,
    'running',
  );
  const broken = fixture({ levels: [5, 10], mode: 'custom', failSave: true });
  await events(await broken.post(req(), ctx()));
  const detail = await (await broken.finalize(req(), ctx())).json();
  assert.equal(detail.run.status, 'inconclusive');
  assert.equal(
    detail.run.concurrencyMetrics.stages[0].outcome,
    'tester_incomplete',
  );
});
