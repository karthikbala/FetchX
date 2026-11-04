import {randomUUID} from 'node:crypto';
import {Cookie,CookieJar} from 'tough-cookie';
import {ID,GatewayError,fail} from './policy.mjs';
import {sha} from './crypto.mjs';
import {browserProbePolicy,BROWSER_SCREENSHOT_MAX_BYTES} from './v2-browser-policy.mjs';
import {admitPlaygroundRoute,isPlaygroundRef,materializePlaygroundProfile,playgroundOperationProfile} from './control-playground.mjs';
import {safeFailure} from './v2-diagnostics.mjs';
import {residentialTrafficCharge,finishResidentialTrafficCharge} from './customer-traffic.mjs';

const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const sorted=v=>Array.isArray(v)?v.map(sorted):plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
const canonical=v=>JSON.stringify(sorted(v));
const matchingDomain=(domain,origins)=>origins.some(origin=>{const host=new URL(origin).hostname;return host===domain||host.endsWith('.'+domain);});
function browserCookies(jar,origins){return jar.serializeSync().cookies.filter(c=>matchingDomain(c.domain,origins)).map(c=>({name:c.key,value:c.value,domain:(c.hostOnly?'':'.')+c.domain,path:c.path??'/',httpOnly:!!c.httpOnly,secure:!!c.secure,sameSite:c.sameSite==='strict'?'Strict':c.sameSite==='none'?'None':'Lax',expires:Number.isFinite(Date.parse(c.expires))?Math.floor(Date.parse(c.expires)/1000):-1}));}
async function savedCookies(values,origins){
 if(!Array.isArray(values)||values.length>3000)fail('browser_cookie_state_invalid',502);
 const jar=new CookieJar();
 for(const value of values){
  if(!value||typeof value.domain!=='string'||!matchingDomain(value.domain.replace(/^\./,''),origins))continue;
  const domain=value.domain.replace(/^\./,''),cookie=new Cookie({key:value.name,value:value.value,domain,path:value.path??'/',hostOnly:!value.domain.startsWith('.'),secure:!!value.secure,httpOnly:!!value.httpOnly,sameSite:value.sameSite?.toLowerCase(),...(value.expires>0?{expires:new Date(value.expires*1000)}:{})});
  await jar.setCookie(cookie,'https://'+domain+(value.path??'/'));
 }
 return jar.serializeSync();
}
const emptyResult=()=>({kind:'browser_network_probe',status:null,final_url:null,artifacts:[],physical_requests:0,physical_requests_basis:'admitted_browser_target_attempts',blocked_requests:0,blocked_reasons:{},capture_complete:false,encoded_bytes:null,decoded_bytes:0,dom_bytes:0,tunnel_bytes:null,provider_status:null,retry_after:null});

