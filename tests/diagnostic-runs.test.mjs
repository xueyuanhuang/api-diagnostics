import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import {
  DiagnosticError, DIAGNOSTIC_MAX_BYTES,
  diagnosticStore,
  validateDiagnosticRun,
} from '../lib/server/diagnostic-store.ts';
import { diagnosticExport, diagnosticSummary } from '../lib/diagnostic-runs.ts';
import { DiagnosticSaveQueue } from '../lib/diagnostic-save-queue.ts';
import { captureEndpointExchange } from '../lib/server/endpoint-check.ts';
import { captureBoundaryExchange } from '../lib/server/tool-boundary.ts';

const id = 'ab1cec03-078c-4cc4-8001-b37c44c42d39';
const connection = {
  model: 'test-model',
  apiType: 'anthropic',
  baseUrl: 'https://example.com',
  actualBaseUrl: 'https://example.com',
  apiKey: 'synthetic-test-key',
};
const body = (answer = 'OK', extra = {}) =>
  JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: answer }],
    usage: { input_tokens: 3, output_tokens: 1 },
    ...extra,
  });
const base = {
  id,
  label: 'Saved connection',
  profileId: 'profile-at-start',
  model: 'test-model',
  apiType: 'anthropic',
  baseUrl: 'https://example.com',
  createdAt: '2026-09-08T00:00:00.000Z',
};
async function endpoint(raw = body()) {
  const exchange = await captureEndpointExchange(
    connection,
    'messages',
    'ok',
    new AbortController().signal,
    async () =>
      new Response(raw, {
        headers: {
          'anthropic-ratelimit-tokens-remaining': '123',
          'set-cookie': 'secret-cookie',
        },
      }),
  );
  return {
    ...base,
    testKind: 'endpoints',
    rows: [
      {
        protocol: 'messages',
        caseId: 'ok',
        repeat: 1,
        status: 'pass',
        exchange,
        error: null,
      },
    ],
  };
}
async function boundary() {
  const exchange = await captureBoundaryExchange(
    connection,
    new AbortController().signal,
    async () => new Response(body('No tools are available.')),
  );
  return {
    ...base,
    testKind: 'boundary',
    rows: Array.from({ length: 3 }, () => ({
      status: 'complete',
      exchange,
      error: null,
      review: 'pending',
    })),
  };
}
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle', import.meta.url))
    .filter((file) => file.endsWith('.sql'))
    .sort())
    sqlite.exec(
      readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  const objects = new Map();
  const reads = [];
  const deletes = [];
  let beforeRun;
  let beforePut;
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              return sqlite.prepare(sql).get(...args) ?? null;
            },
            async all() {
              return { results: sqlite.prepare(sql).all(...args) };
            },
            async run() {
              if (beforeRun) {
                const callback = beforeRun;
                beforeRun = null;
                await callback(sql);
              }
              return {
                meta: {
                  changes: Number(sqlite.prepare(sql).run(...args).changes),
                },
              };
            },
          };
        },
      };
    },
  };
  const bucket = {
    async put(key, value) {
      if (beforePut) {
        const callback = beforePut;
        beforePut = null;
        await callback();
      }
      objects.set(key, value);
    },
    async get(key) {
      reads.push(key);
      const value = objects.get(key);
      return value === undefined
        ? null
        : { json: async () => JSON.parse(value) };
    },
    async list({ prefix }) {
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        deletes.push(key);
        objects.delete(key);
      }
    },
  };
  return {
    store: diagnosticStore(db, bucket),
    sqlite,
    objects,
    reads,
    deletes,
    beforeWrite(fn) {
      beforeRun = fn;
    },
    beforeObject(fn) {
      beforePut = fn;
    },
  };
}
const status = (code) => (error) => error.status === code;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function loadServerModule(path, modules) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('require', 'exports', code)((name) => {
    if (!(name in modules)) throw new Error(`Unexpected dependency ${name}`);
    return modules[name];
  }, exports);
  return exports;
}

