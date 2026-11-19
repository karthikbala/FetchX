// Auto mode for POST /v2/fetch: `proxy: {"class": "auto"}` lets FetchX choose
// how to get the page. It starts from what site knowledge says works for the
// host and otherwise climbs a cheapest-first ladder through every transport
// the access profile allows: plain HTTP (direct, datacenter, residential),
// then a rendered browser on residential, a fresh residential session (new
// IP), and a browser on datacenter. It stops at the caller's attempt cap
// (default and maximum 5) and respects provider rules.
//
// Every attempt is an ordinary public fetch or render under a derived
// idempotency key, so admission, cost ceilings, budgets, provider rules and
// billing apply unchanged. Failed attempts are never billed (unbilledAttempt).
// The route of each attempt is recorded before dispatch, so a same-key replay
// re-reads the same attempts and never dispatches new source work for them.
//
// Safety: only GET and HEAD escalate (browser rungs are GET only). An uncertain
// attempt stops the ladder, because uncertain source work is never retried. A
// genuine rate limit (429 with Retry-After) is honoured, not routed around; a
// challenge page served with 429 counts as a block and escalates.
import {sha} from './crypto.mjs';
import {GatewayError,ID,fail} from './policy.mjs';
import {isPlaygroundRef,playgroundPolicy} from './control-playground.mjs';
import {PUBLIC_URL_REF} from './v2-public-url.mjs';
import {providerRule} from './provider-rules.mjs';
import {siteHost,siteRoutes} from './site-knowledge.mjs';

export const AUTO_MAX_ATTEMPTS=5;
const AUTO_MAX_SLOTS=10,AUTO_MAX_INLINE_WAIT_S=20;
function cooldownSeconds(error){
 if(error?.code!=='source_cooldown')return null;
 const until=Date.parse(error.details?.cooldown_until??'');
 if(Number.isFinite(until))return Math.max(1,Math.ceil((until-Date.now())/1000));
 const seconds=Number(error.details?.retry_after_seconds);
 return Number.isFinite(seconds)&&seconds>0?seconds:null;
}
const STATE_KIND='public_fetch_auto_v1',ROUTE_KIND='public_fetch_auto_route_v1';
const CLASS_ORDER=['direct','datacenter','residential'];
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const sort=v=>Array.isArray(v)?v.map(sort):plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
const canonical=v=>JSON.stringify(sort(v));
const regKey=(project,key)=>sha(canonical([project,key,'auto']));
export const autoAttemptKey=(key,index)=>'auto.'+sha(key).slice(0,48)+'.'+index;
// Responses that end the ladder: data was returned, the source answered with a
// real "not found", or the outcome is uncertain and must be recovered first.
const FINAL_CODES=new Set(['source_not_found']);
// Admission refusals that are about the caller's money or limits: escalating
// cannot help, so they are returned as they are.
const CALLER_LIMIT_CODES=new Set(['client_quota_exhausted','credit_balance_exhausted','cost_ceiling_exceeded','residential_budget_exhausted','paid_credit_balance_exhausted','paid_public_url_daily_quota_exhausted','idempotency_conflict','request_invalid','method_rejected','body_rejected','headers_rejected']);

// Client mistakes FetchX fixes in auto mode: an automation User-Agent (or none)
// and missing browser Accept headers make many sites refuse the request. The
// caller's other headers are kept exactly as sent.
export const BROWSER_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const AUTOMATION_UA=/^$|curl|wget|python|aiohttp|httpx|requests|urllib|scrapy|go-http|golang|java\/|okhttp|apache-httpclient|axios|node-fetch|undici|got \(|libwww|postman|insomnia|headless|phantomjs|selenium|puppeteer|playwright|\bbot\b|crawler|spider/i;
export function browserHeaders(headers,allowed){
 const out={},adjusted=[],has=name=>allowed.includes(name);
 for(const [name,value] of Object.entries(headers??{}))out[name.toLowerCase()]=value;
 const ua=typeof out['user-agent']==='string'?out['user-agent'].trim():'';
 if(AUTOMATION_UA.test(ua)){
  if(has('user-agent')){out['user-agent']=BROWSER_UA;adjusted.push('user-agent');}
  else if('user-agent' in out){delete out['user-agent'];adjusted.push('user-agent');}
 }
 if(!out.accept&&has('accept')){out.accept='text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';adjusted.push('accept');}
 if(!out['accept-language']&&has('accept-language')){out['accept-language']='en-US,en;q=0.9';adjusted.push('accept-language');}
 return {headers:out,adjusted};
}

export const isAutoRequest=raw=>plain(raw)&&plain(raw.proxy)&&raw.proxy.class==='auto';

function normalizeAuto(raw){
 const allowed=['idempotency_key','access_profile','url','proxy','method','headers','body_base64','max_estimated_micro_usd','max_transfer_mb','max_credits','retry','max_attempts'];
 if(Object.keys(raw).some(k=>!allowed.includes(k)))fail('request_invalid');
 if(typeof raw.idempotency_key!=='string'||!ID.test(raw.idempotency_key))fail('idempotency_key_required');
 if(Object.keys(raw.proxy).some(k=>!['class','country'].includes(k)))fail('proxy_required');
 const country=raw.proxy.country??null;
 if(country!==null&&(typeof country!=='string'||!/^[A-Z]{2}$/.test(country)))fail('country_required');
 const maxAttempts=raw.max_attempts??AUTO_MAX_ATTEMPTS;
 if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>AUTO_MAX_ATTEMPTS)fail('max_attempts_invalid');
 if(typeof raw.url!=='string'||raw.url.length>12000)fail('request_invalid');
 return {...raw,proxy:{class:'auto',country},method:raw.method??'GET',max_attempts:maxAttempts};
}

