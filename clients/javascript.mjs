import {randomUUID} from 'node:crypto';
export class GatewayError extends Error {
 constructor(code,{status=null,details,workflow=null,idempotency_key=null}={}){
  super(code);this.name='GatewayError';this.code=code;this.status=status;
  this.workflow=workflow;this.idempotency_key=idempotency_key;
  if(details!==undefined)this.details=details;
 }
}
export class GatewayClient {
 constructor({url,token,fetch:request=globalThis.fetch}){if(!url||!token)throw Error('gateway_config_missing');this.url=url.replace(/\/$/,'');this.token=token;this.fetch=request;}
 async call(path,body,context={}){
  let response;try{response=await this.fetch(this.url+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+this.token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(85000)});}catch{throw new GatewayError('gateway_unavailable',context);}
  let data;try{data=await response.json();}catch{throw new GatewayError('gateway_invalid_response',{...context,status:response.status});}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new GatewayError('gateway_invalid_response',{...context,status:response.status});
  if(!response.ok)throw new GatewayError(typeof data.error==='string'?data.error:'gateway_failed',{...context,status:response.status,details:data.details});
  return data;
 }
 async workflow(profile,key=randomUUID(),limits={}){const body={profile,idempotency_key:key,...limits};return this.call('/v1/workflows',body,{idempotency_key:body.idempotency_key});}
 async request(workflow,input){const body={idempotency_key:randomUUID(),...input};return this.call('/v1/workflows/'+workflow+'/operations',body,{workflow,idempotency_key:body.idempotency_key});}
 async lookup(workflow,key){return this.call('/v1/workflows/'+workflow+'/operations/'+encodeURIComponent(key),undefined,{workflow,idempotency_key:key});}
 async close(workflow){return this.call('/v1/workflows/'+workflow+'/close',{}, {workflow});}
 async fetchPage(input){if(!input?.idempotency_key)throw new GatewayError('idempotency_key_required');return this.call('/v1/fetch',input,{idempotency_key:input.idempotency_key});}
 async lookupFetch(key){return this.call('/v1/fetch/'+encodeURIComponent(key),undefined,{idempotency_key:key});}
 async submitJob(input){if(!input?.idempotency_key)throw new GatewayError('idempotency_key_required');return this.call('/v1/jobs',input,{idempotency_key:input.idempotency_key});}
 async job(id){return this.call('/v1/jobs/'+id);}
 async profiles(){return this.call('/v1/profiles');}
 async status(){return this.call('/v1/status');}
 async diagnostics(operation){return this.call('/v1/operations/'+operation+'/diagnostics');}
 async outcome(operation,{accepted_records,rejected_records,reason_code}){return this.call('/v1/operations/'+operation+'/outcome',{accepted_records,rejected_records,reason_code});}
}

export {GatewayClient as FetchXClient};
