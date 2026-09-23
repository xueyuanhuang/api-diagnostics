import test from 'node:test';
import assert from 'node:assert/strict';
import { SseFramer } from '../lib/protocols/sse-framer.ts';
import { readProviderStream } from '../lib/server/provider-stream.ts';
import {
  assessResult,
  compareBaseline,
  inspectRaw,
} from '../lib/result-assessment.ts';
const event = (data) => `data:${JSON.stringify(data)}\n\n`;
const done =
  event({ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] }) +
  event({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }) +
  'data:[DONE]\n\n';
const read = (body, type = 'openai', options = { preservePartial: true }) =>
  readProviderStream(
    new Response(body),
    type,
    'secret-test-key',
    performance.now(),
    10000,
    options,
  );
test('SSE framing is invariant under every split and handles multiline data, comments and CRLF', () => {
  const source =
    ': ping\r\nevent:message\r\ndata:{"a":\r\ndata: 1}\r\n\r\ndata:[DONE]\r\n\r\n';
  for (let split = 0; split <= source.length; split++) {
    const actual = [];
    const f = new SseFramer((data, event) => actual.push({ data, event }));
    f.push(source.slice(0, split));
    f.push(source.slice(split));
    assert.equal(f.end(), false);
    assert.deepEqual(actual, [
      { data: '{"a":\n1}', event: 'message' },
      { data: '[DONE]', event: '' },
    ]);
  }
});
test('HTTP 200 JSON and streamed business errors fail while preserving evidence', async () => {
  for (const body of [
    '{"error":{"message":"Model unavailable"}}',
    event({ error: { message: 'Model unavailable' } }),
  ]) {
    const r = await read(body);
    assert.equal(r.completionStatus, 'failed');
    assert.match(r.error, /Model unavailable/);
    assert.equal(r.rawResponse, body);
  }
});
test('normal terminal sequence accepts usage-only chunks and suppresses burst timing', async () => {
  const r = await read(done);
  assert.equal(r.completionStatus, 'completed');
  assert.equal(r.captureComplete, true);
  assert.deepEqual(r.protocolFindings, []);
  assert.equal(r.generationMs, null);
  assert.equal(r.usage.prompt_tokens, 10);
});
test('missing terminal is incomplete; token limit is a separate outcome', async () => {
  const r = await read(
    event({
      choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }],
    }),
  );
  assert.equal(r.completionStatus, 'incomplete');
  assert.match(r.error, /Completion not confirmed/);
  const limited = await read(
    event({
      choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }],
    }) + 'data:[DONE]\n\n',
  );
  assert.equal(limited.completionStatus, 'output_limit');
  assert.equal(limited.error, null);
});
test('disconnect, size limit and cancellation preserve partial bytes and classify separately', async () => {
  let step = 0;
  const broken = new ReadableStream({
    pull(c) {
      if (step++ === 0)
        c.enqueue(
          new TextEncoder().encode(
            event({ choices: [{ delta: { content: 'hello' } }] }),
          ),
        );
      else c.error(new Error('Disconnected'));
    },
  });
  const r = await read(broken);
  assert.equal(r.answer, 'hello');
  assert.equal(r.captureComplete, false);
  assert.match(r.rawResponse, /hello/);
  const capped = await readProviderStream(
    new Response('x'.repeat(101)),
    'openai',
    '',
    performance.now(),
    100,
    { preservePartial: true },
  );
  assert.equal(capped.capturedBytes, 100);
  assert.equal(capped.rawResponse.length, 100);
  assert.match(capped.error, /response-size limit/);
  const cancelled = new AbortController();
  cancelled.abort();
  const stream = new ReadableStream({
    start(c) {
      c.error(new Error('abort'));
    },
  });
  const c = await read(stream, 'openai', {
    preservePartial: true,
    signal: cancelled.signal,
  });
  assert.equal(c.completionStatus, 'cancelled');
});
test('duplicate start and data after terminal are visible findings', async () => {
  const r = await read(
    event({ type: 'message_start' }) +
      event({ type: 'message_start' }) +
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) +
      event({ type: 'message_stop' }) +
      event({ type: 'ping' }),
    'anthropic',
  );
  assert.ok(r.protocolFindings.some((x) => x.includes('Duplicate')));
  assert.ok(r.protocolFindings.some((x) => x.includes('after')));
});
test('escaped secret echoes are redacted and raw invalid usage is retained as a finding', async () => {
  const r = await read(
    '{"error":{"message":"secret-test-key"},"usage":{"prompt_tokens":-1}}',
  );
  assert.ok(!r.rawResponse.includes('secret-test-key'));
  assert.ok(!r.error.includes('secret-test-key'));
  const a = assessResult({
    totalInputTokens: null,
    assessmentJson: JSON.stringify({ rawUsage: { prompt_tokens: -1 } }),
  });
  assert.equal(a.usageAvailability, 'invalid');
  assert.equal(a.cache, 'unknown');
  assert.equal(inspectRaw('{"error":{"message":"bad"}}').providerError, 'bad');
});
test('comparison abstains for legacy, differing parameters, incomplete runs and too few samples', () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    prompt: `q${i}`,
    answer: 'yes',
    requestBody: JSON.stringify({ model: 'a', max_tokens: 96, stream: true }),
    assessmentJson: JSON.stringify({
      completionStatus: 'completed',
      captureComplete: true,
    }),
  }));
  assert.equal(compareBaseline(rows, rows, true).observations.length, 6);
  assert.match(compareBaseline(rows, rows, false).verdict, /Insufficient/);
  assert.match(
    compareBaseline(
      rows,
      rows.map((r) => ({ ...r, assessmentJson: null })),
      true,
    ).verdict,
    /Insufficient/,
  );
  assert.match(
    compareBaseline(
      rows,
      rows.map((r) => ({ ...r, requestBody: '{"max_tokens":512}' })),
      true,
    ).verdict,
    /Insufficient/,
  );
  assert.match(
    compareBaseline(rows.slice(0, 2), rows, true).verdict,
    /Insufficient/,
  );
});

