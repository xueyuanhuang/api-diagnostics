import { env } from 'cloudflare:workers';
import { safeRelativeReturnPath } from '@/lib/auth-paths';
import { cookie, FLOW_COOKIE, randomToken, redirect, tokenHash } from '@/lib/server/google-auth';

export async function GET(request: Request) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.APP_ORIGIN) {
    return new Response('Google sign-in is awaiting deployment configuration. Please try again later.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const token = randomToken(), state = randomToken(), verifier = randomToken(), nonce = randomToken();
  const returnTo = safeRelativeReturnPath(new URL(request.url).searchParams.get('return_to') ?? '/');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_flows WHERE expires_at <= ?').bind(Date.now()),
    env.DB.prepare('INSERT INTO auth_flows (token_hash, state, verifier, nonce, return_to, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(await tokenHash(token), state, verifier, nonce, returnTo, Date.now() + 600_000),
  ]);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.APP_ORIGIN}/auth/google/callback`, response_type: 'code', scope: 'openid email profile',
    state, nonce, code_challenge: await tokenHash(verifier), code_challenge_method: 'S256',
  }).toString();
  return redirect(url.href, [cookie(FLOW_COOKIE, token, 600)]);
}
