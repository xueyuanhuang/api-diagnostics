import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const code=ts.transpileModule(readFileSync(new URL('../app/api/rpm-runs/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
test('old automatic clients are rejected before connection lookup, storage, or provider use',async()=>{
 const scope={exports:{},require:name=>{
  if(name==='@/app/chatgpt-auth')return {getChatGPTUser:async()=>({userId:'owner'})};
  if(name==='@/lib/server/http')return {noStore:(body,init)=>Response.json(body,init)};
  return new Proxy({}, {get(){throw new Error('Unexpected dependency use before version check: '+name);}});
 },Response};
 vm.runInNewContext(code,scope);
 for (const runnerVersion of [undefined,1,'2']) {
  const response=await scope.exports.POST(new Request('https://test.local/api/rpm-runs',{method:'POST',body:JSON.stringify({rampMode:'automatic',runnerVersion})}));
  assert.equal(response.status,409);
  assert.match((await response.json()).error,/out of date.*No provider requests/);
 }
});
