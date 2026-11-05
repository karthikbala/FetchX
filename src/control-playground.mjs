import {sha} from './crypto.mjs';
import {GatewayError,ID,fail} from './policy.mjs';
import {creditWeight,reviewedCreditPolicy} from './control-credits.mjs';
import {discoveryOrigins} from './v2-discovery.mjs';

export const PLAYGROUND_PREFIX='playground:';
const EXECUTIONS=['http','browser'];
const ROUTES=['direct','datacenter','residential'];
const METHODS={http:['GET','HEAD'],browser:['GET']};
const HTTP_HEADERS=['accept','accept-language','user-agent'];
const LIMITS={max_requests:32,max_encoded_bytes:2097152,max_decoded_bytes:8388608,max_session_encoded_bytes:16777216,max_input_bytes:1,max_tunnel_bytes:4194304,max_redirects:2,max_expansion_ratio:100,timeout_ms:30000,min_interval_ms:250,ttl_seconds:900};
const BROWSER={enabled:true,max_requests:32,max_network_bytes:8388608,max_decoded_bytes:8388608,max_dom_bytes:1048576,settle_ms:750};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const COUNTRY=/^[A-Z]{2}$/;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>plain(v)&&Object.keys(v).every(key=>keys.includes(key));
const ordered=value=>Array.isArray(value)?value.map(ordered):plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
const unavailable=reason=>({available:false,reason,countries:[]});
const available=countries=>({available:true,reason:null,countries});
const reference=({id,version})=>({id,version});
const methods=execution=>METHODS[execution]??[];
const headers=execution=>execution==='http'?HTTP_HEADERS:[];
export const isPlaygroundRef=ref=>typeof ref?.id==='string'&&ref.id.startsWith(PLAYGROUND_PREFIX);

export async function initPlayground(pool){
 await pool.query(`
  CREATE TABLE IF NOT EXISTS control_playground_policies(version text PRIMARY KEY,policy_hash text NOT NULL);
  CREATE TABLE IF NOT EXISTS control_playground_profiles(
   id text PRIMARY KEY,project text NOT NULL REFERENCES control_projects(id),policy_version text NOT NULL REFERENCES control_playground_policies(version),
   origin text NOT NULL,execution text NOT NULL CHECK(execution IN ('http','browser')),created_at timestamptz NOT NULL DEFAULT now(),
   UNIQUE(project,policy_version,origin,execution)
  );
  CREATE INDEX IF NOT EXISTS control_playground_profiles_origin ON control_playground_profiles(project,origin);
 `);
}

export function playgroundPolicy(config){
 const raw=config.controlPlane?.playground;
 if(raw===undefined||exact(raw,['enabled','reviewed','version','maxProfilesPerProject','routes'])&&raw.enabled===false)return null;
 if(!exact(raw,['enabled','reviewed','version','maxProfilesPerProject','routes'])||raw.enabled!==true||raw.reviewed!==true||
    typeof raw.version!=='string'||!ID.test(raw.version)||!Number.isSafeInteger(raw.maxProfilesPerProject)||raw.maxProfilesPerProject<1||raw.maxProfilesPerProject>1000||
    !exact(raw.routes,EXECUTIONS))fail('playground_policy_invalid',503);
 const routes={};
 for(const execution of EXECUTIONS){
  const mode=raw.routes[execution]===undefined?{}:raw.routes[execution];
  if(!exact(mode,ROUTES)||mode.direct!==undefined&&typeof mode.direct!=='boolean')fail('playground_policy_invalid',503);
  routes[execution]={direct:mode.direct===true};
  for(const route of ['datacenter','residential']){
   const countries=mode[route]===undefined?[]:mode[route];
   if(!Array.isArray(countries)||countries.length>250||countries.some(country=>typeof country!=='string'||!COUNTRY.test(country))||new Set(countries).size!==countries.length)fail('playground_policy_invalid',503);
   routes[execution][route]=[...countries].sort();
  }
 }
 const body={version:raw.version,maxProfilesPerProject:raw.maxProfilesPerProject,routes,limits:LIMITS,browser:BROWSER,methods:METHODS,headers:HTTP_HEADERS};
 return {...body,hash:sha(JSON.stringify(body))};
}

