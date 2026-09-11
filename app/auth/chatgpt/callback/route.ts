import { env } from 'cloudflare:workers';
import { cookie,FLOW_COOKIE,readCookie,redirect,SESSION_COOKIE,tokenHash } from '@/lib/server/google-auth';
import { encryptApiKey } from '@/lib/server/encryption';
import { importChatGPTConnections, type LegacyProfile } from '@/lib/server/import-chatgpt';
export async function GET(request:Request){
  const clear=cookie(FLOW_COOKIE,'',0);
  let stage='validating the transfer link';
  const fail=()=>new Response(`Import could not finish while ${stage}. Your original data is unchanged. Start a fresh import from Connections.`,{status:400,headers:{'Cache-Control':'no-store','Set-Cookie':clear,'Referrer-Policy':'no-referrer'}});
  try{
    const params=new URL(request.url).searchParams,token=readCookie(request.headers.get('cookie'),FLOW_COOKIE),state=params.get('import_state')??params.get('state'),code=params.get('import_code')??params.get('code');
    if(!token||!state||!code)return fail();
    stage='checking the browser transfer session';
    const flow=await env.DB.prepare("SELECT verifier,return_to,nonce FROM auth_flows WHERE token_hash = ? AND state = ? AND nonce LIKE 'import:google:%' AND expires_at > ?")
      .bind(await tokenHash(token),state,Date.now()).first<{verifier:string;return_to:string;nonce:string}>();
    if(!flow)return fail();
    stage='checking the signed-in Google account';
    const sessionToken=readCookie(request.headers.get('cookie'),SESSION_COOKIE);
    if(!sessionToken)return fail();
    const account=await env.DB.prepare('SELECT user_id FROM auth_sessions WHERE token_hash = ? AND expires_at > ?').bind(await tokenHash(sessionToken),Date.now()).first<{user_id:string}>();
    if(!account || flow.nonce!==`import:${account.user_id}`)return fail();
    const consumed=await env.DB.prepare('DELETE FROM auth_flows WHERE token_hash = ? AND state = ? RETURNING verifier').bind(await tokenHash(token),state).first();
    if(!consumed)return fail();
    stage='reading the approved source export';
    const stagedKey=`migrations/staged/${await tokenHash(state)}.json`;
    const staged=await env.EVIDENCE.get(stagedKey);
    let data:{user:{userId:string;email:string;fullName:string|null};profiles:LegacyProfile[];ticket?:string};
    if(staged){
      const envelope=await staged.json() as {iv:string;ciphertext:string};
      const bytes=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
      const key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(flow.verifier)),{name:'AES-GCM'},false,['decrypt']);
      const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(envelope.iv)},key,bytes(envelope.ciphertext));
      const imported=JSON.parse(new TextDecoder().decode(plaintext));
      if(imported.targetUser!==account.user_id)return fail();
      data=imported.data;
    }else{
      stage='contacting the original website';
      const response=await fetch('https://normal-token-check.yh-xue-2023.chatgpt.site/api/cloudflare-transfer',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,verifier:flow.verifier}),redirect:'manual',signal:AbortSignal.timeout(60000),
      });
      if(!response.ok){stage=`reading the original website (HTTP ${response.status})`;return fail();}
      data=await response.json() as typeof data;
    }
    if(!data.user?.userId||!data.user.email||!Array.isArray(data.profiles))return fail();
    stage='linking the original and Google accounts';
    const userId=account.user_id;
    await env.DB.prepare('INSERT OR IGNORE INTO legacy_account_links (source_user,target_user,linked_at) VALUES (?,?,?)').bind(data.user.userId,userId,Date.now()).run();
    const link=await env.DB.prepare('SELECT target_user FROM legacy_account_links WHERE source_user = ?').bind(data.user.userId).first<{target_user:string}>();
    if(link?.target_user!==userId)return fail();
    stage='saving the imported connections';
    await importChatGPTConnections(env.DB,userId,data.profiles,encryptApiKey);
    if(data.ticket)await env.EVIDENCE.put(`migrations/${userId}/source-transfer.json`,JSON.stringify({sourceUser:data.user.userId,targetUser:userId,ticket:data.ticket,verifier:flow.verifier,expiresAt:Date.now()+3600000}),{httpMetadata:{contentType:'application/json'}});
    if(staged)await env.EVIDENCE.delete(stagedKey);
    return redirect(new URL('/connections?imported=1',env.APP_ORIGIN).href,[clear]);
  }catch{return fail();}
}
