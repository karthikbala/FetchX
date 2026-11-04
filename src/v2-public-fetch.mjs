import {sha} from './crypto.mjs';
import {GatewayError,ID,fail} from './policy.mjs';
import {hasHtmlChallenge} from './source-challenge.mjs';
import {ensurePlaygroundProfile,isPlaygroundRef,playgroundMessage} from './control-playground.mjs';

const KIND='public_fetch_request_v1';
const failureContexts=new WeakMap();
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>plain(v)&&Object.keys(v).every(k=>keys.includes(k));
const sort=v=>Array.isArray(v)?v.map(sort):plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
const canonical=v=>JSON.stringify(sort(v));
const validKey=k=>typeof k==='string'&&ID.test(k);
const keys=k=>({session:'public-fetch.s.'+sha(k).slice(0,32),operation:'public-fetch.o.'+sha(k).slice(0,32)});
const registryKey=(project,k)=>sha(canonical([project,k]));
const lookupUrl=k=>validKey(k)?'/v2/fetch/'+encodeURIComponent(k):null;
const publicCode=code=>typeof code==='string'&&/^[a-z][a-z0-9_]{0,80}$/.test(code)?code:'internal_error';
const responseHeaders=new Set(['accept-ranges','cache-control','content-disposition','content-encoding','content-language','content-length','content-type','date','etag','expires','last-modified','pragma','retry-after','vary']);
export function publicResponseHeaders(headers){
 return Object.fromEntries(Object.entries(headers??{}).filter(([name,value])=>responseHeaders.has(name.toLowerCase())&&typeof value==='string').map(([name,value])=>[name.toLowerCase(),value.slice(0,2048)]));
}
const renderOptions=new Set(['render','browser','javascript','js_render','wait_for','waitFor','screenshot','screenshots','formats','actions','script','selectors','extract','transport']);
const operationAdmissionCodes=new Set(['operation_invalid','idempotency_key_required','identifier_invalid','cost_ceiling_invalid','idempotency_conflict','session_not_found','access_profile_forbidden','access_profile_configuration','version_immutable','request_invalid','method_rejected','body_rejected','headers_rejected','session_expired','session_busy_or_unknown','session_limit','client_quota_exhausted','capacity_wait','artifact_quota','residential_budget_exhausted','residential_provider_held','residential_budget_unconfigured','residential_rate_unconfigured','residential_provider_unavailable','residential_country_unavailable','cost_estimate_unavailable','cost_ceiling_exceeded','entitlement_configuration']);
for(const code of ['credit_policy_unreviewed','credit_policy_invalid','credit_route_forbidden','credit_account_unavailable','credit_balance_exhausted','api_key_identity_required','api_key_forbidden','project_inactive','project_not_found','credential_scope_rejected','country_pool_unavailable','proxy_configuration_invalid','playground_key_selection_required','playground_policy_invalid','playground_policy_version_changed','playground_profile_invalid','playground_profile_limit','playground_destination_rejected','playground_url_invalid','playground_execution_mismatch','playground_route_unreviewed','playground_route_unhealthy','playground_route_mismatch'])operationAdmissionCodes.add(code);
export const isPublicOperationAdmissionError=error=>error instanceof GatewayError&&operationAdmissionCodes.has(error.code);

function retryEvidence(result){
 const retry=result?.retry;
 if(!plain(retry)||retry.requested!==true)return {};
 // The public advice object has an established contract. Add only the native
 // retry's safe evidence fields, never arbitrary transport/route properties.
 return {requested:true,attempts:retry.attempts,route_changed:retry.route_changed,effective_session_id:retry.effective_session_id,stop_reason:retry.stop_reason};
}

export function isPublicFetchRequest(req){return /^\/v2\/fetch(?:\/|\?|$)/.test(req.url);}

