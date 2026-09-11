import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveIpConnection,
  mappingTarget,
} from '../lib/server/ip-mapping.ts';

const config = {
  token: 'PRIVATE-DNS-CREDENTIAL',
  zoneId: 'a'.repeat(32),
  suffix: 'ip-api.example.com',
};
const base = 'http://45.58.184.227:3000';
const record = {
  type: 'A',
  name: '45-58-184-227.ip-api.example.com',
  content: '45.58.184.227',
  proxied: false,
};
const ok = (result) =>
  Response.json({ success: true, result, result_info: { total_pages: 1 } });
const dns = () =>
  Response.json({ Status: 0, Answer: [{ type: 1, data: record.content }] });

test('migration reuses only an exact public DNS mapping without a management credential', async()=>{
  const settings={suffix:config.suffix,existingOnly:true};
  const resolved=await resolveIpConnection(base,true,settings,async(url,init)=>{
    assert.ok(String(url).startsWith('https://cloudflare-dns.com/dns-query?'));
    assert.equal(init.headers.authorization,undefined);
    return dns();
  });
  assert.equal(resolved.actualBaseUrl,'http://45-58-184-227.ip-api.example.com:3000');
  for(const Answer of [[{type:1,data:'1.2.3.4'}],[{type:5,data:'elsewhere.example'},{type:1,data:record.content}]]){
    await assert.rejects(resolveIpConnection(base,true,settings,async()=>Response.json({Status:0,Answer}),async()=>{}));
  }
});

test('mapping preserves port/path and both API endpoint conventions', () => {
  assert.equal(
    mappingTarget(`${base}/v1/`, config.suffix).actualBaseUrl,
    'http://45-58-184-227.ip-api.example.com:3000/v1',
  );
  assert.equal(
    mappingTarget(`${base}/prefix/v1/messages`, config.suffix).actualBaseUrl,
    'http://45-58-184-227.ip-api.example.com:3000/prefix/v1/messages',
  );
  assert.throws(
    () => mappingTarget('https://45.58.184.227:3000', config.suffix),
    /never downgraded/,
  );
});

test('normal domain needs neither authentication nor DNS credentials', async () => {
  const result = await resolveIpConnection(
    'https://api.example.com/v1/',
    false,
    {},
    () => assert.fail('no DNS call'),
  );
  assert.deepEqual(result, {
    originalBaseUrl: 'https://api.example.com/v1',
    actualBaseUrl: 'https://api.example.com/v1',
    mapping: null,
  });
});

test('unauthenticated, private, invalid, HTTPS IP fail before external calls', async () => {
  for (const url of [
    'http://127.0.0.1',
    'http://10.0.0.1',
    'http://169.254.169.254',
    'http://[::1]',
    'http://0x7f000001',
    'http://user:pass@45.58.184.227',
    'https://45.58.184.227',
    base,
  ]) {
    await assert.rejects(
      resolveIpConnection(url, url !== base, config, () =>
        assert.fail('must not call DNS'),
      ),
    );
  }
});

test('creates one DNS-only A then verifies propagation without leaking DNS auth', async () => {
  const calls = [];
  const result = await resolveIpConnection(
    base,
    true,
    config,
    async (url, init) => {
      calls.push({ url, init });
      if (url.includes('dns-query')) {
        assert.equal(init.headers.authorization, undefined);
        return dns();
      }
      assert.equal(init.headers.authorization, `Bearer ${config.token}`);
      if (init.method === 'POST') {
        const body = JSON.parse(init.body);
        assert.equal(body.type, 'A');
        assert.equal(body.proxied, false);
        assert.equal(body.name, record.name);
        assert.equal(body.content, record.content);
        return ok(record);
      }
      return ok([]);
    },
  );
  assert.equal(calls.length, 3);
  assert.equal(result.actualBaseUrl, `http://${record.name}:3000`);
  assert.equal(result.originalBaseUrl, base);
  assert.equal(JSON.stringify(result).includes(config.token), false);
});

test('existing exact record is reused; conflicting record is never overwritten', async () => {
  for (const existing of [
    record,
    { ...record, proxied: true },
    { ...record, type: 'CNAME' },
    { ...record, content: '1.2.3.4' },
  ]) {
    const result = resolveIpConnection(
      base,
      true,
      config,
      async (url, init) => {
        assert.equal(init.method ?? 'GET', 'GET');
        return url.includes('dns-query') ? dns() : ok([existing]);
      },
    );
    if (existing === record) await result;
    else await assert.rejects(result, /conflicts/);
  }
});

test('concurrent creation collision only reuses exact matching record', async () => {
  let reads = 0;
  const result = await resolveIpConnection(
    base,
    true,
    config,
    async (url, init) => {
      if (url.includes('dns-query')) return dns();
      if (init.method === 'POST')
        return Response.json(
          { success: false, errors: [{ code: 81057 }] },
          { status: 400 },
        );
      return ok(reads++ ? [record] : []);
    },
  );
  assert.equal(result.mapping.hostname, record.name);
});

test('DNS failures and quota errors do not expose raw service response or token', async () => {
  await assert.rejects(
    resolveIpConnection(base, true, config, async () => {
      throw new Error(`connection failed ${config.token}`);
    }),
    (error) =>
      !error.message.includes(config.token) &&
      /could not be reached/.test(error.message),
  );
  await assert.rejects(
    resolveIpConnection(base, true, config, async () =>
      Response.json(
        { success: false, errors: [{ code: 1001, message: config.token }] },
        { status: 403 },
      ),
    ),
    (error) =>
      error.message.includes('HTTP 403') &&
      !error.message.includes(config.token),
  );
});

test('unresolved/misdirected DNS blocks provider dispatch after bounded retries', async () => {
  let attempts = 0;
  await assert.rejects(
    resolveIpConnection(
      base,
      true,
      config,
      async (url) => {
        if (!url.includes('dns-query')) return ok([record]);
        attempts++;
        return Response.json({
          Status: 0,
          Answer: [{ type: 1, data: '127.0.0.1' }],
        });
      },
      async () => {},
    ),
    /DNS is not ready/,
  );
  assert.equal(attempts, 3);
});

test('mapping completes before normal timing and RPM shard readiness', () => {
  const normal = readFileSync(
    new URL('../app/api/test/route.ts', import.meta.url),
    'utf8',
  );
  assert.ok(
    normal.indexOf('await resolveHostedConnection') <
      normal.indexOf('const startedAt ='),
  );
  assert.match(normal, /getChatGPTUser/);
  const shard = readFileSync(
    new URL(
      '../app/api/rpm-runs/[id]/stages/[stage]/shards/[shard]/route.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.ok(
    shard.indexOf('await loadRpmConnection') < shard.indexOf('const readyAt ='),
  );
  assert.doesNotMatch(shard, /resolveHostedConnection|prepareRpmConnection/);
  assert.match(shard, /baseUrl: resolved.actualBaseUrl/);
  assert.match(shard, /originalBaseUrl: run.baseUrl/);
});
