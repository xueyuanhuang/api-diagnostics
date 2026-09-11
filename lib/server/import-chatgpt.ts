type LegacyModel = {model_name:string;created_at:number};
type LegacyConfig = {apiType:string;baseUrl:string;model:string;apiKey:string;models:(LegacyModel & {position:number})[]};
export type LegacyProfile = {id:string;name:string;apiType:string;baseUrl:string;apiKey:string;createdAt:number;updatedAt:number;models:LegacyModel[];configs:LegacyConfig[]};

export async function importChatGPTConnections(DB:D1Database,userId:string,profiles:LegacyProfile[],encrypt:(key:string)=>Promise<{encryptedApiKey:string;keyIv:string}>) {
  let imported=0;
  for(const p of profiles){
    if(await DB.prepare('SELECT target_id FROM chatgpt_imports WHERE user_id = ? AND source_id = ?').bind(userId,p.id).first())continue;
    const id=crypto.randomUUID();
    const existing=await DB.prepare('SELECT id FROM connection_profiles WHERE user_id = ? AND name = ?').bind(userId,p.name).first();
    const name=existing?`${p.name} (import ${id.slice(0,8)})`:p.name;
    const key=await encrypt(p.apiKey);
    const statements=[
      DB.prepare('INSERT INTO chatgpt_imports (user_id,source_id,target_id,imported_at) VALUES (?,?,?,?)').bind(userId,p.id,id,Date.now()),
      DB.prepare('INSERT INTO connection_profiles (id,user_id,name,api_type,base_url,encrypted_api_key,key_iv,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id,userId,name,p.apiType,p.baseUrl,key.encryptedApiKey,key.keyIv,p.createdAt,p.updatedAt),
    ];
    for(const m of p.models)statements.push(DB.prepare('INSERT INTO profile_models (id,profile_id,model_name,created_at) VALUES (?,?,?,?)').bind(crypto.randomUUID(),id,m.model_name,m.created_at));
    for(const c of p.configs){
      const configId=crypto.randomUUID(), k=await encrypt(c.apiKey);
      statements.push(DB.prepare('INSERT INTO profile_api_configs (id,profile_id,api_type,base_url,model_name,encrypted_api_key,key_iv,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(configId,id,c.apiType,c.baseUrl,c.model,k.encryptedApiKey,k.keyIv,p.createdAt,p.updatedAt));
      for(const m of c.models)statements.push(DB.prepare('INSERT INTO profile_api_models (id,config_id,model_name,position,created_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),configId,m.model_name,m.position,m.created_at));
    }
    try{await DB.batch(statements);imported++;}catch(error){
      // A concurrent login may have committed this complete profile transaction first.
      if(!(await DB.prepare('SELECT target_id FROM chatgpt_imports WHERE user_id = ? AND source_id = ?').bind(userId,p.id).first()))throw error;
    }
  }
  return imported;
}