export function playgroundDestination(raw){
 if(typeof raw!=='string'||raw.length>12000||/[\s\u0000-\u001f\u007f\\]/u.test(raw))fail('playground_url_invalid');
 let url;
 try{url=new URL(raw);}catch{fail('playground_url_invalid');}
 if(url.username||url.password||url.hash||raw.includes('#')||url.protocol!=='https:'||url.port)fail('playground_destination_rejected');
 try{discoveryOrigins([url.origin]);}catch{fail('playground_destination_rejected');}
 const path=raw.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1];
 if(path===undefined||(path||'/')!==url.pathname)fail('playground_destination_rejected');
 return url;
}

function buildProfile(project,policy,origin,execution){
 const mode=policy.routes[execution];
 const proxy_classes=ROUTES.filter(route=>route==='direct'?mode.direct:mode[route].length);
 return {
  id:PLAYGROUND_PREFIX+sha(JSON.stringify([project,policy.version,origin,execution])),version:1,kind:'playground',
  playground_execution:execution,playground_policy_version:policy.version,
  origins:[origin],paths:['^/'],methods:methods(execution),method_paths:Object.fromEntries(methods(execution).map(method=>[method,['^/']])),
  headers:headers(execution),credential_headers:[],proxy_classes,countries:[...new Set([...mode.datacenter,...mode.residential])].sort(),limits:{...policy.limits},
  ...(execution==='browser'?{browser_probe:{...policy.browser}}:{})
 };
}

async function assertPolicyBinding(db,policy){
 const row=(await db.query('SELECT policy_hash FROM control_playground_policies WHERE version=$1',[policy.version])).rows[0];
 if(row&&row.policy_hash!==policy.hash)fail('playground_policy_version_changed',409);
}

async function assertOriginLimit(db,project,origin,maximum){
 const row=(await db.query(`SELECT EXISTS(SELECT 1 FROM control_playground_profiles WHERE project=$1 AND origin=$2) AS existing,
  (SELECT count(DISTINCT origin)::int FROM control_playground_profiles WHERE project=$1) AS count`,[project,origin])).rows[0];
 if(!row.existing&&row.count>=maximum)fail('playground_profile_limit',429);
}

function managed(v2,project){return v2.controlCredits.managed(project)&&Object.hasOwn(v2.config.projects??{},project);}

export async function readPlaygroundProfile(v2,project,ref){
 const policy=playgroundPolicy(v2.config);
 if(!managed(v2,project)||!policy||ref.version!==1)fail('access_profile_forbidden',403);
 await assertPolicyBinding(v2.store.pool,policy);
 const row=(await v2.store.pool.query('SELECT origin,execution FROM control_playground_profiles WHERE id=$1 AND project=$2 AND policy_version=$3',[ref.id,project,policy.version])).rows[0];
 if(!row)fail('access_profile_forbidden',403);
 if(!EXECUTIONS.includes(row.execution))fail('playground_profile_invalid',503);
 try{discoveryOrigins([row.origin]);}catch{fail('playground_profile_invalid',503);}
 const profile=buildProfile(project,policy,row.origin,row.execution);
 if(profile.id!==ref.id)fail('playground_profile_invalid',503);
 return profile;
}

function validateProxy(proxy){
 if(!exact(proxy,['class','country','affinity'])||!ROUTES.includes(proxy.class)||proxy.affinity!==undefined&&proxy.affinity!=='session')fail('proxy_required');
 if(proxy.class==='direct'){
  if(proxy.country!==null)fail('direct_country_unverified');
 }else if(typeof proxy.country!=='string'||!COUNTRY.test(proxy.country))fail('country_required');
}

const modeAllows=(mode,route,country)=>route==='direct'?mode.direct:mode[route].includes(country);
const tunnelBytes=(profile,route,execution)=>route.class==='direct'?0:execution==='browser'?profile.browser_probe.max_network_bytes:profile.limits.max_tunnel_bytes*(profile.limits.max_redirects+1);