// Routes the access profile allows for HTTP, as {class, countries|direct}.
async function allowedRoutes(v2,project,ref){
 if(isPlaygroundRef(ref)){
  const mode=playgroundPolicy(v2.config)?.routes?.http;
  if(!mode)fail('capability_unsupported',409);
  return {direct:mode.direct===true,datacenter:mode.datacenter??[],residential:mode.residential??[],headers:['accept','accept-language','user-agent']};
 }
 const profile=await v2.profile(project,ref),countries=profile.countries??[],classes=profile.proxy_classes??[];
 return {direct:classes.includes('direct'),datacenter:classes.includes('datacenter')?countries:[],residential:classes.includes('residential')?countries:[],headers:(profile.headers??[]).map(h=>String(h).toLowerCase())};
}
const datacenterProvider=(config,country)=>(config.proxies??[]).find(p=>p.country===country)?.provider??'oxylabs';

// The ladder for a host, cheapest first:
//   HTTP direct -> HTTP datacenter -> HTTP residential ->
//   browser residential -> browser residential on a fresh session (new IP) ->
//   browser datacenter.
// Routes proven by site knowledge (either transport) move to the front;
// cooling routes and provider-rule exclusions are skipped. Browser rungs are
// offered only to GET requests and only if the access profile can render;
// a rung the profile cannot use is refused at admission with no dispatch.
export async function autoLadder(v2,project,input,host,{now=Date.now()}={}){
 const allowed=await allowedRoutes(v2,project,input.access_profile);
 const knowledge=await siteRoutes(v2.store.pool,host,{config:v2.config,now});
 const countries=[...new Set([...allowed.datacenter,...allowed.residential])];
 const proven=knowledge.filter(r=>r.state==='proven'&&r.country&&countries.includes(r.country));
 const country=input.proxy.country??proven[0]?.country??(countries.includes('US')?'US':[...countries].sort()[0]??null);
 const candidates=[];
 if(allowed.direct)candidates.push({transport:'http',class:'direct',country:null});
 if(country&&allowed.datacenter.includes(country))candidates.push({transport:'http',class:'datacenter',country});
 if(country&&allowed.residential.includes(country))candidates.push({transport:'http',class:'residential',country});
 if(input.method==='GET'){
  if(country&&allowed.residential.includes(country))candidates.push({transport:'browser',class:'residential',country},{transport:'browser',class:'residential',country,rotation:1});
  if(country&&allowed.datacenter.includes(country))candidates.push({transport:'browser',class:'datacenter',country});
 }
 const stateOf=route=>{
  const rows=knowledge.filter(r=>r.execution===route.transport&&r.proxy_class===route.class&&(route.class==='direct'||r.country===route.country));
  if(rows.some(r=>r.state==='proven'))return 'proven';
  if(rows.length&&rows.every(r=>r.state==='cooling'))return 'cooling';
  return 'unknown';
 };
 const routes=[],skipped=[];
 for(const [order,route] of candidates.entries()){
  if(route.class==='datacenter'&&providerRule(v2.config,datacenterProvider(v2.config,route.country),host)){skipped.push({...route,reason:'excluded_by_provider_rule'});continue;}
  const state=stateOf(route);
  // A cooling route is skipped, but a rotation rung exists to get a new IP, so it stays.
  if(state==='cooling'&&!route.rotation){skipped.push({...route,reason:'cooling'});continue;}
  routes.push({...route,known:state,order});
 }
 routes.sort((a,b)=>(a.known==='proven'?0:1)-(b.known==='proven'?0:1)||a.order-b.order);
 const coolingUntil=knowledge.filter(r=>r.state==='cooling').map(r=>+new Date(r.retry_not_before));
 // Only rotation rungs left means every real route is cooling.
 const usable=routes.filter(r=>!r.rotation||routes.some(x=>!x.rotation&&x.transport===r.transport&&x.class===r.class));
 return {routes:usable.map(({known,order,...route})=>route),skipped,headers:allowed.headers,retry_after_seconds:coolingUntil.length?Math.max(1,Math.ceil((Math.min(...coolingUntil)-now)/1000)):null};
}
const sameRoute=(a,b)=>a.transport===b.transport&&a.class===b.class&&a.country===b.country&&(a.rotation??0)===(b.rotation??0);
const publicRoute=t=>({transport:t.transport??'http',class:t.class,country:t.country,...(t.rotation?{rotation:t.rotation}:{}),result:t.result,...(t.code?{code:t.code}:{})});

