import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { AvailabilityStore } from '../lib/server/availability-store.ts';
import { checkProviderAvailability } from '../lib/server/availability-provider.ts';
import {
  availabilityRequestBody,
  probeSlot,
  PROBE_INTERVAL_MS,
  targetHealth,
  historySlots,
} from '../lib/availability.ts';
import { signProbeTick, verifyProbeTick } from '../lib/probe-signature.ts';
import { triggerAvailability } from '../scheduler/worker.ts';

const now = probeSlot(Date.now()) + 1000;
const slot = probeSlot(now);
const input = {
  id: 'probe',
  profileId: 'profile',
  apiType: 'openai',
  modelName: 'model',
  baseUrl: 'https://example.com',
  allowInsecureHttp: 0,
  createdAt: now,
};
const success = {
  status: 'ok',
  httpStatus: 200,
  finishedAt: now + 100,
  latencyMs: 100,
  returnedModel: 'model',
  requestId: 'request',
  answer: 'OK',
  error: null,
};
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  for (const [id, user] of [
    ['profile', 'owner'],
    ['foreign', 'other'],
  ])
    sqlite
      .prepare(
        'INSERT INTO connection_profiles(id,user_id,name,api_type,base_url,encrypted_api_key,key_iv,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        user,
        id,
        'openai',
        'https://example.com',
        'ENCRYPTED-KEY',
        'IV',
        now,
        now,
      );
  const db = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
        },
        async first() {
          return sqlite.prepare(sql).get(...args) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...args) };
        },
        async run() {
          return {
            meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) },
          };
        },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return {
    sqlite,
    store: new AvailabilityStore(db),
    close: () => sqlite.close(),
  };
}

test('generated migrations preserve old tables and availability ownership survives reloads', async () => {
  const f = fixture();
  try {
    await f.store.add('owner', input);
    assert.equal(await f.store.active('probe', 'other'), null);
    await assert.rejects(
      f.store.add('owner', { ...input, id: 'bad', profileId: 'foreign' }),
    );
    await assert.rejects(
      f.store.remove('other', 'probe', now + 1),
      (error) => error.status === 404,
    );
    const loaded = await f.store.list('owner', true, now);
    assert.equal(loaded.targets.length, 1);
    assert.equal(loaded.targets[0].modelName, 'model');
    assert.equal((await f.store.list('other', true, now)).targets.length, 0);
    assert.ok(!JSON.stringify(loaded).includes('ENCRYPTED-KEY'));
    assert.equal(
      f.sqlite.prepare('SELECT COUNT(*) AS n FROM test_runs').get().n,
      0,
    );
  } finally {
    f.close();
  }
});

test('duplicate scheduler requests can claim only one paid attempt per target and interval', async () => {
  const f = fixture();
  try {
    await f.store.add('owner', input);
    const target = await f.store.active('probe');
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => f.store.claim(target, slot, now + 1)),
    );
    assert.equal(attempts.filter(Boolean).length, 1);
    await f.store.finish(target, slot, success);
    assert.equal(await f.store.claim(target, slot, now + 5), false);
    assert.deepEqual(await f.store.due(slot, now + 5), []);
    assert.deepEqual(
      await f.store.due(slot + PROBE_INTERVAL_MS, now + PROBE_INTERVAL_MS),
      ['probe'],
    );
    assert.equal(
      (await f.store.list('owner', true, now + 500)).targets[0].samples[0]
        .status,
      'ok',
    );
  } finally {
    f.close();
  }
});

test('deletion blocks future claims and re-add has a new identity and immediate first check', async () => {
  const f = fixture();
  try {
    await f.store.add('owner', input);
    const old = await f.store.active('probe');
    await f.store.claim(old, slot, now + 1);
    await f.store.remove('owner', 'probe', now + 2);
    assert.equal(await f.store.active('probe'), null);
    assert.equal(
      await f.store.claim(old, slot + PROBE_INTERVAL_MS, now + 3),
      false,
    );
    assert.deepEqual(await f.store.due(slot, now + 3), []);
    await f.store.add('owner', {
      ...input,
      id: 'new-probe',
      createdAt: now + 4,
      baseUrl: 'https://new.example.com',
    });
    const fresh = await f.store.active('new-probe');
    assert.equal(await f.store.claim(fresh, slot, now + 5), true);
    await f.store.finish(old, slot, success);
    assert.equal(
      (await f.store.list('owner', true, now + 6)).targets[0].samples[0].status,
      'checking',
    );
    await f.store.finish(fresh, slot, success);
    assert.equal(
      (await f.store.list('owner', true, now + 7)).targets[0].samples[0].status,
      'ok',
    );
  } finally {
    f.close();
  }
});

