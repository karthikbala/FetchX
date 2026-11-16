import {sha} from './crypto.mjs';
import {GatewayError,ID,fail} from './policy.mjs';
import {RENDER_PREPARATION_PATH,ensurePlaygroundProfile,isPlaygroundRef,playgroundPolicy,prepareBearerRender,readPlaygroundProfile} from './control-playground.mjs';
import {PUBLIC_URL_KIND,isPublicUrlRef} from './v2-public-url.mjs';
import {hasHtmlChallenge} from './source-challenge.mjs';
import {BROWSER_SCREENSHOT_MAX_BYTES} from './v2-browser-policy.mjs';
import {isPublicOperationAdmissionError,publicFetchFailure,publicOperationErrorCode,publicOperationErrorMessage,publicResponseHeaders} from './v2-public-fetch.mjs';

const KIND='public_render_request_v1';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>plain(value)&&Object.keys(value).every(k=>keys.includes(k));
const validKey=key=>typeof key==='string'&&ID.test(key);
const lookupUrl=key=>validKey(key)?'/v2/render/'+encodeURIComponent(key):null;
const failureContexts=new WeakMap();
const admissionCodes=new Set([
 'browser_probe_profile_unapproved','browser_probe_invalid','browser_request_ceiling_rejected','browser_session_required',
 'browser_wait_ceiling_rejected','browser_screenshot_rejected','browser_probe_disabled','browser_probe_runtime_unqualified','browser_probe_runtime_unavailable',
 'browser_probe_build_mismatch','browser_probe_redirect_admission_unqualified','browser_capacity','capability_unsupported',
 'browser_queue_running','browser_queue_full','browser_queue_timeout','browser_queue_cancelled'
]);
const messages={
 browser_probe_invalid:'Check the render URL and options. Browser rendering accepts GET navigation, an optional wait and an optional viewport screenshot.',
 browser_wait_ceiling_rejected:'The requested wait exceeds the browser limit for this access profile.',
 browser_probe_profile_unapproved:'Browser rendering is unavailable for the selected access profile.',
 render_profile_execution_mismatch:'The selected access profile is for HTTP execution. Choose an access profile approved for browser rendering.',
 render_profile_preparation_required:'Use the browser access profile returned by render preparation for this URL.',
 browser_probe_disabled:'Browser rendering is currently unavailable.',
 browser_queue_running:'The original browser request is waiting or running. Replay it with the same idempotency key.',
 browser_queue_full:'The browser waiting queue is full. Retry the same request with its original idempotency key.',
 browser_queue_timeout:'The browser request timed out before dispatch. Retry the same request with its original idempotency key.',
 browser_queue_cancelled:'The browser request was cancelled before dispatch. Retry it with its original idempotency key.',
 browser_request_limit:'The rendered page exceeded its browser network request limit.',
 browser_dom_byte_limit:'The rendered HTML exceeded its capture limit.',
 browser_screenshot_byte_limit:'The viewport screenshot exceeded its capture limit.'
};
const message=code=>Object.hasOwn(messages,code)?messages[code]:publicOperationErrorMessage(code);

export function isPublicRenderRequest(req){return /^\/v2\/render(?:\/|\?|$)/.test(req.url);}

