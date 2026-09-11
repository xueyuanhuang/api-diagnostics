import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {importChatGPTConnections} from '../lib/server/import-chatgpt.ts';

function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
 const DB={prepare(sql){return {bind(...values){return {first:async()=>sqlite.prepare(sql).get(...values)??null,run:async()=>sqlite.prepare(sql).run(...values)};}};},async batch(statements){sqlite.exec('BEGIN');try{for(const s of statements)await s.run();sqlite.exec('COMMIT');}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 return {sqlite,DB};
}
const profile=()=>({id:crypto.randomUUID(),name:'previous connection',apiType:'openai',baseUrl:'https://provider.example',apiKey:'old-key',createdAt:123,updatedAt:456,models:[{model_name:'legacy-model',created_at:123}],configs:[{apiType:'openai',baseUrl:'https://provider.example/v1',model:'default-model',apiKey:'format-key',models:[{model_name:'default-model',position:0,created_at:123},{model_name:'additional-model',position:1,created_at:124}]}]});
const encrypt=async value=>({encryptedApiKey:'encrypted:'+value,keyIv:'new-iv'});
test('connections are copied to the authenticated identity, keys re-encrypted, models/defaults preserved, repeated login preserves user edits',async()=>{
 const {sqlite,DB}=fixture();try{
 const p=profile();assert.equal(await importChatGPTConnections(DB,'chatgpt:owner',[p],encrypt),1);
 const saved=sqlite.prepare('SELECT * FROM connection_profiles').get();assert.equal(saved.user_id,'chatgpt:owner');assert.equal(saved.encrypted_api_key,'encrypted:old-key');assert.equal(saved.created_at,123);
 const config=sqlite.prepare('SELECT * FROM profile_api_configs').get();assert.equal(config.model_name,'default-model');assert.equal(config.encrypted_api_key,'encrypted:format-key');assert.equal(config.base_url,'https://provider.example/v1');
 assert.deepEqual(sqlite.prepare('SELECT model_name FROM profile_api_models ORDER BY position').all().map(x=>x.model_name),['default-model','additional-model']);
 sqlite.prepare('UPDATE connection_profiles SET name = ? WHERE id = ?').run('edited',saved.id);
 assert.equal(await importChatGPTConnections(DB,'chatgpt:owner',[p],encrypt),0);assert.equal(sqlite.prepare('SELECT name FROM connection_profiles').get().name,'edited');
 assert.equal(sqlite.prepare('SELECT count(*) AS n FROM connection_profiles WHERE user_id = ?').get('other').n,0);
 }finally{sqlite.close();}
});
test('failed profile writes roll back the import marker so retry remains possible',async()=>{
 const {sqlite,DB}=fixture();try{
 const p=profile();p.configs[0].models.push(p.configs[0].models[0]);
 await assert.rejects(()=>importChatGPTConnections(DB,'owner',[p],encrypt));assert.equal(sqlite.prepare('SELECT count(*) AS n FROM chatgpt_imports').get().n,0);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM connection_profiles').get().n,0);
 p.configs[0].models.pop();assert.equal(await importChatGPTConnections(DB,'owner',[p],encrypt),1);
 }finally{sqlite.close();}
});