function normalize(raw){
 if(plain(raw)&&Object.keys(raw).some(k=>renderOptions.has(k)))fail('capability_unsupported',409);
 if(!exact(raw,['idempotency_key','access_profile','url','proxy','session_id','method','headers','body_base64','max_estimated_micro_usd','retry']))fail('request_invalid');
 if(raw.retry!==undefined&&typeof raw.retry!=='boolean')fail('request_invalid');
 if(!validKey(raw.idempotency_key))fail('idempotency_key_required');
 if(!exact(raw.access_profile,['id','version'])||!validKey(raw.access_profile.id)||!Number.isSafeInteger(raw.access_profile.version)||raw.access_profile.version<1)fail('version_reference_invalid');
 if(typeof raw.url!=='string'||raw.url.length>12000)fail('request_invalid');
 if(raw.method!==undefined&&(typeof raw.method!=='string'||!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(raw.method)))fail('method_rejected');
 if(!exact(raw.proxy,['class','country'])||!['direct','datacenter','residential'].includes(raw.proxy.class))fail('proxy_required');
 if(!Object.hasOwn(raw.proxy,'country'))fail('country_required');
 if(raw.proxy.class==='direct'){if(raw.proxy.country!==null)fail('direct_country_unverified');}
 else if(typeof raw.proxy.country!=='string'||!/^[A-Z]{2}$/.test(raw.proxy.country))fail('country_required');
 if(raw.session_id!==undefined&&(typeof raw.session_id!=='string'||!UUID.test(raw.session_id)))fail('identifier_invalid');
 if(raw.max_estimated_micro_usd!==undefined&&(!Number.isSafeInteger(raw.max_estimated_micro_usd)||raw.max_estimated_micro_usd<0))fail('cost_ceiling_invalid');
 // Keep false identical to omission, including fingerprints bound before retry
 // existed. Only an explicit true changes the durable request contract.
 return {idempotency_key:raw.idempotency_key,access_profile:raw.access_profile,url:raw.url,proxy:raw.proxy,session_id:raw.session_id??null,method:raw.method===undefined?'GET':raw.method,headers:raw.headers===undefined?{}:raw.headers,body_base64:raw.body_base64??null,...(raw.max_estimated_micro_usd===undefined?{}:{max_estimated_micro_usd:raw.max_estimated_micro_usd}),...(raw.retry===true?{retry:true}:{})};
}

