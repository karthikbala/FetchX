import {randomUUID} from 'node:crypto';

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const stringOrNull=value=>typeof value==='string'?value:null;

export class GatewayError extends Error {
 constructor(code,{status=null,details,workflow=null,idempotency_key=null,response=null}={}){
  super(code);this.name='GatewayError';this.code=code;this.status=status;
  this.workflow=workflow;
  this.idempotency_key=idempotency_key??stringOrNull(response?.idempotency_key);
  this.response=response;
  this.operation_id=stringOrNull(response?.operation_id);
  this.session_id=stringOrNull(response?.session_id);
  this.retry=isObject(response?.retry)?response.retry:null;
  this.diagnostics=isObject(response?.diagnostics)?response.diagnostics:null;
  if(details!==undefined)this.details=details;
 }
}
export class GatewayClient {
 constructor({url,token,fetch:request=globalThis.fetch}){if(!url||!token)throw Error('gateway_config_missing');this.url=url.replace(/\/$/,'');this.token=token;this.fetch=request;}
 async call(path,body,context={},{headers={}}={}){
  let response;
  try{
   response=await this.fetch(this.url+path,{
    method:body===undefined?'GET':'POST',
    headers:{...headers,authorization:'Bearer '+this.token,'content-type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(85000),
    ...(path.startsWith('/v2/')?{redirect:'manual'}:{})
   });
  }catch{throw new GatewayError('gateway_unavailable',context);}
  let data;try{data=await response.json();}catch{throw new GatewayError('gateway_invalid_response',{...context,status:response.status});}
  if(!isObject(data))throw new GatewayError('gateway_invalid_response',{...context,status:response.status});
  if(!response.ok){
   const error=data.error;
   // Scrape failures carry {code, error: message}; other APIs carry the code in error.
   const code=stringOrNull(error?.code)??stringOrNull(data.code)??stringOrNull(error)??'gateway_failed';
   throw new GatewayError(code,{...context,status:response.status,details:data.details,response:data});
  }
  return data;
 }
 async #submitV2(path,input){
  if(!input?.idempotency_key)throw new GatewayError('idempotency_key_required');
  return this.call(path,input,{idempotency_key:input.idempotency_key});
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
 async fetchV2(input){return this.#submitV2('/v2/fetch',input);}
 async lookupFetchV2(key){return this.call('/v2/fetch/'+encodeURIComponent(key),undefined,{idempotency_key:key});}
 async readFetchOperationV2(id){return this.call('/v2/fetch/operations/'+encodeURIComponent(id));}
 async renderV2(input){return this.#submitV2('/v2/render',input);}
 async prepareRenderV2(input){return this.call('/v2/render/prepare',input);}
 async scrapeV2(input,idempotencyKey){
  if(!idempotencyKey)throw new GatewayError('idempotency_key_required');
  return this.call('/v2/scrape',input,{idempotency_key:idempotencyKey},{headers:{'x-idempotency-key':idempotencyKey}});
 }
 async lookupRenderV2(key){return this.call('/v2/render/'+encodeURIComponent(key),undefined,{idempotency_key:key});}
 async capabilitiesV2(){return this.call('/v2/capabilities');}
 async accessProfilesV2(){return this.call('/v2/access-profiles');}
 async discoveryProfileV2(input){return this.#submitV2('/v2/discovery-profiles',input);}
 async recipesV2(){return this.call('/v2/recipes');}
 async sessionV2(input){return this.#submitV2('/v2/sessions',input);}
 async readSessionV2(id){return this.call('/v2/sessions/'+encodeURIComponent(id));}
 async operationV2(input){return this.#submitV2('/v2/operations',input);}
 async browserProbeV2(input){return this.#submitV2('/v2/browser-probes',input);}
 async readOperationV2(id){return this.call('/v2/operations/'+encodeURIComponent(id));}
 async lookupOperationV2(key){return this.call('/v2/operations/by-key/'+encodeURIComponent(key),undefined,{idempotency_key:key});}
 async artifactV2(id){return this.call('/v2/artifacts/'+encodeURIComponent(id));}
 async usageV2(){return this.call('/v2/usage');}
 async recentOperationsV2(limit=25){return this.call('/v2/operations?limit='+encodeURIComponent(limit));}
}

export {GatewayClient as FetchXClient};