function normalize(raw){
 if(!exact(raw,['idempotency_key','access_profile','url','proxy','max_estimated_micro_usd','screenshot','wait_ms']))fail('browser_probe_invalid');
 if(!validKey(raw.idempotency_key))fail('idempotency_key_required');
 const ref=raw.access_profile,proxy=raw.proxy;
 if(!exact(ref,['id','version'])||!validKey(ref.id)||!Number.isSafeInteger(ref.version)||ref.version<1)fail('version_reference_invalid');
 if(typeof raw.url!=='string'||!raw.url.length||raw.url.length>12000)fail('browser_probe_invalid');
 if(!exact(proxy,['class','country'])||!['direct','datacenter','residential'].includes(proxy.class))fail('proxy_required');
 if(!Object.hasOwn(proxy,'country'))fail('country_required');
 if(proxy.class==='direct'){if(proxy.country!==null)fail('direct_country_unverified');}
 else if(typeof proxy.country!=='string'||!/^[A-Z]{2}$/.test(proxy.country))fail('country_required');
 if(raw.max_estimated_micro_usd!==undefined&&(!Number.isSafeInteger(raw.max_estimated_micro_usd)||raw.max_estimated_micro_usd<0))fail('cost_ceiling_invalid');
 if(raw.screenshot!==undefined&&typeof raw.screenshot!=='boolean')fail('browser_probe_invalid');
 if(raw.wait_ms!==undefined&&(!Number.isSafeInteger(raw.wait_ms)||raw.wait_ms<0||raw.wait_ms>2000))fail('browser_wait_ceiling_rejected');
 return {idempotency_key:raw.idempotency_key,access_profile:{id:ref.id,version:ref.version},url:raw.url,proxy:{class:proxy.class,country:proxy.country},
  ...(raw.max_estimated_micro_usd===undefined?{}:{max_estimated_micro_usd:raw.max_estimated_micro_usd}),...(raw.screenshot===true?{screenshot:true}:{}),...(raw.wait_ms===undefined?{}:{wait_ms:raw.wait_ms})};
}

function retry(key,code,state,{recoveryUrl=lookupUrl(key),replaySafe=true,retryAfter=null}={}){
 const advice={safe_to_retry:false,same_key_replay_safe:replaySafe,new_request_allowed:false,next_action:'recover_first',lookup_url:recoveryUrl};
 if(['reserved','running','unknown'].includes(state)||/unknown|incomplete|interrupted|internal_error|idempotency_conflict/.test(code??''))return advice;
 if(['browser_queue_full','browser_queue_timeout','browser_queue_cancelled'].includes(code))return {...advice,safe_to_retry:true,next_action:'retry_same_key'};
 if(!code)return {...advice,next_action:'complete'};
 if(code==='operation_not_found')return {...advice,next_action:'check_original_request'};
 if(code==='source_rate_limited'||code==='source_cooldown')return {...advice,next_action:'wait_for_source_retry_after',retry_after:retryAfter};
 if(code==='source_challenge'||code==='source_forbidden')return {...advice,next_action:'review_source_access'};
 return {...advice,next_action:state==='rejected'?'fix_request_or_configuration':'review_saved_failure'};
}

export function publicRenderFailure(error,{key=null,status,stage}={}){
 const context=error&&typeof error==='object'?failureContexts.get(error):null;
 const {supported,...base}=publicFetchFailure(error,{key,status,stage});
 const code=base.error.code,state=context?.state??base.state;
 return {...base,state,operation_id:context?.operationId??null,session_id:context?.sessionId??null,routing:context?.routing??null,
  ...(context?.keyScope?{idempotency_key_scope:context.keyScope}:{}),execution:'browser',supported:{transport:'browser',render:true},
  diagnostics:context?.diagnostics??base.diagnostics,
  error:{code,message:context?.message??message(code),stage:context?.stage??base.error.stage},retry:retry(base.idempotency_key,code,state,{recoveryUrl:context?.recoveryUrl,replaySafe:context?.keyScope===undefined||context.keyScope==='caller'})};
}

function rejectRenderProfile(code,{profile,managed,unavailable=false}={}){
 const error=new GatewayError(code,403),diagnostics={requested_execution:'browser'};
 if(profile){
  diagnostics.profile_kind=[PUBLIC_URL_KIND,'playground','discovery'].includes(profile.kind)?profile.kind:'static';
  diagnostics.approved_executions=profile.playground_execution==='browser'?['browser']:['http'];
 }
 if(managed)diagnostics.preparation_path=RENDER_PREPARATION_PATH;
 const hint=unavailable?'Browser rendering is unavailable for this project.':managed&&code==='access_profile_forbidden'?messages.render_profile_preparation_required:undefined;
 failureContexts.set(error,{diagnostics,message:hint});
 throw error;
}

