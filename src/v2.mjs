import {randomUUID,randomBytes} from 'node:crypto';
import {CookieJar} from 'tough-cookie';
import {sha} from './crypto.mjs';
import {ID,GatewayError,fail,checkedHeaders} from './policy.mjs';
import {providerProxy} from './residential.mjs';
import {nativeHttp,pinnedDestination,decodeNative} from './v2-http.mjs';
import {createSourceResolver} from './v2-dns.mjs';
import {safeFailure} from './v2-diagnostics.mjs';
import {DISCOVERY_PREFIX,discoveryPolicy,discoveryOrigins,discoveryProfileBody,assertDiscoveryCeiling} from './v2-discovery.mjs';
import {browserProbePolicy,browserProbeRuntime} from './v2-browser-policy.mjs';
import {browserRelay} from './v2-browser-relay.mjs';
import {runBrowserProbe} from './v2-browser-runner.mjs';
import {browserProbeOperation} from './v2-browser-operation.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>plain(v)&&Object.keys(v).every(k=>keys.includes(k));
const refKey=r=>plain(r)&&typeof r.id==='string'&&ID.test(r.id)&&Number.isSafeInteger(r.version)&&r.version>0?`${r.id}@${r.version}`:fail('version_reference_invalid');
const key=k=>{if(typeof k!=='string'||!ID.test(k))fail('idempotency_key_required');return k;};
const uuid=v=>{if(typeof v!=='string'||!UUID.test(v))fail('identifier_invalid');return v;};
const canonical=v=>JSON.stringify(sort(v));
function sort(v){return Array.isArray(v)?v.map(sort):plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;}
const positive=(v,name,max=Number.MAX_SAFE_INTEGER)=>{if(!Number.isSafeInteger(v)||v<1||v>max)fail(name,503);return v;};
const defaults={max_requests:50,max_encoded_bytes:1048576,max_decoded_bytes:4194304,max_session_encoded_bytes:16777216,max_input_bytes:65536,max_tunnel_bytes:4194304,max_redirects:2,max_expansion_ratio:100,timeout_ms:20000,min_interval_ms:1000,ttl_seconds:900};

export const V2_CAPABILITIES=Object.freeze({api_version:'2',transports:{http:true,browser:false},proxy_classes:{direct:true,datacenter:true,residential:true},features:{native_responses:true,downloads:true,encoded_bodies:true,cookie_jar:true,json_pointers:true,dom_selectors:false,websockets:false,local_storage:false,live_leases:false},retries:{owner:'gateway',max_physical_retries:0},profile_approval:'server_configuration'});

export async function initV2(pool){await pool.query(`
 CREATE TABLE IF NOT EXISTS v2_registry(kind text NOT NULL,key text NOT NULL,hash text NOT NULL,PRIMARY KEY(kind,key));
 CREATE TABLE IF NOT EXISTS v2_discovery_profiles(id text PRIMARY KEY,version int NOT NULL CHECK(version=1),project text NOT NULL,key text NOT NULL,input_hash text NOT NULL,profile jsonb NOT NULL,profile_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(project,key));
 CREATE INDEX IF NOT EXISTS v2_discovery_project_created ON v2_discovery_profiles(project,created_at,id);
 CREATE TABLE IF NOT EXISTS v2_sessions(id uuid PRIMARY KEY,project text NOT NULL,key text NOT NULL,input_hash text NOT NULL,policy jsonb NOT NULL,route bytea NOT NULL,cookie_jar bytea NOT NULL,state text NOT NULL DEFAULT 'open',requests int NOT NULL DEFAULT 0,encoded_bytes bigint NOT NULL DEFAULT 0,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(project,key));
 CREATE TABLE IF NOT EXISTS v2_operations(id uuid PRIMARY KEY,project text NOT NULL,key_id text NOT NULL,key text NOT NULL,session_id uuid NOT NULL REFERENCES v2_sessions(id),input_hash text NOT NULL,input bytea NOT NULL,recipe jsonb,state text NOT NULL DEFAULT 'reserved',error text,result bytea,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,UNIQUE(project,key));
 ALTER TABLE v2_operations ADD COLUMN IF NOT EXISTS summary jsonb;
 ALTER TABLE v2_operations ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'http';
 CREATE INDEX IF NOT EXISTS v2_operation_session_active ON v2_operations(session_id) WHERE state IN ('reserved','running');
 CREATE TABLE IF NOT EXISTS v2_artifacts(id uuid PRIMARY KEY,operation uuid NOT NULL REFERENCES v2_operations(id),project text NOT NULL,body bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS v2_ledger(operation uuid PRIMARY KEY REFERENCES v2_operations(id),project text NOT NULL,session_id uuid NOT NULL REFERENCES v2_sessions(id),provider text NOT NULL,proxy_class text NOT NULL,state text NOT NULL DEFAULT 'reserved',reserved_requests int NOT NULL,accounted_requests int NOT NULL,reserved_encoded_bytes bigint NOT NULL,accounted_encoded_bytes bigint NOT NULL,reserved_tunnel_bytes bigint NOT NULL,accounted_tunnel_bytes bigint NOT NULL,observed_tunnel_bytes bigint,estimated_micro_usd bigint,invoice_micro_usd bigint,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS v2_ledger_events(id bigserial PRIMARY KEY,operation uuid NOT NULL REFERENCES v2_operations(id),event text NOT NULL,detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(operation,event));
 CREATE INDEX IF NOT EXISTS v2_ledger_project_created ON v2_ledger(project,created_at);
 `);}

export async function recoverV2(pool){
 // Even reserved work is not replayed automatically. A dispatched request has
 // no recoverable remote job handle; its original reservation survives restart.
 await pool.query(`UPDATE v2_operations SET state='unknown',error='interrupted_unknown',finished_at=now() WHERE state='running';
  UPDATE v2_operations SET state='failed',error='interrupted_before_dispatch',finished_at=now() WHERE state='reserved';
  UPDATE v2_ledger l SET state='unknown' FROM v2_operations o WHERE l.operation=o.id AND o.state='unknown' AND l.state='reserved';
  UPDATE v2_sessions s SET requests=s.requests-u.requests,encoded_bytes=s.encoded_bytes-u.bytes FROM
   (SELECT l.session_id,sum(l.accounted_requests)::int requests,sum(l.accounted_encoded_bytes) bytes FROM v2_ledger l JOIN v2_operations o ON o.id=l.operation WHERE o.error='interrupted_before_dispatch' AND l.state='reserved' GROUP BY l.session_id) u WHERE s.id=u.session_id;
  UPDATE v2_ledger l SET state='cancelled_before_dispatch',accounted_requests=0,accounted_encoded_bytes=0,accounted_tunnel_bytes=0,estimated_micro_usd=0 FROM v2_operations o WHERE l.operation=o.id AND o.error='interrupted_before_dispatch' AND l.state='reserved';
  INSERT INTO v2_ledger_events(operation,event,detail) SELECT id,'recovery',jsonb_build_object('state',state,'error',error) FROM v2_operations WHERE error IN ('interrupted_unknown','interrupted_before_dispatch') ON CONFLICT DO NOTHING;`);
}

