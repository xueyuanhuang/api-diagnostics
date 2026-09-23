import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { measureAutomaticThroughput } from '../lib/automatic-throughput.ts';
import { countRpmOutcomes } from '../lib/server/rpm-evidence.ts';
const code = ts.transpileModule(
  readFileSync(
    new URL('../app/api/rpm-runs/[id]/measure/route.ts', import.meta.url),
    'utf8',
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
function fixture({
  user = { userId: 'owner' },
  found = true,
  claim = 1,
  cap = 3,
  state = 'ready',
  checkpoint = null,
} = {}) {
  let selects = 0,
    requests = 0;
  const writes = [];
  const evidence = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            writes.push({ sql, args });
            return this;
          },
          async run() {
            return { meta: { changes: claim } };
          },
          async first() {
            return { status: 'running' };
          },
        };
      },
      async batch(items) {
        return items.map(() => ({ meta: { changes: 1 } }));
      },
    },
    EVIDENCE: {
      async get() {
        return checkpoint ? { json: async () => checkpoint } : null;
      },
      async put(key, body) {
        evidence.push({ key, body });
      },
    },
  };
  const modules = {
    'cloudflare:workers': { env },
    'drizzle-orm': { and: (...v) => v, eq: (...v) => v },
    '@/app/chatgpt-auth': { getChatGPTUser: async () => user },
    '@/db': {
      getDb: () => ({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () =>
                ++selects === 1
                  ? found
                    ? [
                        {
                          id: 'run',
                          userId: 'owner',
                          rampMode: 'automatic',
                          status: state,
                          baseUrl: 'https://openrouter.ai/api/v1',
                          apiType: 'openai',
                          modelName: 'openai/gpt-6-astra',
                          openRouterTier: 'flex',
                        },
                      ]
                    : []
                  : [{ encryptedApiKey: 'enc', keyIv: 'iv' }],
            }),
          }),
        }),
      }),
    },
    '@/db/schema': {
      rpmRuns: { id: 'id', userId: 'userId' },
      rpmRunSecrets: { runId: 'runId' },
    },
    '@/lib/server/http': {
      noStore: (data, init) => Response.json(data, init),
      serverError: () => Response.json({ error: 'server' }, { status: 500 }),
    },
    '@/lib/server/encryption': { decryptApiKey: async () => 'test-secret' },
    '@/lib/server/hosted-ip-mapping': {
      prepareRpmConnection: async () => ({
        actualBaseUrl: 'https://openrouter.ai/api/v1',
      }),
    },
    '@/lib/server/rpm-provider': {
      runProviderRequest: async (input) => {
        requests++;
        assert.equal(input.openRouterTier, 'flex');
        return {
          outcome: 'success',
          completedAt: Date.now(),
          totalTimeMs: 1,
          request: { body: '{}' },
          response: {},
        };
      },
    },
    '@/lib/automatic-throughput': {
      measureAutomaticThroughput: (opts) =>
        measureAutomaticThroughput({ ...opts, requestCap: cap }),
    },
    '@/lib/server/rpm-evidence': { countRpmOutcomes },
  };
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
    setInterval,
    clearInterval,
    URL,
  };
  vm.runInNewContext(code, scope);
  return {
    post: scope.exports.POST,
    writes,
    evidence,
    requests: () => requests,
  };
}
const request = (origin = 'https://test.local') =>
  new Request('https://test.local/api/rpm-runs/run/measure', {
    method: 'POST',
    headers: { origin },
  });
const context = { params: Promise.resolve({ id: 'run' }) };
test('automatic measurement rejects unauthenticated, cross-origin, missing-owner and duplicate-start requests without provider traffic', async () => {
  for (const [settings, origin, status] of [
    [{ user: null }, 'https://test.local', 401],
    [{}, 'https://elsewhere.test', 403],
    [{ found: false }, 'https://test.local', 404],
    [{ claim: 0 }, 'https://test.local', 409],
  ]) {
    const f = fixture(settings);
    const response = await f.post(request(origin), context);
    assert.equal(response.status, status);
    assert.equal(f.requests(), 0);
  }
});
test('automatic route saves individual evidence, final counters and metrics before acknowledging completion', async () => {
  const f = fixture();
  const response = await f.post(request(), context);
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).metrics.sent, 3);
  assert.equal(f.evidence.length, 3);
  const final = f.writes.find((w) =>
    w.sql.startsWith('UPDATE rpm_runs SET status=?,automatic_metrics_json'),
  );
  assert.equal(final.args[0], 'passed');
  assert.equal(JSON.parse(final.args[1]).requestCap, 3);
  assert.ok(
    f.writes.some((w) => w.sql.startsWith('DELETE FROM rpm_run_secrets')),
  );
});

test('segments pass 50 provider calls across fresh invocations without losing the shared budget', async () => {
  let checkpoint = null;
  let total = 0;
  for (let chunk = 0; chunk < 12; chunk++) {
    const f = fixture({
      cap: 300,
      state: chunk ? 'running' : 'ready',
      checkpoint,
    });
    const req = new Request('https://test.local/api/rpm-runs/run/measure', {
      method: 'POST',
      headers: { origin: 'https://test.local' },
      body: JSON.stringify({ chunk }),
    });
    const response = await f.post(req, context);
    const events = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.equal(f.requests(), 25);
    total += f.requests();
    const last = events.at(-1);
    assert.equal(last.metrics.sent, total);
    assert.equal(last.type, chunk === 11 ? 'done' : 'continue');
    if (chunk < 11) {
      checkpoint = JSON.parse(
        f.evidence.find((x) => x.key.includes('/checkpoints/')).body,
      );
      assert.equal(checkpoint.samples.length, total);
      assert.equal(
        f.writes.some((x) => x.sql.startsWith('DELETE FROM rpm_run_secrets')),
        false,
      );
    }
  }
  assert.equal(total, 300);
});
test('missing checkpoint and duplicate continuation cannot send provider requests', async () => {
  for (const settings of [
    { state: 'running' },
    {
      state: 'running',
      claim: 0,
      checkpoint: { startedAt: Date.now(), samples: [] },
    },
  ]) {
    const f = fixture(settings);
    const req = new Request('https://test.local/api/rpm-runs/run/measure', {
      method: 'POST',
      body: JSON.stringify({ chunk: 1 }),
    });
    assert.equal((await f.post(req, context)).status, 409);
    assert.equal(f.requests(), 0);
  }
});
