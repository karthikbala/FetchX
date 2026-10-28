import {ID,fail,requestInput,checkedURL,checkedHeaders} from './policy.mjs';
import {sha} from './crypto.mjs';
export function fetchWorkflowKey(key){return 'fetchx:'+sha(key);}
export async function fetchOnce(gateway,project,raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||typeof raw.profile!=='string'||typeof raw.idempotency_key!=='string'||!ID.test(raw.idempotency_key))fail('request_invalid');
 const {profile,...request}=raw;
 const p=gateway.profile(project,profile);
 // Validate before allocating a durable workflow. All actual dispatch still
 // goes through the same operation ledger and admission controls.
 const input=requestInput({...request,main_document:request.main_document??true},p);
 const url=await checkedURL(input.url,p,gateway.resolve);checkedHeaders(input.headers,p,url,input.method);
 const workflow=await gateway.workflow(project,{profile,idempotency_key:fetchWorkflowKey(raw.idempotency_key)});
 const result=await gateway.operation(project,workflow.id,{...request,main_document:request.main_document??true});
 await gateway.close(project,workflow.id);
 return result;
}
export async function lookupFetch(gateway,project,key){
 if(!ID.test(key))fail('request_invalid');
 const row=(await gateway.store.pool.query('SELECT id FROM workflows WHERE project=$1 AND key=$2',[project,fetchWorkflowKey(key)])).rows[0];
 if(!row)fail('operation_not_found',404);
 return gateway.lookup(project,row.id,key);
}
export function publicProfiles(gateway,project){
 return {service:'FetchX',profiles:gateway.config.projects[project].profiles.filter(id=>Object.hasOwn(gateway.profiles,id)).map(id=>{
  const p=gateway.profile(project,id);
  return {id,execution:p.execution??'http',country:p.country,methods:p.methods,recipes:Object.keys(p.browserRecipes??{}),max_response_bytes:p.maxResponseBytes};
 })};
}