function normalizeProfile(raw){
 if(!plain(raw))fail('access_profile_configuration',503);refKey(raw);
 const p=structuredClone(raw);p.limits={...defaults,...p.limits};
 if(!Array.isArray(p.origins)||!p.origins.length||p.origins.length>20||p.origins.some(o=>{try{const u=new URL(o);return u.protocol!=='https:'||u.origin!==o||u.port&&u.port!=='443';}catch{return true;}}))fail('access_profile_configuration',503);
 if(!Array.isArray(p.methods)||!p.methods.length||p.methods.some(m=>!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(m)))fail('access_profile_configuration',503);
 for(const field of ['headers','proxy_classes','countries'])if(!Array.isArray(p[field]))fail('access_profile_configuration',503);
 if(p.headers.some(h=>typeof h!=='string'||h!==h.toLowerCase())||p.proxy_classes.some(c=>!['direct','datacenter','residential'].includes(c))||p.countries.some(c=>!/^[A-Z]{2}$/.test(c)))fail('access_profile_configuration',503);
 if(p.paths!==undefined&&(!Array.isArray(p.paths)||p.paths.some(x=>typeof x!=='string'||x.length>500)))fail('access_profile_configuration',503);
 try{for(const expression of p.paths??[])new RegExp(expression);}catch{fail('access_profile_configuration',503);}
 if(p.method_paths!==undefined){
  if(!plain(p.method_paths)||Object.entries(p.method_paths).some(([method,paths])=>!p.methods.includes(method)||!Array.isArray(paths)||!paths.length||paths.some(x=>typeof x!=='string'||x.length>500)))fail('access_profile_configuration',503);
  try{for(const paths of Object.values(p.method_paths))for(const expression of paths)new RegExp(expression);}catch{fail('access_profile_configuration',503);}
 }
 for(const [name,max]of [['max_requests',10000],['max_encoded_bytes',8*1024*1024],['max_decoded_bytes',16*1024*1024],['max_input_bytes',1024*1024],['max_tunnel_bytes',64*1024*1024],['max_expansion_ratio',1000],['timeout_ms',45000],['ttl_seconds',1800],['max_session_encoded_bytes',1024*1024*1024]])positive(p.limits[name],'access_profile_configuration',max);
 for(const [name,max]of [['max_redirects',5],['min_interval_ms',60000]])if(!Number.isSafeInteger(p.limits[name])||p.limits[name]<0||p.limits[name]>max)fail('access_profile_configuration',503);
 if(p.browser_probe!==undefined){const probe=browserProbePolicy(p.browser_probe);p.browser_probe=probe??{enabled:false};if(probe&&(!p.methods.includes('GET')||probe.max_requests>p.limits.max_requests||probe.max_network_bytes>p.limits.max_session_encoded_bytes||probe.max_decoded_bytes>p.limits.max_decoded_bytes))fail('browser_probe_configuration',503);}
 return p;
}

function pointer(value,path){
 if(path==='')return value;
 if(typeof path!=='string'||!path.startsWith('/'))fail('recipe_configuration',503);
 for(const segment of path.slice(1).split('/').map(s=>s.replace(/~1/g,'/').replace(/~0/g,'~'))){
  if(!value||typeof value!=='object'||!Object.hasOwn(value,segment))return null;
  value=value[segment];
 }return value;
}

function operationSummary(result){
 if(!result)return {source_http_status:null,physical_requests:null,encoded_bytes:null,decoded_bytes:null,tunnel_bytes:null,diagnostics:null};
 return {source_http_status:result.status??null,physical_requests:result.physical_requests??null,encoded_bytes:result.encoded_bytes??null,decoded_bytes:result.decoded_bytes??null,tunnel_bytes:result.tunnel_bytes??null,diagnostics:result.diagnostics??null};
}

