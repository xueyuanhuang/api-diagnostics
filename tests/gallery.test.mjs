import test from 'node:test';
import { createHash } from 'node:crypto';
const ownerHash = createHash('sha256').update('owner@example.com').digest('hex');
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { canManageGallery, publicGallery } from '../lib/server/gallery.ts';

test('gallery management requires the configured owner and fails closed', () => {
  assert.equal(canManageGallery(null, ownerHash), false);
  assert.equal(canManageGallery({email:'someone@example.com'}, ownerHash), false);
  assert.equal(canManageGallery({email:'owner@example.com'}, undefined), false);
  assert.equal(canManageGallery({email:'OWNER@example.com'}, ownerHash), true);
});
test('published replacements override seeds and new examples append without leaking storage details', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0013_public_gallery.sql', import.meta.url), 'utf8'));
  const db = {prepare: sql => ({all: async () => ({results:sqlite.prepare(sql).all()})})};
  assert.equal((await publicGallery(db)).length, 3);
  const insert = sqlite.prepare('INSERT INTO public_gallery VALUES (?, ?, ?, ?, ?, ?, ?)');
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
