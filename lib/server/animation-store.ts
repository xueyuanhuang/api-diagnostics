import type { AnimationSummary, SavedAnimation } from '@/lib/animation-results';

type Storage = { DB: D1Database; EVIDENCE: R2Bucket };

export async function listAnimations(env: Storage, userId: string, cursor?: string | null): Promise<AnimationSummary[]> {
  const [timestamp, lastId] = cursor?.split(':') ?? [];
  const before = Number(timestamp) || Date.now() + 1;
  const rows = await env.DB.prepare('SELECT id, model, created_at, connection_name, key_hint FROM animation_results WHERE user_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 100').bind(userId, before, before, lastId || '\uffff').all<{ id: string; model: string; created_at: number; connection_name: string | null; key_hint: string | null }>();
  return rows.results.map(row => ({ id: row.id, model: row.model, connectionName: row.connection_name, keyHint: row.key_hint, savedAt: new Date(row.created_at).toISOString() }));
}

export async function readAnimation(env: Storage, userId: string, id: string): Promise<SavedAnimation | null> {
  const row = await env.DB.prepare('SELECT evidence_key FROM animation_results WHERE user_id = ? AND id = ?').bind(userId, id).first<{ evidence_key: string }>();
  if (!row) return null;
  const object = await env.EVIDENCE.get(row.evidence_key);
  if (!object) throw new Error('Saved animation content is unavailable');
  return await object.json<SavedAnimation>();
}

export async function saveAnimation(env: Storage, userId: string, animation: SavedAnimation) {
  const existing = await env.DB.prepare('SELECT id, model, created_at, connection_name, key_hint FROM animation_results WHERE user_id = ? AND id = ?').bind(userId, animation.id).first<{ id: string; model: string; created_at: number; connection_name: string | null; key_hint: string | null }>();
  if (existing) return { id: existing.id, model: existing.model, connectionName: existing.connection_name, keyHint: existing.key_hint, savedAt: new Date(existing.created_at).toISOString() };
  const key = `animation-results/${encodeURIComponent(userId)}/${animation.id}.json`;
  const createdAt = Date.now();
  const saved = { ...animation, savedAt: new Date(createdAt).toISOString() };
  await env.EVIDENCE.put(key, JSON.stringify(saved), { httpMetadata: { contentType: 'application/json' } });
  await env.DB.prepare('INSERT INTO animation_results (user_id, id, model, evidence_key, created_at, connection_name, key_hint) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, id) DO NOTHING').bind(userId, animation.id, animation.model, key, createdAt, animation.result.connectionName ?? null, animation.result.keyHint ?? null).run();
  return { id: saved.id, model: saved.model, savedAt: saved.savedAt, connectionName: saved.result.connectionName ?? null, keyHint: saved.result.keyHint ?? null };
}
