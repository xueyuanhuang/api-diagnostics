import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { rememberModels } from '../lib/server/remember-models.ts';

const input = (models) => ({
  apiType: 'anthropic',
  baseUrl: 'https://example.com/',
  models,
});
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE connection_profiles(id TEXT PRIMARY KEY,user_id TEXT,name TEXT,encrypted_api_key TEXT);
    CREATE TABLE profile_api_configs(id TEXT PRIMARY KEY,profile_id TEXT,api_type TEXT,base_url TEXT,model_name TEXT,encrypted_api_key TEXT);
    CREATE TABLE profile_api_models(id TEXT PRIMARY KEY,config_id TEXT,model_name TEXT,position INTEGER,created_at INTEGER,UNIQUE(config_id,model_name));
    CREATE TABLE test_runs(user_id TEXT,profile_id TEXT,api_type TEXT,base_url TEXT,model_name TEXT);
    INSERT INTO connection_profiles VALUES ('p','u','Saved','unchanged');
    INSERT INTO profile_api_configs VALUES ('a','p','anthropic','https://example.com','old','a-secret'),('o','p','openai','https://example.com','gpt','o-secret');
    INSERT INTO profile_api_models VALUES ('old','a','old',0,1),('gpt','o','gpt',0,1);
  `);
  const queries = [];
  let race;
  const db = {
    prepare(sql) {
      queries.push(sql);
      return {
        bind(...args) {
          return {
            first: async () => sqlite.prepare(sql).get(...args) ?? null,
            all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
            run: async () => {
              if (race) {
                const fn = race;
                race = null;
                fn();
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
  return {
    db,
    sqlite,
    queries,
    race: (fn) => {
      race = fn;
    },
    models: (type = 'a') =>
      sqlite
        .prepare(
          'SELECT model_name FROM profile_api_models WHERE config_id = ? ORDER BY position,created_at,model_name',
        )
        .all(type)
        .map((r) => r.model_name),
  };
}

test('append preserves defaults, other API, keys; dedupes across parallel batches and reloads', async () => {
  const f = fixture();
  try {
    const before = f.sqlite
      .prepare('SELECT * FROM profile_api_configs ORDER BY id')
      .all();
    await Promise.all([
      rememberModels(f.db, 'u', 'p', input([' old ', 'new-a', 'new-a'])),
      rememberModels(f.db, 'u', 'p', input(['new-b'])),
    ]);
    assert.deepEqual(new Set(f.models()), new Set(['old', 'new-a', 'new-b']));
    assert.deepEqual(f.models('o'), ['gpt']);
    assert.deepEqual(
      f.sqlite.prepare('SELECT * FROM profile_api_configs ORDER BY id').all(),
      before,
    );
    const again = await rememberModels(
      f.db,
      'u',
      'p',
      input(['new-a', 'new-b']),
    );
    assert.equal(again.added, 0);
    assert.deepEqual(new Set(again.models), new Set(f.models()));
    assert.ok(
      f.queries.every((sql) => !/encrypted|key_iv|UPDATE |DELETE /i.test(sql)),
    );
  } finally {
    f.sqlite.close();
  }
});

test('history restores nine missing models, excludes other owner/API/URL, and is idempotent', async () => {
  const f = fixture();
  try {
    const add = f.sqlite.prepare('INSERT INTO test_runs VALUES (?,?,?,?,?)');
    // Old records remain recoverable even when newer rows exceed the UI history page.
    for (let i = 0; i < 60; i++)
      add.run('u', 'p', 'anthropic', 'https://example.com/', 'm' + (i % 9));
    add.run('other', 'p', 'anthropic', 'https://example.com', 'foreign-owner');
    add.run(
      'u',
      'other',
      'anthropic',
      'https://example.com',
      'foreign-profile',
    );
    add.run('u', 'p', 'openai', 'https://example.com', 'other-api');
    add.run('u', 'p', 'anthropic', 'https://other.com', 'other-url');
    const result = await rememberModels(f.db, 'u', 'p', {
      ...input(),
      source: 'history',
    });
    assert.equal(result.added, 9);
    assert.equal(result.models.length, 10);
    assert.equal(
      (await rememberModels(f.db, 'u', 'p', { ...input(), source: 'history' }))
        .added,
      0,
    );
    assert.deepEqual(f.models('o'), ['gpt']);
  } finally {
    f.sqlite.close();
  }
});

test('ownership, URL mismatch, invalid model, legacy config, and over-limit requests make no writes', async () => {
  const f = fixture();
  try {
    for (const [user, id, payload] of [
      ['', 'p', input(['x'])],
      ['other', 'p', input(['x'])],
      ['u', 'missing', input(['x'])],
      ['u', 'p', { ...input(['x']), baseUrl: 'https://other.com' }],
      ['u', 'p', input([''])],
      ['u', 'p', input(['x'.repeat(121)])],
      ['u', 'p', input(Array.from({ length: 20 }, (_, i) => 'm' + i))],
    ])
      await assert.rejects(rememberModels(f.db, user, id, payload));
    assert.deepEqual(f.models(), ['old']);
  } finally {
    f.sqlite.close();
  }
});

test('atomic capacity guard adds nothing when another batch fills the list first', async () => {
  const f = fixture();
  try {
    f.race(() => {
      for (let i = 0; i < 18; i++)
        f.sqlite
          .prepare('INSERT INTO profile_api_models VALUES (?,?,?,?,?)')
          .run('r' + i, 'a', 'r' + i, i + 1, 2);
    });
    await assert.rejects(
      rememberModels(f.db, 'u', 'p', input(['new-a', 'new-b'])),
      (e) => e.status === 409,
    );
    assert.equal(f.models().length, 19);
    assert.equal(f.models().includes('new-a'), false);
    assert.equal(f.models().includes('new-b'), false);
  } finally {
    f.sqlite.close();
  }
});

test('configuration change at write time cannot add a model to the wrong destination', async () => {
  const f = fixture();
  try {
    f.race(() =>
      f.sqlite.exec(
        "UPDATE profile_api_configs SET base_url='https://changed.com' WHERE id='a'",
      ),
    );
    await assert.rejects(
      rememberModels(f.db, 'u', 'p', input(['new'])),
      (e) => e.status === 409,
    );
    assert.deepEqual(f.models(), ['old']);
  } finally {
    f.sqlite.close();
  }
});

test('metadata endpoint authenticates and never touches provider requests or credentials', () => {
  const route = readFileSync(
    new URL('../app/api/profiles/[id]/models/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(route, /getChatGPTUser/);
  assert.match(route, /user\.userId/);
  assert.match(route, /Cross-origin/);
  assert.doesNotMatch(route, /encryptApiKey|testFetch|\/v1\/messages/);
  const component = readFileSync(
    new URL('../components/token-check-app.tsx', import.meta.url),
    'utf8',
  );
  assert.match(component, /startBlocked=\{isRunning \|\| profileBusy\}/);
});