async function managedRenderProfile(v2,project,input){
 const browser=playgroundPolicy(v2.config)?.routes.browser;
 if(!browser||!browser.direct&&!browser.datacenter.length&&!browser.residential.length)rejectRenderProfile('capability_unsupported',{unavailable:true});
 const ref=input.access_profile;
 if(!isPlaygroundRef(ref)){
  const key=ref.id+'@'+ref.version;
  const approvedStatic=v2.config.projects[project]?.v2_access_profiles?.includes(key);
  const profile=isPublicUrlRef(ref)&&v2.publicUrlPolicy(project,ref)?{kind:PUBLIC_URL_KIND}:approvedStatic&&v2.config.v2?.accessProfiles?.[key];
  if(!profile)rejectRenderProfile('access_profile_forbidden',{managed:true});
  rejectRenderProfile(profile.browser_probe?.enabled?'render_profile_preparation_required':'render_profile_execution_mismatch',{profile,managed:true});
 }
 try{return await ensurePlaygroundProfile(v2,project,ref,input.url,'browser',input.proxy,'GET');}
 catch(error){
  if(!(error instanceof GatewayError)||error.code!=='access_profile_forbidden')throw error;
  let profile;
  try{profile=await readPlaygroundProfile(v2,project,ref);}
  catch(lookupError){
   if(!(lookupError instanceof GatewayError)||lookupError.code!=='access_profile_forbidden')throw lookupError;
  }
  rejectRenderProfile(profile?.playground_execution==='http'?'render_profile_execution_mismatch':'access_profile_forbidden',{profile,managed:true});
 }
}

function mainDocument(result,artifacts){
 const native=artifacts.filter(a=>a.kind==='browser_response');
 if(result?.main_artifact_id)return native.find(a=>a.id===result.main_artifact_id);
 return native.findLast(a=>(a.main_document||a.request?.resource_type==='document')&&a.url===result?.final_url&&a.status===result?.status);
}

function generatedArtifact(artifacts,kind,id){
 return id?artifacts.find(a=>a.kind===kind&&a.id===id&&a.generated===true):artifacts.findLast(a=>a.kind===kind&&a.generated===true);
}

function responseArtifact(artifact,screenshot){
 const {id,kind,status}=artifact;
 return {id,kind,status:status??null,encoded_sha256:artifact.encoded_sha256??null,decoded_sha256:artifact.decoded_sha256??null,
  encoded_bytes:artifact.encoded_bytes??null,decoded_bytes:artifact.decoded_bytes??null,content_encoding:artifact.content_encoding??null,decoding_error:artifact.decoding_error??null,
  ...(artifact===screenshot&&artifact.headers?.['content-type']==='image/jpeg'&&typeof artifact.decoded_body_base64==='string'&&artifact.decoded_bytes<=BROWSER_SCREENSHOT_MAX_BYTES&&artifact.decoded_body_base64.length<=4*Math.ceil(BROWSER_SCREENSHOT_MAX_BYTES/3)?{content_type:'image/jpeg',body_base64:artifact.decoded_body_base64}:{})};
}

