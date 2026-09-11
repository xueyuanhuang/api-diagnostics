import { createRemoteJWKSet, jwtVerify } from 'jose';

export const SESSION_COOKIE = '__Host-api-session';
export const FLOW_COOKIE = '__Host-api-login';
export const SESSION_SECONDS = 60 * 60 * 24 * 14;
export const GOOGLE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export function randomToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function readCookie(cookieHeader: string | null, name: string) {
  return cookieHeader?.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}
export function cookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function redirect(url: string, cookies: string[] = []) {
  const headers = new Headers({ Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const item of cookies) headers.append('Set-Cookie', item);
  return new Response(null, { status: 303, headers });
}
export async function verifyGoogleIdentity(idToken: string, clientId: string, nonce: string) {
  const { payload } = await jwtVerify(idToken, GOOGLE_KEYS, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: clientId, algorithms: ['RS256'], maxTokenAge: '10 minutes',
  });
  if (payload.nonce !== nonce || !payload.sub || typeof payload.email !== 'string' || payload.email_verified !== true) {
    throw new Error('Google identity could not be verified.');
  }
  return { userId: `google:${payload.sub}`, email: payload.email,
    fullName: typeof payload.name === 'string' ? payload.name : null };
}