test('actual diagnostic routes require sign-in and same-origin JSON; a saved run can be listed, reopened, exported and deleted', async () => {
  const f = fixture();
  try {
    let user = null;
    const http = { noStore: (body, init) => Response.json(body, init), serverError: () => Response.json({ error: 'Unexpected error' }, { status: 500 }) };
    const helper = loadServerModule('../lib/server/diagnostic-http.ts', {
      'cloudflare:workers': { env: {} },
      './diagnostic-store': { diagnosticStore: () => f.store, DiagnosticError, DIAGNOSTIC_MAX_BYTES },
      './http': http,
    });
    const modules = {
      '@/app/chatgpt-auth': { getChatGPTUser: async () => user },
      '@/lib/server/http': http,
      '@/lib/server/diagnostic-http': helper,
      '@/lib/server/diagnostic-store': { validateDiagnosticRun },
      '@/lib/diagnostic-runs': { diagnosticExport },
    };
    const routes = loadServerModule('../app/api/diagnostic-runs/route.ts', modules);
    const detail = loadServerModule('../app/api/diagnostic-runs/[id]/route.ts', modules);
    const exported = loadServerModule('../app/api/diagnostic-runs/[id]/export/route.ts', modules);
    const url = 'https://site.example/api/diagnostic-runs';
    const doc = await endpoint();
    const request = (headers = {}) => new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ document: doc, revision: 1 }) });
    const context = { params: Promise.resolve({ id }) };
    assert.equal((await routes.POST(request())).status, 401);
    assert.equal((await routes.GET()).status, 401);
    assert.equal((await detail.GET(new Request(url), context)).status, 401);
    assert.equal((await exported.GET(new Request(url), context)).status, 401);
    user = { userId: 'owner' };
    assert.equal((await routes.POST(request({ Origin: 'https://foreign.example' }))).status, 403);
    assert.equal((await routes.POST(request({ 'Content-Type': 'text/plain' }))).status, 415);
    assert.equal(f.objects.size, 0);
    assert.equal((await routes.POST(request({ Origin: 'https://site.example' }))).status, 200);
    assert.equal((await (await routes.GET()).json()).runs.length, 1);
    assert.equal((await (await detail.GET(new Request(url), context)).json()).document.id, id);
    const download = await exported.GET(new Request(url), context);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.deepEqual((await download.json()).rows, doc.rows);
    assert.equal((await detail.DELETE(new Request(url, { method: 'DELETE', headers: { Origin: 'https://foreign.example' } }), context)).status, 403);
    assert.equal((await detail.DELETE(new Request(url, { method: 'DELETE' }), context)).status, 200);
    assert.deepEqual((await (await routes.GET()).json()).runs, []);
    assert.equal((await exported.GET(new Request(url), context)).status, 404);
  } finally { f.sqlite.close(); }
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test('all migrations apply; raw evidence over one million characters survives save/reload/export without clipping or counter-header redaction', async () => {
  const f = fixture();
  try {
    const raw = body('OK', {
      reasoning: 'evidence'.repeat(140000) + '证据',
      signature: 'unchanged-signature',
      vendor_data: { nested: ['keep', 7] },
    });
    const original = await endpoint(raw);
    original.apiKey = 'must-not-persist';
    original.rows[0].exchange.apiKey = 'must-not-persist';
    const doc = validateDiagnosticRun(original);
    await f.store.save('owner', doc, 1);
    const loaded = await f.store.get('owner', id);
    assert.deepEqual(loaded.document, doc);
    assert.equal(loaded.document.rows[0].exchange.rawResponse, raw);
    assert.ok(
      loaded.document.rows[0].exchange.responseHeaders.some(
        ([k, v]) => k === 'anthropic-ratelimit-tokens-remaining' && v === '123',
      ),
    );
    assert.ok(
      loaded.document.rows[0].exchange.responseHeaders.some(
        ([k, v]) => k === 'set-cookie' && v === '[REDACTED]',
      ),
    );
    assert.deepEqual(
      diagnosticExport(loaded.document).rows,
      original.rows.map(({ exchange, ...row }) => ({
        ...row,
        exchange: doc.rows[0].exchange,
      })),
    );
    assert.equal(
      [...f.objects.values()].some((value) =>
        value.includes('must-not-persist'),
      ),
      false,
    );
    assert.equal((await f.store.list('owner'))[0].testKind, 'endpoints');
  } finally {
    f.sqlite.close();
  }
});

test('list/read/export/delete ownership is checked before any evidence access; same run ID is scoped to its owner', async () => {
  const f = fixture();
  try {
    const doc = validateDiagnosticRun(await endpoint());
    await f.store.save('owner', doc, 1);
    assert.deepEqual(await f.store.list('stranger'), []);
    await assert.rejects(f.store.get('stranger', id), status(404));
    await assert.rejects(f.store.delete('stranger', id), status(404));
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.deletes, []);
    await f.store.save('stranger', { ...doc, label: 'Other account' }, 1);
    assert.equal(
      (await f.store.get('owner', id)).document.label,
      'Saved connection',
    );
    assert.equal(
      (await f.store.get('stranger', id)).document.label,
      'Other account',
    );
    await f.store.delete('stranger', id);
    assert.equal(
      (await f.store.get('owner', id)).document.label,
      'Saved connection',
    );
  } finally {
    f.sqlite.close();
  }
});