export class V2Gateway{
 constructor(gateway,{http=nativeHttp,dnsHttp=nativeHttp,browserRuntime=browserProbeRuntime,browserRunner=runBrowserProbe,relayFactory=browserRelay}={}){this.gateway=gateway;this.store=gateway.store;this.config=gateway.config;this.sealer=gateway.sealer;this.http=http;this.resolve=createSourceResolver(this.config.v2?.dns,{systemLookup:gateway.resolve,http:dnsHttp});Object.assign(this,{browserRuntime,browserRunner,browserRelay:relayFactory});
  if(Object.entries(this.config.v2?.accessProfiles??{}).some(([k,p])=>k.startsWith(DISCOVERY_PREFIX)||typeof p?.id==='string'&&p.id.startsWith(DISCOVERY_PREFIX)))fail('discovery_namespace_reserved',503);
 }
 async capabilities(project){const policy=discoveryPolicy(this.config,project),runtime=await this.browserRuntime(this.config),approved=!!policy.browser_probe?.enabled||(this.config.projects[project]?.v2_access_profiles??[]).some(k=>this.config.v2?.accessProfiles?.[k]?.browser_probe?.enabled===true),available=runtime.available&&approved;return {...V2_CAPABILITIES,features:{...V2_CAPABILITIES.features,discovery_profiles:policy.enabled,browser_network_probe:available},browser_probe:{available,reason:!runtime.available?runtime.reason:!approved?'browser_probe_profile_unapproved':null,original_encoded_available:false,max_requests:32,max_decoded_bytes:8388608,max_dom_bytes:1048576,proxy_classes:['direct','datacenter','residential'],methods:['GET','HEAD'],live_leases:false},discovery_profile_policy:policy.enabled?{enabled:true,max_profiles:policy.max_profiles,max_origins:policy.max_origins,methods:['GET','HEAD'],proxy_classes:['direct'],max_paid_cost_micro_usd:0,limits:policy.limits,...(policy.browser_probe?{browser_probe:policy.browser_probe}:{})}:{enabled:false}};}
 async browserProbe(project,raw){return browserProbeOperation(this,project,raw);}
 entitlement(project){
  const e=this.config.projects[project]?.v2_entitlement??{mode:'unmetered'};
  if(!['unmetered','metered'].includes(e.mode))fail('entitlement_configuration',503);
  if(e.mode==='metered')positive(e.max_daily_operations,'entitlement_configuration');
  return {mode:e.mode,max_daily_operations:e.mode==='metered'?e.max_daily_operations:null};
 }
 async registered(kind,value){
  const k=refKey(value),hash=sha(canonical(value));
  await this.store.pool.query('INSERT INTO v2_registry(kind,key,hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[kind,k,hash]);
  const row=(await this.store.pool.query('SELECT hash FROM v2_registry WHERE kind=$1 AND key=$2',[kind,k])).rows[0];
  if(row.hash!==hash)fail('version_immutable',409);return value;
 }
 async profile(project,ref){
  const k=refKey(ref);
  if(ref.id.startsWith(DISCOVERY_PREFIX)){
   const policy=discoveryPolicy(this.config,project);if(!policy.enabled)fail('access_profile_forbidden',403);
   const row=(await this.store.pool.query('SELECT * FROM v2_discovery_profiles WHERE project=$1 AND id=$2 AND version=$3',[project,ref.id,ref.version])).rows[0];
   if(!row)fail('access_profile_forbidden',403);
   if(sha(canonical(row.profile))!==row.profile_hash)fail('discovery_profile_invalid',503);
   const p=normalizeProfile(row.profile);if(refKey(p)!==k||sha(canonical(p))!==row.profile_hash||p.kind!=='discovery')fail('discovery_profile_invalid',503);
   assertDiscoveryCeiling(p,policy);return this.registered('access_profile',p);
  }
  if(!this.config.projects[project]?.v2_access_profiles?.includes(k))fail('access_profile_forbidden',403);
  const p=normalizeProfile(this.config.v2?.accessProfiles?.[k]);
  if(refKey(p)!==k)fail('access_profile_configuration',503);
  return this.registered('access_profile',p);
 }
 async profiles(project){
  const profiles=[];for(const k of this.config.projects[project]?.v2_access_profiles??[]){const p=this.config.v2?.accessProfiles?.[k];if(p)profiles.push(await this.profile(project,{id:p.id,version:p.version}));}
  if(discoveryPolicy(this.config,project).enabled)for(const row of (await this.store.pool.query('SELECT id,version FROM v2_discovery_profiles WHERE project=$1 ORDER BY created_at,id',[project])).rows){try{profiles.push(await this.profile(project,{id:row.id,version:row.version}));}catch(error){if(error.code!=='discovery_policy_changed')throw error;}}
  return {access_profiles:profiles.map(p=>this.publicProfile(p))};
 }
 publicProfile(p){
   const {id,version,origins,paths,method_paths,methods,headers,proxy_classes,countries,limits}=p;
   const bytes=limits.max_tunnel_bytes*(limits.max_redirects+1),route_reservations=[];
   for(const cls of proxy_classes){
    if(cls==='direct')route_reservations.push({class:cls,country:null,provider:'direct',reserved_tunnel_bytes:0,estimated_micro_usd:0});
    else for(const country of countries){
     const provider=cls==='residential'?['evomi','dataimpulse'].find(name=>{const v=this.config.residential?.providers?.[name];return v?.enabled&&v.username&&v.password&&(!v.countries||v.countries.includes(country));}):'configured_datacenter';
     const rate=this.config.residential?.providers?.[provider]?.microUsdPerGB;
     route_reservations.push({class:cls,country,provider:provider??null,reserved_tunnel_bytes:bytes,estimated_micro_usd:cls==='residential'&&Number.isSafeInteger(rate)?Math.ceil(bytes/1e9*rate):null});
    }
   }
   const browser_probe=p.browser_probe?{...p.browser_probe,...(p.browser_probe.enabled?{route_reservations:route_reservations.map(r=>{const n=r.class==='direct'?0:p.browser_probe.max_network_bytes,rate=this.config.residential?.providers?.[r.provider]?.microUsdPerGB;return {...r,reserved_tunnel_bytes:n,estimated_micro_usd:r.class==='direct'?0:r.class==='residential'&&Number.isSafeInteger(rate)?Math.ceil(n/1e9*rate):null};})}:{})}:undefined;
   return {id,version,origins,paths:paths??null,method_paths:method_paths??null,methods,headers,proxy_classes,countries,limits,route_reservations,...(browser_probe?{browser_probe}:{}),...(p.kind==='discovery'?{kind:'discovery',max_paid_cost_micro_usd:0}:{})};
 }
 async discoveryProfile(project,raw){
  const policy=discoveryPolicy(this.config,project);if(!policy.enabled)fail('discovery_profiles_disabled',403);
  if(!exact(raw,['idempotency_key','origins']))fail('discovery_profile_invalid');key(raw.idempotency_key);
  const origins=discoveryOrigins(raw.origins),inputHash=sha(canonical(raw));
  return this.store.tx(async c=>{
   // All count/check/insert work shares a project lock. Retries replay their
   // original immutable body even after an operator changes future ceilings.
   await c.query('SELECT pg_advisory_xact_lock(2003,hashtext($1))',[project]);
   const old=(await c.query('SELECT * FROM v2_discovery_profiles WHERE project=$1 AND key=$2',[project,raw.idempotency_key])).rows[0];
   if(old){if(old.input_hash!==inputHash)fail('idempotency_conflict',409);if(sha(canonical(old.profile))!==old.profile_hash)fail('discovery_profile_invalid',503);return {access_profile:{id:old.id,version:old.version},profile:this.publicProfile(old.profile),created_at:old.created_at};}
   if(raw.origins.length>policy.max_origins)fail('discovery_origins_limit',400);
   const count=Number((await c.query('SELECT count(*) AS n FROM v2_discovery_profiles WHERE project=$1',[project])).rows[0].n);if(count>=policy.max_profiles)fail('discovery_profiles_limit',429);
   const id=DISCOVERY_PREFIX+randomUUID(),profile=normalizeProfile(discoveryProfileBody(id,origins,policy));
   const row=(await c.query('INSERT INTO v2_discovery_profiles(id,version,project,key,input_hash,profile,profile_hash) VALUES($1,1,$2,$3,$4,$5,$6) RETURNING created_at',[id,project,raw.idempotency_key,inputHash,profile,sha(canonical(profile))])).rows[0];
   return {access_profile:{id,version:1},profile:this.publicProfile(profile),created_at:row.created_at};
  });
 }
 async recipe(project,ref,profile){
  if(ref===undefined)return null;
  const r=this.config.v2?.recipes?.[refKey(ref)];if(!plain(r)||refKey(r)!==refKey(ref))fail('recipe_not_found',404);
  if(r.kind!=='http'||r.selectors||r.script)fail('capability_unsupported',409);
  const p=await this.profile(project,r.access_profile);
  if(profile&&refKey(profile)!==refKey(p))fail('recipe_profile_mismatch');
  if(r.request&&(!exact(r.request,['method','path_pattern'])||r.request.method&&!p.methods.includes(r.request.method)))fail('recipe_configuration',503);
  if(r.request?.path_pattern){try{new RegExp(r.request.path_pattern);}catch{fail('recipe_configuration',503);}}
  if(r.json_pointers!==undefined&&(!plain(r.json_pointers)||Object.keys(r.json_pointers).length>100||Object.values(r.json_pointers).some(x=>typeof x!=='string'||x.length>500||x!==''&&!x.startsWith('/'))))fail('recipe_configuration',503);
  return this.registered('recipe',r);
 }
 async recipes(project){const recipes=[];for(const r of Object.values(this.config.v2?.recipes??{}))if(this.config.projects[project]?.v2_access_profiles?.includes(refKey(r.access_profile)))recipes.push(await this.recipe(project,{id:r.id,version:r.version}));return {recipes};}
 route(p,proxy){
  if(!exact(proxy,['class','country','affinity'])||!['direct','datacenter','residential'].includes(proxy.class)||proxy.affinity!=='session')fail('capability_unsupported',409);
  if(!p.proxy_classes.includes(proxy.class))fail('proxy_class_forbidden',403);
  if(proxy.class==='direct'){if(proxy.country!==null)fail('direct_country_unverified');return {...proxy,provider:'direct',proxy_id:null};}
  if(typeof proxy.country!=='string'||!p.countries.includes(proxy.country))fail('country_forbidden',403);
  if(proxy.class==='datacenter'){
   const pool=(this.config.proxies??[]).filter(x=>x.country===proxy.country);
   if(!pool.length)fail('country_pool_unavailable',503);
   const selected=pool[Math.floor(Math.random()*pool.length)];this.checkProxy(selected);
   return {...proxy,provider:'configured_datacenter',proxy_id:selected.id};
  }
  const provider=['evomi','dataimpulse'].find(name=>{const v=this.config.residential?.providers?.[name];return v?.enabled&&v.username&&v.password&&(!v.countries||v.countries.includes(proxy.country));});
  if(!provider)fail('residential_provider_unavailable',503);
  const residentialSession=randomBytes(5).toString('hex');
  providerProxy(this.config,{country:proxy.country,residentialSession},provider);
  return {...proxy,provider,proxy_id:null,residential_session:residentialSession};
 }
 checkProxy(proxy){let u;try{u=new URL(proxy.url);}catch{fail('proxy_configuration_invalid',503);}if(!proxy.id||u.protocol!=='http:'||u.pathname!=='/'||u.search||u.hash)fail('proxy_configuration_invalid',503);}
 resolveProxy(route){
  if(route.class==='direct')return null;
  if(route.class==='residential')return providerProxy(this.config,{country:route.country,residentialSession:route.residential_session},route.provider);
  const proxy=this.config.proxies?.find(p=>p.id===route.proxy_id&&p.country===route.country);if(!proxy)fail('proxy_configuration_unavailable',503);this.checkProxy(proxy);return proxy;
 }
 sessionView(row){const r=this.sealer.open(row.route);return {id:row.id,access_profile:{id:row.policy.id,version:row.policy.version},transport:'http',proxy:{class:r.class,country:r.country,affinity:r.affinity,provider:r.provider},state:new Date(row.expires_at)<=new Date()?'expired':row.state,expires_at:row.expires_at,requests:row.requests,encoded_bytes:Number(row.encoded_bytes),state_support:{cookie_jar:true,local_storage:false,live_connection:false}};}
 async session(project,raw){
  if(!exact(raw,['idempotency_key','access_profile','transport','proxy']))fail('session_invalid');key(raw.idempotency_key);
  if(raw.transport!=='http')fail('capability_unsupported',409);
  const p=await this.profile(project,raw.access_profile),hash=sha(canonical(raw));
  return this.store.tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(2002)');
   const old=(await c.query('SELECT * FROM v2_sessions WHERE project=$1 AND key=$2',[project,raw.idempotency_key])).rows[0];
   if(old){if(old.input_hash!==hash)fail('idempotency_conflict',409);return this.sessionView(old);}
   const route=this.route(p,raw.proxy),id=randomUUID();
   const row=(await c.query('INSERT INTO v2_sessions(id,project,key,input_hash,policy,route,cookie_jar,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8*interval \'1 second\') RETURNING *',[id,project,raw.idempotency_key,hash,p,this.sealer.seal(route),this.sealer.seal(new CookieJar().serializeSync()),p.limits.ttl_seconds])).rows[0];
   return this.sessionView(row);
  });
 }
 async owned(project,id,c=this.store.pool){const row=(await c.query('SELECT * FROM v2_sessions WHERE id=$1 AND project=$2',[uuid(id),project])).rows[0];if(!row)fail('session_not_found',404);return row;}
 async readSession(project,id){return this.sessionView(await this.owned(project,id));}
 request(raw,p){
  if(!exact(raw,['url','method','headers','body_base64'])||typeof raw.url!=='string'||raw.url.length>12000)fail('request_invalid');
  const method=raw.method??'GET';if(!p.methods.includes(method))fail('method_rejected');
  const b64=raw.body_base64??null;
  if(b64!==null&&(typeof b64!=='string'||b64.length>4*Math.ceil(p.limits.max_input_bytes/3)||Buffer.from(b64,'base64').toString('base64')!==b64))fail('body_rejected');
  const body=b64===null?null:Buffer.from(b64,'base64');if(body&&(body.length>p.limits.max_input_bytes||['GET','HEAD'].includes(method)))fail('body_rejected');
  if(raw.headers!==undefined&&!plain(raw.headers))fail('headers_rejected');
  return {url:raw.url,method,headers:raw.headers??{},body};
 }
 headers(input,p,url){
  if(!p.methods.includes(input.method)||p.method_paths&&!(p.method_paths[input.method]??[]).some(pattern=>new RegExp(pattern).test(url.pathname)))fail('endpoint_method_rejected');
  for(const name of Object.keys(input.headers))if(/^(?:cookie|set-cookie|x-forwarded-|forwarded$)/i.test(name))fail('headers_rejected');
  const credentials=p.credential_headers??[];
  const rules=credentials.includes('authorization')?[{host:url.hostname,method:input.method,path:'.*',query:'.*'}]:[];
  const headers=checkedHeaders(input.headers,{headers:p.headers,guestAuth:rules},url,input.method);
  for(const [name,value]of Object.entries(headers)){
   if(/^(?:authorization|x-api-key|api-key|x-auth-)/i.test(name)&&!credentials.includes(name))fail('credential_scope_rejected');
   for(const config of Object.values(this.config.projects))if(sha(value.trim().replace(/^Bearer\s+/i,''))===config.tokenHash)fail('credential_scope_rejected');
  }
  return {...headers,'accept-encoding':headers['accept-encoding']??'gzip, br, deflate'};
 }
 async reserveResidential(c,project,session,route,bytes){
  if(route.class!=='residential')return null;
  const settings=this.config.residential,pc=settings?.providers?.[route.provider];this.resolveProxy(route);
  const row=(await c.query(`SELECT COALESCE(sum(accounted_bytes),0) total,
   COALESCE(sum(accounted_bytes) FILTER(WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) daily,
   COALESCE(sum(accounted_bytes) FILTER(WHERE project=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) project_daily,
   COALESCE(sum(accounted_bytes) FILTER(WHERE provider=$2),0) provider_total FROM (
    SELECT project,provider,accounted_bytes,created_at FROM residential_usage UNION ALL
    SELECT project,provider,accounted_tunnel_bytes AS accounted_bytes,created_at FROM v2_ledger WHERE proxy_class='residential') u`,[project,route.provider])).rows[0];
  const prior=Object.values(settings.providers).reduce((sum,p)=>sum+(p.priorReservedBytes??0),0);
  for(const [used,cap]of [[Number(row.total)+prior,settings.maxTotalBytes],[Number(row.daily),settings.maxDailyBytes],[Number(row.project_daily),this.config.projects[project].maxDailyResidentialBytes??settings.maxDailyBytes],[Number(row.provider_total)+(pc.priorReservedBytes??0),pc.maxTotalBytes]])if(used+bytes>positive(cap,'residential_budget_unconfigured'))fail('residential_budget_exhausted',429);
  if((await c.query("SELECT 1 FROM attempts WHERE provider=$1 AND error=ANY($2::text[]) UNION ALL SELECT 1 FROM v2_operations o JOIN v2_ledger l ON l.operation=o.id WHERE l.provider=$1 AND o.error=ANY($2::text[]) LIMIT 1",[route.provider,['provider_account_rejected','sensitive_provider_response','cost_overrun']])).rowCount)fail('residential_provider_held',409);
  if(!Number.isSafeInteger(pc.microUsdPerGB)||pc.microUsdPerGB<0)fail('residential_rate_unconfigured',503);
  return Math.ceil(bytes/1e9*pc.microUsdPerGB);
 }
 async operation(project,raw){
  if(!exact(raw,['idempotency_key','session_id','request','recipe','max_estimated_micro_usd']))fail('operation_invalid');key(raw.idempotency_key);uuid(raw.session_id);
  if(raw.max_estimated_micro_usd!==undefined&&(!Number.isSafeInteger(raw.max_estimated_micro_usd)||raw.max_estimated_micro_usd<0))fail('cost_ceiling_invalid');
  const hash=sha(canonical(raw));
  const prior=(await this.store.pool.query('SELECT * FROM v2_operations WHERE project=$1 AND key=$2',[project,raw.idempotency_key])).rows[0];
  if(prior){if(prior.input_hash!==hash)fail('idempotency_conflict',409);return this.operationView(prior);}
  const session=await this.owned(project,raw.session_id),p=await this.profile(project,{id:session.policy.id,version:session.policy.version});
  const input=this.request(raw.request,p),recipe=await this.recipe(project,raw.recipe,p),route=this.sealer.open(session.route);
  const id=randomUUID(),hops=p.limits.max_redirects+1,reservedBytes=p.limits.max_encoded_bytes*hops,reservedTunnel=route.class==='direct'?0:p.limits.max_tunnel_bytes*hops;
  let reused;
  await this.store.tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(1002)');
   const old=(await c.query('SELECT * FROM v2_operations WHERE project=$1 AND key=$2',[project,raw.idempotency_key])).rows[0];if(old){if(old.input_hash!==hash)fail('idempotency_conflict',409);reused=old;return;}
   const locked=(await c.query('SELECT * FROM v2_sessions WHERE id=$1 AND project=$2 FOR UPDATE',[session.id,project])).rows[0];
   if(locked.state!=='open'||new Date(locked.expires_at)<=new Date())fail('session_expired',409);
   if((await c.query("SELECT 1 FROM v2_operations WHERE session_id=$1 AND state IN ('reserved','running','unknown')",[session.id])).rowCount)fail('session_busy_or_unknown',409);
   if(locked.requests+hops>p.limits.max_requests||Number(locked.encoded_bytes)+reservedBytes>p.limits.max_session_encoded_bytes)fail('session_limit',429);
   const usage=(await c.query("SELECT count(*)::int AS n FROM v2_operations WHERE project=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",[project])).rows[0];
   const entitlement=this.entitlement(project);if(entitlement.mode==='metered'&&usage.n>=entitlement.max_daily_operations)fail('client_quota_exhausted',429);
   const active=(await c.query("SELECT count(*)::int n FROM v2_operations WHERE state IN ('reserved','running')")).rows[0].n+Number((await c.query("SELECT count(*) AS n FROM attempts WHERE state IN ('reserved','sent')")).rows[0].n);
   if(active>=(this.config.maxConcurrentRequests??4))fail('capacity_wait',503);
   const stored=Number((await c.query('SELECT COALESCE(sum(octet_length(body)),0) AS n FROM v2_artifacts')).rows[0].n);
   if(stored+(reservedBytes+p.limits.max_decoded_bytes*hops)*1.4+65536>(this.config.v2?.maxArtifactBytes??256*1024*1024))fail('artifact_quota',507);
   const estimated=route.class==='direct'?0:await this.reserveResidential(c,project,session,route,reservedTunnel);
   if(raw.max_estimated_micro_usd!==undefined){if(estimated===null)fail('cost_estimate_unavailable',409);if(estimated>raw.max_estimated_micro_usd)fail('cost_ceiling_exceeded',429);}
   await c.query('INSERT INTO v2_operations(id,project,key_id,key,session_id,input_hash,input,recipe) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,project,this.config.projects[project].keyId??project,raw.idempotency_key,session.id,hash,this.sealer.seal(raw),recipe]);
   await c.query('INSERT INTO v2_ledger(operation,project,session_id,provider,proxy_class,reserved_requests,accounted_requests,reserved_encoded_bytes,accounted_encoded_bytes,reserved_tunnel_bytes,accounted_tunnel_bytes,estimated_micro_usd) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$7,$8,$8,$9)',[id,project,session.id,route.provider,route.class,hops,reservedBytes,reservedTunnel,estimated]);
   await c.query("INSERT INTO v2_ledger_events(operation,event,detail) VALUES($1,'reserve',$2)",[id,{requests:hops,encoded_bytes:reservedBytes,tunnel_bytes:reservedTunnel}]);
   await c.query('UPDATE v2_sessions SET requests=requests+$2,encoded_bytes=encoded_bytes+$3 WHERE id=$1',[session.id,hops,reservedBytes]);
  });
  if(reused)return this.operationView(reused);
  await this.execute(project,id,session,p,route,input,recipe);
  return this.readOperation(project,id);
 }
 async pace(url,limits,deadline){
  const delay=await this.store.tx(async c=>{
   const source='origin:'+url.hostname;await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[source]);
   await c.query('INSERT INTO source_limits(source) VALUES($1) ON CONFLICT DO NOTHING',[source]);
   const row=(await c.query('SELECT * FROM source_limits WHERE source=$1 FOR UPDATE',[source])).rows[0];
   if(new Date(row.cooldown_until)>new Date())fail('source_cooldown',429);
   const at=Math.max(Date.now(),new Date(row.next_at).getTime());if(at>=deadline)fail('source_pacing_deadline',429);
   await c.query('UPDATE source_limits SET next_at=$2 WHERE source=$1',[source,new Date(at+limits.min_interval_ms)]);return Math.max(0,at-Date.now());
  });
  if(delay)await new Promise(r=>setTimeout(r,delay));
 }
 async dispatchable(project,id,session,url){
  await this.store.tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(1002)');
   const row=(await c.query('SELECT s.state,s.expires_at,o.state AS operation_state FROM v2_sessions s JOIN v2_operations o ON o.session_id=s.id WHERE s.id=$1 AND s.project=$2 AND o.id=$3',[session,project,id])).rows[0];
   if(!row||!['reserved','running'].includes(row.operation_state))fail('operation_not_dispatchable',409);
   if(row.state!=='open'||new Date(row.expires_at)<=new Date())fail('session_expired',409);
   if((await c.query('SELECT 1 FROM source_limits WHERE source=$1 AND cooldown_until>now()',['origin:'+url.hostname])).rowCount)fail('source_cooldown',429);
   await c.query("UPDATE v2_operations SET state='running' WHERE id=$1",[id]);
  });
 }
 async destination(raw,p,deadline){
  let timer;
  try{return await Promise.race([pinnedDestination(raw,p,this.resolve),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new GatewayError('dns_deadline',504)),Math.max(1,deadline-Date.now()));})]);}
  finally{clearTimeout(timer);}
 }
 async cooldown(url,response){
  if(response.status!==429&&!response.headers['retry-after'])return;
  const raw=response.headers['retry-after'],s=/^\d+$/.test(raw??'')?Number(raw):Math.ceil((Date.parse(raw)-Date.now())/1000);
  const until=new Date(Date.now()+Math.min(3600,Math.max(1,Number.isFinite(s)?s:60))*1000);
  await this.store.pool.query('INSERT INTO source_limits(source,next_at,cooldown_until) VALUES($1,$2,$2) ON CONFLICT(source) DO UPDATE SET next_at=GREATEST(source_limits.next_at,EXCLUDED.next_at),cooldown_until=GREATEST(source_limits.cooldown_until,EXCLUDED.cooldown_until)',['origin:'+url.hostname,until]);
 }
 async execute(project,id,session,p,route,input,recipe){
  const jar=CookieJar.deserializeSync(this.sealer.open(session.cookie_jar));
  const deadline=Date.now()+p.limits.timeout_ms,artifacts=[],dns=[];let requests=0,encoded=0,decoded=0,tunnel=route.class==='direct'?null:0,error=null,unknown=false,last=null,stage='route',failure=null;
  try{
   const proxy=this.resolveProxy(route);
   let current=input;
   for(let hop=0;;hop++){
    stage='dns';
    const destination=await this.destination(current.url,p,deadline);
    if(destination.dns_diagnostics)dns.push(destination.dns_diagnostics);
    stage='request_policy';
    if(recipe?.request&&(recipe.request.method&&recipe.request.method!==current.method||recipe.request.path_pattern&&!new RegExp(recipe.request.path_pattern).test(destination.url.pathname)))fail('recipe_request_mismatch');
    const headers=this.headers(current,p,destination.url),cookies=await jar.getCookieString(destination.url.href);if(cookies)headers.cookie=cookies;
    stage='pacing';
    await this.pace(destination.url,p.limits,deadline);
    const timeout=deadline-Date.now();if(timeout<=0)fail('source_deadline',504);
    stage='dispatch_admission';
    await this.dispatchable(project,id,session.id,destination.url);
    requests++;
    stage='transport';
    let response;
    try{response=await this.http({...current,headers},destination,{...p.limits,timeout_ms:timeout},{proxy});}
    catch(e){encoded+=e.observed_encoded_bytes??0;if(tunnel!==null)tunnel=Number.isSafeInteger(e.observed_tunnel_bytes)?tunnel+e.observed_tunnel_bytes:null;throw e;}
    encoded+=response.encoded.length;if(tunnel!==null)tunnel=Number.isSafeInteger(response.tunnel_bytes)?tunnel+response.tunnel_bytes:null;
    stage='response_accounting';
    for(const value of response.headers['set-cookie']??[])await jar.setCookie(value,destination.url.href,{ignoreError:true});
    await this.cooldown(destination.url,response);
    let body=null,decodingError=null;
    stage='content_decoding';
    try{body=current.method==='HEAD'||[204,205,304].includes(response.status)?Buffer.alloc(0):decodeNative(response.encoded,response.headers['content-encoding'],p.limits);decoded+=body.length;}catch(e){decodingError=e instanceof GatewayError?e.code:'content_decoding_failed';}
    const artifact={id:randomUUID(),operation_id:id,kind:/attachment/i.test(response.headers['content-disposition']??'')?'download':'native_response',url:current.url,method:current.method,status:response.status,headers:response.headers,raw_headers:response.raw_headers??null,captured_at:new Date().toISOString(),content_encoding:response.headers['content-encoding']??'identity',encoded_body_base64:response.encoded.toString('base64'),decoded_body_base64:body?.toString('base64')??null,encoded_bytes:response.encoded.length,decoded_bytes:body?.length??null,encoded_sha256:sha(response.encoded),decoded_sha256:body?sha(body):null,tunnel_bytes:response.tunnel_bytes??null,provider_status:response.provider_status??null,decoding_error:decodingError};
    this.rejectSecrets(artifact);
    stage='artifact_storage';
    await this.store.pool.query('INSERT INTO v2_artifacts(id,operation,project,body) VALUES($1,$2,$3,$4)',[artifact.id,id,project,this.sealer.seal(artifact,{compress:true})]);
    artifacts.push({id:artifact.id,kind:artifact.kind,status:artifact.status,encoded_bytes:artifact.encoded_bytes,decoded_bytes:artifact.decoded_bytes,content_encoding:artifact.content_encoding});
    last={response,body,url:current.url};
    stage='session_state';
    await this.store.pool.query('UPDATE v2_sessions SET cookie_jar=$2 WHERE id=$1',[session.id,this.sealer.seal(jar.serializeSync())]);
    if(decodingError)fail(decodingError,502);
    if([301,302,303,307,308].includes(response.status)&&response.headers.location){
     stage='redirect_policy';
     if(hop>=p.limits.max_redirects)fail('redirect_limit',502);
     const target=new URL(response.headers.location,destination.url).href;
     stage='dns';const checked=await this.destination(target,p,deadline);stage='redirect_policy';
     if(checked.url.origin!==destination.url.origin&&!(p.id.startsWith(DISCOVERY_PREFIX)&&p.kind==='discovery'))fail('redirect_origin_rejected');
     const toGet=response.status===303&&current.method!=='HEAD'||[301,302].includes(response.status)&&current.method==='POST';
     current={...current,url:target,...(toGet?{method:'GET',body:null,headers:Object.fromEntries(Object.entries(current.headers).filter(([k])=>!['content-type','content-length'].includes(k.toLowerCase())))}:{})};
     continue;
    }
    break;
   }
  }catch(e){error=e instanceof GatewayError?e.code:'operation_internal_error';failure=safeFailure(e,stage,{dispatched:requests>0});unknown=requests>0&&/unknown|incomplete|internal_error/.test(error);}
  let extracted={};
  if(!error&&recipe?.json_pointers){try{const value=JSON.parse(last.body.toString('utf8'));extracted=Object.fromEntries(Object.entries(recipe.json_pointers).map(([name,path])=>[name,pointer(value,path)]));}catch{error='recipe_json_invalid';}}
  const result={status:last?.response.status??null,final_url:last?.url??null,artifacts,extracted,physical_requests:requests,encoded_bytes:encoded,decoded_bytes:decoded,tunnel_bytes:tunnel,provider_status:last?.response.provider_status??null,retry_after:last?.response.headers['retry-after']??null,diagnostics:{stage:failure?.stage??'completed',failure,dns}};
  await this.store.tx(async c=>{
   const ledger=(await c.query('SELECT * FROM v2_ledger WHERE operation=$1 FOR UPDATE',[id])).rows[0];
   const held=unknown;const requestsAccounted=held?ledger.reserved_requests:requests,encodedAccounted=held?Number(ledger.reserved_encoded_bytes):encoded;
   // Paid tunnel reservations are never released from a local byte observation.
   const accountedTunnel=requests?Math.max(Number(ledger.reserved_tunnel_bytes),tunnel??0):0;
   if(tunnel!==null&&tunnel>Number(ledger.reserved_tunnel_bytes))error='cost_overrun';
   const state=unknown?'unknown':error?'failed':'completed';
   await c.query('UPDATE v2_operations SET state=$2,error=$3,result=$4,summary=$5,finished_at=clock_timestamp() WHERE id=$1',[id,state,error,this.sealer.seal(result,{compress:true}),operationSummary(result)]);
   await c.query('UPDATE v2_ledger SET state=$2,accounted_requests=$3,accounted_encoded_bytes=$4,observed_tunnel_bytes=$5,accounted_tunnel_bytes=$6,estimated_micro_usd=CASE WHEN $3=0 THEN 0 ELSE estimated_micro_usd END WHERE operation=$1',[id,unknown?'unknown':requests?'unreconciled':'cancelled_before_dispatch',requestsAccounted,encodedAccounted,tunnel,accountedTunnel]);
   await c.query("INSERT INTO v2_ledger_events(operation,event,detail) VALUES($1,'finish',$2)",[id,{state,error,physical_requests:requests,encoded_bytes:encoded,observed_tunnel_bytes:tunnel}]);
   await c.query('UPDATE v2_sessions SET requests=requests-$2+$3,encoded_bytes=encoded_bytes-$4+$5 WHERE id=$1',[session.id,ledger.reserved_requests,requestsAccounted,ledger.reserved_encoded_bytes,encodedAccounted]);
  });
 }
 rejectSecrets(artifact){
  const secrets=[this.config.scrapeDoToken,this.config.captcha?.apiKey,...Object.values(this.config.residential?.providers??{}).flatMap(p=>[p.username,p.password]),...(this.config.proxies??[]).flatMap(p=>{try{const u=new URL(p.url);return [decodeURIComponent(u.password)];}catch{return [];}})].filter(v=>typeof v==='string'&&v.length>3);
  const encoded=artifact.decoded_body_base64??artifact.encoded_body_base64,body=typeof encoded==='string'?Buffer.from(encoded,'base64'):Buffer.alloc(0),metadata=JSON.stringify([artifact.headers,artifact.raw_headers,artifact.request]);
  if(secrets.some(secret=>body.includes(Buffer.from(secret))||metadata.includes(secret)))fail('sensitive_provider_response',502);
 }
 async operationView(row){
  const session=await this.owned(row.project,row.session_id),ledger=(await this.store.pool.query('SELECT * FROM v2_ledger WHERE operation=$1',[row.id])).rows[0];
  let result=row.result?this.sealer.open(row.result):null;
  if(!result&&row.state==='unknown'){
   const retained=(await this.store.pool.query('SELECT body FROM v2_artifacts WHERE operation=$1 AND project=$2 ORDER BY created_at,id',[row.id,row.project])).rows.map(r=>this.sealer.open(r.body));
   if(retained.length){const last=retained.at(-1);result={status:last.status,final_url:last.url,artifacts:retained.map(a=>({id:a.id,kind:a.kind,status:a.status,encoded_bytes:a.encoded_bytes,decoded_bytes:a.decoded_bytes,content_encoding:a.content_encoding})),extracted:{},physical_requests:null,encoded_bytes:retained.reduce((n,a)=>n+a.encoded_bytes,0),decoded_bytes:retained.reduce((n,a)=>n+(a.decoded_bytes??0),0),tunnel_bytes:ledger.observed_tunnel_bytes===null?null:Number(ledger.observed_tunnel_bytes),provider_status:last.provider_status,retry_after:null,partial:true,additional_dispatches_unknown:true};}
   if(row.kind==='browser_probe')result={kind:'browser_network_probe',status:null,final_url:null,artifacts:result?.artifacts??[],physical_requests:null,blocked_requests:null,blocked_reasons:{},capture_complete:false,encoded_bytes:null,decoded_bytes:retained.filter(a=>a.kind==='browser_response').reduce((n,a)=>n+(a.decoded_bytes??0),0),dom_bytes:retained.filter(a=>a.kind==='rendered_dom').reduce((n,a)=>n+(a.decoded_bytes??0),0),tunnel_bytes:ledger.observed_tunnel_bytes===null?null:Number(ledger.observed_tunnel_bytes),provider_status:null,retry_after:null,partial:true,additional_dispatches_unknown:true};
  }
  return {id:row.id,idempotency_key:row.key,session_id:row.session_id,state:row.state,error:row.error??null,access_profile:{id:session.policy.id,version:session.policy.version},recipe:row.recipe?{id:row.recipe.id,version:row.recipe.version}:null,created_at:row.created_at,finished_at:row.finished_at??null,result,accounting:{provider:ledger.provider,reserved_tunnel_bytes:Number(ledger.reserved_tunnel_bytes),observed_tunnel_bytes:ledger.observed_tunnel_bytes===null?null:Number(ledger.observed_tunnel_bytes),estimated_micro_usd:ledger.estimated_micro_usd===null?null:Number(ledger.estimated_micro_usd),invoice_micro_usd:ledger.invoice_micro_usd===null?null:Number(ledger.invoice_micro_usd),basis:ledger.proxy_class==='direct'?'direct_no_provider_invoice':'conservative_bandwidth_reservation_not_invoice'}};
 }
 async readOperation(project,id){const row=(await this.store.pool.query('SELECT * FROM v2_operations WHERE id=$1 AND project=$2',[uuid(id),project])).rows[0];if(!row)fail('operation_not_found',404);return this.operationView(row);}
 async lookup(project,k){const row=(await this.store.pool.query('SELECT * FROM v2_operations WHERE project=$1 AND key=$2',[project,key(k)])).rows[0];if(!row)fail('operation_not_found',404);return this.operationView(row);}
 async artifact(project,id){const row=(await this.store.pool.query('SELECT body FROM v2_artifacts WHERE id=$1 AND project=$2',[uuid(id),project])).rows[0];if(!row)fail('artifact_not_found',404);return this.sealer.open(row.body);}
 async recentOperations(project,query={}){
  if(!exact(query,['limit'])||query.limit!==undefined&&(typeof query.limit!=='string'||!/^\d{1,2}$/.test(query.limit)))fail('recent_operations_query_invalid');
  const limit=query.limit===undefined?25:Number(query.limit);if(limit<1||limit>50)fail('recent_operations_query_invalid');
  const rows=(await this.store.pool.query(`SELECT o.id,o.key_id,o.state,o.error,o.created_at,o.finished_at,o.summary,
   CASE WHEN o.summary IS NULL THEN o.result ELSE NULL END AS legacy_result,
   s.policy->>'id' AS profile_id,s.policy->'version' AS profile_version,l.provider,l.estimated_micro_usd,l.invoice_micro_usd
   FROM v2_operations o JOIN v2_sessions s ON s.id=o.session_id JOIN v2_ledger l ON l.operation=o.id
   WHERE o.project=$1 ORDER BY o.created_at DESC,o.id DESC LIMIT $2`,[project,limit])).rows;
  return {operations:rows.map(row=>({id:row.id,key_id:row.key_id,state:row.state,error:row.error,created_at:row.created_at,finished_at:row.finished_at,access_profile:{id:row.profile_id,version:row.profile_version},...(row.summary??operationSummary(row.legacy_result?this.sealer.open(row.legacy_result):null)),provider:row.provider,estimated_micro_usd:row.estimated_micro_usd===null?null:Number(row.estimated_micro_usd),invoice_micro_usd:row.invoice_micro_usd===null?null:Number(row.invoice_micro_usd)})),scope:'v2_project_recent',limit};
 }
 async usage(project){
  const rows=(await this.store.pool.query(`SELECT o.key_id,o.state,count(*)::int AS operations,
   COALESCE(sum(l.accounted_requests),0)::text AS reserved_or_actual_requests,
   COALESCE(sum(l.accounted_encoded_bytes),0)::text AS reserved_or_actual_encoded_bytes,
   COALESCE(sum(l.accounted_tunnel_bytes),0)::text AS held_tunnel_bytes,
   sum(l.observed_tunnel_bytes)::text AS observed_tunnel_bytes,
   sum(l.estimated_micro_usd)::text AS estimated_micro_usd,
   count(*) FILTER(WHERE l.estimated_micro_usd IS NULL)::int AS unknown_estimate_operations,
   sum(l.invoice_micro_usd)::text AS known_invoice_micro_usd,
   count(*) FILTER(WHERE l.invoice_micro_usd IS NULL)::int AS unknown_invoice_operations
   FROM v2_operations o JOIN v2_ledger l ON l.operation=o.id WHERE o.project=$1 GROUP BY o.key_id,o.state ORDER BY o.key_id,o.state`,[project])).rows;
  const operations=(await this.store.pool.query('SELECT key_id,state,error,summary,CASE WHEN summary IS NULL THEN result ELSE NULL END AS result FROM v2_operations WHERE project=$1',[project])).rows;
  const outcome={source_successes:0,source_failures:0,gateway_failures:0,unknown:0,physical_requests:0,encoded_bytes:0,decoded_bytes:0};
  const byKey={};
  for(const o of operations){
   const r=o.summary??(o.result?this.sealer.open(o.result):null),status=r?.source_http_status??r?.status;byKey[o.key_id]??={...Object.fromEntries(Object.keys(outcome).map(k=>[k,0]))};
   const category=o.state==='unknown'?'unknown':o.error?'gateway_failures':status>=200&&status<400?'source_successes':status>=400?'source_failures':null;
   for(const target of [outcome,byKey[o.key_id]]){if(category)target[category]++;for(const k of ['physical_requests','encoded_bytes','decoded_bytes'])target[k]+=r?.[k]??0;}
  }
  const usage=rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v===null||['key_id','state'].includes(k)?v:Number(v)])));
  return {project,key_id:this.config.projects[project].keyId??project,entitlement:this.entitlement(project),outcomes:outcome,outcomes_by_key:byKey,by_key_and_state:usage,scope:'v2_project_lifetime',application_acceptance:'not_measured',invoice_basis:'unknown_until_authoritative_reconciliation'};
 }
}

export function registerV2(app,gateway){
 const v2=gateway.v2??new V2Gateway(gateway);app.decorate('v2',v2);
 app.get('/v2/capabilities',req=>v2.capabilities(req.project));
 app.post('/v2/discovery-profiles',req=>v2.discoveryProfile(req.project,req.body));
 app.get('/v2/access-profiles',req=>v2.profiles(req.project));
 app.get('/v2/recipes',req=>v2.recipes(req.project));
 app.get('/v2/usage',req=>v2.usage(req.project));
 app.post('/v2/sessions',req=>v2.session(req.project,req.body));
 app.get('/v2/sessions/:id',req=>v2.readSession(req.project,req.params.id));
 app.post('/v2/operations',req=>v2.operation(req.project,req.body));
 app.post('/v2/browser-probes',req=>v2.browserProbe(req.project,req.body));
 app.get('/v2/operations',req=>v2.recentOperations(req.project,req.query));
 app.get('/v2/operations/by-key/:key',req=>v2.lookup(req.project,req.params.key));
 app.get('/v2/operations/:id',req=>v2.readOperation(req.project,req.params.id));
 app.get('/v2/artifacts/:id',req=>v2.artifact(req.project,req.params.id));
}
