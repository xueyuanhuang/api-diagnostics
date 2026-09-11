import { env } from 'cloudflare:workers';
import { cookie, FLOW_COOKIE, randomToken, readCookie, redirect, SESSION_COOKIE, SESSION_SECONDS, tokenHash, verifyGoogleIdentity } from '@/lib/server/google-auth';

export async function GET(request: Request) {
  const clearFlow = cookie(FLOW_COOKIE, '', 0);
  const fail = () => new Response('Sign-in could not be completed. Please return to the site and try again.', {
    status: 400, headers: { 'Cache-Control': 'no-store', 'Set-Cookie': clearFlow, 'Referrer-Policy': 'no-referrer' },
  });
  try {
    const params = new URL(request.url).searchParams;
    const token = readCookie(request.headers.get('cookie'), FLOW_COOKIE);
    const code = params.get('code'), state = params.get('state');
    if (!token || !code || !state || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.APP_ORIGIN) return fail();
    // Consume each flow atomically, before exchanging its one-time authorization code.
    const flow = await env.DB.prepare('DELETE FROM auth_flows WHERE token_hash = ? AND state = ? AND expires_at > ? RETURNING verifier, nonce, return_to')
      .bind(await tokenHash(token), state, Date.now()).first<{ verifier: string; nonce: string; return_to: string }>();
    if (!flow) return fail();
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${env.APP_ORIGIN}/auth/google/callback`, grant_type: 'authorization_code', code_verifier: flow.verifier }),
    });
    if (!response.ok) return fail();
    const data = await response.json() as { id_token?: string };
    if (!data.id_token) return fail();
    const user = await verifyGoogleIdentity(data.id_token, env.GOOGLE_CLIENT_ID, flow.nonce);
    const session = randomToken();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(Date.now()),
      env.DB.prepare('INSERT INTO auth_sessions (token_hash, user_id, email, full_name, expires_at) VALUES (?, ?, ?, ?, ?)')
        .bind(await tokenHash(session), user.userId, user.email, user.fullName, Date.now() + SESSION_SECONDS * 1000),
    ]);
    return redirect(new URL(flow.return_to, env.APP_ORIGIN).href, [clearFlow, cookie(SESSION_COOKIE, session, SESSION_SECONDS)]);
  } catch {
    return fail();
  }
}
