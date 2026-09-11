import { env } from 'cloudflare:workers';
import { safeRelativeReturnPath } from '@/lib/auth-paths';
import { cookie, FLOW_COOKIE, randomToken, redirect, tokenHash } from '@/lib/server/google-auth';
export async function GET(request: Request) {
  const token=randomToken(), state=randomToken(), verifier=randomToken();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_flows WHERE expires_at <= ?').bind(Date.now()),
    env.DB.prepare('INSERT INTO auth_flows (token_hash,state,verifier,nonce,return_to,expires_at) VALUES (?,?,?,?,?,?)')
      .bind(await tokenHash(token),state,verifier,'chatgpt',safeRelativeReturnPath(new URL(request.url).searchParams.get('return_to')??'/connections'),Date.now()+600000),
  ]);
  return redirect(`https://normal-token-check.yh-xue-2023.chatgpt.site/cloudflare-signin?${new URLSearchParams({state,challenge:await tokenHash(verifier)})}`,[cookie(FLOW_COOKIE,token,600)]);
}