async function quoteRoute(v2,project,profile,policy,execution,proxy,selectedRoute,{originKnown=true}={}){
 if(!modeAllows(policy.routes[execution],proxy.class,proxy.country))fail('playground_route_unreviewed',403);
 if(!creditWeight(reviewedCreditPolicy(v2.config),execution,proxy.class,true))fail('credit_route_forbidden',403);
 const route=selectedRoute??v2.route(profile,{class:proxy.class,country:proxy.country,affinity:'session'});
 if(route.class!==proxy.class||route.country!==proxy.country)fail('playground_route_mismatch',409);
 const bytes=tunnelBytes(profile,route,execution);
 if(route.class==='datacenter'){
  const pool=v2.config.proxies.filter(proxy=>proxy.country===route.country);
  for(const member of pool){
   v2.checkProxy(member);
   if(member.enabled===false)fail('playground_route_unhealthy',503);
  }
  if((await v2.store.pool.query('SELECT 1 FROM route_health WHERE proxy_id=ANY($1::text[]) AND quarantined_until>clock_timestamp() LIMIT 1',[pool.map(member=>member.id)])).rowCount)fail('playground_route_unhealthy',503);
 }else if(route.class==='residential'){
  // The existing reservation helper checks provider holds and all bandwidth
  // caps with read-only queries. Admission repeats these checks under its lock.
  await v2.reserveResidential(v2.store.pool,project,null,route,bytes);
 }
 const decision=v2.pricing(project,profile,route,bytes,execution);
 if(!Number.isSafeInteger(decision.estimated_micro_usd)||decision.estimated_micro_usd<0){
  const grants=v2.config.v2?.datacenterPricingAttestations;
  const now=Date.now();
  const targetScoped=!originKnown&&decision.pricing?.reason==='attestation_scope_mismatch'&&Array.isArray(grants)&&grants.some(grant=>
   grant?.project===project&&grant.country===route.country&&grant.transport===execution&&grant.reviewed===true&&
   Date.parse(grant.valid_from)<=now&&Date.parse(grant.expires_at)>now+profile.limits.timeout_ms&&
   Array.isArray(grant.access_profiles)&&grant.access_profiles.some(isPlaygroundRef));
  if(targetScoped)fail('playground_target_required',409);
  fail('cost_estimate_unavailable',409);
 }
 const maximum=Math.max(decision.estimated_micro_usd,decision.customer_traffic_reservation?.max_estimated_micro_usd??0);
 const quote=v2.controlCredits.quote({profile,route,transport:execution,estimatedMicroUsd:maximum});
 return {credits:quote.credits,max_estimated_micro_usd:maximum};
}

async function assertRuntime(v2,execution){
 if(execution==='browser'){
  const runtime=await v2.browserRuntime(v2.config);
  if(!runtime.available)fail(runtime.reason??'browser_probe_runtime_unavailable',503);
 }
}

export async function admitPlaygroundRoute(v2,project,profile,proxy,execution,selectedRoute){
 if(!isPlaygroundRef(profile))return null;
 const policy=playgroundPolicy(v2.config);
 if(!managed(v2,project)||!policy||profile.playground_policy_version!==policy.version)fail('access_profile_forbidden',403);
 if(profile.playground_execution!==execution)fail('playground_execution_mismatch',403);
 // Workflow admission can pass the already pinned server route. Validate
 // its public selector separately from the private provider/session fields.
 const selector=selectedRoute?{class:proxy.class,country:proxy.country,affinity:proxy.affinity}:proxy;
 validateProxy(selector);
 await assertPolicyBinding(v2.store.pool,policy);
 await assertRuntime(v2,execution);
 return quoteRoute(v2,project,profile,policy,execution,selector,selectedRoute);
}

export async function ensurePlaygroundProfile(v2,project,ref,url,execution,proxy,method='GET'){
 if(!isPlaygroundRef(ref))return;
 const policy=playgroundPolicy(v2.config);
 if(!managed(v2,project)||!policy||!EXECUTIONS.includes(execution))fail('access_profile_forbidden',403);
 if(!methods(execution).includes(method))fail('method_rejected');
 const {origin}=playgroundDestination(url),profile=buildProfile(project,policy,origin,execution);
 if(ref.id!==profile.id||ref.version!==profile.version)fail('access_profile_forbidden',403);
 validateProxy(proxy);
 if(!modeAllows(policy.routes[execution],proxy.class,proxy.country))fail('playground_route_unreviewed',403);
 await assertPolicyBinding(v2.store.pool,policy);
 return profile;
}

export function playgroundOperationProfile(v2,project,sessionPolicy,url,execution){
 const policy=playgroundPolicy(v2.config);
 if(!managed(v2,project)||!policy||!EXECUTIONS.includes(execution)||!isPlaygroundRef(sessionPolicy))fail('access_profile_forbidden',403);
 const {origin}=playgroundDestination(url),profile=buildProfile(project,policy,origin,execution);
 if(JSON.stringify(ordered(profile))!==JSON.stringify(ordered(sessionPolicy)))fail('access_profile_forbidden',403);
 return profile;
}