async function renderResponse(v2,project,key,operation,{keyScope='caller',recoveryUrl=lookupUrl(key),documentOnly=false}={}){
 if(operation.execution!=='browser')fail('capability_unsupported',409);
 const session=await v2.readSession(project,operation.session_id),routing={class:session.proxy.class,country:session.proxy.country,provider:session.proxy.provider};
 const result=operation.result,artifacts=[];
 for(const item of result?.artifacts??[]){
  if(documentOnly&&item.kind!=='rendered_dom'&&
   (item.kind!=='browser_response'||result.main_artifact_id&&result.main_artifact_id!==item.id))continue;
  artifacts.push(await v2.artifact(project,item.id));
 }
 const main=mainDocument(result,artifacts),dom=generatedArtifact(artifacts,'rendered_dom',result?.dom_artifact_id);
 const screenshot=generatedArtifact(artifacts,'browser_screenshot',result?.screenshot_artifact_id),headers=publicResponseHeaders(main?.headers);
 const bodyBase64=dom?.decoded_body_base64??null,text=bodyBase64===null?null:Buffer.from(bodyBase64,'base64').toString('utf8');
 const status=result?.status??null,challenge=hasHtmlChallenge({headers:dom?.headers,body:text})||hasHtmlChallenge({headers:main?.headers,body:typeof main?.decoded_body_base64==='string'?Buffer.from(main.decoded_body_base64,'base64'):null});
 let code=operation.error?publicOperationErrorCode(operation.error):null;
 if(!code&&(operation.state!=='completed'||!result||result.partial))code='operation_incomplete';
 if(!code){
  if(status===429)code='source_rate_limited';
  else if(challenge)code='source_challenge';
  else if(status===403)code='source_forbidden';
  else if(status===404)code='source_not_found';
  else if(!(status>=200&&status<300))code='source_http_error';
 }
 const retryAfter=result?.retry_after??headers['retry-after']??null;
 const duration=operation.finished_at&&operation.created_at?new Date(operation.finished_at)-new Date(operation.created_at):null;
 return {success:!code,state:operation.state,gateway_http_status:200,operation_id:operation.id,session_id:operation.session_id,idempotency_key:key,idempotency_key_scope:keyScope,
  ...(keyScope==='internal_operation'?{internal_idempotency_key:operation.idempotency_key}:{}),routing,execution:'browser',
  data:result?{status,final_url:result.final_url??dom?.url??null,content_type:dom?.headers?.['content-type']??headers['content-type']??null,text,body_base64:bodyBase64,headers,retry_after:retryAfter}:null,
  artifacts:artifacts.map(a=>responseArtifact(a,screenshot)),diagnostics:result?.diagnostics??null,
  error:code?{code,message:message(code),stage:code.startsWith('source_')&&['source_rate_limited','source_challenge','source_forbidden','source_not_found','source_http_error'].includes(code)?'source_response':result?.diagnostics?.stage??'operation'}:null,
  retry:retry(key,code,operation.state,{recoveryUrl,replaySafe:keyScope==='caller',retryAfter}),
  usage:{accounting:operation.accounting,native_requests:null,browser_requests:result?.physical_requests??null,blocked_requests:result?.blocked_requests??null,
   encoded_bytes:result?.encoded_bytes??null,decoded_bytes:result?.decoded_bytes??null,dom_bytes:result?.dom_bytes??null,screenshot_bytes:result?.screenshot_bytes??null,tunnel_bytes:result?.tunnel_bytes??null,
   capture_complete:result?.capture_complete??null,
   duration_ms:Number.isFinite(duration)?Math.max(0,duration):null,byte_basis:result?.network_byte_basis??null},application_acceptance:'not_evaluated'};
}

export class PublicRenderGateway{
 constructor(v2,{kind=KIND,namespace='public-render'}={}){this.v2=v2;this.kind=kind;this.namespace=namespace;}

 operationKey(key){return this.namespace+'.o.'+sha(key).slice(0,32);}
 sessionKey(key){return this.namespace+'.s.'+sha(key).slice(0,32);}

 async respond(project,key,operation,options={}){
  try{return await renderResponse(this.v2,project,key,operation,options);}
  catch(error){
   if(error&&typeof error==='object')failureContexts.set(error,{operationId:operation.id,sessionId:operation.session_id,keyScope:options.keyScope??'caller',
    state:error instanceof GatewayError&&error.code==='capability_unsupported'?'rejected':'unknown',stage:'response_reconstruction',recoveryUrl:options.recoveryUrl});
   throw error;
  }
 }