function message(code){
 const messages={
  unauthorized:'A valid project Bearer token is required.',
  capability_unsupported:'This endpoint supports native HTTP only. Rendering, browser actions and extraction options are unsupported.',
  proxy_required:'Select proxy.class explicitly: direct, datacenter or residential.',
  country_required:'Supply an explicit uppercase two-letter country for a proxied route, or null for direct.',
  direct_country_unverified:'Direct requests cannot verify a source country; use country: null.',
  idempotency_key_required:'Supply an idempotency key of 1–160 letters, digits, underscores, periods, colons or hyphens.',
  idempotency_conflict:'This key is already bound to a different request, profile, route or session. Recover the original request; use a new key for a deliberate new request.',
  session_route_conflict:'The selected class and country differ from the pinned session. Use a fresh session and a new idempotency key to change routes.',
  session_profile_conflict:'The access profile differs from the pinned session. Use a fresh session and a new idempotency key.',
  session_busy_or_unknown:'This session has active or uncertain work. Recover that operation before submitting more work.',
  source_forbidden:'The source returned HTTP 403.',
  source_not_found:'The source returned HTTP 404. Check the requested URL.',
  source_rate_limited:'The source returned HTTP 429. Wait for its Retry-After before considering another request.',
  source_challenge:'A known HTML challenge marker was detected in the retained source response.',
  source_http_error:'The retained source HTTP status is not successful.',
  source_dns_timeout:'Source DNS resolution timed out. No source response was obtained.',
  source_dns_not_found:'Source DNS returned no usable address for this hostname.',
  source_dns_servfail:'The DNS resolver could not resolve the source hostname (SERVFAIL).',
  source_dns_authority_unreachable:'The DNS resolver could not reach the source authoritative nameservers.',
  source_dns_validation_failed:'Source DNS validation failed. The gateway did not bypass DNS validation.',
  source_dns_refused:'The DNS resolver refused source hostname resolution.',
  source_dns_unavailable:'Source DNS resolution is unavailable.',
  source_dns_invalid_response:'The DNS resolver response did not match the required validated DNS format.',
  source_dns_meter_unknown:'The session-proxy DNS charge is uncertain. Its reservation remains held; recover before any new work.',
  proxy_connect_failed:'The selected proxy could not establish the source tunnel.',
  proxy_connect_refused:'The selected proxy refused the TCP connection before any proxy request or target traffic on this dial. An operator must review the selected proxy configuration; recover the saved operation before considering new work.',
  proxy_connect_rejected:'The selected proxy rejected the requested tunnel. Inspect safe diagnostics for its status and destination stage; no source HTTP denial is implied.',
  proxy_connect_unknown:'The proxy tunnel connection failed or timed out after a transport attempt; its outcome may be uncertain.',
  proxy_response_invalid:'The proxy returned an invalid tunnel handshake. No native source response was captured.',
  provider_account_rejected:'The selected provider rejected its account credentials or access. An operator must fix the configuration.',
  source_tls_failed:'TLS verification or negotiation with the source failed.',
  source_timeout_unknown:'The source transport timed out after dispatch; the remote outcome and charge may be uncertain.',
  source_transport_unknown:'The source connection failed after a transport attempt; the remote outcome and charge may be uncertain.',
  source_body_incomplete:'The source response body ended incompletely. Recover retained evidence before any new source work.',
  operation_not_found:'No retained operation was found for this project and key.',
  session_not_found:'The session was not found in this project.',
  access_profile_forbidden:'This project is not approved for the requested access profile.',
  country_forbidden:'This country is not approved by the access profile.',
  proxy_class_forbidden:'This proxy class is not approved by the access profile.',
  client_quota_exhausted:'The project operation quota is exhausted; session creation does not grant an allowance.',
  credit_balance_exhausted:'The project has no available request credits for this operation.',
  credit_route_forbidden:'The operator has not approved request credits for this transport or proxy class.',
  credit_policy_unreviewed:'The operator must review the self-service request credit policy before requests can run.',
  api_key_identity_required:'A scoped API key or authenticated project console session is required.',
  api_key_forbidden:'This API key is revoked, belongs to another project or lacks fetch permission.',
  residential_budget_exhausted:'The residential bandwidth reservation exceeds the configured budget.',
  cost_ceiling_exceeded:'The conservative cost estimate exceeds the requested ceiling.',
  cost_estimate_unavailable:'An estimate is unavailable for this route, so its requested cost ceiling cannot be guaranteed.',
  operation_incomplete:'The operation is active or incomplete. Recover the saved operation before any new source work.',
  internal_error:'The gateway could not complete this request. Recover by key before considering new source work.'
 };
 if(Object.hasOwn(messages,code))return messages[code];
 if(code.startsWith('playground_'))return playgroundMessage(code);
 if(/forbidden|rejected|invalid|required|mismatch/.test(code))return 'The request is not permitted by the gateway or approved access profile.';
 if(/budget|quota|limit|capacity|ceiling/.test(code))return 'A gateway quota, capacity or spending reservation prevented this request.';
 if(/configuration|unconfigured|unavailable|held/.test(code))return 'The selected route is unavailable or requires an operator configuration change.';
 if(/unknown|incomplete|interrupted/.test(code))return 'The operation outcome is uncertain. Recover the saved operation; do not replay source work.';
 return 'The gateway could not complete this operation. Inspect the retained operation and its safe diagnostics.';
}

export {publicCode as publicOperationErrorCode,message as publicOperationErrorMessage};

