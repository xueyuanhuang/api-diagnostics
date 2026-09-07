import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assignHistoryConnection } from '../lib/server/history-assignment.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE connection_profiles (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, api_type TEXT, base_url TEXT);
    CREATE TABLE profile_api_configs (id TEXT PRIMARY KEY, profile_id TEXT, api_type TEXT, base_url TEXT);
    CREATE TABLE test_runs (id TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT, profile_name TEXT, api_type TEXT, base_url TEXT, model_name TEXT, normal_count INTEGER, created_at INTEGER);
    CREATE TABLE test_results (run_id TEXT, request_body TEXT, raw_response TEXT, request_id TEXT);
    INSERT INTO connection_profiles VALUES ('p','u','IDT-ccmax-蒸馏','anthropic','http://45.58.184.227:3000');
    INSERT INTO connection_profiles VALUES ('foreign','other','Other owner','anthropic','http://45.58.184.227:3000');
    INSERT INTO profile_api_configs VALUES ('c','p','anthropic','http://45.58.184.227:3000/');
    INSERT INTO profile_api_configs VALUES ('o','p','openai','https://example.com/v1');
    INSERT INTO test_runs VALUES ('r','u',NULL,NULL,'anthropic','http://45.58.184.227:3000','claude-opus-5',12,12345);
    INSERT INTO test_results VALUES ('r','exact-request','exact-response','request-123');
  `);
  const sqlLog = [];
  let beforeUpdate;
  const db = {
    prepare(sql) {
      sqlLog.push(sql);
      return {
        bind(...args) {
          return {
            async first() {
              return sqlite.prepare(sql).get(...args) ?? null;
            },
            async run() {
              if (beforeUpdate) {
                const fn = beforeUpdate;
                beforeUpdate = null;
                fn();
              }
              const result = sqlite.prepare(sql).run(...args);
              return { meta: { changes: Number(result.changes) } };
            },
          };
        },
      };
    },
  };
  return {
    db,
    sqlite,
    sqlLog,
    race(fn) {
      beforeUpdate = fn;
    },
  };
}
const status = (n) => (error) => error.status === n;

test('history association changes only two metadata fields and keeps evidence/timestamps intact', async () => {
  const f = fixture();
  try {
    const before = f.sqlite.prepare('SELECT * FROM test_runs').get();
    const evidence = f.sqlite.prepare('SELECT * FROM test_results').get();
    assert.deepEqual(await assignHistoryConnection(f.db, 'u', 'r', 'p'), {
      id: 'r',
      profileId: 'p',
      profileName: 'IDT-ccmax-蒸馏',
    });
    assert.deepEqual(
      { ...f.sqlite.prepare('SELECT * FROM test_runs').get() },
      { ...before, profile_id: 'p', profile_name: 'IDT-ccmax-蒸馏' },
    );
    assert.deepEqual(
      f.sqlite.prepare('SELECT * FROM test_results').get(),
      evidence,
    );
    assert.ok(
      f.sqlLog.every(
        (sql) => !/encrypted|key_iv|UPDATE test_results/i.test(sql),
      ),
    );
    await assert.rejects(
      assignHistoryConnection(f.db, 'u', 'r', 'p'),
      status(409),
    );
  } finally {
    f.sqlite.close();
  }
});

test('assignment rejects anonymous access and both directions of cross-owner access', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      assignHistoryConnection(f.db, '', 'r', 'p'),
      status(401),
    );
    await assert.rejects(
      assignHistoryConnection(f.db, 'other', 'r', 'p'),
      status(404),
    );
    await assert.rejects(
      assignHistoryConnection(f.db, 'u', 'r', 'foreign'),
      status(404),
    );
    assert.equal(
      f.sqlite.prepare('SELECT profile_id FROM test_runs').get().profile_id,
      null,
    );
  } finally {
    f.sqlite.close();
  }
});

test('assignment rejects mismatched protocol/base URL and preserves deleted-profile names', async () => {
  const f = fixture();
  try {
    f.sqlite.exec("UPDATE test_runs SET api_type = 'openai'");
    await assert.rejects(
      assignHistoryConnection(f.db, 'u', 'r', 'p'),
      status(409),
    );
    f.sqlite.exec(
      "UPDATE test_runs SET api_type = 'anthropic', base_url = 'http://45.58.184.227:4000'",
    );
    await assert.rejects(
      assignHistoryConnection(f.db, 'u', 'r', 'p'),
      status(409),
    );
    f.sqlite.exec(
      "UPDATE test_runs SET base_url = 'http://45.58.184.227:3000', profile_name = 'Deleted profile'",
    );
    await assert.rejects(
      assignHistoryConnection(f.db, 'u', 'r', 'p'),
      status(409),
    );
    assert.equal(
      f.sqlite.prepare('SELECT profile_name FROM test_runs').get().profile_name,
      'Deleted profile',
    );
  } finally {
    f.sqlite.close();
  }
});

test('atomic update refuses a target configuration change after initial validation', async () => {
  const f = fixture();
  try {
    f.race(() =>
      f.sqlite.exec(
        "UPDATE profile_api_configs SET base_url = 'https://example.org' WHERE id = 'c'",
      ),
    );
    await assert.rejects(
      assignHistoryConnection(f.db, 'u', 'r', 'p'),
      status(409),
    );
    assert.equal(
      f.sqlite.prepare('SELECT profile_id FROM test_runs').get().profile_id,
      null,
    );
  } finally {
    f.sqlite.close();
  }
});

test('PATCH requires real sign-in and JSON; refreshed history metadata feeds both export paths', () => {
  const route = readFileSync(
    new URL('../app/api/runs/[id]/route.ts', import.meta.url),
    'utf8',
  );
  const app = readFileSync(
    new URL('../components/token-check-app.tsx', import.meta.url),
    'utf8',
  );
  assert.match(route, /const user = await getChatGPTUser\(\)/);
  assert.match(route, /if \(!user\)\s+return noStore/);
  assert.match(
    route,
    /assignHistoryConnection\(env.DB, user.userId, id, profileId\)/,
  );
  assert.match(route, /Cross-origin changes are not allowed/);
  assert.match(app, /setSavedPreview\([\s\S]*?run: update\(current.run\)/);
  assert.match(app, /profileName: data.run.profileName/);
});
