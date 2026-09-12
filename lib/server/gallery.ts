import { createHash } from 'node:crypto';
import { gallerySeeds, type GalleryExample } from '@/lib/gallery';
export function canManageGallery(user: { email: string } | null, owner: string | undefined) {
  return Boolean(owner && user && createHash('sha256').update(user.email.toLowerCase()).digest('hex') === owner);
}
export async function publicGallery(db: D1Database): Promise<GalleryExample[]> {
  const rows = await db.prepare('SELECT id, name, description, seconds, tokens, updated_at FROM public_gallery ORDER BY updated_at').all<GalleryExample & {updated_at: number}>();
  const entries = new Map(gallerySeeds.map(item => [item.id, item]));
  for (const row of rows.results) entries.set(row.id, {id: row.id, name: row.name, description: row.description, seconds: row.seconds, tokens: row.tokens, url: `/api/gallery/${encodeURIComponent(row.id)}?v=${row.updated_at}`});
  return [...entries.values()];
}
