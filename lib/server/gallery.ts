import { createHash } from 'node:crypto';
import { gallerySeeds, type GalleryExample } from '@/lib/gallery';
export function canManageGallery(user: { email: string } | null, owner: string | undefined) {
  return Boolean(owner && user && createHash('sha256').update(user.email.toLowerCase()).digest('hex') === owner);
}
export async function publicGallery(db: D1Database): Promise<GalleryExample[]> {
  const rows = await db.prepare('SELECT id, name, description, seconds, tokens, updated_at FROM public_gallery ORDER BY updated_at').all<GalleryExample & {updated_at: number}>();
  const removed = await db.prepare('SELECT id FROM public_gallery_removed').all<{id: string}>();
  const removedIds = new Set(removed.results.map(item => item.id));
  const entries = new Map(gallerySeeds.filter(item => !removedIds.has(item.id)).map(item => [item.id, item]));
  for (const row of rows.results) {
    if (!removedIds.has(row.id)) entries.set(row.id, {id: row.id, name: row.name, description: row.description, seconds: row.seconds, tokens: row.tokens, url: `/api/gallery/${encodeURIComponent(row.id)}?v=${row.updated_at}`});
  }
  return [...entries.values()];
}

export async function removePublicGalleryExample(db: D1Database, id: string): Promise<boolean> {
  if (!(await publicGallery(db)).some(example => example.id === id)) return false;
  // Keep the saved result and published object intact; a tombstone also prevents seed fallback.
  await db.prepare('INSERT INTO public_gallery_removed (id, removed_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING').bind(id, Date.now()).run();
  return true;
}

export async function publicGalleryObjectKey(db: D1Database, id: string): Promise<string | null> {
  const row = await db.prepare('SELECT object_key FROM public_gallery WHERE id = ? AND NOT EXISTS (SELECT 1 FROM public_gallery_removed WHERE public_gallery_removed.id = public_gallery.id)').bind(id).first<{object_key: string}>();
  return row?.object_key ?? null;
}