export async function browserProbeOperation(v2,project,raw,identity){
 if(!plain(raw)||Object.keys(raw).some(k=>!['idempotency_key','session_id','url','max_physical_requests','max_estimated_micro_usd','screenshot','wait_ms'].includes(k))||typeof raw.idempotency_key!=='string'||!ID.test(raw.idempotency_key)||typeof raw.session_id!=='string'||!/^[a-f0-9-]{36}$/i.test(raw.session_id)||typeof raw.url!=='string'||raw.url.length>12000||raw.max_physical_requests!==undefined&&!Number.isSafeInteger(raw.max_physical_requests)||raw.max_estimated_micro_usd!==undefined&&!Number.isSafeInteger(raw.max_estimated_micro_usd)||raw.screenshot!==undefined&&typeof raw.screenshot!=='boolean'||raw.wait_ms!==undefined&&(!Number.isSafeInteger(raw.wait_ms)||raw.wait_ms<0||raw.wait_ms>2000))fail('browser_probe_invalid');
 const keyId=v2.controlCredits.keyId(project,identity);
 const hash=sha(canonical({kind:'browser_network_probe',...raw}));
 const old=(await v2.store.pool.query('SELECT * FROM v2_operations WHERE project=$1 AND key=$2',[project,raw.idempotency_key])).rows[0];
 if(old){if(old.input_hash!==hash)fail('idempotency_conflict',409);return v2.operationView(old);}
 const session=await v2.owned(project,raw.session_id),route=v2.sealer.open(session.route);
 const managed=v2.controlCredits.managed(project);
 if(managed&&(!isPlaygroundRef(session.policy)||route.transport!=='browser'))fail('browser_session_required',403);
 const profile=managed?playgroundOperationProfile(v2,project,session.policy,raw.url,'browser'):await v2.profile(project,{id:session.policy.id,version:session.policy.version});
 const configured=browserProbePolicy(profile.browser_probe);
 if(!configured)fail('browser_probe_profile_unapproved',403);
 const runtime=await v2.browserRuntime(v2.config);if(!runtime.available)fail(runtime.reason??'browser_probe_runtime_unqualified',409);
 const maximum=raw.max_physical_requests??configured.max_requests;
 if(!Number.isSafeInteger(maximum)||maximum<1||maximum>configured.max_requests)fail('browser_request_ceiling_rejected');
 if(raw.max_estimated_micro_usd!==undefined&&(!Number.isSafeInteger(raw.max_estimated_micro_usd)||raw.max_estimated_micro_usd<0))fail('cost_ceiling_invalid');
 const policy={...configured,max_requests:maximum,settle_ms:raw.wait_ms??configured.settle_ms},id=randomUUID(),reservedBytes=policy.max_network_bytes,reservedTunnel=route.class==='direct'?0:reservedBytes;
 if(policy.settle_ms>configured.settle_ms)fail('browser_wait_ceiling_rejected');
 await admitPlaygroundRoute(v2,project,profile,{class:route.class,country:route.country,affinity:'session'},'browser',route);
 let replay,pricingDecision;
 await v2.store.tx(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(1002)');
  const prior=(await c.query('SELECT * FROM v2_operations WHERE project=$1 AND key=$2',[project,raw.idempotency_key])).rows[0];if(prior){if(prior.input_hash!==hash)fail('idempotency_conflict',409);replay=prior;return;}
  const current=(await c.query('SELECT * FROM v2_sessions WHERE id=$1 AND project=$2 FOR UPDATE',[session.id,project])).rows[0];
  if(current.state!=='open'||new Date(current.expires_at)<=new Date())fail('session_expired',409);
  if((await c.query("SELECT 1 FROM v2_operations WHERE session_id=$1 AND ($2 OR state IN ('reserved','running','unknown'))",[session.id,route.transport==='browser'])).rowCount)fail('session_busy_or_unknown',409);
  if(current.requests+maximum>profile.limits.max_requests||Number(current.encoded_bytes)+reservedBytes>profile.limits.max_session_encoded_bytes)fail('session_limit',429);
  const usage=(await c.query("SELECT count(*)::int AS n FROM v2_operations WHERE project=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",[project])).rows[0];const entitlement=v2.entitlement(project);if(entitlement.mode==='metered'&&usage.n>=entitlement.max_daily_operations)fail('client_quota_exhausted',429);
  const active=(await c.query("SELECT count(*)::int n FROM v2_operations WHERE state IN ('reserved','running')")).rows[0].n+Number((await c.query("SELECT count(*) AS n FROM attempts WHERE state IN ('reserved','sent')")).rows[0].n);
  if(active>=(v2.config.maxConcurrentRequests??4))fail('capacity_wait',503);
  if(Number((await c.query("SELECT count(*) AS n FROM v2_operations WHERE kind='browser_probe' AND state IN ('reserved','running')")).rows[0].n)>=(v2.config.browser?.maxConcurrent??1))fail('browser_capacity',503);
  const stored=Number((await c.query('SELECT COALESCE(sum(octet_length(body)),0) AS n FROM v2_artifacts')).rows[0].n);
  if(stored+Math.ceil((policy.max_decoded_bytes+policy.max_dom_bytes+(raw.screenshot?BROWSER_SCREENSHOT_MAX_BYTES:0))*1.4)+maximum*131072>(v2.config.v2?.maxArtifactBytes??268435456))fail('artifact_quota',507);
  await v2.reserveResidential(c,project,session,route,reservedTunnel);
  pricingDecision=v2.pricing(project,profile,route,reservedTunnel,'browser',profile.limits.timeout_ms);
  const estimate=pricingDecision.estimated_micro_usd;
  const creditEstimate=estimate===null?null:Math.max(estimate,pricingDecision.customer_traffic_reservation?.max_estimated_micro_usd??0);
  if(raw.max_estimated_micro_usd!==undefined){if(creditEstimate===null)fail('cost_estimate_unavailable',409);if(creditEstimate>raw.max_estimated_micro_usd)fail('cost_ceiling_exceeded',429);}
  await c.query("INSERT INTO v2_operations(id,project,key_id,key,session_id,input_hash,input,kind) VALUES($1,$2,$3,$4,$5,$6,$7,'browser_probe')",[id,project,keyId,raw.idempotency_key,session.id,hash,v2.sealer.seal(raw)]);
  await v2.controlCredits.reserve(c,{project,operation:id,keyId,userId:identity?.userId,requireSoleKey:identity?.requireSoleKey,route,profile,transport:'browser',estimatedMicroUsd:creditEstimate});
  if(managed)await materializePlaygroundProfile(v2,c,project,profile);
  await c.query('INSERT INTO v2_ledger(operation,project,session_id,provider,proxy_class,reserved_requests,accounted_requests,reserved_encoded_bytes,accounted_encoded_bytes,reserved_tunnel_bytes,accounted_tunnel_bytes,estimated_micro_usd,customer_traffic,customer_traffic_reservation) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$7,$8,$8,$9,$10,$11)',[id,project,session.id,route.provider,route.class,maximum,reservedBytes,reservedTunnel,estimate,route.class==='residential'?residentialTrafficCharge({status:'pending'}):null,pricingDecision.customer_traffic_reservation??null]);
  await c.query("INSERT INTO v2_ledger_events(operation,event,detail) VALUES($1,'reserve',$2)",[id,{kind:'browser_network_probe',requests:maximum,max_network_bytes:reservedBytes,reserved_tunnel_bytes:reservedTunnel,pricing_decision:pricingDecision}]);
  await c.query('UPDATE v2_sessions SET requests=requests+$2,encoded_bytes=encoded_bytes+$3 WHERE id=$1',[session.id,maximum,reservedBytes]);
 });
 if(replay)return v2.operationView(replay);
 const runtimeExpires=Date.parse(runtime.runtime?.expires_at);
 const deadline=Math.min(Date.now()+profile.limits.timeout_ms,new Date(session.expires_at).getTime(),pricingDecision.dispatch_deadline_ms??Infinity,Number.isFinite(runtimeExpires)?runtimeExpires:Infinity),result=emptyResult();
 const pricingContext={profile,route,decision:pricingDecision,transport:'browser'},pinnedDestinations=new Map();
 let relay=null,requests=0,dispatched=false,error=null,stage='dns',failure=null,cookieState=null,encodedSum=0,decodedSum=0,domSum=0,screenshotBytes=0,domArtifact=null,screenshotArtifact=null;
 const artifacts=[],seenKinds=new Set(),mainArtifacts=new Map();let admission=Promise.resolve(),callbackFailed=false,parentBlocked=0,runnerStarted=false,outputReceived=false,relayCloseUnknown=false;
 try{
  const first=await v2.destination(raw.url,profile,deadline);v2.headers({method:'GET',headers:{}},profile,first.url);
  const proxy=v2.resolveProxy(route),jar=CookieJar.deserializeSync(v2.sealer.open(session.cookie_jar));
  relay=await v2.browserRelay({profile,pinnedDestinations,proxy,limits:policy,deadline,beforeConnect:async destination=>{await v2.dispatchable(project,id,session.id,destination.url,pricingContext);dispatched=true;}});
  stage='browser';
  runnerStarted=true;const output=await v2.browserRunner({url:raw.url,timeout_ms:Math.max(1,deadline-Date.now()),deadline,policy,runtime:runtime.runtime,relay:relay.url,deny_relay:relay.deny_url,screenshot:raw.screenshot===true,cookies:browserCookies(jar,profile.origins)},{
   admit:(request,{signal}={})=>{const task=admission.then(async()=>{
    if(signal?.aborted||Date.now()>=deadline)fail('browser_probe_deadline_unknown',504);
    if(!request||!['GET','HEAD'].includes(request.method)||typeof request.url!=='string'||!plain(request.headers)||request.body_base64!==null)fail('method_rejected');
    if(requests>=maximum)fail('browser_request_limit',429);
    if(request.url.length>12000)fail('destination_rejected');
    if(!Number.isSafeInteger(request.redirect_depth)||request.redirect_depth<0||request.redirect_depth>profile.limits.max_redirects)fail('redirect_limit');
    const destination=await v2.destination(request.url,profile,deadline);
    v2.headers({method:request.method,headers:{}},profile,destination.url);
    if(request.redirected_from&&new URL(request.redirected_from).origin!==destination.url.origin&&!(profile.kind==='discovery'&&profile.id.startsWith('discovery:')))fail('redirect_origin_rejected');
    if(Buffer.byteLength(JSON.stringify(request.headers))>32768)fail('headers_rejected');
    for(const [name,value]of Object.entries(request.headers)){
     if(typeof value!=='string'||/^(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-|x-gateway|upgrade$)/i.test(name))fail('credential_scope_rejected');
     for(const p of Object.values(v2.config.projects))if(sha(value.trim().replace(/^Bearer\s+/i,''))===p.tokenHash)fail('credential_scope_rejected');
    }
    await v2.rejectControlCredentials(request.headers);
    await v2.pace(destination.url,profile.limits,deadline);
    if(signal?.aborted||Date.now()>=deadline)fail('browser_probe_deadline_unknown',504);
    await v2.dispatchable(project,id,session.id,destination.url,pricingContext);
    if(signal?.aborted||Date.now()>=deadline)fail('browser_probe_deadline_unknown',504);
    requests++;
    // Validate every request's DNS answer set. The relay keeps the original
    // public pin for this host so neither Chromium nor the proxy re-resolves it.
    const pin=pinnedDestinations.get(destination.url.hostname)??{destination,permits:0};
    pin.permits++;pinnedDestinations.set(destination.url.hostname,pin);
    return {ok:true};
   });admission=task.catch(()=>{});return task.catch(error=>{parentBlocked++;throw error;});},
   cooldown:async ({url,status,retry_after})=>{
    const source=new URL(url);
    if(!pinnedDestinations.has(source.hostname)||!profile.origins.includes(source.origin))fail('browser_probe_callback_unknown',502);
    await v2.cooldown(source,{status,headers:{'retry-after':retry_after}});
   },
   artifact:async artifact=>{
    try{
    if(!artifact||!['browser_response','rendered_dom','browser_screenshot'].includes(artifact.kind)||artifact.original_encoded_available!==false||artifact.encoded_body_base64!==null||artifact.encoded_sha256!==null||typeof artifact.url!=='string'||artifact.decoded_body_base64!==null&&typeof artifact.decoded_body_base64!=='string')fail('browser_probe_artifact_invalid',502);
    const artifactUrl=new URL(artifact.url);if(!profile.origins.includes(artifactUrl.origin))fail('browser_probe_artifact_invalid',502);v2.headers({method:artifact.method,headers:{}},profile,artifactUrl);
    const body=artifact.decoded_body_base64===null?null:Buffer.from(artifact.decoded_body_base64,'base64');
    if(body&&(body.toString('base64')!==artifact.decoded_body_base64||sha(body)!==artifact.decoded_sha256||body.length!==artifact.decoded_bytes))fail('browser_probe_artifact_invalid',502);
    if(!body&&(artifact.decoded_sha256!==null||artifact.decoded_bytes!==null)||artifact.encoded_bytes===null&&artifact.encoded_size_basis!==null||artifact.encoded_bytes!==null&&(!Number.isSafeInteger(artifact.encoded_bytes)||artifact.encoded_bytes<0||artifact.encoded_size_basis!=='playwright_request_sizes'))fail('browser_probe_artifact_invalid',502);
    if(artifact.kind==='browser_screenshot'){
     if(!raw.screenshot||seenKinds.has(artifact.kind)||artifact.generated!==true||!body||body.length>BROWSER_SCREENSHOT_MAX_BYTES||artifact.headers?.['content-type']!=='image/jpeg'||body[0]!==0xff||body[1]!==0xd8)fail('browser_probe_artifact_invalid',502);
     seenKinds.add(artifact.kind);screenshotBytes=body.length;
    }else if(artifact.kind==='rendered_dom'){if(seenKinds.has('rendered_dom')||artifact.generated!==true||!body||body.length>policy.max_dom_bytes)fail('browser_probe_artifact_invalid',502);seenKinds.add('rendered_dom');domSum=body.length;}
    else{if(artifacts.filter(a=>a.kind==='browser_response').length>=requests||decodedSum+(body?.length??0)>policy.max_decoded_bytes||!artifact.request||artifact.request.url!==artifact.url||!['GET','HEAD'].includes(artifact.request.method))fail('browser_probe_artifact_invalid',502);decodedSum+=body?.length??0;if(Number.isSafeInteger(artifact.encoded_bytes)&&artifact.encoded_bytes>=0)encodedSum+=artifact.encoded_bytes;}
    if(Buffer.byteLength(JSON.stringify([artifact.headers,artifact.raw_headers,artifact.request?.headers]))>131072)fail('browser_probe_artifact_invalid',502);
    v2.rejectSecrets(artifact);const record={...artifact,id:randomUUID(),operation_id:id};
    await v2.store.pool.query('INSERT INTO v2_artifacts(id,operation,project,body) VALUES($1,$2,$3,$4)',[record.id,id,project,v2.sealer.seal(record,{compress:true})]);
    artifacts.push({id:record.id,kind:record.kind,status:record.status,encoded_bytes:record.encoded_bytes,decoded_bytes:record.decoded_bytes,content_encoding:record.content_encoding});
    if(record.kind==='rendered_dom')domArtifact=record.id;
    if(record.kind==='browser_screenshot')screenshotArtifact=record.id;
    if(record.kind==='browser_response'&&record.main_document===true)mainArtifacts.set(JSON.stringify([record.url,record.status]),record.id);
    if(record.status===429)await v2.cooldown(new URL(record.url),{status:429,headers:record.headers});
    return {ok:true};
    }catch(error){callbackFailed=true;throw error;}
   }
  });
  outputReceived=true;error=relay.error??output.error??null;
  if(output.cookies)cookieState=await savedCookies(output.cookies,profile.origins);
  const native=artifacts.filter(a=>a.kind==='browser_response'),encodedComplete=native.length>0&&native.length===requests&&native.every(a=>Number.isSafeInteger(a.encoded_bytes));
  Object.assign(result,{status:output.status??null,final_url:output.final_url??null,blocked_requests:output.counts_complete===false?null:Math.max(parentBlocked,output.blocked_requests??0),blocked_reasons:output.blocked_reasons??{},capture_complete:!!output.capture_complete&&!parentBlocked&&!error&&native.length===requests&&seenKinds.has('rendered_dom')&&(!raw.screenshot||!!screenshotArtifact),encoded_bytes:encodedComplete?encodedSum:null,decoded_bytes:decodedSum,dom_bytes:domSum,screenshot_bytes:screenshotBytes,main_artifact_id:mainArtifacts.get(JSON.stringify([output.final_url,output.status]))??null,dom_artifact_id:domArtifact,screenshot_artifact_id:screenshotArtifact});
 }catch(e){error=e instanceof GatewayError?e.code:'browser_probe_internal_unknown';failure=safeFailure(e,stage,{dispatched:dispatched||requests>0});if(runnerStarted&&!outputReceived)result.blocked_requests=null;}
 finally{if(relay){try{await relay.close();}catch(e){relayCloseUnknown=true;error??='browser_relay_close_unknown';failure??=safeFailure(e,'relay_close',{dispatched:dispatched||requests>0});}error??=relay.error??null;}}
 const rawObserved=relay?.bytes,observed=Number.isSafeInteger(rawObserved)&&rawObserved>=0?rawObserved:null,networkDispatched=dispatched||relay?.dispatched||false,meterIncomplete=relayCloseUnknown||relay?.meter_complete===false||/unknown|incomplete/.test(relay?.error??''),unknown=(networkDispatched||requests>0)&&(meterIncomplete||!!error&&(callbackFailed||/unknown|incomplete|deadline/.test(error)));
 Object.assign(result,{artifacts,physical_requests:requests,tunnel_bytes:observed,provider_status:relay?.provider_status??null,target_connections:relay?.connections??0,capture_complete:result.capture_complete&&!unknown,diagnostics:{stage:error?stage:'completed',failure},network_byte_basis:route.class==='direct'?'bidirectional_origin_tls_stream_excludes_local_connect':'bidirectional_proxy_tunnel_includes_connect'});
 await v2.store.tx(async c=>{
  const ledger=(await c.query('SELECT * FROM v2_ledger WHERE operation=$1 FOR UPDATE',[id])).rows[0];
  const usedRequests=unknown?maximum:requests,usedEncoded=unknown||result.encoded_bytes===null&&networkDispatched?reservedBytes:result.encoded_bytes??0;
  const heldTunnel=networkDispatched?Math.max(reservedTunnel,route.class==='direct'?0:observed??0):0;
  if(route.class!=='direct'&&observed!==null&&observed>reservedTunnel)error='cost_overrun';
  const customerTraffic=finishResidentialTrafficCharge(ledger.customer_traffic,{dispatched:networkDispatched,unknown,partial:meterIncomplete,bytes:observed,maxBillableBytes:Number(ledger.customer_traffic_reservation?.reserved_bytes??ledger.reserved_tunnel_bytes)});
  const state=unknown?'unknown':error?'failed':'completed';
  await c.query('UPDATE v2_operations SET state=$2,error=$3,result=$4,summary=$5,finished_at=clock_timestamp() WHERE id=$1',[id,state,error,v2.sealer.seal(result,{compress:true}),{kind:'browser_network_probe',source_http_status:result.status,physical_requests:requests,encoded_bytes:result.encoded_bytes,decoded_bytes:result.decoded_bytes,tunnel_bytes:observed,diagnostics:result.diagnostics}]);
  await c.query('UPDATE v2_ledger SET state=$2,accounted_requests=$3,accounted_encoded_bytes=$4,observed_tunnel_bytes=$5,accounted_tunnel_bytes=$6,estimated_micro_usd=CASE WHEN $7 THEN estimated_micro_usd ELSE 0 END,customer_traffic=$8 WHERE operation=$1',[id,unknown?'unknown':networkDispatched?'unreconciled':'cancelled_before_dispatch',usedRequests,usedEncoded,observed,heldTunnel,networkDispatched,customerTraffic]);
  await c.query("INSERT INTO v2_ledger_events(operation,event,detail) VALUES($1,'finish',$2)",[id,{kind:'browser_network_probe',state,error,physical_requests:requests,network_dispatched:networkDispatched,observed_network_bytes:observed,...(customerTraffic?{customer_traffic:customerTraffic}:{})}]);
  await c.query('UPDATE v2_sessions SET requests=requests-$2+$3,encoded_bytes=encoded_bytes-$4+$5 WHERE id=$1',[session.id,ledger.reserved_requests,usedRequests,ledger.reserved_encoded_bytes,usedEncoded]);
  await v2.controlCredits.finish(c,{project,operation:id,dispatched:networkDispatched,unknown});
  if(cookieState&&!unknown)await c.query('UPDATE v2_sessions SET cookie_jar=$2 WHERE id=$1',[session.id,v2.sealer.seal(cookieState)]);
 });
 return v2.readOperation(project,id);
}