test('review edits persist idempotently; stale revisions cannot replace newer evidence and delete cannot be undone by a delayed save', async () => {
  const f = fixture();
  try {
    const doc = validateDiagnosticRun(await boundary());
    await f.store.save('owner', doc, 1);
    doc.rows[0].review = 'denies';
    await f.store.save('owner', doc, 2);
    await f.store.save('owner', doc, 2);
    assert.equal(f.objects.size, 1);
    assert.equal(
      (await f.store.get('owner', id)).document.rows[0].review,
      'denies',
    );
    assert.equal((await f.store.list('owner'))[0].reviewedCount, 1);
    await assert.rejects(f.store.save('owner', doc, 1), status(409));
    const different = structuredClone(doc);
    different.rows[0].review = 'claims';
    await assert.rejects(f.store.save('owner', different, 2), status(409));
    f.beforeWrite(async (sql) => {
      if (sql.startsWith('INSERT')) await f.store.delete('owner', id);
    });
    await assert.rejects(f.store.save('owner', different, 3), status(410));
    assert.deepEqual(await f.store.list('owner'), []);
    assert.equal(f.objects.size, 0);
    await assert.rejects(f.store.save('owner', different, 4), status(410));
  } finally {
    f.sqlite.close();
  }
});

test('stopped and abnormal captures preserve partial evidence without claiming a successful check', async () => {
  const f = fixture();
  try {
    const doc = await boundary();
    doc.rows[0].exchange.rawResponse = 'partial raw response';
    doc.rows[0].exchange.captureComplete = false;
    doc.rows[0].status = 'error';
    doc.rows[1] = {
      status: 'stopped',
      exchange: null,
      error: 'Stopped in flight.',
      review: 'pending',
    };
    doc.rows[2] = { ...doc.rows[1], error: 'Stopped before dispatch.' };
    const validated = validateDiagnosticRun(doc);
    await f.store.save('owner', validated, 1);
    assert.deepEqual((await f.store.get('owner', id)).document, validated);
    assert.deepEqual(
      {
        status: diagnosticSummary(validated).status,
        captured: diagnosticSummary(validated).capturedCount,
        issues: diagnosticSummary(validated).issueCount,
      },
      { status: 'stopped', captured: 1, issues: 1 },
    );
  } finally {
    f.sqlite.close();
  }
});

test('malformed enums, active rows and duplicate endpoints are rejected instead of coercing into saved data', async () => {
  const doc = await boundary();
  for (const apiType of [['anthropic'], {}, { toString: 'bad' }, null])
    assert.throws(
      () => validateDiagnosticRun({ ...doc, apiType }),
      status(400),
    );
  for (const review of [['denies'], {}, 'unknown']) {
    const invalid = structuredClone(doc);
    invalid.rows[0].review = review;
    assert.throws(() => validateDiagnosticRun(invalid), status(400));
  }
  doc.rows[0].status = 'running';
  assert.throws(() => validateDiagnosticRun(doc), status(400));
  const e = await endpoint();
  e.rows = [e.rows[0], e.rows[0], e.rows[0]];
  assert.throws(() => validateDiagnosticRun(e), status(400));
});

test('saving never starts for unfinished runs; rapid review edits queue behind the current save', async () => {
  const calls = [];
  const statuses = [];
  const saved = [];
  const gates = [];
  const queue = new DiagnosticSaveQueue(
    (doc, revision) => {
      const gate = deferred();
      gates.push(gate);
      calls.push({ doc, revision });
      return gate.promise;
    },
    (id, state) => statuses.push(state),
    (doc) => saved.push(doc),
  );
  const doc = await boundary();
  doc.rows[2].status = 'running';
  queue.update(doc);
  assert.equal(calls.length, 0);
  doc.rows[2].status = 'complete';
  queue.update(doc);
  assert.equal(calls.length, 1);
  doc.rows[0].review = 'claims';
  queue.update(doc);
  doc.rows[0].review = 'denies';
  queue.update(doc);
  assert.equal(calls.length, 1);
  gates[0].resolve(diagnosticSummary(calls[0].doc));
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].doc.rows[0].review, 'denies');
  assert.equal(calls[1].doc.label, 'Saved connection');
  gates[1].resolve(diagnosticSummary(calls[1].doc));
  await tick();
  assert.equal(statuses.at(-1).state, 'saved');
  assert.equal(saved.at(-1).reviewedCount, 1);
  queue.update(doc);
  assert.equal(calls.length, 2);
});

test('failed or uncertain saves retain evidence for explicit retry using the same revision', async () => {
  const calls = [];
  const states = [];
  let fail = true;
  const queue = new DiagnosticSaveQueue(
    async (doc, revision) => {
      calls.push({ doc, revision });
      if (fail) throw new Error('offline');
      return diagnosticSummary(doc);
    },
    (_id, state) => states.push(state),
    () => {},
  );
  const doc = await endpoint();
  queue.update(doc);
  await tick();
  assert.equal(states.at(-1).state, 'error');
  queue.update(doc);
  await tick();
  assert.equal(calls.length, 1);
  fail = false;
  queue.retry(id);
  await tick();
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(states.at(-1).state, 'saved');
});