test('capacity is enforced atomically and deleting a saved connection stops all its targets', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 200; i++)
      await f.store.add('owner', { ...input, id: `p${i}`, modelName: `m${i}` });
    await assert.rejects(
      f.store.add('owner', { ...input, id: 'over', modelName: 'over' }),
      (error) => error.message.includes('200-target'),
    );
    assert.equal((await f.store.due(slot, now + 1)).length, 200);
    await f.store.remove('owner', 'p0', now + 2);
    await f.store.add('owner', {
      ...input,
      id: 'replacement',
      modelName: 'new',
    });
    f.sqlite
      .prepare('DELETE FROM connection_profiles WHERE id=?')
      .run('profile');
    assert.deepEqual(await f.store.due(slot, now + 3), []);
  } finally {
    f.close();
  }
});

test('unknown gaps and interrupted/stale checks never display as model outages or fresh success', () => {
  const target = { ...input, profileName: 'test', samples: [] };
  assert.equal(targetHealth(target, now).status, 'unknown');
  const checked = {
    ...target,
    samples: [{ ...success, slotStart: slot, startedAt: now }],
  };
  assert.equal(targetHealth(checked, now + 500).status, 'ok');
  assert.equal(
    targetHealth(checked, now + 2 * PROBE_INTERVAL_MS + 1).status,
    'unknown',
  );
  assert.equal(
    targetHealth(
      {
        ...target,
        samples: [
          { ...success, status: 'checking', startedAt: now, slotStart: slot },
        ],
      },
      now + 91_000,
    ).status,
    'unknown',
  );
  const bars = historySlots(checked, now + PROBE_INTERVAL_MS);
  assert.equal(bars.length, 24);
  assert.equal(bars.filter((x) => x.status === 'ok').length, 1);
  assert.equal(bars.at(-1).status, 'unknown');
});

const connection = {
  apiType: 'openai',
  model: 'model',
  apiKey: 'test-key-do-not-leak',
  actualBaseUrl: 'https://example.com',
};
const chat = (content = 'OK', finish = 'stop') =>
  JSON.stringify({
    model: 'returned',
    choices: [
      { message: { role: 'assistant', content }, finish_reason: finish },
    ],
  });
test('availability sends one small clean request for each supported protocol', async () => {
  for (const apiType of ['anthropic', 'openai']) {
    let sent;
    const result = await checkProviderAvailability(
      { ...connection, apiType },
      new AbortController().signal,
      async (url, init) => {
        sent = { url: String(url), ...init };
        return new Response(
          apiType === 'openai'
            ? chat()
            : JSON.stringify({
                model: 'returned',
                content: [{ type: 'text', text: 'OK' }],
                stop_reason: 'end_turn',
              }),
        );
      },
    );
    assert.deepEqual(
      JSON.parse(sent.body),
      availabilityRequestBody(apiType, 'model'),
    );
    assert.equal(sent.redirect, 'manual');
    assert.equal(result.status, 'ok');
    assert.equal(result.answer, 'OK');
    assert.ok(
      sent.url.endsWith(
        apiType === 'openai' ? '/v1/chat/completions' : '/v1/messages',
      ),
    );
    assert.equal(Object.keys(JSON.parse(sent.body)).length, 4);
    assert.ok(!JSON.stringify(result).includes(connection.apiKey));
  }
});

