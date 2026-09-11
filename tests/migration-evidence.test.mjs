import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import ts from 'typescript';

test('batched evidence import requires the current account capability, owned keys and matching bytes',async()=>{
  const owner='google:123',grant={targetUser:owner,sourceUser:'source',ticket:'t'.repeat(43),verifier:'v'.repeat(43),expiresAt:Date.now()+60000};
  const manifest={sourceUser:'source',rpmRunIds:['run'],exactKeys:['diagnostic/owned.json']};
  const puts=[];let existingOwner=owner;
  const env={DB:{prepare(sql){return {bind(){return {first:async()=>sql.includes('legacy_account_links')?{target_user:owner}:{user_id:existingOwner}};}};}},EVIDENCE:{get:async key=>key.startsWith('rpm/')?{arrayBuffer:async()=>puts.find(p=>p.key===key).bytes.buffer}:{json:async()=>key.endsWith('source-transfer.json')?grant:manifest},put:async(key,bytes)=>puts.push({key,bytes})}};
  const modules={'cloudflare:workers':{env},'@/lib/server/google-auth':{tokenHash:async value=>createHash('sha256').update(value).digest('base64url')}};
  const code=ts.transpileModule(readFileSync(new URL('../app/api/migration/evidence/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const handler={};new Function('require','exports',code)(name=>modules[name],handler);
  const bytes=Buffer.from('original evidence');
  const item={key:'rpm/v1/run/response.json',data:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
  const call=extra=>handler.POST(new Request('https://app.example/api/migration/evidence',{method:'POST',body:JSON.stringify({owner,ticket:grant.ticket,verifier:grant.verifier,objects:[item],...extra})}));
  assert.equal((await call({ticket:'wrong'})).status,403);
  assert.equal((await call({objects:[{...item,key:'migrations/source-transfer.json'}]})).status,403);
  existingOwner='google:456';assert.equal((await call({})).status,403);existingOwner=owner;
  assert.equal((await call({objects:[{...item,sha256:'bad'}]})).status,400);
  assert.equal(puts.length,0);
  const result=await call({});assert.equal(result.status,200);assert.equal((await result.json()).verified,1);assert.deepEqual(Buffer.from(puts[0].bytes),bytes);
  grant.expiresAt=1;assert.equal((await call({})).status,403);assert.equal(puts.length,1);
});
