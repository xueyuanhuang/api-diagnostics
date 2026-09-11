import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import * as jose from 'jose';
import * as paths from '../lib/auth-paths.ts';

function load(path, modules, fetcher) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('require', 'exports', 'fetch', code)(name => {
    if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
    return modules[name];
  }, exports, fetcher);
  return exports;
}
const keys = await jose.generateKeyPair('RS256');
const publicKey = await jose.exportJWK(keys.publicKey);
const helpers = load('../lib/server/google-auth.ts', { jose: { ...jose, createRemoteJWKSet: () => jose.createLocalJWKSet({keys:[publicKey]}) } });
const sign = (claims = {}) => new jose.SignJWT({nonce:'nonce', email:'user@example.com', email_verified:true, ...claims}).setProtectedHeader({alg:'RS256'}).setSubject('subject').setIssuer('https://accounts.google.com').setAudience('client').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);

test('legacy migration binds to the initiating Google session and never reassigns another account link', async()=>{
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0008_powerful_vulture.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../drizzle/0010_special_sleeper.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){return {bind(...args){return {first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>sqlite.prepare(sql).run(...args)};}};}};
  let imports=0,exchanges=0,stagedObject=null;
  const env={DB,APP_ORIGIN:'https://app.example',EVIDENCE:{get:async()=>stagedObject,put:async()=>{},delete:async()=>{stagedObject=null;}}};
  const callback=load('../app/auth/chatgpt/callback/route.ts',{'cloudflare:workers':{env},'@/lib/server/google-auth':helpers,'@/lib/server/encryption':{encryptApiKey:async()=>({})},'@/lib/server/import-chatgpt':{importChatGPTConnections:async(_db,user)=>{assert.equal(user,'google:owner');imports++;}}},async()=>{exchanges++;return Response.json({user:{userId:'old-owner',email:'owner@example.com'},profiles:[]});});
  const flow='f'.repeat(43),session='s'.repeat(43);
  const request=new Request('https://app.example/migration/complete?import_code=code&import_state=state',{headers:{cookie:`${helpers.FLOW_COOKIE}=${flow}; ${helpers.SESSION_COOKIE}=${session}`}});
  const addFlow=async()=>sqlite.prepare('INSERT OR REPLACE INTO auth_flows VALUES (?,?,?,?,?,?)').run(await helpers.tokenHash(flow),'state','verifier','import:google:owner','/',Date.now()+60000);
  try{
    sqlite.prepare('INSERT INTO auth_sessions VALUES (?,?,?,?,?)').run(await helpers.tokenHash(session),'google:other','other@example.com',null,Date.now()+60000);
    await addFlow();assert.equal((await callback.GET(request)).status,400);assert.equal(exchanges,0);
    sqlite.prepare('UPDATE auth_sessions SET user_id=?').run('google:owner');
    await addFlow();assert.equal((await callback.GET(request)).status,303);assert.equal(imports,1);
    assert.equal((await callback.GET(request)).status,400);
    sqlite.prepare('UPDATE legacy_account_links SET target_user=?').run('google:other');
    await addFlow();assert.equal((await callback.GET(request)).status,400);assert.equal(imports,1);
    sqlite.prepare('UPDATE legacy_account_links SET target_user=?').run('google:owner');
    const stage=async(targetUser)=>{
      const iv=crypto.getRandomValues(new Uint8Array(12));
      const key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode('verifier')),{name:'AES-GCM'},false,['encrypt']);
      const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify({targetUser,data:{user:{userId:'old-owner',email:'owner@example.com'},profiles:[]}})));
      stagedObject={json:async()=>({iv:Buffer.from(iv).toString('base64'),ciphertext:Buffer.from(cipher).toString('base64')})};
    };
    await stage('google:other');await addFlow();assert.equal((await callback.GET(request)).status,400);assert.equal(imports,1);
    await stage('google:owner');await addFlow();assert.equal((await callback.GET(request)).status,303);assert.equal(imports,2);assert.equal(stagedObject,null);

  }finally{sqlite.close();}
});