 async fingerprint(project,key,hash,{bind=false}={}){
  const args=[this.kind,sha(JSON.stringify([project,key]))];
  if(bind)await this.v2.store.pool.query('INSERT INTO v2_registry(kind,key,hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[...args,hash]);
  const row=(await this.v2.store.pool.query('SELECT hash FROM v2_registry WHERE kind=$1 AND key=$2',args)).rows[0];
  if(row&&hash!==undefined&&row.hash!==hash)fail('idempotency_conflict',409);
  return row;
 }

 async render(project,raw,identity){
  this.v2.controlCredits.keyId(project,identity);
  const input=normalize(raw),key=input.idempotency_key,hash=sha(JSON.stringify(input));
  return this.respond(project,key,await this.capture(project,key,hash,()=>input,identity));
 }

 // The caller contract is fingerprinted separately from the configured
 // routing input. Existing captures can be recovered after route changes.
 async capture(project,key,hash,resolveInput,identity,{timeoutMs}={}){
  const internalKey=this.operationKey(key);
  if(await this.fingerprint(project,key,hash)){
   let retained;
   try{retained=await this.v2.lookup(project,internalKey);}catch(error){if(!(error instanceof GatewayError)||error.code!=='operation_not_found')throw error;}
   if(retained)return retained;
  }
  const input=await resolveInput();
  const managed=this.v2.controlCredits.managed(project);
  const candidate=managed?await managedRenderProfile(this.v2,project,input):null;
  let profile=candidate;
  if(!profile){
   try{profile=await this.v2.profile(project,input.access_profile);}
   catch(error){
    if(!(error instanceof GatewayError)||error.code!=='access_profile_forbidden')throw error;
    rejectRenderProfile('access_profile_forbidden');
   }
  }
  if(!profile.browser_probe?.enabled)rejectRenderProfile('browser_probe_profile_unapproved',{profile});
  if(input.wait_ms!==undefined&&input.wait_ms>profile.browser_probe.settle_ms)fail('browser_wait_ceiling_rejected');
  const request=this.v2.request({url:input.url,method:'GET'},profile);
  let url;try{url=new URL(request.url);}catch{fail('destination_rejected');}
  if(!profile.origins.includes(url.origin))fail('destination_rejected');
  this.v2.headers(request,profile,url);
  // Bind before opening a session so even concurrent conflicting submissions
  // cannot create sessions with different routes under the caller's key.
  await this.fingerprint(project,key,hash,{bind:true});
  const session=await this.v2.renderSession(project,{idempotency_key:this.sessionKey(key),access_profile:input.access_profile,transport:'browser',proxy:{...input.proxy,affinity:'session'}},{profile:candidate});
  let operation;
  try{
   const {max_estimated_micro_usd,screenshot,wait_ms}=input;
   operation=await this.v2.browserProbe(project,{idempotency_key:internalKey,session_id:session.id,url:input.url,
    ...(max_estimated_micro_usd===undefined?{}:{max_estimated_micro_usd}),...(screenshot===true?{screenshot:true}:{}),...(wait_ms===undefined?{}:{wait_ms})},identity,{timeoutMs});
  }catch(error){
   if(error&&typeof error==='object'){
    const rejected=isPublicOperationAdmissionError(error)||error instanceof GatewayError&&admissionCodes.has(error.code);
    failureContexts.set(error,{sessionId:session.id,routing:{class:session.proxy.class,country:session.proxy.country,provider:session.proxy.provider},state:error.code==='browser_queue_running'?'running':rejected?'rejected':'unknown',stage:rejected?'operation_admission':'operation'});
   }
   throw error;
  }
  return operation;
 }

 async lookup(project,key){
  if(!validKey(key))fail('idempotency_key_required');
  if(!await this.fingerprint(project,key))fail('operation_not_found',404);
  return this.respond(project,key,await this.v2.lookup(project,this.operationKey(key)));
 }

 async lookupOperation(project,id,retained){
  const operation=retained??await this.v2.readOperation(project,id),internal=/^public-(?:render|scrape)\.o\.[a-f0-9]{32}$/.test(operation.idempotency_key);
  return this.respond(project,internal?null:operation.idempotency_key,operation,{keyScope:internal?'internal_operation':'browser_probe',recoveryUrl:'/v2/operations/'+operation.id});
 }
}

export function registerPublicRender(app){
 const render=new PublicRenderGateway(app.v2);
 app.decorate('publicRender',render);
 app.post(RENDER_PREPARATION_PATH,{bodyLimit:96*1024},req=>prepareBearerRender(app.v2,req.project,req.body,req.apiKeyId));
 app.post('/v2/render',{bodyLimit:96*1024},req=>render.render(req.project,req.body,{keyId:req.apiKeyId}));
 app.get('/v2/render/:key',req=>render.lookup(req.project,req.params.key));
}