function retryGuidance({key,code,state,method,route,profile,result,admission=false}){
 // safe_to_retry refers only to new source work. Exact same-key POSTs and GET
 // recovery remain safe because they cannot dispatch an existing operation.
 const recovery={safe_to_retry:false,same_key_replay_safe:true,new_request_allowed:false,next_action:'recover_first',lookup_url:lookupUrl(key)};
 if(['reserved','running','unknown'].includes(state)||result?.partial||/unknown|incomplete|interrupted|internal_error|session_busy/.test(code??''))return recovery;
 if(!code)return {...recovery,next_action:'complete'};
 if(code==='proxy_connect_refused')return {...recovery,next_action:'review_proxy_configuration'};
 if(code==='source_rate_limited'||code==='source_cooldown')return {...recovery,next_action:'wait_for_source_retry_after',retry_after:result?.retry_after??null};
 // A non-GET request may already have changed state even when the source fails.
 if(!admission&&method!=='GET')return recovery;
 if(code==='source_not_found')return {...recovery,next_action:'check_url'};
 if(['source_forbidden','source_challenge'].includes(code)){
  const approved=route?.class==='datacenter'&&profile?.proxy_classes?.includes('residential')&&profile?.countries?.includes(route.country);
  return {...recovery,next_action:approved?'consider_approved_residential_fresh_session':'review_source_access',...(approved?{safe_to_retry:true,new_request_allowed:true,suggested_proxy:{class:'residential',country:route.country},requires_new_idempotency_key:true,requires_fresh_session:true}:{})};
 }
 if(code==='idempotency_conflict')return recovery;
 if(code==='client_quota_exhausted'||code==='residential_budget_exhausted')return {...recovery,next_action:'review_quota_or_budget'};
 if(code==='operation_not_found')return {...recovery,next_action:'check_original_request'};
 return {...recovery,next_action:admission?'fix_request_or_configuration':'review_saved_failure'};
}

export function publicFetchFailure(error,{key=null,status,stage}={}){
 const context=error&&typeof error==='object'?failureContexts.get(error):null;
 const code=error instanceof GatewayError?publicCode(error.code):error?.validation||[400,413,415].includes(error?.statusCode)?'request_invalid':'internal_error';
 const gatewayStatus=status??(error instanceof GatewayError?error.status:[400,413,415].includes(error?.statusCode)?error.statusCode:500);
 const state=context?.state??(code==='internal_error'?'unknown':'rejected');
 key=context?.key??key;
 return {success:false,state,gateway_http_status:gatewayStatus,operation_id:context?.operation_id??null,session_id:context?.session_id??null,idempotency_key:validKey(key)?key:null,...(context?.key_scope?{idempotency_key_scope:context.key_scope}:{}),routing:context?.routing??null,data:null,artifacts:[],diagnostics:null,error:{code,message:message(code),stage:context?.stage??stage??(code==='internal_error'?'unknown':'request_admission')},retry:{...retryGuidance({key,code,state,admission:state==='rejected'}),same_key_replay_safe:context?.same_key_replay_safe??true,...(context?.lookup_url?{lookup_url:context.lookup_url}:{})},usage:null,application_acceptance:'not_evaluated',supported:{transport:'http',render:false}};
}