// Called only inside the serialized v2 operation admission transaction. Failed
// request, key, quota and credit checks therefore cannot claim an origin slot.
export async function materializePlaygroundProfile(v2,c,project,candidate){
 const {origins:[origin],playground_execution:execution}=candidate;
 const profile=playgroundOperationProfile(v2,project,candidate,origin,execution),policy=playgroundPolicy(v2.config);
 await c.query('INSERT INTO control_playground_policies(version,policy_hash) VALUES($1,$2) ON CONFLICT DO NOTHING',[policy.version,policy.hash]);
 await assertPolicyBinding(c,policy);
 if((await c.query('SELECT 1 FROM control_playground_profiles WHERE id=$1 AND project=$2',[profile.id,project])).rowCount)return;
 await assertOriginLimit(c,project,origin,policy.maxProfilesPerProject);
 await c.query('INSERT INTO control_playground_profiles(id,project,policy_version,origin,execution) VALUES($1,$2,$3,$4,$5)',[profile.id,project,policy.version,origin,execution]);
}

const reason=error=>error instanceof GatewayError?error.code:null;
function expectedFailure(error){
 const code=reason(error);
 if(!code)throw error;
 return code;
}

async function inspectMode(v2,project,policy,execution,origin){
 const mode=policy?.routes[execution],profile=mode&&buildProfile(project,policy,origin??'https://example.com',execution);
 const enabled=!!profile?.proxy_classes.length;
 let disabled=policy?enabled?null:'playground_execution_unreviewed':'playground_disabled';
 if(!disabled){
  try{await assertRuntime(v2,execution);}catch(error){disabled=expectedFailure(error);}
 }
 const routes={},quotes=new Map(),issues=new Map();
 for(const route of ROUTES){
  const countries=route==='direct'?(mode?.direct?[null]:[]):mode?.[route]??[];
  if(disabled||!countries.length){routes[route]=unavailable(disabled??'playground_route_unreviewed');continue;}
  let issue;
  const supported=[];
  for(const country of countries){
   try{
   quotes.set(JSON.stringify([route,country]),await quoteRoute(v2,project,profile,policy,execution,{class:route,country},undefined,{originKnown:!!origin}));
    supported.push(country);
   }catch(error){
    const code=expectedFailure(error);
    issues.set(JSON.stringify([route,country]),code);
    if(!issue||code==='playground_target_required')issue=code;
   }
  }
  routes[route]=supported.length?available(supported.filter(country=>country!==null)):unavailable(issue);
 }
 const usable=Object.values(routes).some(route=>route.available);
 const needsTarget=Object.values(routes).some(route=>route.reason==='playground_target_required');
 return {execution:{id:execution,available:usable,reason:usable?null:disabled??(needsTarget?'playground_target_required':'playground_no_route'),methods:methods(execution),headers:headers(execution),...(execution==='browser'?{max_wait_ms:BROWSER.settle_ms}:{})},routes,quotes,issues,profile};
}

async function inspect(v2,project,origin,selectedExecution){
 let policy=playgroundPolicy(v2.config??{});
 if(policy&&!managed(v2,project))policy=null;
 if(policy)await assertPolicyBinding(v2.store.pool,policy);
 const modes={};
 // Origin-independent pricing policies can advertise project capabilities
 // before input. Profile-specific grants are evaluated for the actual URL.
 for(const execution of EXECUTIONS)modes[execution]=await inspectMode(v2,project,policy,execution,origin);
 const capabilities={
  executions:EXECUTIONS.map(execution=>modes[execution].execution),
  routes:ROUTES.map(route=>{
   const executions=Object.fromEntries(EXECUTIONS.map(execution=>[execution,{
    ...modes[execution].routes[route],reviewed_countries:route==='direct'?[]:policy?.routes[execution][route]??[]
   }]));
   const choices=Object.values(executions).filter(value=>value.available);
   const aggregate=choices.length?available([...new Set(choices.flatMap(value=>value.countries))].sort()):unavailable(executions.http.reason);
   return {class:route,...(executions[selectedExecution]??aggregate),executions};
  })
 };
 return {policy,modes,capabilities};
}

export async function playgroundCapabilities(v2,project){
 return (await inspect(v2,project)).capabilities;
}

export function selectPlaygroundKey(keys,requested){
 const eligible=keys.filter(key=>!key.revoked_at&&Array.isArray(key.scopes)&&key.scopes.includes('fetch:write'));
 if(requested!==undefined){
  if(typeof requested!=='string'||!UUID.test(requested))return {keys:eligible,key:null,error:'playground_key_invalid'};
  const key=eligible.find(key=>key.id.toLowerCase()===requested.toLowerCase());
  return {keys:eligible,key:key??null,error:key?null:'api_key_forbidden'};
 }
 if(eligible.length===1)return {keys:eligible,key:eligible[0],error:null};
 return {keys:eligible,key:null,error:eligible.length?'playground_key_selection_required':'playground_key_required'};
}