test('Google identity verifies signature, audience, issuer, nonce, expiry and verified email', async () => {
  assert.equal((await helpers.verifyGoogleIdentity(await sign(), 'client', 'nonce')).userId, 'google:subject');
  for (const claims of [{nonce:'other'}, {email_verified:false}, {aud:'other'}, {iss:'https://attacker.example'}, {exp:1}]) {
    const token = await new jose.SignJWT({sub:'subject',email:'user@example.com',email_verified:true,nonce:'nonce',aud:'client',iss:'https://accounts.google.com',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,...claims}).setProtectedHeader({alg:'RS256'}).sign(keys.privateKey);
    await assert.rejects(() => helpers.verifyGoogleIdentity(token, 'client', 'nonce'));
  }
  const token = await sign();
  await assert.rejects(() => helpers.verifyGoogleIdentity(token.slice(0,-10)+'AAAAAAAAAA', 'client','nonce'));
});

test('actual auth routes consume login once, persist account sessions, reject forged hosting headers, and revoke sign-out', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0008_powerful_vulture.sql', import.meta.url),'utf8'));
  const DB = { prepare(sql) { return {bind(...args) { return {first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>sqlite.prepare(sql).run(...args)}; }}; }, batch:async statements=>Promise.all(statements.map(s=>s.run())) };
  const env = {DB, APP_ORIGIN:'https://app.example',GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'};
  let headers = new Headers(), exchanges=0;
  const modules = {'cloudflare:workers':{env},'@/lib/server/google-auth':helpers,'@/lib/auth-paths':paths,'next/headers':{headers:async()=>headers}};
  const start = load('../app/auth/google/route.ts',modules);
  const session = load('../app/chatgpt-auth.ts',modules);
  const callback = load('../app/auth/google/callback/route.ts',modules,async (_url,init)=>{
    exchanges++;
    assert.equal(init.body.get('client_secret'),'secret');
    const flow=sqlite.prepare('SELECT * FROM auth_flows').get();
    assert.equal(flow,undefined);
    return Response.json({id_token:await sign({nonce:nonce})});
  });
  let nonce;
  try {
    headers=new Headers({'oai-authenticated-user-id':'victim','oai-authenticated-user-email':'victim@example.com'});
    assert.equal(await session.getChatGPTUser(),null);
    const response=await start.GET(new Request('https://app.example/auth/google?return_to=//attacker.example'));
    const destination=new URL(response.headers.get('location'));
    nonce=destination.searchParams.get('nonce');
    assert.equal(destination.searchParams.get('code_challenge_method'),'S256');
    const flowCookie=response.headers.get('set-cookie').split(';')[0];
    assert.match(response.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/);
    const request=(state)=>new Request(`https://app.example/auth/google/callback?code=code&state=${state}`,{headers:{cookie:flowCookie}});
    assert.equal((await callback.GET(request('wrong'))).status,400);
    assert.equal(exchanges,0);
    const completed=await callback.GET(request(destination.searchParams.get('state')));
    assert.equal(completed.status,303);
    assert.equal(completed.headers.get('location'),'https://app.example/');
    assert.equal((await callback.GET(request(destination.searchParams.get('state')))).status,400);
    assert.equal(exchanges,1);
    const savedCookie=completed.headers.getSetCookie().find(c=>c.startsWith(helpers.SESSION_COOKIE+'=')).split(';')[0];
    headers=new Headers({cookie:savedCookie});
    assert.equal((await session.getChatGPTUser()).userId,'google:subject');
    headers.set('origin','https://evil.example');
    assert.equal(await session.getChatGPTUser(),null);
    headers.delete('origin');
    const logout=load('../app/auth/signout/route.ts',modules);
    await logout.GET(new Request('https://app.example/auth/signout',{headers}));
    assert.equal(await session.getChatGPTUser(),null);
  } finally {sqlite.close();}
});
