import { readBoundedBody } from './mcp-security';
import { env } from 'cloudflare:workers';
import { randomToken, tokenHash, readCookie, SESSION_COOKIE, redirect } from './google-auth';
import { allowedRedirect, MCP_SCOPE } from './mcp-security';

export const origin = () => { if (!env.APP_ORIGIN) throw new Error('Application origin is not configured'); return env.APP_ORIGIN; };
export const resource = () => `${origin()}/mcp`;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export function challenge() {
  return jsonWithChallenge();
}
function jsonWithChallenge() {
  return new Response(JSON.stringify({ error: 'Authentication required to read your saved results.' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'WWW-Authenticate': `Bearer resource_metadata="${origin()}/.well-known/oauth-protected-resource/mcp", scope="${MCP_SCOPE}"` } });
}
export async function bearerUser(request: Request) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') || '');
  if (!match) return null;
  return env.DB.prepare('SELECT user_id FROM mcp_tokens WHERE hash = ? AND resource = ? AND scope = ? AND expires_at > ?').bind(await tokenHash(match[1]), resource(), MCP_SCOPE, Date.now()).first<{ user_id: string }>();
}
async function sessionUser(request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return env.DB.prepare('SELECT user_id FROM auth_sessions WHERE token_hash = ? AND expires_at > ?').bind(await tokenHash(token), Date.now()).first<{user_id: string}>();
}
export function authorizationMetadata() {
  return json({ issuer: origin(), authorization_endpoint: `${origin()}/oauth/authorize`, token_endpoint: `${origin()}/oauth/token`, registration_endpoint: `${origin()}/oauth/register`, revocation_endpoint: `${origin()}/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: [MCP_SCOPE], authorization_response_iss_parameter_supported: true });
}
export function resourceMetadata() {
  return json({ resource: resource(), authorization_servers: [origin()], scopes_supported: [MCP_SCOPE], bearer_methods_supported: ['header'], resource_name: 'API Diagnostics saved results' });
}
function html(content: string) {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect ChatGPT · API Diagnostics</title><body><main><h1>Connect ChatGPT</h1>${content}</main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Frame-Options': 'DENY' } });
}
export async function oauth(request: Request, action: string) {
  try {
    if (request.method === 'POST') {
      const text = await readBoundedBody(request, 12000);
      if (text === null) return json({error:'invalid_request'},413);
      request = new Request(request.url,{method:'POST',headers:request.headers,body:text});
    }
    if (action === 'register' && request.method === 'POST') {
      const body = await request.json() as Record<string, unknown>;
      const urls = body.redirect_uris;
      if (!Array.isArray(urls) || urls.length !== 1 || !allowedRedirect(urls[0]) || (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none')) return json({ error: 'invalid_client_metadata' }, 400);
      // Only ChatGPT callback destinations are accepted. Reuse registration for an identical redirect.
      const id = `chatgpt-${await tokenHash(urls[0])}`;
      await env.DB.prepare('INSERT OR IGNORE INTO mcp_clients (id, redirect_uri, created_at) VALUES (?, ?, ?)').bind(id, urls[0], Date.now()).run();
      return json({ client_id: id, client_name: 'ChatGPT', redirect_uris: urls, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }, 201);
    }
    if (action === 'authorize' && request.method === 'GET') {
      const p = new URL(request.url).searchParams;
      const client = await env.DB.prepare('SELECT redirect_uri FROM mcp_clients WHERE id = ?').bind(p.get('client_id') || '').first<{redirect_uri:string}>();
      if (!client || !allowedRedirect(p.get('redirect_uri')) || p.get('redirect_uri') !== client.redirect_uri || p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') || '') || p.get('scope') !== MCP_SCOPE || p.get('resource') !== resource() || (p.get('state') || '').length > 2048) return json({ error: 'invalid_request' }, 400);
      const user = await sessionUser(request);
      if (!user) return redirect(`${origin()}/auth/google?return_to=${encodeURIComponent('/oauth/authorize?' + p.toString())}`);
      const nonce = randomToken();
      await env.DB.prepare('DELETE FROM mcp_codes WHERE expires_at < ?').bind(Date.now()).run();
      await env.DB.prepare('INSERT INTO mcp_codes (hash, user_id, client_id, redirect_uri, challenge, state, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(await tokenHash(nonce), user.user_id, p.get('client_id'), client.redirect_uri, p.get('code_challenge'), p.get('state') || '', Date.now() + 300000).run();
      return html(`<p>Allow ChatGPT to read your saved API tests and animation results for comparison and review.</p><p>This connection cannot read API keys, run paid tests, change connections, publish, or delete data. Access expires after seven days. Revoke it at any time from this website.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="nonce" value="${nonce}"><button name="decision" value="allow">Allow read-only access</button> <button name="decision" value="deny">Cancel</button></form>`);
    }
    if (action === 'authorize' && request.method === 'POST') {
      if (request.headers.get('origin') !== origin()) return json({error:'invalid_request'},403);
      const user = await sessionUser(request); if (!user) return json({error:'unauthorized'},401);
      const p = await request.formData(); const nonce = String(p.get('nonce') || '');
      const pending = await env.DB.prepare('DELETE FROM mcp_codes WHERE hash = ? AND user_id = ? AND approved = 0 AND expires_at > ? RETURNING *').bind(await tokenHash(nonce), user.user_id, Date.now()).first<{client_id:string; redirect_uri:string; challenge:string; state:string}>();
      if (!pending) return json({error:'invalid_request'},400);
      const callback = new URL(pending.redirect_uri); callback.searchParams.set('iss',origin()); callback.searchParams.set('state',pending.state);
      if (p.get('decision') !== 'allow') { callback.searchParams.set('error','access_denied'); return redirect(callback.toString()); }
      const code = randomToken();
      await env.DB.prepare('INSERT INTO mcp_codes (hash,user_id,client_id,redirect_uri,challenge,state,approved,expires_at) VALUES (?,?,?,?,?,?,1,?)').bind(await tokenHash(code),user.user_id,pending.client_id,pending.redirect_uri,pending.challenge,pending.state,Date.now()+60000).run();
      callback.searchParams.set('code',code); return redirect(callback.toString());
    }
    if (action === 'token' && request.method === 'POST') {
      const p = new URLSearchParams(await request.text());
      if (p.get('grant_type') !== 'authorization_code' || p.get('resource') !== resource() || !/^[A-Za-z0-9._~-]{43,128}$/.test(p.get('code_verifier') || '')) return json({error:'invalid_grant'},400);
      // Atomic redemption checks PKCE, client, callback, audience and expiry before consuming the code.
      const row = await env.DB.prepare('DELETE FROM mcp_codes WHERE hash = ? AND client_id = ? AND redirect_uri = ? AND challenge = ? AND approved = 1 AND expires_at > ? RETURNING user_id').bind(await tokenHash(p.get('code') || ''),p.get('client_id') || '',p.get('redirect_uri') || '',await tokenHash(p.get('code_verifier') || ''),Date.now()).first<{user_id:string}>();
      if (!row) return json({error:'invalid_grant'},400);
      const token = randomToken(); const expires = 604800;
      await env.DB.prepare('INSERT INTO mcp_tokens (hash,user_id,client_id,resource,scope,expires_at) VALUES (?,?,?,?,?,?)').bind(await tokenHash(token),row.user_id,p.get('client_id'),resource(),MCP_SCOPE,Date.now()+expires*1000).run();
      return json({access_token:token,token_type:'Bearer',expires_in:expires,scope:MCP_SCOPE});
    }
    if (action === 'revoke' && request.method === 'POST') {
      const p = new URLSearchParams(await request.text());
      await env.DB.prepare('DELETE FROM mcp_tokens WHERE hash = ?').bind(await tokenHash(p.get('token') || '')).run(); return json({});
    }
    if (action === 'disconnect' && request.method === 'POST') {
      if (request.headers.get('origin') !== origin()) return json({error:'invalid_request'},403);
      const user = await sessionUser(request); if (!user) return json({error:'unauthorized'},401);
      await env.DB.prepare('DELETE FROM mcp_tokens WHERE user_id = ?').bind(user.user_id).run();
      return html('<p>All ChatGPT MCP access to your account has been revoked.</p><a href="/mcp-setup">Back to setup</a>');
    }
    return json({error:'not_found'},404);
  } catch { return json({ error: 'invalid_request' },400); }
}
