import {env} from 'cloudflare:workers';
import {tokenHash} from '@/lib/server/google-auth';

// Temporary, account-bound import capability. It can write only source evidence
// listed in the administrator's private snapshot, and expires with the transfer.
export async function POST(request:Request){
  const headers={'Cache-Control':'no-store'};
  const fail=(status=403)=>Response.json({error:'Invalid evidence transfer.'},{status,headers});
  try{
    if(Number(request.headers.get('content-length'))>5_000_000)return fail(413);
    const raw=await request.text();if(raw.length>5_000_000)return fail(413);
    const body=JSON.parse(raw);
    if(typeof body.owner!=='string'||!/^google:\d+$/.test(body.owner)||typeof body.ticket!=='string'||typeof body.verifier!=='string'||!Array.isArray(body.objects)||body.objects.length<1||body.objects.length>12)return fail();
    const object=await env.EVIDENCE.get(`migrations/${body.owner}/source-transfer.json`);
    if(!object)return fail();
    const grant=await object.json() as {targetUser:string;sourceUser:string;ticket:string;verifier:string;expiresAt:number};
    if(grant.targetUser!==body.owner||grant.expiresAt<Date.now()||await tokenHash(body.ticket)!==await tokenHash(grant.ticket)||await tokenHash(body.verifier)!==await tokenHash(grant.verifier))return fail();
    const link=await env.DB.prepare('SELECT target_user FROM legacy_account_links WHERE source_user=?').bind(grant.sourceUser).first<{target_user:string}>();
    if(link?.target_user!==body.owner)return fail();
    const archive=await env.EVIDENCE.get(`migrations/${body.owner}/evidence-allowlist.json`);
    if(!archive)return fail();
    const manifest=await archive.json() as {sourceUser:string;rpmRunIds:string[];exactKeys:string[]};
    if(manifest.sourceUser!==grant.sourceUser)return fail();
    const rpm=new Set(manifest.rpmRunIds),exact=new Set(manifest.exactKeys);
    const prepared:{key:string;bytes:Uint8Array;sha256:string}[]=[];
    const ownership=new Map<string,Promise<{user_id:string}|null>>();
    for(const item of body.objects){
      if(typeof item.key!=='string'||item.key.length>2048||typeof item.data!=='string'||typeof item.sha256!=='string')return fail();
      const match=/^rpm\/v1\/([^/]+)\//.exec(item.key);
      if(match?!rpm.has(match[1]):!exact.has(item.key))return fail();
      const ownerKey=match?`rpm:${match[1]}`:item.key;
      if(!ownership.has(ownerKey))ownership.set(ownerKey,match?env.DB.prepare('SELECT user_id FROM rpm_runs WHERE id=?').bind(match[1]).first<{user_id:string}>():env.DB.prepare('SELECT user_id FROM diagnostic_runs WHERE evidence_key=? UNION ALL SELECT user_id FROM animation_results WHERE evidence_key=?').bind(item.key,item.key).first<{user_id:string}>());
      const existing=await ownership.get(ownerKey);
      if(existing&&existing.user_id!==body.owner)return fail();
      const bytes=Uint8Array.from(atob(item.data),(c)=>c.charCodeAt(0));
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
      if(digest!==item.sha256)return fail(400);
      prepared.push({key:item.key,bytes,sha256:item.sha256});
    }
    await Promise.all(prepared.map(item=>env.EVIDENCE.put(item.key,item.bytes)));
    await Promise.all(prepared.map(async item=>{
      const stored=await env.EVIDENCE.get(item.key);if(!stored)throw new Error('Stored evidence missing');
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await stored.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
      if(digest!==item.sha256)throw new Error('Stored evidence mismatch');
    }));
    return Response.json({verified:prepared.length},{headers});
  }catch{return fail(503);}
}
