import { env } from 'cloudflare:workers';
import { safeRelativeReturnPath } from '@/lib/auth-paths';
import { cookie, readCookie, redirect, SESSION_COOKIE, tokenHash } from '@/lib/server/google-auth';

export async function GET(request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await tokenHash(token)).run();
  const path = safeRelativeReturnPath(new URL(request.url).searchParams.get('return_to') ?? '/');
  return redirect(path, [cookie(SESSION_COOKIE, '', 0)]);
}
