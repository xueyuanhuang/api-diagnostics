import test from 'node:test';
import { createHash } from 'node:crypto';
const ownerHash = createHash('sha256').update('owner@example.com').digest('hex');
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { canManageGallery, publicGallery, publicGalleryObjectKey, removePublicGalleryExample } from '../lib/server/gallery.ts';

function galleryDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['0013_public_gallery.sql', '0014_public_gallery_removed.sql']) {
    sqlite.exec(readFileSync(new URL(`../drizzle/${migration}`, import.meta.url), 'utf8'));
  }
  const db = {prepare: sql => {
    const statement = sqlite.prepare(sql);
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      all: async () => ({results: statement.all(...values)}),
      first: async () => statement.get(...values) ?? null,
      run: async () => statement.run(...values),
    };
  }};
  const insert = sqlite.prepare('INSERT INTO public_gallery VALUES (?, ?, ?, ?, ?, ?, ?)');
  return {sqlite, db, insert};
}

test('gallery management requires the configured owner and fails closed', () => {
  assert.equal(canManageGallery(null, ownerHash), false);
  assert.equal(canManageGallery({email:'someone@example.com'}, ownerHash), false);
  assert.equal(canManageGallery({email:'owner@example.com'}, undefined), false);
  assert.equal(canManageGallery({email:'OWNER@example.com'}, ownerHash), true);
});
test('published replacements override seeds and new examples append without leaking storage details', async () => {
  const {sqlite, db, insert} = galleryDatabase();
  assert.equal((await publicGallery(db)).length, 3);
  insert.run('gpt-6-astra', 'replacement-model', 'new animation', '12.0', '100', 'private-object-path', 1);
  insert.run('new-example', 'new-model', 'another animation', '10.0', '200', 'another-object', 2);
  const examples = await publicGallery(db);
  assert.equal(examples.length, 4);
  assert.equal(examples[0].name, 'replacement-model');
  assert.equal(examples[3].name, 'new-model');
  assert.equal(examples[0].url, '/api/gallery/gpt-6-astra?v=1');
  assert.equal(JSON.stringify(examples).includes('private-object-path'), false);
  assert.equal('object_key' in examples[0], false);
  sqlite.close();
});

test('deleting a seeded example survives subsequent gallery loads without a replacement', async () => {
  const {sqlite, db} = galleryDatabase();
  assert.equal(await removePublicGalleryExample(db, 'gpt-6-astra'), true);
  for (let load = 0; load < 2; load++) {
    const examples = await publicGallery(db);
    assert.equal(examples.length, 2);
    assert.equal(examples.some(example => example.id === 'gpt-6-astra'), false);
  }
  assert.equal(await removePublicGalleryExample(db, 'gpt-6-astra'), false);
  assert.equal(await removePublicGalleryExample(db, 'missing'), false);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM public_gallery_removed').get().count, 1);
  sqlite.close();
});

test('deleting a published example removes its public object access but retains the stored animation', async () => {
  const {sqlite, db, insert} = galleryDatabase();
  insert.run('new-example', 'new-model', 'another animation', '10.0', '200', 'retained-object', 2);
  assert.equal(await publicGalleryObjectKey(db, 'new-example'), 'retained-object');
  assert.equal(await removePublicGalleryExample(db, 'new-example'), true);
  assert.equal((await publicGallery(db)).length, 3);
  assert.equal(await publicGalleryObjectKey(db, 'new-example'), null);
  assert.equal(await publicGalleryObjectKey(db, 'unknown'), null);
  assert.equal(sqlite.prepare('SELECT object_key FROM public_gallery WHERE id = ?').get('new-example').object_key, 'retained-object');
  sqlite.close();
});

test('deleting a replaced seed does not resurrect its bundled animation', async () => {
  const {sqlite, db, insert} = galleryDatabase();
  insert.run('gpt-6-astra', 'replacement-model', 'new animation', '12.0', '100', 'replacement-object', 1);
  assert.equal((await publicGallery(db))[0].name, 'replacement-model');
  assert.equal(await removePublicGalleryExample(db, 'gpt-6-astra'), true);
  assert.equal(await publicGalleryObjectKey(db, 'gpt-6-astra'), null);
  assert.equal((await publicGallery(db)).some(example => example.id === 'gpt-6-astra'), false);
  // A late replacement write must not make the removed example public again.
  sqlite.prepare('UPDATE public_gallery SET object_key = ? WHERE id = ?').run('late-object', 'gpt-6-astra');
  assert.equal(await publicGalleryObjectKey(db, 'gpt-6-astra'), null);
  assert.equal((await publicGallery(db)).some(example => example.id === 'gpt-6-astra'), false);
  sqlite.close();
});

test('removing every example returns an empty gallery rather than the seed list', async () => {
  const {sqlite, db, insert} = galleryDatabase();
  insert.run('new-example', 'new-model', 'another animation', '10.0', '200', 'retained-object', 2);
  for (const example of await publicGallery(db)) {
    assert.equal(await removePublicGalleryExample(db, example.id), true);
  }
  assert.deepEqual(await publicGallery(db), []);
  assert.deepEqual(await publicGallery(db), []);
  sqlite.close();
});
