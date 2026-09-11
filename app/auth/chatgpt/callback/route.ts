import { env } from 'cloudflare:workers';
import { cookie,FLOW_COOKIE,randomToken,readCookie,redirect,SESSION_COOKIE,SESSION_SECONDS,tokenHash } from '@/lib/server/google-auth';
import { encryptApiKey } from '@/lib/server/encryption';
import { importChatGPTConnections, type LegacyProfile } from '@/lib/server/import-chatgpt';
export async function GET(request:Request){
  const clear=cookie(FLOW_COOKIE,'',0);
  const fail=()=>new Response('ChatGPT sign-in or connection copying could not finish. Your original data is unchanged. Return to Connections and try signing in again.',{status:400,headers:{'Cache-Control':'no-store','Set-Cookie':clear,'Referrer-Policy':'no-referrer'}});
  try{
    const params=new URL(request.url).searchParams,token=readCookie(request.headers.get('cookie'),FLOW_COOKIE),state=params.get('state'),code=params.get('code');
    if(!token||!state||!code)return fail();
    const flow=await env.DB.prepare("DELETE FROM auth_flows WHERE token_hash = ? AND state = ? AND nonce = 'chatgpt' AND expires_at > ? RETURNING verifier,return_to")
      .bind(await tokenHash(token),state,Date.now()).first<{verifier:string;return_to:string}>();
    if(!flow)return fail();
    const response=await fetch('https://normal-token-check.yh-xue-2023.chatgpt.site/api/cloudflare-transfer',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,verifier:flow.verifier}),redirect:'error',signal:AbortSignal.timeout(60000),
    });
    if(!response.ok)return fail();
    const data=await response.json() as {user:{userId:string;email:string;fullName:string|null};profiles:LegacyProfile[]};
    if(!data.user?.userId||!data.user.email||!Array.isArray(data.profiles))return fail();
    const userId=`chatgpt:${data.user.userId}`;
    await importChatGPTConnections(env.DB,userId,data.profiles,encryptApiKey);
    const session=randomToken();
    await env.DB.prepare('INSERT INTO auth_sessions (token_hash,user_id,email,full_name,expires_at) VALUES (?,?,?,?,?)')
      .bind(await tokenHash(session),userId,data.user.email,data.user.fullName,Date.now()+SESSION_SECONDS*1000).run();
    return redirect(new URL(flow.return_to,env.APP_ORIGIN).href,[clear,cookie(SESSION_COOKIE,session,SESSION_SECONDS)]);
  }catch{return fail();}
}
