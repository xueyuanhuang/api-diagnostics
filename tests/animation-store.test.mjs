import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { parseAnimation } from '../lib/animation-results.ts';
import { listAnimations, readAnimation, saveAnimation } from '../lib/server/animation-store.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0007_stormy_prodigy.sql', import.meta.url), 'utf8'));
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
