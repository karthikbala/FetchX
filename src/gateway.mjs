import {isResidential,residentialPolicy,selectedRoute,routePlan,providerProxy,reserveResidential,settleResidential} from './residential.mjs';
import {residentialRequest} from './residential-transport.mjs';
import {CaptchaSolver,validateCaptchaProfile} from './captcha.mjs';
import {validateRecipe} from './browser-recipes.mjs';
import {checkBrowserTier} from './browser.mjs';
import {randomUUID,randomInt,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {ID,GatewayError,fail,checkedURL,checkedHeaders,requestInput,FALLBACK_FAILURES,METERED_BLOCKING_ERRORS} from './policy.mjs';
import {sha,Sealer} from './crypto.mjs';
import {oxylabsRequest,scrapeDoRequest,redactProviderSecrets} from './transport.mjs';
import {artifactAdmission,recordArtifact} from './artifacts.mjs';
import {validateAdmissionConfig,enqueueAdmission,requireAdmissionTurn,completeAdmission,checkProjectBudget} from './admission.mjs';
import {classifyOutcome} from './diagnostics.mjs';
import {hasHtmlChallenge} from './source-challenge.mjs';
import {observeProtection} from './protection.mjs';
import {chooseHealthyProxy,recordRouteOutcome,validateRouteHealthConfig} from './route-health.mjs';

export class Gateway {
 constructor({store,config,profiles,resolve,browserTierCheck=checkBrowserTier,transport={oxylabs:oxylabsRequest,scrapedo:scrapeDoRequest}}){
  Object.assign(this,{store,config,profiles,resolve,transport,browserTierCheck});this.sealer=new Sealer(config.artifactKey);
  for(const p of Object.values(profiles))for(const recipe of Object.values(p.browserRecipes??{}))validateRecipe(recipe);
  for(const n of [config.jobs?.maxQueued,...Object.values(config.projects).map(p=>p.maxQueuedJobs)])if(n!==undefined&&(!Number.isSafeInteger(n)||n<1||n>10000))fail('job_queue_configuration',500);
  for(const p of Object.values(profiles))validateCaptchaProfile(p);
  this.captchaSolver=new CaptchaSolver(store,config);
  validateAdmissionConfig(config);
  validateRouteHealthConfig(config);
 }
 profile(project,id){if(typeof id!=='string'||!this.config.projects[project]?.profiles.includes(id)||!Object.hasOwn(this.profiles,id))fail('profile_forbidden',403);return residentialPolicy(this.profiles[id],this.config);}
 async workflow(project,input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['idempotency_key','profile','max_requests','max_bytes','ttl_seconds'].includes(k))||typeof input.idempotency_key!=='string'||typeof input.profile!=='string'||!ID.test(input.idempotency_key))fail('workflow_invalid');
  const p=this.profile(project,input.profile),maxRequests=input.max_requests??p.maxRequests,maxBytes=input.max_bytes??p.maxBytes,ttl=input.ttl_seconds??p.ttlSeconds;
  if(!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>p.maxRequests||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>p.maxBytes||!Number.isInteger(ttl)||ttl<1||ttl>p.ttlSeconds)fail('workflow_limits_rejected');
  const policy={...p,maxRequests,maxBytes,ttlSeconds:ttl,profileVersion:this.config.release};
  return this.store.tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(1001)');
   const old=(await c.query('SELECT * FROM workflows WHERE project=$1 AND key=$2',[project,input.idempotency_key])).rows[0];
   if(old){if(old.profile!==input.profile||old.config.maxRequests!==maxRequests||old.config.maxBytes!==maxBytes||old.config.ttlSeconds!==ttl)fail('idempotency_conflict',409);return this.workflowView(old);}
   if(isResidential(p)){
    providerProxy(this.config,policy,'evomi');
    const id=randomUUID(),config={...policy,routingSelection:'evomi_default'};
    const row=(await c.query("INSERT INTO workflows(id,project,key,profile,config,proxy_id,route,expires_at) VALUES($1,$2,$3,$4,$5,$6,'evomi',now()+$7*interval '1 second') RETURNING *",[id,project,input.idempotency_key,input.profile,config,`evomi:${p.residentialSession}`,ttl])).rows[0];
    return this.workflowView(row);
   }
   const eligible=this.config.proxies.filter(x=>x.country===p.country);
   if(!eligible.length)fail('country_pool_unavailable',503);
   const n=Number((await c.query('UPDATE pool_cursor SET value=value+1 WHERE id=1 RETURNING value')).rows[0].value);
   const proxy=await chooseHealthyProxy(c,{profile:input.profile,eligible,cursor:n,config:this.config}),id=randomUUID();
   const config={...policy,providerSession:randomInt(0,1000001),routingSelection:proxy.selectionReason};
   const row=(await c.query("INSERT INTO workflows(id,project,key,profile,config,proxy_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 second') RETURNING *",[id,project,input.idempotency_key,input.profile,config,proxy.id,ttl])).rows[0];
   return this.workflowView(row);
  });
 }
 workflowView(w){return {id:w.id,profile:w.profile,state:w.state,route:w.route,...(isResidential(w.config)?{routing_policy:w.config.routingPolicy,browser_tier:selectedRoute(w.config).tier,route_index:w.config.routeIndex}:{}),country:w.config.country,sticky:true,expires_at:w.expires_at,requests:w.requests,bytes:Number(w.bytes)};}
 async owned(project,id,c=this.store.pool){const w=(await c.query('SELECT * FROM workflows WHERE id=$1 AND project=$2',[id,project])).rows[0];if(!w)fail('workflow_not_found',404);return w;}
 async read(project,id){const w=await this.owned(project,id);const billing=(await this.store.pool.query('SELECT provider,state,count(*)::int AS attempts,sum(credits)::int AS known_credits,sum(CASE WHEN credits IS NULL THEN reserved_credits ELSE 0 END)::int AS held_credits FROM attempts WHERE workflow=$1 GROUP BY provider,state',[id])).rows;return {...this.workflowView(w),billing};}
 async fallback(project,id,input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['reason','evidence'].includes(k))||input.reason!=='native_flow_incomplete'||typeof input.evidence!=='string'||!/^sha256:[a-f0-9]{64}$/.test(input.evidence))fail('fallback_proof_required');
  await this.store.tx(async c=>{
   const w=(await c.query('SELECT * FROM workflows WHERE id=$1 AND project=$2 FOR UPDATE',[id,project])).rows[0];
   if(!w)fail('workflow_not_found',404);this.profile(project,w.profile);
   if(isResidential(w.config))fail('managed_fallback_only',409);
   if(!w.config.allowFallbackRestart||w.state!=='closed'||w.route!=='oxylabs'||w.config.fallbackRestarted||new Date(w.expires_at)<=new Date())fail('fallback_restart_rejected',409);
   if((await c.query("SELECT 1 FROM operations WHERE workflow=$1 AND state IN ('running','reserved')",[id])).rowCount)fail('workflow_busy',409);
   const config={...w.config,fallbackRestarted:true,fallbackEvidence:input.evidence,providerSession:randomInt(0,1000001)};
   await c.query("UPDATE workflows SET state='open',route='scrapedo',config=$2 WHERE id=$1",[id,config]);
  });return this.read(project,id);
 }
 async close(project,id){await this.store.tx(async c=>{await this.owned(project,id,c);await c.query("UPDATE workflows SET state=CASE WHEN EXISTS(SELECT 1 FROM operations WHERE workflow=$1 AND state IN ('running','reserved')) THEN 'closing' ELSE 'closed' END WHERE id=$1",[id]);await c.query("DELETE FROM browser_state WHERE workflow=$1 AND EXISTS(SELECT 1 FROM workflows WHERE id=$1 AND state='closed')",[id]);});return this.read(project,id);}
 async operation(project,id,raw,{asyncJob=false}={}){
  const w=await this.owned(project,id),p=w.config;this.profile(project,w.profile);
  if(p.captcha&&!asyncJob)fail('captcha_async_required',409);
  if(!raw||typeof raw!=='object')fail('request_invalid');
  if(isResidential(p)&&p.execution==='browser'&&(raw.method&&raw.method!=='GET'||raw.body_base64||raw.main_document!==true))fail('browser_main_document_required');
  const input=requestInput(raw,p),u=await checkedURL(input.url,p,this.resolve);input.headers=checkedHeaders(input.headers,p,u,input.method);
  // Source guest credentials may be approved, but project gateway credentials
  // never belong to a source, even if a caller accidentally reuses its headers.
  const gatewayTokenHashes=new Set(Object.values(this.config.projects).map(project=>project.tokenHash).filter(Boolean));
  for(const value of Object.values(input.headers))if(gatewayTokenHashes.has(sha(value.trim().replace(/^Bearer\s+/i,'').trim())))fail('credential_scope_rejected');
  for(const value of Object.values(input.browser?.values??{}))if(gatewayTokenHashes.has(sha(value)))fail('credential_scope_rejected');
  const canonical=JSON.stringify({...input,body:undefined}),opId=randomUUID();let reused=false;
  await this.store.tx(async c=>{
   const locked=(await c.query('SELECT * FROM workflows WHERE id=$1 FOR UPDATE',[id])).rows[0];
   const old=(await c.query('SELECT * FROM operations WHERE workflow=$1 AND key=$2',[id,input.idempotency_key])).rows[0];
   if(old){if(this.sealer.open(old.input)!==canonical)fail('idempotency_conflict',409);reused=old;return;}
   if(locked.state!=='open'||new Date(locked.expires_at)<=new Date())fail('workflow_closed',409);
   if(locked.requests>=p.maxRequests||Number(locked.bytes)>=p.maxBytes)fail('workflow_limit',429);
   const active=(await c.query("SELECT 1 FROM operations WHERE workflow=$1 AND state IN ('running','reserved')",[id])).rowCount;
   // The first operation owns the routing decision through capture/fallback. A request
   // reservation increments requests before its response, so that counter alone
   // cannot establish that it is safe to start another browser resource.
   const first=(await c.query("SELECT o.state FROM attempts a JOIN operations o ON o.id=a.operation WHERE a.workflow=$1 AND a.state<>'cancelled' ORDER BY a.created_at,a.id LIMIT 1",[id])).rows[0];
   if(active>=(p.maxConcurrent??1)||(active>0&&(locked.requests===0||['running','reserved'].includes(first?.state))))fail('workflow_busy',409);
   await c.query('SELECT pg_advisory_xact_lock(1003)');
   const pending=Number((await c.query("SELECT COALESCE(sum(ceil((w.config->>'maxResponseBytes')::numeric*1.4)+65536),0) AS n FROM operations o JOIN workflows w ON w.id=o.workflow WHERE o.state IN ('running','reserved')")).rows[0].n);
   await artifactAdmission(this.config,pending+Math.ceil(p.maxResponseBytes*1.4)+65536);
   await c.query('INSERT INTO operations(id,workflow,key,input,state) VALUES($1,$2,$3,$4,\'running\')',[opId,id,input.idempotency_key,this.sealer.seal(canonical)]);
  });
  if(reused)return this.result(project,reused.id);
  try{
   let current=await this.owned(project,id),provider=current.route;
   const firstRestart=provider==='scrapedo'&&p.fallbackRestarted&&!(await this.store.pool.query("SELECT 1 FROM attempts WHERE workflow=$1 AND provider='scrapedo' LIMIT 1",[id])).rowCount;
   const routingReason=firstRestart?'fallback_native_flow_incomplete':current.requests===0?(p.routingSelection??'oxylabs_default'):'sticky_session';
   let response=await this.attempt(current,opId,input,provider,routingReason);
   if(isResidential(p))response=await this.residentialFallback(current,opId,input,response);
   const htmlChallenge=input.main_document&&hasHtmlChallenge(response);
   const category=response.error??([401,403].includes(response.status)?'source_denied':htmlChallenge?'source_challenge':null);
   // First request only. Never move an established cookie/browser session to a new egress.
   if(provider==='oxylabs'&&FALLBACK_FAILURES.has(category)&&current.requests===0&&input.method==='GET'&&p.maxFallbackCredits>0&&this.config.scrapeDoToken){
    await this.store.pool.query("UPDATE workflows SET route='scrapedo' WHERE id=$1",[id]);
    response=await this.attempt(current,opId,input,'scrapedo','fallback_'+category);
   }
   const result={id:opId,workflow:id,...(response.captcha?{captcha:response.captcha}:{}),...(response.extracted!==undefined?{extracted:response.extracted}:{}),...(response.screenshot_base64?{screenshot:{content_type:'image/png',body_base64:response.screenshot_base64}}:{}),...(input.browser?{browser_recipe:input.browser.recipe,actions_completed:response.actionsCompleted??0,action_step:response.actionStep??null}:{}),provider:response.provider,...(isResidential(p)?{browser_tier:response.browserTier??null,browser_version:response.browserVersion??null,browser_phase:response.browserPhase??null,browser_failure_code:response.browserFailureCode??null,wire_bytes:response.wireBytes??null,billing_basis:'reserved_bandwidth_unreconciled'}:{}),proxy_class:['evomi','dataimpulse'].includes(response.provider)?'residential':response.provider==='oxylabs'?'dedicated_datacenter':p.fallbackSuper?'residential':'datacenter',country:p.country,status:response.status??null,provider_status:response.providerStatus??null,headers:response.headers??{},cookies:response.cookies??[],body_base64:response.body.toString('base64'),captured_at:new Date().toISOString(),fallback_blocked:response.fallbackBlocked??null,credits:response.provider==='scrapedo'?(response.credits??null):null,proxy_cost_basis:response.provider==='oxylabs'?'existing_subscription_included_usage':['evomi','dataimpulse'].includes(response.provider)?'bandwidth_reservation':'metered',error:response.error??null};
   const encrypted=this.sealer.seal(result,{compress:true}),path=join(this.config.artifactDir,opId+'.bin');
   await mkdir(this.config.artifactDir,{recursive:true,mode:0o700});await writeFile(path+'.tmp',encrypted,{mode:0o600});await rename(path+'.tmp',path);recordArtifact(this.config,encrypted.length);
   await this.store.tx(async c=>{await c.query("UPDATE operations SET state=$2,result_path=$3,error=$4 WHERE id=$1",[opId,response.error?'failed':'captured',path,response.error??null]);await c.query("UPDATE workflows w SET state='closed' WHERE id=$1 AND state='closing' AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.workflow=w.id AND o.state IN ('running','reserved'))",[id]);});
   return result;
  }catch(e){await this.store.tx(async c=>{await c.query("UPDATE operations SET state='failed',error=$2 WHERE id=$1",[opId,e instanceof GatewayError?e.code:'operation_failed']);await c.query("UPDATE workflows w SET state='closed' WHERE id=$1 AND (state='closing' OR expires_at<=now()) AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.workflow=w.id AND o.state IN ('running','reserved'))",[id]);});throw e;}
 }
 async residentialFallback(w,opId,input,response){
  // Browser captures are isolated from caller state. Native first GET only.
  if(w.requests!==0||input.method!=='GET'||Object.keys(input.headers).some(k=>['cookie','authorization'].includes(k.toLowerCase())))return response;
  for(;;){
   const category=classifyOutcome(response,{...input,main_document:true});
   const eligibleError=!response.error||['proxy_connect_failed','source_challenge','source_denied'].includes(response.error)||response.error==='browser_capture_failed'&&['source_denied','source_challenge'].includes(category);
   if(!eligibleError||response.headers?.['retry-after']||!['source_denied','source_challenge','transport_failure'].includes(category))return response;
   if(response.actionsStarted)return {...response,fallbackBlocked:'browser_actions_not_replayable'};
   const next=(w.config.routeIndex??0)+1;
   if(next>=Math.min(routePlan(w.config).length,w.config.maxRouteAttempts??4))return response;
   const config={...w.config,routeIndex:next,residentialSession:randomBytes(5).toString('hex')},route=selectedRoute(config);
   try{providerProxy(this.config,config,route.provider);if(route.tier)await this.browserTierCheck(this.config,route.tier);}catch(e){return {...response,fallbackBlocked:e.code??'route_unavailable'};}
   await this.store.tx(async c=>{
    const current=await this.owned(w.project,w.id,c);if(current.state!=='open')fail('workflow_closed',409);
    await c.query('DELETE FROM browser_state WHERE workflow=$1',[w.id]);
    await c.query('UPDATE workflows SET route=$2,config=$3,proxy_id=$4 WHERE id=$1',[w.id,route.provider,config,`${route.provider}:${config.residentialSession}`]);
   });
   w={...w,config,route:route.provider,proxy_id:`${route.provider}:${config.residentialSession}`};
   response=await this.attempt(w,opId,input,route.provider,'residential_fallback');
  }
 }
 async attempt(w,opId,input,provider,routingReason='sticky_session'){
  const p=w.config,aid=randomUUID(),reserved=provider==='scrapedo'?p.fallbackMaxCost:0;
  if(isResidential(p)&&p.execution==='browser')await this.browserTierCheck(this.config,selectedRoute(p).tier);
  if(provider==='scrapedo'&&(!Number.isInteger(p.providerSession)||p.providerSession<0||p.providerSession>1000000))fail('provider_session_invalid',500);
  let delay,admitted=false;const admissionDeadline=Math.min(+new Date(w.expires_at),Date.now()+15000);
  const queuedAt=await enqueueAdmission(this.store,this.config,{id:aid,operation:opId,project:w.project,provider,deadline:admissionDeadline});
  try{
  for(;;){try{delay=await this.store.tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(1002)');
   const now=(await c.query('SELECT * FROM workflows WHERE id=$1 FOR UPDATE',[w.id])).rows[0];
   const inflight=(await c.query("SELECT 1 FROM attempts WHERE workflow=$1 AND state IN ('reserved','sent')",[w.id])).rowCount;
   if(now.state!=='open'||new Date(now.expires_at)<=new Date()||now.requests>=p.maxRequests||Number(now.bytes)+(inflight+1)*p.maxResponseBytes>p.maxBytes)fail('workflow_limit',429);
   if(provider==='scrapedo'){
    if(!this.config.scrapeDoToken)fail('fallback_unavailable',503);
    const wf=Number((await c.query("SELECT COALESCE(sum(COALESCE(credits,reserved_credits)),0) AS n FROM attempts WHERE workflow=$1 AND provider='scrapedo'",[w.id])).rows[0].n);
    const account=Number((await c.query("SELECT COALESCE(sum(COALESCE(credits,reserved_credits)),0) AS n FROM attempts WHERE provider='scrapedo' AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'")).rows[0].n);
    if(wf+reserved>p.maxFallbackCredits||account+reserved>this.config.maxDailyFallbackCredits)fail('fallback_limit',429);
    await checkProjectBudget(c,this.config,w.project,reserved);
    // Unknown billing is already counted by both sums above. Only a classified
    // account, security or price failure suspends new paid work across workflows.
    if((await c.query("SELECT 1 FROM attempts WHERE provider='scrapedo' AND error=ANY($1::text[]) LIMIT 1",[METERED_BLOCKING_ERRORS])).rowCount)fail('metered_account_busy_or_held',409);
    if((await c.query("SELECT 1 FROM attempts WHERE provider='scrapedo' AND state IN ('reserved','sent') LIMIT 1")).rowCount)fail('capacity_wait',503);
   }
   await requireAdmissionTurn(c,this.config,aid);
   const sources=['source:'+w.profile.split('.').slice(0,2).join('.'),'origin:'+new URL(input.url).hostname,'egress:'+w.proxy_id];
   for(const source of sources)await c.query('INSERT INTO source_limits(source) VALUES($1) ON CONFLICT DO NOTHING',[source]);
   const prior=(await c.query('SELECT * FROM source_limits WHERE source=ANY($1) ORDER BY source FOR UPDATE',[sources])).rows;
   const start=Math.max(Date.now(),...prior.map(x=>+new Date(x.next_at)));if(start-Date.now()>10000)fail('source_cooldown',429);
   for(const source of sources)await c.query('UPDATE source_limits SET next_at=$2 WHERE source=$1',[source,new Date(start+(source.startsWith('egress:')?Math.min(p.minIntervalMs,100):p.minIntervalMs))]);
   await c.query('UPDATE workflows SET requests=requests+1 WHERE id=$1',[w.id]);
   await c.query('INSERT INTO attempts(id,operation,workflow,provider,reserved_credits,queued_at,routing_reason) VALUES($1,$2,$3,$4,$5,$6,$7)',[aid,opId,w.id,provider,reserved,queuedAt,routingReason]);
   if(isResidential(p))await reserveResidential(c,this.config,w,aid,provider);
   await c.query("INSERT INTO ledger(attempt,event,credits) VALUES($1,'reserve',$2)",[aid,reserved]);
   await completeAdmission(c,w.project,aid);
   return start-Date.now();
  });admitted=true;break;}catch(e){if(e.code!=='capacity_wait'||Date.now()>=admissionDeadline)throw e;await new Promise(r=>setTimeout(r,100));}}
  }finally{
   // Admission already deletes the queue row atomically with reservation. A
   // cleanup failure must not strand that reservation or hide an earlier error.
   if(!admitted)await this.store.pool.query('DELETE FROM admission_queue WHERE id=$1',[aid]).catch(()=>process.stderr.write(JSON.stringify({event:'admission_cleanup_failed',operation:opId})+'\n'));
  }
  if(delay>0)await new Promise(r=>setTimeout(r,delay));
  // Closing, expiry, or a new 429 can happen while this reservation waits for
  // its pacing slot. Only a durable sent transition permits network dispatch.
  const cancelled=await this.store.tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(1002)');
   const current=(await c.query('SELECT * FROM workflows WHERE id=$1 FOR UPDATE',[w.id])).rows[0];
   const attempt=(await c.query('SELECT state FROM attempts WHERE id=$1 FOR UPDATE',[aid])).rows[0];
   if(attempt?.state!=='reserved')return 'attempt_not_dispatchable';
   const sources=['source:'+w.profile.split('.').slice(0,2).join('.'),'origin:'+new URL(input.url).hostname,'egress:'+w.proxy_id];
   const cooling=(await c.query('SELECT 1 FROM source_limits WHERE source=ANY($1) AND cooldown_until>now()',[sources])).rowCount;
   const reason=current.state!=='open'||new Date(current.expires_at)<=new Date()?'workflow_closed':cooling?'source_cooldown':null;
   if(reason){
    await c.query("UPDATE attempts SET state='cancelled',credits=$2,error=$3,finished_at=clock_timestamp(),outcome_category='cancelled' WHERE id=$1",[aid,provider==='scrapedo'?0:null,reason]);
    await c.query("INSERT INTO ledger(attempt,event,credits) VALUES($1,'cancel_before_dispatch',0)",[aid]);
    await c.query('UPDATE workflows SET requests=requests-1 WHERE id=$1',[w.id]);
   }else await c.query("UPDATE attempts SET state='sent',dispatched_at=clock_timestamp() WHERE id=$1",[aid]);
   return reason;
  });
  if(cancelled&&isResidential(p))await this.store.pool.query("UPDATE residential_usage SET accounted_bytes=0,estimated_micro_usd=0,state='cancelled_before_dispatch' WHERE attempt=$1",[aid]);
  if(cancelled)fail(cancelled,cancelled==='source_cooldown'?429:409);
  let r;
  try{if(isResidential(p)){const state=(await this.store.pool.query('SELECT state FROM browser_state WHERE workflow=$1',[w.id])).rows[0];r=await (this.transport.residential??residentialRequest)(input,w,this.config,state?this.sealer.open(state.state):null,{solve:(candidate,options)=>this.captchaSolver.solve(w,aid,opId,candidate,options),report:verification=>this.captchaSolver.report(w,aid,verification)});}else{const proxy=this.config.proxies.find(x=>x.id===w.proxy_id);r=provider==='oxylabs'?await this.transport.oxylabs(input,proxy,p):await this.transport.scrapedo(input,p.providerSession,p,this.config.scrapeDoToken);}}
  catch(e){r={status:null,providerStatus:null,headers:{},cookies:[],body:Buffer.alloc(0),credits:null,error:e instanceof GatewayError?e.code:provider==='scrapedo'?'metered_outcome_unknown':isResidential(p)?'transport_outcome_unknown':'proxy_connect_failed'};}
  const secrets=[this.config.captcha?.apiKey,...Object.values(this.config.residential?.providers??{}).flatMap(x=>[x.username,x.password]),...Object.values(this.config.browser??{}).filter(x=>typeof x==='object').map(x=>x.licenseKey),this.config.scrapeDoToken,...this.config.proxies.flatMap(x=>{try{const u=new URL(x.url);return [u.password,decodeURIComponent(u.password)];}catch{return [];}})];
  r=redactProviderSecrets(r,secrets);r.provider=provider;if(isResidential(p))r.browserTier=selectedRoute(p).tier;
  const unknown=provider==='scrapedo'&&r.credits===null||isResidential(p)&&r.error==='transport_outcome_unknown';
  if(provider==='scrapedo'&&r.credits>reserved)r.error='cost_overrun';
  await this.store.tx(async c=>{
   await c.query('UPDATE attempts SET state=$2,credits=$3,native_status=$4,provider_status=$5,bytes=$6,error=$7,finished_at=clock_timestamp(),outcome_category=$8 WHERE id=$1',[aid,unknown?'unknown':'settled',provider==='scrapedo'?r.credits:null,r.status,r.providerStatus,r.receivedBytes??r.redactedBytes??r.body.length,r.error??null,classifyOutcome(r,input)]);
   await c.query("INSERT INTO ledger(attempt,event,credits) VALUES($1,$2,$3)",[aid,unknown?'held_unknown':'settle',provider==='scrapedo'?r.credits:null]);
   if(isResidential(p)){await settleResidential(c,this.config,aid,provider,r);if(r.storageState&&!r.error)await c.query('INSERT INTO browser_state(workflow,state) VALUES($1,$2) ON CONFLICT(workflow) DO UPDATE SET state=EXCLUDED.state',[w.id,this.sealer.seal(r.storageState)]);}
   await c.query('UPDATE workflows SET bytes=bytes+$2 WHERE id=$1',[w.id,r.receivedBytes??r.redactedBytes??r.body.length]);
   if(r.status===429||r.headers?.['retry-after']){
    const text=r.headers?.['retry-after'],seconds=/^\d+$/.test(text??'')?Number(text):Math.ceil((Date.parse(text)-Date.now())/1000);
    const until=new Date(Date.now()+Math.min(3600,Math.max(60,Number.isFinite(seconds)?seconds:60))*1000);
    const keys=['source:'+w.profile.split('.').slice(0,2).join('.'),'origin:'+new URL(input.url).hostname,'egress:'+w.proxy_id];
    for(const key of keys)await c.query('INSERT INTO source_limits(source,next_at,cooldown_until) VALUES($1,$2,$2) ON CONFLICT(source) DO UPDATE SET next_at=GREATEST(source_limits.next_at,EXCLUDED.next_at),cooldown_until=GREATEST(source_limits.cooldown_until,EXCLUDED.cooldown_until)',[key,until]);
   }
  });
  // Passive fingerprints are independent of health/fallback and settlement.
  await observeProtection(this.store,{attemptId:aid,response:r,input});
  // Observational health must never roll back a settled receipt or prevent
  // publication of a response that was already fetched. It cannot dispatch.
  if(provider==='oxylabs')try{
   await this.store.tx(async c=>{
    await c.query("SET LOCAL lock_timeout='500ms'");await c.query("SET LOCAL statement_timeout='1000ms'");
    await recordRouteOutcome(c,{profile:w.profile,proxyId:w.proxy_id,workflowId:w.id,response:r,input,config:this.config});
   });
  }catch{process.stderr.write(JSON.stringify({event:'route_health_update_failed',attempt:aid,profile:w.profile})+'\n');}
  if(unknown&&provider==='scrapedo'&&!METERED_BLOCKING_ERRORS.includes(r.error))process.stderr.write(JSON.stringify({event:'billing_receipt_unknown',blocking:false,attempt:aid,workflow:w.id,profile:w.profile,provider:'scrapedo',reserved_credits:reserved,error:r.error??null})+'\n');
  return r;
 }
 async recoverCaptures(){
  // rename() precedes the database result pointer. A crash between them can
  // leave a complete authenticated capture whose billing already settled.
  // Recover only interrupted operations and never infer or alter billing.
  const rows=(await this.store.pool.query("SELECT id,workflow FROM operations WHERE state='unknown' AND error='interrupted_unknown' AND result_path IS NULL")).rows;
  const summary={recovered:0,missing:0,invalid:0};
  for(const row of rows){
   const path=join(this.config.artifactDir,row.id+'.bin');let capture;
   try{capture=this.sealer.open(await readFile(path));}catch(e){summary[e.code==='ENOENT'?'missing':'invalid']++;continue;}
   if(!capture||typeof capture!=='object'||capture.id!==row.id||capture.workflow!==row.workflow||!['oxylabs','scrapedo','evomi','dataimpulse'].includes(capture.provider)||typeof capture.body_base64!=='string'||Buffer.from(capture.body_base64,'base64').toString('base64')!==capture.body_base64||typeof capture.captured_at!=='string'||!Number.isFinite(Date.parse(capture.captured_at))||(capture.error!==null&&typeof capture.error!=='string')){summary.invalid++;continue;}
   const last=(await this.store.pool.query("SELECT provider,state FROM attempts WHERE operation=$1 AND state<>'cancelled' ORDER BY created_at DESC,id DESC LIMIT 1",[row.id])).rows[0];
   if(!last||last.provider!==capture.provider||['sent','reserved'].includes(last.state)){summary.invalid++;continue;}
   await this.store.tx(async c=>{
    const restored=await c.query("UPDATE operations SET result_path=$2,state=$3,error=$4 WHERE id=$1 AND state='unknown' AND error='interrupted_unknown' AND result_path IS NULL RETURNING id",[row.id,path,capture.error?'failed':'captured',capture.error]);
    if(restored.rowCount){summary.recovered++;await c.query("UPDATE workflows w SET state='closed' WHERE id=$1 AND state='closing' AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.workflow=w.id AND o.state IN ('running','reserved'))",[row.workflow]);}
   });
  }
  return summary;
 }
 async result(project,id){const row=(await this.store.pool.query('SELECT o.* FROM operations o JOIN workflows w ON w.id=o.workflow WHERE o.id=$1 AND w.project=$2',[id,project])).rows[0];if(!row)fail('operation_not_found',404);if(row.result_path){try{const capture=this.sealer.open(await readFile(row.result_path));if(!capture||capture.id!==row.id||capture.workflow!==row.workflow)fail('capture_invalid',500);return capture;}catch(e){if(e.code==='ENOENT')fail('capture_expired',410);throw e;}}fail(row.error??'operation_in_progress',row.state==='expired'?410:409);}
 async lookup(project,workflow,key){await this.owned(project,workflow);const row=(await this.store.pool.query('SELECT id FROM operations WHERE workflow=$1 AND key=$2',[workflow,key])).rows[0];if(!row)fail('operation_not_found',404);return this.result(project,row.id);}
}
