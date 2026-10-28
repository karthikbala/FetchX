import {readdir,stat,statfs,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fail} from './policy.mjs';

// One gateway owns the artifact directory. Cache inventory between requests and
// account for every publication; disk headroom is still checked at each admission.
const inventories=new WeakMap();
export function recordArtifact(config,bytes){
 const inventory=inventories.get(config);
 if(!inventory)return;
 if(inventory.scan)inventory.delta+=bytes;
 else inventory.bytes+=bytes;
}
export async function artifactUsage(config,{refresh=false}={}){
 let inventory=inventories.get(config);
 if(!inventory){inventory={bytes:0,checked:0,delta:0,scan:null};inventories.set(config,inventory);}
 if(!inventory.scan&&(refresh||Date.now()-inventory.checked>30000)){
  inventory.delta=0;
  inventory.scan=(async()=>{
   let bytes=0;
   const names=await readdir(config.artifactDir).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
   for(const name of names){
    const entry=await stat(join(config.artifactDir,name)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(entry)bytes+=entry.size;
   }
   // A file published during scanning may be counted twice, never omitted.
   inventory.bytes=bytes+inventory.delta;inventory.checked=Date.now();
  })().finally(()=>{inventory.scan=null;});
 }
 await inventory.scan;
 const fs=await statfs(config.artifactDir).catch(e=>e.code==='ENOENT'?statfs(join(config.artifactDir,'..')):Promise.reject(e));
 return {bytes:inventory.bytes,free_bytes:fs.bavail*fs.bsize,max_bytes:config.maxArtifactBytes??5*1024**3,min_free_bytes:config.minFreeDiskBytes??1024**3};
}

export async function artifactAdmission(config,reserved=0){
 const usage=await artifactUsage(config);
 const floor=config.minFreeDiskBytes??1024**3;
 if(usage.free_bytes<floor+reserved)fail('artifact_disk_full',503);
 if(usage.bytes+reserved>usage.max_bytes)fail('artifact_quota',503);
}

export async function pruneArtifacts(store,config){
 const days=config.artifactRetentionDays??7;
 let count=0,changed=false;
 try{
  // Drain a bounded backlog, preserving active workflows and every financial hold.
  while(count<5000){
   const limit=Math.min(200,5000-count);
   const rows=(await store.pool.query(`SELECT o.id,o.result_path FROM operations o JOIN workflows w ON w.id=o.workflow
   WHERE o.result_path IS NOT NULL AND w.state='closed' AND o.created_at<now()-$1*interval '1 day'
   AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.operation=o.id AND (a.state='unknown' OR a.error IN ('cost_overrun','provider_account_rejected','sensitive_provider_response')))
   ORDER BY o.created_at,o.id LIMIT $2`,[days,limit])).rows;
   for(const row of rows){
    await unlink(row.result_path).catch(e=>{if(e.code!=='ENOENT')throw e;});changed=true;
    await store.pool.query("UPDATE operations SET result_path=NULL,state='expired',error='capture_expired' WHERE id=$1",[row.id]);
    count++;
   }
   if(rows.length<limit)break;
  }
 }finally{
  // Preserve any in-progress scan's delta tracking when invalidating its age.
  const inventory=inventories.get(config);
  if(changed&&inventory)inventory.checked=0;
 }
 return count;
}