async function recordedRoute(pool,project,key,index,choose){
 const k=regKey(project,key)+':'+index;
 const existing=(await pool.query('SELECT hash FROM v2_registry WHERE kind=$1 AND key=$2',[ROUTE_KIND,k])).rows[0];
 if(existing)return JSON.parse(existing.hash);
 const route=await choose();if(!route)return null;
 await pool.query('INSERT INTO v2_registry(kind,key,hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ROUTE_KIND,k,JSON.stringify(route)]);
 return JSON.parse((await pool.query('SELECT hash FROM v2_registry WHERE kind=$1 AND key=$2',[ROUTE_KIND,k])).rows[0].hash);
}

function attemptResult(response){
 if(response.success)return 'success';
 if(['unknown','reserved','running'].includes(response.state))return 'uncertain';
 const code=response.error?.code;
 if(FINAL_CODES.has(code))return 'answered';
 if(code==='source_rate_limited'||code==='source_cooldown')return 'rate_limited';
 if(['source_challenge','source_forbidden'].includes(code))return 'blocked';
 return 'failed';
}

function nextStep(result,response,{retryAfter=null}={}){
 if(result==='success'||result==='answered')return null;
 if(result==='uncertain')return {action:'recover',detail:'Look up this request with the same idempotency key before sending new work.'};
 const seconds=Number(response?.data?.retry_after)||retryAfter;
 if(result==='rate_limited')return {action:'retry_after',retry_after_seconds:Number.isFinite(seconds)&&seconds>0?Math.min(3600,seconds):60,detail:'The site is limiting request rate. Retry the same URL with a new idempotency key after the wait.'};
 if(result==='blocked')return {action:'retry_later',retry_after_seconds:retryAfter??900,detail:'The site refused every route FetchX was allowed to try within max_attempts, including a rendered browser where the access profile allows one. Retry later with a new idempotency key; a higher max_attempts or a profile that allows more routes gives auto mode more options.'};
 return {action:'retry_later',retry_after_seconds:retryAfter??300,detail:'The site could not be reached on any allowed route. Retry later with a new idempotency key.'};
}

function decorate(response,{key,tried,skipped,maxAttempts,result,retryAfter}){
 const out={...response,idempotency_key:key,idempotency_key_scope:'caller'};
 out.auto={mode:'auto',attempts:tried.filter(t=>t.result!=='not_admitted').length,max_attempts:maxAttempts,
  // Routes only: class and country, never providers or protection details.
  routes_tried:tried.map(publicRoute),
  routes_skipped:skipped.map(s=>({transport:s.transport??'http',class:s.class,country:s.country,reason:s.reason})),
  billed_attempt:result==='success'||result==='answered'?tried.filter(t=>t.result!=='not_admitted').length:null,
  next:nextStep(result,response,{retryAfter})};
 return out;
}

// gw is the PublicFetchGateway; options pass through to each attempt.
export async function autoFetch(gw,project,raw,identity,options={}){
 const v2=gw.v2,managed=v2.controlCredits.managed(project);
 const input=normalizeAuto(raw);
 if(input.access_profile===undefined&&managed)input.access_profile=PUBLIC_URL_REF;
 if(!plain(input.access_profile))fail('version_reference_invalid');
 const host=siteHost(input.url);if(!host)fail('request_invalid');
 const hash=sha(canonical(input)),key=input.idempotency_key;
 await gw.fingerprint(project,key,hash,{bind:true});
 const escalates=['GET','HEAD'].includes(input.method);
 const maxAttempts=escalates?input.max_attempts:1;
 const {max_attempts:_,proxy:__,...base}=input;
 const tried=[];let ladder=null,last=null,result=null,finalSlot=null,finalTransport='http';
 const ensureLadder=async()=>ladder??=await autoLadder(v2,project,input,host);
 const fixed=browserHeaders(input.headers,(await ensureLadder()).headers);base.headers=fixed.headers;
 const {PublicRenderGateway}=await import('./v2-public-render.mjs');
 const render=new PublicRenderGateway(v2);
 let dispatched=0;const waited=new Set();
 // Slots are recorded routes; a slot refused at admission costs nothing and
 // does not count toward max_attempts.
 for(let slot=0;slot<AUTO_MAX_SLOTS&&dispatched<maxAttempts;slot++){
  const route=await recordedRoute(v2.store.pool,project,key,slot,async()=>{
   const l=await ensureLadder();
   return l.routes.find(r=>!tried.some(t=>sameRoute(t,r)))??null;
  });
  if(!route)break;
  const attemptKey=autoAttemptKey(key,slot),proxy={class:route.class,country:route.country};
  const run=()=>route.transport==='browser'
   ?render.render(project,{idempotency_key:attemptKey,access_profile:base.access_profile,url:base.url,proxy,...(base.max_estimated_micro_usd===undefined?{}:{max_estimated_micro_usd:base.max_estimated_micro_usd})},identity)
   :gw.fetch(project,{...base,idempotency_key:attemptKey,proxy},identity,options);
  let response;
  try{response=await run();}
  catch(error){
   if(!(error instanceof GatewayError))throw error;
   if(CALLER_LIMIT_CODES.has(error.code))throw error;
   // A short site cooldown (such as after a challenge page) is waited out once
   // inside the request instead of giving up on the remaining routes.
   const wait=cooldownSeconds(error);
   if(wait!==null&&wait<=AUTO_MAX_INLINE_WAIT_S&&!waited.has(slot)){
    await new Promise(r=>setTimeout(r,wait*1000));waited.add(slot);slot--;
    tried.push({...route,result:'waited',code:error.code});continue;
   }
   // Not admitted on this route (provider unavailable, route unreviewed, no
   // browser for this profile, ...): nothing was dispatched or billed.
   tried.push({...route,result:'not_admitted',code:error.code});continue;
  }
  dispatched++;last=response;result=attemptResult(response);finalSlot=slot;finalTransport=route.transport;tried.push({...route,result});
  // Data, a real 404, or an uncertain outcome ends the ladder. Uncertain source
  // work is never retried. A genuine rate limit (429 with Retry-After, not a
  // challenge page) is honoured: every route reaches the same site limit.
  if(['success','answered','uncertain','rate_limited'].includes(result))break;
 }
 const skipped=ladder?.skipped??[];
 if(last){
  const state={final:finalSlot,final_transport:finalTransport,tried,skipped,max_attempts:maxAttempts,result,retry_after_seconds:ladder?.retry_after_seconds??null,headers_adjusted:fixed.adjusted};
  await v2.store.pool.query('INSERT INTO v2_registry(kind,key,hash) VALUES($1,$2,$3) ON CONFLICT(kind,key) DO UPDATE SET hash=EXCLUDED.hash',[STATE_KIND,regKey(project,key),JSON.stringify(state)]);
 }
 if(!last){
  // Nothing reached the site: every route is cooling, excluded or unavailable.
  const retryAfter=ladder?.retry_after_seconds??null;
  const error=new GatewayError(retryAfter?'source_cooldown':'auto_routes_unavailable',retryAfter?429:409);
  error.details={auto:{mode:'auto',attempts:0,max_attempts:maxAttempts,routes_tried:tried.map(publicRoute),routes_skipped:skipped.map(s=>({transport:s.transport??'http',class:s.class,country:s.country,reason:s.reason})),
   next:retryAfter?{action:'retry_after',retry_after_seconds:retryAfter,detail:'Every allowed route for this site is cooling down after recent failures. Retry after the wait with a new idempotency key.'}
    :{action:'review_access',detail:'No route allowed by this access profile can be used for this site.'}}};
  throw error;
 }
 const out=decorate(last,{key,tried,skipped,maxAttempts,result,retryAfter:ladder?.retry_after_seconds??null});
 out.auto.headers_adjusted=fixed.adjusted;
 return out;
}

// GET /v2/fetch/:key for an auto request: the final attempt, with the summary.
export async function autoLookup(gw,project,key){
 const row=(await gw.v2.store.pool.query('SELECT hash FROM v2_registry WHERE kind=$1 AND key=$2',[STATE_KIND,regKey(project,key)])).rows[0];
 if(!row)return null;
 const state=JSON.parse(row.hash);
 const response=state.final_transport==='browser'
  ?await new (await import('./v2-public-render.mjs')).PublicRenderGateway(gw.v2).lookup(project,autoAttemptKey(key,state.final))
  :await gw.lookup(project,autoAttemptKey(key,state.final));
 const out=decorate(response,{key,tried:state.tried,skipped:state.skipped,maxAttempts:state.max_attempts,result:state.result,retryAfter:state.retry_after_seconds});
 out.auto.headers_adjusted=state.headers_adjusted??[];
 return out;
}
