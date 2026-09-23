import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';
import * as orm from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from '../db/schema.ts';
import * as modelHelpers from '../lib/profile-models.ts';
import * as profileInput from '../lib/server/profile-input.ts';
import { rememberModels } from '../lib/server/remember-models.ts';

const sources = Object.fromEntries([
  'app/api/profiles/route.ts', 'app/api/profiles/[id]/route.ts', 'lib/server/profile-config.ts',
].map(path => [path, ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText]));

function fixture() {
  const sql = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    sql.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  }
  for (const [id, user] of [['p', 'owner'], ['other', 'someone-else']]) {
    sql.prepare('INSERT INTO connection_profiles VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, user, id, 'anthropic', 'https://legacy.example.com', 'parent-key', 'parent-iv', 1, 1);
  }
  for (const [id, profile, type, model] of [['a', 'p', 'anthropic', 'claude'], ['o', 'p', 'openai', 'gpt'], ['x', 'other', 'openai', 'private']]) {
    sql.prepare('INSERT INTO profile_api_configs VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, profile, type, `https://${id}.example.com`, model, `${id}-key`, `${id}-iv`, 1, 1);
    sql.prepare('INSERT INTO profile_api_models VALUES (?,?,?,?,?)').run(id, id, model, 0, 1);
  }
  sql.prepare('INSERT INTO profile_models VALUES (?,?,?,?)').run('legacy', 'p', 'legacy-only', 1);
  sql.prepare('INSERT INTO profile_api_models VALUES (?,?,?,?,?)').run('custom', 'a', 'custom-model', 1, 1);
  const rawDb = {
    prepare(query) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return sql.prepare(query).get(...args) ?? null; },
        async all() { return { results: sql.prepare(query).all(...args) }; },
        async run() { return { meta: { changes: Number(sql.prepare(query).run(...args).changes) } }; },
      };
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sql.exec('COMMIT');
        return results;
      } catch (e) { sql.exec('ROLLBACK'); throw e; }
    },
  };
  const db = drizzle(async (query, params, method) => {
    const statement = sql.prepare(query);
    statement.setReturnArrays(true);
    return { rows: method === 'get' ? statement.get(...params) : statement.all(...params) };
  }, { schema });
  const modules = {
    'cloudflare:workers': { env: { DB: rawDb } },
    'drizzle-orm': orm,
    '@/db': { getDb: () => db },
    '@/db/schema': schema,
    '@/app/chatgpt-auth': { getChatGPTUser: async () => ({ userId: 'owner' }) },
    '@/lib/profile-models': modelHelpers,
    '@/lib/server/profile-input': profileInput,
    '@/lib/server/encryption': { encryptApiKey: async key => ({ encryptedApiKey: `encrypted:${key}`, keyIv: 'new-iv' }) },
    '@/lib/server/http': { noStore: (value, init) => Response.json(value, init), serverError: error => { throw error; } },
  };
  const load = path => {
    const context = { exports: {}, require: name => {
      if (!(name in modules)) throw new Error('Unexpected import: ' + name);
      return modules[name];
    }, crypto: webcrypto, Date, console };
    vm.runInNewContext(sources[path], context);
    return context.exports;
  };
  return {
    sql, rawDb,
    routes: load('app/api/profiles/route.ts'),
    edit: load('app/api/profiles/[id]/route.ts'),
    owned: load('lib/server/profile-config.ts').getOwnedProfileConfig,
  };
}
const catalog = ['claude', 'custom-model', 'gpt', 'legacy-only'];
const modelsOf = profile => [...profile.configs.anthropic.models].sort();

async function getProfile(f, id = 'p') {
  return (await (await f.routes.GET()).json()).profiles.find(p => p.id === id);
}