// Reconstruct from durable encrypted evidence only. No policy lookup, destination
// resolution, route selection or HTTP dispatch belongs in this response adapter.
export async function publicFetchResponse(v2,project,key,operation,{keyScope='caller',recoveryUrl=lookupUrl(key)}={}){
 const row=await v2.owned(project,operation.session_id),session=v2.sessionView(row);
 const inputRow=(await v2.store.pool.query('SELECT input,kind FROM v2_operations WHERE id=$1 AND project=$2',[operation.id,project])).rows[0];
 if(!inputRow)fail('operation_not_found',404);
 if(inputRow&&inputRow.kind!=='http')fail('capability_unsupported',409);
 const original=inputRow?v2.sealer.open(inputRow.input):null,method=original?.request?.method??'GET';
 const result=operation.result,artifacts=[];
 for(const retained of result?.artifacts??[])artifacts.push(await v2.artifact(project,retained.id));
 const native=artifacts.filter(a=>a.kind==='native_response'||a.kind==='download');
 // A retained response from attempt one is audit evidence, not the final body
 // when the replacement route failed before returning a response.
 const last=result?.retry?native.find(a=>a.id===result.final_artifact_id):native.at(-1),body=typeof last?.decoded_body_base64==='string'?Buffer.from(last.decoded_body_base64,'base64'):null;
 const contentType=last?.headers?.['content-type']??null;
 const challenge=last&&hasHtmlChallenge({headers:last.headers,body});
 let code=operation.error?publicCode(operation.error):null;
 if(!code&&(['reserved','running','unknown'].includes(operation.state)||!result||result.partial))code='operation_incomplete';
 if(!code){
  if(result.status===429)code='source_rate_limited';
  else if(challenge)code='source_challenge';
  else if(result.status===403)code='source_forbidden';
  else if(result.status===404)code='source_not_found';
  else if(!(result.status>=200&&result.status<300))code='source_http_error';
 }
 const route={class:session.proxy.class,country:session.proxy.country,provider:session.proxy.provider};
 // Only decode UTF-8 textual media; binary downloads retain base64 and hashes.
 const textual=typeof contentType==='string'&&/^(?:text\/[a-z0-9.+-]+|application\/(?:json|[a-z0-9.+-]+\+json|xml|[a-z0-9.+-]+\+xml|javascript|x-javascript|x-www-form-urlencoded))(?:\s*;|\s*$)/i.test(contentType);
 const charset=/;\s*charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType??'')?.[1];
 let text=null;
 if(body&&textual&&(!charset||/^(?:utf-8|utf8|us-ascii)$/i.test(charset))){try{text=new TextDecoder('utf-8',{fatal:true}).decode(body);}catch{}}
 const stage=code?.startsWith('source_')&&['source_rate_limited','source_forbidden','source_not_found','source_challenge','source_http_error'].includes(code)?'source_response':result?.diagnostics?.stage??'operation';
 return {success:!code&&operation.state==='completed',state:operation.state,gateway_http_status:200,operation_id:operation.id,session_id:operation.session_id,idempotency_key:key,idempotency_key_scope:keyScope,...(keyScope==='internal_operation'?{internal_idempotency_key:operation.idempotency_key}:{}),routing:route,
  data:result?{status:result.status??null,final_url:result.final_url??last?.url??null,content_type:contentType,body_base64:last?.decoded_body_base64??null,text,retry_after:result.retry_after??null,headers:publicResponseHeaders(last?.headers)}:null,
  artifacts:artifacts.map(a=>({id:a.id,kind:a.kind,status:a.status,...(a.attempt===undefined?{}:{attempt:a.attempt}),encoded_sha256:a.encoded_sha256??null,decoded_sha256:a.decoded_sha256??null,encoded_bytes:a.encoded_bytes??null,decoded_bytes:a.decoded_bytes??null,content_encoding:a.content_encoding??null,decoding_error:a.decoding_error??null})),
  diagnostics:result?.diagnostics??null,error:code?{code,message:code==='source_transport_unknown'&&/TLS|SSL|CERT|SELF_SIGNED|ISSUER/.test(result?.diagnostics?.failure?.cause_code??'')?'Source TLS verification or negotiation failed. The transport outcome may be uncertain; recover before any new source work.':message(code),stage}:null,retry:{...retryGuidance({key,code,state:operation.state,method,route,profile:row.policy,result}),...retryEvidence(result),same_key_replay_safe:keyScope==='caller',lookup_url:recoveryUrl},
  usage:{accounting:operation.accounting,native_requests:result?.physical_requests??null,dns_requests:result?.dns_requests??null,encoded_bytes:result?.encoded_bytes??null,decoded_bytes:result?.decoded_bytes??null,tunnel_bytes:result?.tunnel_bytes??null,dns_encoded_bytes:null,dns_decoded_bytes:null,dns_tunnel_bytes:null,byte_basis:result?.retry?'encoded_includes_native_and_metered_session_proxy_dns_when_retry_is_eligible; decoded_is_native_response_bytes; tunnel_includes_native_and_session_proxy_dns; separate_dns_bytes_unavailable':'encoded_and_decoded_are_native_response_bytes; tunnel_includes_native_and_session_proxy_dns; separate_dns_bytes_unavailable'},application_acceptance:'not_evaluated'};
}

