import { headers } from 'next/headers';
import { env } from 'cloudflare:workers';
import { readCookie, SESSION_COOKIE, tokenHash } from '@/lib/server/google-auth';
export { chatGPTSignInPath, chatGPTSignOutPath } from '@/lib/auth-paths';

export type ChatGPTUser = { userId: string; displayName: string; email: string; fullName: string | null };

// Retain the existing internal API name; identity now comes only from a server session.
export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const h = await headers();
  if (h.get('sec-fetch-site') === 'cross-site' || (h.get('origin') && h.get('origin') !== env.APP_ORIGIN)) return null;
  const token = readCookie(h.get('cookie'), SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await env.DB.prepare(
    'SELECT user_id, email, full_name FROM auth_sessions WHERE token_hash = ? AND expires_at > ?',
  ).bind(await tokenHash(token), Date.now()).first<{user_id: string; email: string; full_name: string | null}>();
  return row ? { userId: row.user_id, email: row.email, fullName: row.full_name, displayName: row.full_name ?? row.email } : null;
}
