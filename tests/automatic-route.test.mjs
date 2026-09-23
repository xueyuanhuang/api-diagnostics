import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {measureAutomaticThroughput} from '../lib/automatic-throughput.ts';
import {countRpmOutcomes} from '../lib/server/rpm-evidence.ts';
const code=ts.transpileModule(readFileSync(new URL('../app/api/rpm-runs/[id]/measure/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture({user={userId:'owner'},found=true,claim=1}={}){
 let selects=0,requests=0;const writes=[];const evidence=[];
 const env={DB:{prepare(sql){return {bind(...args){writes.push({sql,args});return this;},async run(){return {meta:{changes:claim}};},async first(){return {status:'running'};}};},async batch(items){return items.map(()=>({meta:{changes:1}}));}},EVIDENCE:{async put(key,body){evidence.push({key,body});}}};
 const modules={
 'cloudflare:workers':{env},'drizzle-orm':{and:(...v)=>v,eq:(...v)=>v},
 '@/app/chatgpt-auth':{getChatGPTUser:async()=>user},
 '@/db':{getDb:()=>({select:()=>({from:()=>({where:()=>({limit:async()=>++selects===1?(found?[{id:'run',userId:'owner',rampMode:'automatic',status:'ready',baseUrl:'https://openrouter.ai/api/v1',apiType:'openai',modelName:'openai/gpt-6-astra',openRouterTier:'flex'}]:[]):[{encryptedApiKey:'enc',keyIv:'iv'}]})})})})},
 '@/db/schema':{rpmRuns:{id:'id',userId:'userId'},rpmRunSecrets:{runId:'runId'}},
 '@/lib/server/http':{noStore:(data,init)=>Response.json(data,init),serverError:()=>Response.json({error:'server'},{status:500})},
 '@/lib/server/encryption':{decryptApiKey:async()=> 'test-secret'},
 '@/lib/server/hosted-ip-mapping':{prepareRpmConnection:async()=>({actualBaseUrl:'https://openrouter.ai/api/v1'})},
 '@/lib/server/rpm-provider':{runProviderRequest:async input=>{requests++;assert.equal(input.openRouterTier,'flex');return {outcome:'success',completedAt:Date.now(),totalTimeMs:1,request:{body:'{}'},response:{}};}},
 '@/lib/automatic-throughput':{measureAutomaticThroughput:opts=>measureAutomaticThroughput({...opts,requestCap:3})},
 '@/lib/server/rpm-evidence':{countRpmOutcomes},
 };
 const scope={exports:{},require:name=>{assert.ok(modules[name],name);return modules[name];},Response,ReadableStream,TextEncoder,AbortController,Date,setInterval,clearInterval,URL};vm.runInNewContext(code,scope);
 return {post:scope.exports.POST,writes,evidence,requests:()=>requests};
}
const request=(origin='https://test.local')=>new Request('https://test.local/api/rpm-runs/run/measure',{method:'POST',headers:{origin}});
const context={params:Promise.resolve({id:'run'})};
test('automatic measurement rejects unauthenticated, cross-origin, missing-owner and duplicate-start requests without provider traffic',async()=>{
 for(const [settings,origin,status] of [[{user:null},'https://test.local',401],[{},'https://elsewhere.test',403],[{found:false},'https://test.local',404],[{claim:0},'https://test.local',409]]){
 const f=fixture(settings);const response=await f.post(request(origin),context);assert.equal(response.status,status);assert.equal(f.requests(),0);
 }
});
test('automatic route saves individual evidence, final counters and metrics before acknowledging completion',async()=>{
 const f=fixture();const response=await f.post(request(),context);assert.equal(response.status,200);
 const events=(await response.text()).trim().split('\n').map(JSON.parse);
 assert.equal(events.at(-1).type,'done');assert.equal(events.at(-1).metrics.sent,3);
 assert.equal(f.evidence.length,3);
 const final=f.writes.find(w=>w.sql.startsWith('UPDATE rpm_runs SET status=?,automatic_metrics_json'));
 assert.equal(final.args[0],'passed');assert.equal(JSON.parse(final.args[1]).requestCap,3);
 assert.ok(f.writes.some(w=>w.sql.startsWith('DELETE FROM rpm_run_secrets')));
});