test('existing catalogs merge without losing legacy models or changing per-format secrets/defaults', async () => {
  const f = fixture();
  try {
    const before = f.sql.prepare('SELECT * FROM profile_api_configs ORDER BY id').all();
    const profile = await getProfile(f);
    assert.deepEqual(modelsOf(profile), catalog);
    assert.deepEqual(profile.configs.anthropic.models, profile.configs.openai.models);
    assert.equal(profile.configs.anthropic.model, 'claude');
    assert.equal(profile.configs.openai.model, 'gpt');
    assert.equal(profile.configs.openai.baseUrl, 'https://o.example.com');
    assert.equal(JSON.stringify(profile).includes('o-key'), false);
    for (const [apiType, prefix] of [['anthropic', 'a'], ['openai', 'o']]) {
      const config = await f.owned({ userId: 'owner', profileId: 'p', apiType, requestedModel: 'custom-model' });
      assert.equal(config.modelName, 'custom-model');
      assert.equal(config.baseUrl, `https://${prefix}.example.com`);
      assert.equal(config.encryptedApiKey, `${prefix}-key`);
      assert.deepEqual([...config.models].sort(), catalog);
    }
    assert.equal(await f.owned({ userId: 'someone-else', profileId: 'p', apiType: 'openai' }), null);
    assert.equal(await f.owned({ userId: 'owner', profileId: 'p', requestedModel: 'private' }), null);
    assert.deepEqual(f.sql.prepare('SELECT * FROM profile_api_configs ORDER BY id').all(), before);
  } finally { f.sql.close(); }
});

test('adding from either format updates both pickers and server validation after reload', async () => {
  const f = fixture();
  try {
    for (const [apiType, prefix] of [['anthropic', 'a'], ['openai', 'o']]) {
      const payload = { apiType, baseUrl: `https://${prefix}.example.com`, models: ['new-shared'] };
      const saved = await rememberModels(f.rawDb, 'owner', 'p', payload);
      assert.equal(saved.added, apiType === 'anthropic' ? 1 : 0);
      const profile = await getProfile(f);
      assert.deepEqual(profile.configs.anthropic.models, profile.configs.openai.models);
      assert.ok(profile.configs.openai.models.includes('new-shared'));
      const config = await f.owned({ userId: 'owner', profileId: 'p', apiType: 'openai', requestedModel: 'new-shared' });
      assert.equal(config.encryptedApiKey, 'o-key');
    }
  } finally { f.sql.close(); }
});

test('editing a shared list removes from both formats and preserves the other format settings', async () => {
  const f = fixture();
  try {
    const sharedModels = ['claude', 'gpt', 'replacement'];
    const response = await f.edit.PATCH({ json: async () => ({
      name: 'edited', apiType: 'anthropic', baseUrl: 'https://new-a.example.com', apiKey: '',
      models: sharedModels, sharedModels,
    }) }, { params: Promise.resolve({ id: 'p' }) });
    assert.equal(response.status, 200);
    const reloaded = await getProfile(f);
    assert.deepEqual(modelsOf(reloaded), sharedModels);
    assert.deepEqual(reloaded.configs.openai.models, reloaded.configs.anthropic.models);
    const openai = await f.owned({ userId: 'owner', profileId: 'p', apiType: 'openai' });
    assert.equal(openai.baseUrl, 'https://o.example.com');
    assert.equal(openai.encryptedApiKey, 'o-key');
    assert.equal(openai.modelName, 'gpt');
    assert.equal(await f.owned({ userId: 'owner', profileId: 'p', apiType: 'openai', requestedModel: 'custom-model' }), null);
  } finally { f.sql.close(); }
});

test('new profiles merge both supplied catalogs and keep independent defaults and keys', async () => {
  const f = fixture();
  try {
    const response = await f.routes.POST({ json: async () => ({ name: 'new', defaultApiType: 'anthropic', configs: {
      anthropic: { baseUrl: 'https://anthropic.example.com', model: 'a-default', models: ['a-extra'], apiKey: 'anthropic-key' },
      openai: { baseUrl: 'https://openai.example.com', model: 'o-default', models: ['o-extra'], apiKey: 'openai-key' },
    } }) });
    assert.equal(response.status, 201);
    const { profile } = await response.json();
    const reloaded = await getProfile(f, profile.id);
    assert.deepEqual(modelsOf(reloaded), ['a-default', 'a-extra', 'o-default', 'o-extra']);
    const config = await f.owned({ userId: 'owner', profileId: profile.id, apiType: 'openai', requestedModel: 'a-extra' });
    assert.equal(config.encryptedApiKey, 'encrypted:openai-key');
    assert.equal(reloaded.configs.openai.model, 'o-default');
  } finally { f.sql.close(); }
});

test('model capacity is enforced across both catalogs, including legacy entries', async () => {
  const f = fixture();
  try {
    const before = await getProfile(f);
    await assert.rejects(rememberModels(f.rawDb, 'owner', 'p', {
      apiType: 'openai', baseUrl: 'https://o.example.com', models: Array.from({ length: 197 }, (_, i) => 'm' + i),
    }), error => error.status === 409);
    assert.deepEqual(await getProfile(f), before);
  } finally { f.sql.close(); }
});
