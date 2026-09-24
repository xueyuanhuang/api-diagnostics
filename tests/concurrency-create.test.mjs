import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as concurrency from '../lib/concurrency-test.ts';
import * as rpm from '../lib/rpm-types.ts';

const code = ts.transpileModule(
  readFileSync(
    new URL('../app/api/rpm-runs/route.ts', import.meta.url),
    'utf8',
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
function fixture() {
  const writes = [];
  let lookups = 0;
  let saved;
  const schema = {
    rpmRuns: { id: 'id' },
    rpmActiveLeases: { userId: 'userId' },
  };
  const env = {
    DB: {
      prepare(sql) {
        return {
          sql,
          args: [],
          bind(...args) {
            assert.equal(args.length, (sql.match(/\?/g) ?? []).length);
            this.args = args;
            return this;
          },
        };
      },
      async batch(queries) {
        writes.push(...queries);
        const insert = queries.find((query) =>
          query.sql.startsWith('INSERT INTO rpm_runs'),
        );
        if (insert)
          saved = {
            id: insert.args[0],
            automaticMetricsJson: insert.args.at(-1),
          };
        return queries.map(() => ({ meta: { changes: 1 } }));
      },
    },
  };
  const modules = {
    'cloudflare:workers': { env },
    'drizzle-orm': { eq: (...v) => v },
    '@/lib/concurrency-test': concurrency,
    '@/lib/rpm-types': rpm,
    '@/lib/openrouter': { openRouterRoute() {} },
    '@/lib/server/connection': { validateOutboundUrl: () => ({}) },
    '@/app/chatgpt-auth': { getChatGPTUser: async () => ({ userId: 'owner' }) },
    '@/db/schema': schema,
    '@/db': {
      getDb: () => ({
        select() {
          let table;
          const q = {
            from(t) {
              table = t;
              return q;
            },
            where() {
              return q;
            },
            async limit() {
              return table === schema.rpmRuns && saved ? [saved] : [];
            },
          };
          return q;
        },
      }),
    },
    '@/lib/server/profile-config': {
      getOwnedProfileConfig: async () => {
        lookups++;
        return {
          profileName: 'fixture',
          baseUrl: 'https://provider.test',
          encryptedApiKey: 'encrypted-test-value',
          keyIv: 'test-iv',
        };
      },
    },
    '@/lib/server/http': {
      noStore: (body, init) => Response.json(body, init),
      serverError: (error) =>
        Response.json({ error: error.message }, { status: 500 }),
    },
    '@/lib/server/rpm-store': {
      runDetail: async (row) => ({
        run: {
          id: row.id,
          concurrencyMetrics: JSON.parse(row.automaticMetricsJson),
        },
      }),
    },
  };
  const scope = {
    exports: {},
    Response,
    crypto,
    require(name) {
      assert.ok(modules[name], name);
      return modules[name];
    },
  };
  vm.runInNewContext(code, scope);
  return { post: scope.exports.POST, writes, lookups: () => lookups };
}
const request = (extras) =>
  new Request('https://test.local/api/rpm-runs', {
    method: 'POST',
    body: JSON.stringify({
      rampMode: 'concurrency',
      runnerVersion: concurrency.CONCURRENCY_RUNNER_VERSION,
      concurrencyMode: 'custom',
      profileId: 'profile',
      apiType: 'openai',
      model: 'model',
      ...extras,
    }),
  });

test('creation saves automatic stop behavior separately from custom continuation', async () => {
  const f = fixture();
  const response = await f.post(request({ concurrencyMode: 'automatic' }));
  assert.equal(response.status, 201);
  assert.equal(
    (await response.json()).run.concurrencyMetrics.mode,
    'automatic',
  );
});

test('creation persists custom plans and allocates exact per-level budgets and dispatchers', async () => {
  for (const levels of [
    [60, 61, 70],
    [61],
    [5, 10, 25, 50, 60, 61, 70, 100, 200],
  ]) {
    const f = fixture();
    const response = await f.post(request({ concurrencyLevels: levels }));
    assert.equal(response.status, 201);
    const metrics = (await response.json()).run.concurrencyMetrics;
    assert.equal(metrics.version, concurrency.CONCURRENCY_RUNNER_VERSION);
    assert.equal(metrics.mode, 'custom');
    assert.deepEqual(metrics.levels, levels);
    const stages = f.writes.filter((query) =>
      query.sql.startsWith('INSERT INTO rpm_stages'),
    );
    assert.equal(stages.length, levels.length);
    stages.forEach((stage, i) => {
      assert.equal(stage.args[2], i);
      assert.equal(stage.args[5], Math.max(100, levels[i] * 5));
      assert.equal(stage.args[6], Math.ceil(levels[i] / 5));
    });
    const runInsert = f.writes.find((query) =>
      query.sql.startsWith('INSERT INTO rpm_runs'),
    );
    assert.equal(
      runInsert.args[13],
      concurrency.concurrencyRequestBudget(levels),
    );
  }
});
test('invalid custom plans and stale clients are rejected before secrets or storage are accessed', async () => {
  for (const payload of [
    { runnerVersion: 2 },
    { runnerVersion: 3 },
    { runnerVersion: '3' },
    { concurrencyMode: 'unknown' },
    { concurrencyMode: undefined },
    { concurrencyLevels: [] },
    { concurrencyLevels: [61.5] },
    { concurrencyLevels: [201] },
    { concurrencyLevels: [61, 60] },
    { concurrencyLevels: [60, 60] },
    { concurrencyLevels: ['61'] },
    { concurrencyLevels: Array.from({ length: 13 }, (_, i) => i + 1) },
  ]) {
    const f = fixture();
    const response = await f.post(request(payload));
    assert.equal(response.status, 'runnerVersion' in payload ? 409 : 400);
    assert.equal(f.lookups(), 0);
    assert.equal(f.writes.length, 0);
  }
});