const messages={
 playground_url_invalid:'Enter a valid HTTPS URL.',
 playground_destination_rejected:'Use a public HTTPS hostname on port 443 without embedded credentials or a fragment.',
 playground_disabled:'Playground requests are unavailable for this project.',
 playground_execution_unreviewed:'This execution mode is unavailable.',
 playground_execution_invalid:'Choose HTTP or Browser.',
 playground_no_route:'No reviewed route can run this mode right now.',
 playground_target_required:'Enter a target URL to check pricing for this route.',
 playground_policy_version_changed:'Playground policy changed and needs a new reviewed version.',
 playground_route_unreviewed:'This route and country are unavailable for this mode.',
 playground_route_unhealthy:'The selected proxy pool is temporarily unavailable.',
 playground_key_invalid:'Select a key from this project.',
 playground_key_required:'Create a project key with permission to send fetch requests.',
 playground_key_selection_required:'Select the project key to attribute this request to.',
 api_key_forbidden:'Select an active key from this project with permission to send fetch requests.',
 method_rejected:'Choose a supported HTTP method for this mode.',
 proxy_required:'Select a proxy route.',
 country_required:'Select an available country for this proxy route.',
 direct_country_unverified:'Use Direct without selecting a country.',
 country_pool_unavailable:'A datacenter proxy is unavailable for this country.',
 residential_provider_unavailable:'A residential provider is unavailable for this country.',
 residential_provider_held:'The residential provider is on hold.',
 residential_budget_exhausted:'The available residential bandwidth is below this request’s reservation.',
 credit_route_forbidden:'This route is unavailable under the project’s credit policy.',
 cost_estimate_unavailable:'The gateway has no reviewed cost estimate for this route and execution mode.',
 cost_ceiling_exceeded:'This route exceeds the project’s spending limit.',
 credit_balance_exhausted:'The project has insufficient available request credits.',
 playground_profile_limit:'The project has reached its playground profile limit.'
};

export function playgroundMessage(code){
 return messages[code]??(/browser_probe/.test(code)?'The browser runtime is currently unavailable.':'The selected request cannot run right now.');
}

export async function preparePlayground(v2,project,raw,keys){
 const errors=[],add=(field,code)=>errors.push({field,code,message:playgroundMessage(code)});
 const execution=EXECUTIONS.includes(raw.execution)?raw.execution:null;
 if(!execution)add('execution','playground_execution_invalid');
 let url=null;
 try{url=playgroundDestination(raw.url);}catch(error){add('url',expectedFailure(error));}
 const method=raw.method===undefined?'GET':raw.method;
 const validMethod=methods(execution).includes(method);
 if(execution&&!validMethod)add('method','method_rejected');
 let proxyValid=false;
 try{
  if(!exact(raw.proxy,['class','country']))fail('proxy_required');
  validateProxy(raw.proxy);proxyValid=true;
 }catch(error){add('proxy',expectedFailure(error));}
 const selection=selectPlaygroundKey(keys,raw.key_id);
 if(selection.error)add('key_id',selection.error);
 const {policy,modes,capabilities}=await inspect(v2,project,url?.origin,execution);
 const mode=modes[execution];
 if(mode&&!mode.execution.available)add('execution',mode.execution.reason);
 let accessProfile=null,quote=null;
 if(url&&mode?.profile&&validMethod){
  accessProfile=reference(mode.profile);
  if(proxyValid){
   const pair=JSON.stringify([raw.proxy.class,raw.proxy.country]);
   quote=mode.quotes.get(pair)??null;
   if(!quote)add('proxy',mode.issues.get(pair)??mode.routes[raw.proxy.class].reason??'playground_route_unreviewed');
  }
  if(quote){
   const usage=await v2.controlCredits.usage(project);
   if(usage.available<quote.credits)add('credits','credit_balance_exhausted');
   try{await assertOriginLimit(v2.store.pool,project,url.origin,policy.maxProfilesPerProject);}
   catch(error){add('url',expectedFailure(error));}
  }
 }
 return {ready:!errors.length&&!!quote,execution,url:url?.href??null,access_profile:accessProfile,selected_key_id:selection.key?.id??null,keys:selection.keys,capabilities,quote,errors};
}