export class PublicFetchGateway{
 constructor(v2){this.v2=v2;}
 async respond(project,key,operation,options={}){
  try{return await publicFetchResponse(this.v2,project,key,operation,options);}
  catch(error){
   if(error&&typeof error==='object')failureContexts.set(error,{key,key_scope:options.keyScope??'caller',same_key_replay_safe:(options.keyScope??'caller')==='caller',operation_id:operation.id,session_id:operation.session_id,state:error instanceof GatewayError&&error.code==='capability_unsupported'?'rejected':'unknown',stage:'response_reconstruction',lookup_url:options.recoveryUrl??lookupUrl(key)});
   throw error;
  }
 }
 async fingerprint(project,key,hash,{bind=false}={}){
  const args=[KIND,registryKey(project,key)];
  if(bind)await this.v2.store.pool.query('INSERT INTO v2_registry(kind,key,hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[...args,hash]);
  const saved=(await this.v2.store.pool.query('SELECT hash FROM v2_registry WHERE kind=$1 AND key=$2',args)).rows[0];
  if(saved&&hash!==undefined&&saved.hash!==hash)fail('idempotency_conflict',409);
  return saved;
 }
 async fetch(project,raw,identity){
  this.v2.controlCredits.keyId(project,identity);
  const input=normalize(raw),hash=sha(canonical(input)),names=keys(input.idempotency_key);
  const prior=await this.fingerprint(project,input.idempotency_key,hash);
  if(prior){
   try{return await this.respond(project,input.idempotency_key,await this.v2.lookup(project,names.operation));}
   catch(error){if(!(error instanceof GatewayError)||error.code!=='operation_not_found')throw error;}
  }
  const candidate=isPlaygroundRef(input.access_profile)?await ensurePlaygroundProfile(this.v2,project,input.access_profile,input.url,'http',input.proxy,input.method):null;
  const profile=candidate??await this.v2.profile(project,input.access_profile);
  const request={url:input.url,method:input.method,headers:input.headers,body_base64:input.body_base64};
  this.v2.request(request,profile);
  let session;
  if(input.session_id){
   session=await this.v2.readSession(project,input.session_id);
   if(session.transport!=='http')fail('capability_unsupported',409);
   if(session.access_profile.id!==input.access_profile.id||session.access_profile.version!==input.access_profile.version)fail('session_profile_conflict',409);
   if(session.proxy.class!==input.proxy.class||session.proxy.country!==input.proxy.country)fail('session_route_conflict',409);
  }else session=await this.v2.session(project,{idempotency_key:names.session,access_profile:input.access_profile,transport:'http',proxy:{...input.proxy,affinity:'session'}},{profile:candidate});
  await this.fingerprint(project,input.idempotency_key,hash,{bind:true});
  let operation;
  try{operation=await this.v2.operation(project,{idempotency_key:names.operation,session_id:session.id,request,...(input.max_estimated_micro_usd===undefined?{}:{max_estimated_micro_usd:input.max_estimated_micro_usd}),...(input.retry===true?{retry:true}:{})},identity);}
  catch(error){
   const rejected=isPublicOperationAdmissionError(error);
   if(error&&typeof error==='object')failureContexts.set(error,{key:input.idempotency_key,session_id:session.id,routing:{class:session.proxy.class,country:session.proxy.country,provider:session.proxy.provider},state:rejected?'rejected':'unknown',stage:rejected?'operation_admission':'operation'});
   throw error;
  }
  return this.respond(project,input.idempotency_key,operation);
 }
 async lookup(project,key){
  if(!validKey(key))fail('idempotency_key_required');
  if(!await this.fingerprint(project,key))fail('operation_not_found',404);
  return this.respond(project,key,await this.v2.lookup(project,keys(key).operation));
 }
 async lookupOperation(project,id,retained){
  const operation=retained??await this.v2.readOperation(project,id),internal=/^public-fetch\.o\.[a-f0-9]{32}$/.test(operation.idempotency_key);
  // The fingerprint intentionally stores no caller key. Do not reverse or
  // relabel a hashed internal key as if it were the original caller key.
  return this.respond(project,internal?null:operation.idempotency_key,operation,{keyScope:internal?'internal_operation':'native_operation',recoveryUrl:'/v2/fetch/operations/'+operation.id});
 }
}

export function registerPublicFetch(app){
 const fetch=new PublicFetchGateway(app.v2);
 app.decorate('publicFetch',fetch);
 app.post('/v2/fetch',req=>fetch.fetch(req.project,req.body,{keyId:req.apiKeyId}));
 app.get('/v2/fetch/:key',req=>fetch.lookup(req.project,req.params.key));
 app.get('/v2/fetch/operations/:id',req=>fetch.lookupOperation(req.project,req.params.id));
}