test('HTTP errors, redirects, empty JSON, empty completions and truncation fail the availability check', async () => {
  for (const [body, status] of [
    ['bad', 503],
    [chat(), 302],
    ['{}', 200],
    [chat(''), 200],
    [chat('OK', 'length'), 200],
    ['<html>OK</html>', 200],
  ]) {
    const result = await checkProviderAvailability(
      connection,
      new AbortController().signal,
      async () => new Response(body, { status }),
    );
    assert.equal(result.status, 'failing');
    assert.ok(result.error);
    assert.ok(result.finishedAt);
  }
  const cancelled = new AbortController();
  cancelled.abort();
  const result = await checkProviderAvailability(
    connection,
    cancelled.signal,
    async (_url, init) => {
      init.signal.throwIfAborted();
    },
  );
  assert.equal(result.status, 'unknown');
});

test('provider error echoes are redacted even when JSON uses equivalent Unicode escapes', async () => {
  const escaped = connection.apiKey.replaceAll('-', String.raw`\u002d`);
  const result = await checkProviderAvailability(
    connection,
    new AbortController().signal,
    async () =>
      new Response(`{"error":{"message":"${escaped}"}}`, { status: 401 }),
  );
  assert.ok(!JSON.stringify(result).includes(connection.apiKey));
  assert.ok(result.error.includes('[REDACTED]'));
});

test('scheduler signature authenticates exact payload and rejects tampering and old/future timestamps', async () => {
  const secret = 's'.repeat(64);
  const timestamp = String(now);
  const body = JSON.stringify({ action: 'list', slot });
  const signature = await signProbeTick(secret, timestamp, body);
  assert.equal(
    await verifyProbeTick(secret, timestamp, signature, body, now),
    true,
  );
  assert.equal(
    await verifyProbeTick(secret, timestamp, signature, body + ' ', now),
    false,
  );
  assert.equal(
    await verifyProbeTick('wrong'.repeat(10), timestamp, signature, body, now),
    false,
  );
  assert.equal(
    await verifyProbeTick(secret, timestamp, signature, body, now + 120001),
    false,
  );
  assert.equal(
    await verifyProbeTick(secret, timestamp, signature, body, now - 120001),
    false,
  );
  assert.equal(await verifyProbeTick(secret, null, null, body, now), false);
});

test('the real scheduler batches targets, signs every request and treats recorded provider failures as completed checks', async () => {
  const env = {
    SITE_ORIGIN: 'https://example.com',
    AVAILABILITY_TRIGGER_SECRET: 's'.repeat(64),
  };
  const ids = Array.from({ length: 25 }, (_, i) => `target-${i}`);
  const calls = [];
  const result = await triggerAvailability(
    env,
    now,
    async (url, init) => {
      assert.equal(String(url), 'https://example.com/api/availability/tick');
      assert.equal(init.redirect, 'manual');
      assert.ok(
        await verifyProbeTick(
          env.AVAILABILITY_TRIGGER_SECRET,
          init.headers['x-probe-timestamp'],
          init.headers['x-probe-signature'],
          init.body,
        ),
      );
      const payload = JSON.parse(init.body);
      calls.push(payload);
      return Response.json(
        payload.action === 'list'
          ? { ids }
          : { checked: payload.ids.length, ok: 0, failing: payload.ids.length },
      );
    },
    async () => {},
  );
  assert.deepEqual(result, { targets: 25, batches: 3 });
  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.filter((x) => x.action === 'check').flatMap((x) => x.ids),
    ids,
  );
  assert.ok(calls.every((x) => x.slot === slot));
});

test('scheduler retries transient delivery failure without changing slot, and never retries authorization failure', async () => {
  const env = {
    SITE_ORIGIN: 'https://example.com',
    AVAILABILITY_TRIGGER_SECRET: 's'.repeat(64),
  };
  const calls = [];
  await triggerAvailability(
    env,
    now,
    async (_url, init) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1)
        return new Response('unavailable', { status: 503 });
      return Response.json({ ids: [] });
    },
    async () => {},
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  let authCalls = 0;
  await assert.rejects(
    triggerAvailability(
      env,
      now,
      async () => {
        authCalls++;
        return new Response('unauthorized', { status: 401 });
      },
      async () => {},
    ),
  );
  assert.equal(authCalls, 1);
});
