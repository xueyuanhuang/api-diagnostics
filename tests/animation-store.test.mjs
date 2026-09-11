import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { animationConnectionLabel, parseAnimation } from '../lib/animation-results.ts';
import { listAnimations, readAnimation, saveAnimation } from '../lib/server/animation-store.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0007_stormy_prodigy.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../drizzle/0012_exotic_emma_frost.sql', import.meta.url), 'utf8'));
  const objects = new Map();
  const storage = {
    DB: { prepare: sql => ({ bind: (...args) => ({
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      run: async () => sqlite.prepare(sql).run(...args),
    }) }) },
    EVIDENCE: { put: async (key, body) => objects.set(key, body), get: async key => objects.has(key) ? { json: async () => JSON.parse(objects.get(key)) } : null },
  };
  return { sqlite, objects, storage };
}
const animation = () => parseAnimation({ id: crypto.randomUUID(), model: 'test-model', prompt: 'Draw a pelican', result: { answer: '<html>animation</html>', outputTokens: 12, apiKey: 'must-not-persist', rawResponse: 'must-not-persist' }, apiKey: 'must-not-persist' });

test('server result survives reload, belongs only to its owner, and retries do not duplicate it', async () => {
  const { storage, sqlite, objects } = fixture();
  try {
    const value = animation();
    const saved = await saveAnimation(storage, 'owner-a', value);
    assert.equal((await listAnimations(storage, 'owner-a'))[0].id, saved.id);
    assert.equal((await readAnimation(storage, 'owner-a', saved.id)).result.answer, value.result.answer);
    assert.equal(await readAnimation(storage, 'owner-b', saved.id), null);
    assert.deepEqual(await listAnimations(storage, 'owner-b'), []);
    await saveAnimation(storage, 'owner-a', value);
    assert.equal((await listAnimations(storage, 'owner-a')).length, 1);
    assert.equal(objects.size, 1);
    assert.ok(![...objects.values()][0].includes('must-not-persist'));
  } finally { sqlite.close(); }
});
test('failed blob write is not reported as a saved result', async () => {
  const { storage, sqlite } = fixture();
  try {
    storage.EVIDENCE.put = async () => { throw new Error('Storage unavailable'); };
    await assert.rejects(saveAnimation(storage, 'owner', animation()), /Storage unavailable/);
    assert.deepEqual(await listAnimations(storage, 'owner'), []);
  } finally { sqlite.close(); }
});
test('pagination retains results sharing the same timestamp', async () => {
  const { storage, sqlite } = fixture();
  try {
    for (let n = 0; n < 105; n++) await saveAnimation(storage, 'owner', animation());
    sqlite.exec('UPDATE animation_results SET created_at = 1000');
    const first = await listAnimations(storage, 'owner');
    const last = first.at(-1);
    const second = await listAnimations(storage, 'owner', `${Date.parse(last.savedAt)}:${last.id}`);
    assert.equal(first.length, 100); assert.equal(second.length, 5);
    assert.equal(new Set([...first, ...second].map(item => item.id)).size, 105);
  } finally { sqlite.close(); }
});

test('saved completion metadata survives reload without rewriting a clipped answer', async () => {
  const { storage, sqlite } = fixture();
  try {
    const value = parseAnimation({ ...animation(), result: { answer: '<svg><defs>', outputTokens: 16384, maxOutputTokens: 16384, finishReason: 'max_tokens' } });
    await saveAnimation(storage, 'owner', value);
    const restored = await readAnimation(storage, 'owner', value.id);
    assert.equal(restored.result.answer, '<svg><defs>');
    assert.equal(restored.result.finishReason, 'max_tokens');
    assert.equal(restored.result.maxOutputTokens, 16384);
  } finally { sqlite.close(); }
});


test('connection and masked key are immutable run snapshots in lists, details and retries', async () => {
  const { storage, sqlite, objects } = fixture();
  try {
    const value = parseAnimation({ ...animation(), result: { answer: '<svg></svg>', connectionName: 'Original provider', keyHint: 'uhvt', apiKey: 'secret-that-must-not-be-saved' } });
    const saved = await saveAnimation(storage, 'owner', value);
    assert.equal(animationConnectionLabel(saved), 'Original provider · ••••uhvt');
    const listed = (await listAnimations(storage, 'owner'))[0];
    assert.equal(listed.connectionName, 'Original provider');
    assert.equal(listed.keyHint, 'uhvt');
    const retry = await saveAnimation(storage, 'owner', { ...value, result: { ...value.result, connectionName: 'Renamed provider', keyHint: 'new1' } });
    assert.equal(retry.connectionName, 'Original provider');
    assert.equal(retry.keyHint, 'uhvt');
    assert.equal((await readAnimation(storage, 'owner', value.id)).result.keyHint, 'uhvt');
    assert.ok(![...objects.values()][0].includes('secret-that-must-not-be-saved'));
  } finally { sqlite.close(); }
});

test('legacy animation history is not attributed to the current connection', async () => {
  const { storage, sqlite } = fixture();
  try {
    await saveAnimation(storage, 'owner', animation());
    const saved = (await listAnimations(storage, 'owner'))[0];
    assert.equal(animationConnectionLabel(saved), 'Connection not recorded');
    assert.equal(saved.keyHint, null);
    const invalidHint = parseAnimation({ ...animation(), result: { answer: '<svg></svg>', keyHint: 'sk-a-complete-secret' } });
    assert.equal(invalidHint.result.keyHint, null);
  } finally { sqlite.close(); }
});