test('saved reviews enforce both run ownership checks and append without modifying evidence', async () => {
  const { readFileSync } = await import('node:fs');
  const { default: ts } = await import('typescript');
  const store = {
    a: { id: 'a', userId: 'owner', apiType: 'openai' },
    b: { id: 'b', userId: 'other', apiType: 'openai' },
  };
  const writes = [];
  const tables = {
    testRuns: { id: 'id', userId: 'userId' },
    testResults: { runId: 'runId', position: 'position' },
  };
  const db = {
    select() {
      return {
        from(table) {
          return {
            where(condition) {
              const rows =
                table === tables.testRuns
                  ? Object.values(store).filter(condition)
                  : [];
              return { limit: async () => rows, orderBy: async () => rows };
            },
          };
        },
      };
    },
  };
  let user = { userId: 'owner' };
  const deps = {
    'cloudflare:workers': {
      env: {
        DB: {
          prepare(sql) {
            return {
              bind(...args) {
                return {
                  run: async () => writes.push({ sql, args }),
                  all: async () => ({ results: [] }),
                };
              },
            };
          },
        },
      },
    },
    'drizzle-orm': {
      eq: (k, v) => (row) => row[k] === v,
      and:
        (...fs) =>
        (row) =>
          fs.every((f) => f(row)),
      asc: (x) => x,
    },
    '@/app/chatgpt-auth': { getChatGPTUser: async () => user },
    '@/db': { getDb: () => db },
    '@/db/schema': tables,
    '@/lib/server/http': {
      noStore: (data, options) => Response.json(data, options),
    },
    '@/lib/result-assessment': await import('../lib/result-assessment.ts'),
  };
  const source = readFileSync(
    new URL('../app/api/runs/[id]/assessments/route.ts', import.meta.url),
    'utf8',
  );
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const handler = {};
  new Function('require', 'exports', code)((name) => deps[name], handler);
  const call = (id, body = {}, origin = 'https://app.test') =>
    handler.POST(
      new Request('https://app.test/api/runs/' + id + '/assessments', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  assert.equal((await call('b')).status, 404);
  assert.equal((await call('a', { referenceRunId: 'b' })).status, 400);
  assert.equal(writes.length, 0);
  assert.equal((await call('a', {}, 'https://other.test')).status, 403);
  assert.equal((await call('a', null)).status, 400);
  assert.equal((await call('a')).status, 200);
  assert.equal((await call('a')).status, 200);
  assert.equal(writes.length, 2);
  assert.notEqual(writes[0].args[0], writes[1].args[0]);
  assert.ok(
    writes.every((w) => w.sql.startsWith('INSERT INTO run_assessments')),
  );
  user = null;
  assert.equal((await call('a')).status, 401);
});

test('UTF-8 bytes split mid-character produce the same complete answer',async()=>{
 const bytes=new TextEncoder().encode(event({choices:[{delta:{content:'鹈鹕🚲'},finish_reason:'stop'}]})+'data:[DONE]\n\n');let index=0;
 const stream=new ReadableStream({pull(c){if(index<bytes.length)c.enqueue(bytes.slice(index,index+=1));else c.close();}});
 const r=await read(stream);assert.equal(r.answer,'鹈鹕🚲');assert.equal(r.completionStatus,'completed');
});
test('timing excludes delayed trailing usage from visible-text delivery span',async()=>{
 const pieces=[event({choices:[{delta:{content:'first'}}]}),event({choices:[{delta:{content:'last'},finish_reason:'stop'}]}),event({choices:[],usage:{completion_tokens:40}})+'data:[DONE]\n\n'];let index=0;
 const stream=new ReadableStream({async pull(c){if(index===pieces.length){c.close();return;}if(index)await new Promise(resolve=>setTimeout(resolve,index===2?80:20));c.enqueue(new TextEncoder().encode(pieces[index++]));}});
 const r=await read(stream);assert.equal(r.textChunkCount,2);assert.ok(r.totalTimeMs-r.ttftMs-r.generationMs>=60);assert.equal(r.completionStatus,'completed');
});
test('failure responses can be read as evidence without suppressing ordinary API errors',async()=>{
 const {readApiResponse}=await import('../lib/api-response.ts');
 const evidence={requestBody:'{}',error:'Disconnected',rawResponse:'partial'};
 assert.equal((await readApiResponse(Response.json(evidence,{status:502}),{preserveEvidence:true})).rawResponse,'partial');
 await assert.rejects(readApiResponse(Response.json({error:'Invalid key'},{status:401}),{preserveEvidence:true}),/Invalid key/);
 assert.equal(assessResult({assessmentJson:'null'}).capture,'unknown (legacy record)');
 const a=assessResult({totalInputTokens:4400,cacheReadInputTokens:4000,cacheCreationInputTokens:0,outputTokens:2});assert.match(a.inputSize,/elevated/);assert.equal(a.cache,'read reported');
});
