import {randomUUID,randomBytes} from 'node:crypto';
import {CookieJar} from 'tough-cookie';
import {sha} from './crypto.mjs';
import {ID,GatewayError,fail,checkedHeaders} from './policy.mjs';
import {providerProxy} from './residential.mjs';
import {nativeHttp,pinnedDestination,decodeNative,PAID_WIRE_READ_BYTES} from './v2-http.mjs';
import {createSourceResolver,reviewedPaidDns,resolvePaidSource} from './v2-dns.mjs';
import {reviewedAddressPreference} from './v2-address-policy.mjs';
import {safeFailure,proxyRefusedBeforeConnect} from './v2-diagnostics.mjs';
import {DISCOVERY_PREFIX,discoveryPolicy,discoveryOrigins,discoveryProfileBody,assertDiscoveryCeiling} from './v2-discovery.mjs';
import {browserProbePolicy,browserProbeRuntime} from './v2-browser-policy.mjs';
import {browserRelay} from './v2-browser-relay.mjs';
import {runBrowserProbe} from './v2-browser-runner.mjs';
import {browserProbeOperation} from './v2-browser-operation.mjs';
import {estimateRoutePricing,estimatePaidPublicDatacenter} from './v2-pricing.mjs';
import {residentialTrafficCharge,finishResidentialTrafficCharge} from './customer-traffic.mjs';
import {distinctNativeRetryRoute,nativeRetryIdentityBinding,pristineNativeRetry,transientNativeTransport,transientNativeResponse,successfulNativeResponse} from './v2-native-retry.mjs';
import {ControlCredits,recoverControlCredits,reviewedCreditPolicy} from './control-credits.mjs';
import {ControlPaidCredits,PAID_CREDIT_RESIDENTIAL_LIABILITY_BYTES,outstandingPaidCreditLiabilitySql,recoverControlPaidCredits,reviewedPaidCreditRoutes,quotePaidHttpCredits} from './control-paid-credits.mjs';
import {PUBLIC_URL_ID,PUBLIC_URL_KIND,PUBLIC_URL_REF,PUBLIC_URL_ROUTES,RESERVED_PUBLIC_URL_IDS,PUBLIC_URL_MAX_BODY_BYTES,PUBLIC_URL_TRANSFER_LIMITS,checkedPublicRedirect,checkedPublicSourceUrl,checkedPublicAddresses,
 isPublicUrlProfile,publicUrlProfile,reviewedPublicUrlPolicy} from './v2-public-url.mjs';

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

export const V2_CAPABILITIES=Object.freeze({api_version:'2',transports:{http:true,browser:false},proxy_classes:{direct:true,datacenter:true,residential:true},features:{native_responses:true,downloads:true,encoded_bodies:true,cookie_jar:true,json_pointers:true,dom_selectors:false,websockets:false,local_storage:false,live_leases:false},retries:{owner:'gateway',max_physical_retries:1,default_physical_retries:0,opt_in:'retry:true',scope:'pristine_native_http_dedicated_datacenter'},profile_approval:'server_configuration'});

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
 ALTER TABLE v2_ledger ADD COLUMN IF NOT EXISTS customer_traffic jsonb;
 ALTER TABLE v2_ledger ADD COLUMN IF NOT EXISTS customer_traffic_reservation jsonb;
 CREATE TABLE IF NOT EXISTS v2_ledger_events(id bigserial PRIMARY KEY,operation uuid NOT NULL REFERENCES v2_operations(id),event text NOT NULL,detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(operation,event));
 CREATE INDEX IF NOT EXISTS v2_ledger_project_created ON v2_ledger(project,created_at);
 `);}

export async function recoverV2(pool){
 // Even reserved work is not replayed automatically. A dispatched request has
 // no recoverable remote job handle; its original reservation survives restart.
 await pool.query(`UPDATE v2_operations SET state='unknown',error='interrupted_unknown',finished_at=now() WHERE state='running';
  UPDATE v2_operations SET state='failed',error='interrupted_before_dispatch',finished_at=now() WHERE state='reserved';
  UPDATE v2_ledger l SET state='unknown',customer_traffic=CASE WHEN l.customer_traffic IS NOT NULL THEN l.customer_traffic || '{"status":"unknown","metered_bytes":null,"billable_bytes":null,"cost_usd":null}'::jsonb ELSE NULL END FROM v2_operations o WHERE l.operation=o.id AND o.state='unknown' AND l.state='reserved';
  UPDATE v2_sessions s SET requests=s.requests-u.requests,encoded_bytes=s.encoded_bytes-u.bytes FROM
   (SELECT l.session_id,sum(l.accounted_requests)::int requests,sum(l.accounted_encoded_bytes) bytes FROM v2_ledger l JOIN v2_operations o ON o.id=l.operation WHERE o.error='interrupted_before_dispatch' AND l.state='reserved' GROUP BY l.session_id) u WHERE s.id=u.session_id;
  UPDATE v2_ledger l SET state='cancelled_before_dispatch',accounted_requests=0,accounted_encoded_bytes=0,accounted_tunnel_bytes=0,estimated_micro_usd=0,customer_traffic=CASE WHEN l.customer_traffic IS NOT NULL THEN l.customer_traffic || '{"status":"no_traffic","metered_bytes":0,"billable_bytes":0,"cost_usd":"0.000000000"}'::jsonb ELSE NULL END FROM v2_operations o WHERE l.operation=o.id AND o.error='interrupted_before_dispatch' AND l.state='reserved';
  INSERT INTO v2_ledger_events(operation,event,detail) SELECT id,'recovery',jsonb_build_object('state',state,'error',error) FROM v2_operations WHERE error IN ('interrupted_unknown','interrupted_before_dispatch') ON CONFLICT DO NOTHING;`);
 await recoverControlCredits(pool);
 await recoverControlPaidCredits(pool);
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

function providerPricing(pricing,paid){
 if(!paid||!pricing)return pricing;
 const {customer_traffic_charge_micro_usd,...provider}=pricing;
 return provider;
}

function operationSummary(result){
 if(!result)return {source_http_status:null,physical_requests:null,encoded_bytes:null,decoded_bytes:null,tunnel_bytes:null,diagnostics:null};
 return {source_http_status:result.status??null,physical_requests:result.physical_requests??null,encoded_bytes:result.encoded_bytes??null,decoded_bytes:result.decoded_bytes??null,tunnel_bytes:result.tunnel_bytes??null,diagnostics:result.diagnostics??null};
}

export class V2Gateway{
 constructor(gateway,{http=nativeHttp,dnsHttp=nativeHttp,browserRuntime=browserProbeRuntime,browserRunner=runBrowserProbe,relayFactory=browserRelay}={}){this.gateway=gateway;this.store=gateway.store;this.config=gateway.config;this.sealer=gateway.sealer;this.http=http;this.resolve=createSourceResolver(this.config.v2?.dns,{systemLookup:gateway.resolve,http:dnsHttp});Object.assign(this,{browserRuntime,browserRunner,browserRelay:relayFactory});
  this.controlCredits=gateway.controlCredits??new ControlCredits({store:this.store,config:this.config});
  this.controlPaidCredits=gateway.controlPaidCredits??new ControlPaidCredits({store:this.store,config:this.config});
  this.dnsHttp=dnsHttp;
  if(Object.entries(this.config.v2?.accessProfiles??{}).some(([k,p])=>k.startsWith(DISCOVERY_PREFIX)||typeof p?.id==='string'&&p.id.startsWith(DISCOVERY_PREFIX)))fail('discovery_namespace_reserved',503);
  if(Object.entries(this.config.v2?.accessProfiles??{}).some(([k,p])=>RESERVED_PUBLIC_URL_IDS.some(id=>k.startsWith(id+'@')||p?.id===id)||[PUBLIC_URL_KIND,'public_url_residential'].includes(p?.kind)))fail('public_url_profile_reserved',503);
 }
 async capabilities(project){
  const policy=discoveryPolicy(this.config,project),runtime=await this.browserRuntime(this.config),selfService=this.controlCredits.managed(project),creditPolicy=selfService?reviewedCreditPolicy(this.config):null;
  const approved=!!policy.browser_probe?.enabled||(this.config.projects[project]?.v2_access_profiles??[]).some(k=>this.config.v2?.accessProfiles?.[k]?.browser_probe?.enabled===true),available=!selfService&&runtime.available&&approved;
  let paidHttp;
  if(selfService){
   const proxyClasses={};
   for(const cls of ['direct','datacenter','residential'])proxyClasses[cls]=await this.paidCreditReady(project,{proxyClass:cls});
   const publicReady=this.publicUrlPolicy(project)&&await this.paidCreditReady(project,{publicOnly:true});
   paidHttp={proxy_classes:proxyClasses,public_url_access_profile:publicReady?PUBLIC_URL_REF:null,
    ...(publicReady?{public_url_transfer_limits:PUBLIC_URL_TRANSFER_LIMITS}:{})};
  }
  return {...V2_CAPABILITIES,...(selfService?{proxy_classes:{direct:true,datacenter:Object.hasOwn(creditPolicy.weights,'datacenter')||paidHttp.proxy_classes.datacenter,residential:paidHttp.proxy_classes.residential},paid_http:paidHttp}:{}),features:{...V2_CAPABILITIES.features,discovery_profiles:policy.enabled,browser_network_probe:available},browser_probe:{available,reason:selfService?'self_service_http_only':!runtime.available?runtime.reason:!approved?'browser_probe_profile_unapproved':null,original_encoded_available:false,max_requests:32,max_decoded_bytes:8388608,max_dom_bytes:1048576,proxy_classes:selfService?[]:['direct','datacenter','residential'],methods:['GET','HEAD'],live_leases:false},discovery_profile_policy:policy.enabled?{enabled:true,max_profiles:policy.max_profiles,max_origins:policy.max_origins,methods:['GET','HEAD'],proxy_classes:['direct'],max_paid_cost_micro_usd:0,limits:policy.limits,...(!selfService&&policy.browser_probe?{browser_probe:policy.browser_probe}:{})}:{enabled:false}};
 }
 async browserProbe(project,raw){if(this.controlCredits.managed(project))fail('self_service_http_only',403);return browserProbeOperation(this,project,raw);}
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
  if(ref.id===PUBLIC_URL_ID){
   if(ref.version!==PUBLIC_URL_REF.version||!this.publicUrlPolicy(project))fail('access_profile_forbidden',403);
   return this.registered('access_profile',publicUrlProfile());
  }
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
  const publicClasses=[];
  if(this.publicUrlPolicy(project))for(const {class:proxyClass} of PUBLIC_URL_ROUTES){
   if(await this.paidCreditReady(project,{publicOnly:true,proxyClass}))publicClasses.push(proxyClass);
  }
  if(publicClasses.length)profiles.push(await this.profile(project,PUBLIC_URL_REF));
  if(discoveryPolicy(this.config,project).enabled)for(const row of (await this.store.pool.query('SELECT id,version FROM v2_discovery_profiles WHERE project=$1 ORDER BY created_at,id',[project])).rows){try{profiles.push(await this.profile(project,{id:row.id,version:row.version}));}catch(error){if(error.code!=='discovery_policy_changed')throw error;}}
  return {access_profiles:profiles.map(p=>this.publicProfile(p,project,publicClasses))};
 }
 pricing(project,profile,route,bytes,transport='http',duration=profile.limits.timeout_ms){
  const options={config:this.config,project,profile,route,transport,reserved_tunnel_bytes:bytes,duration_ms:duration};
  if(this.controlCredits.managed(project)&&isPublicUrlProfile(profile)&&route.class==='datacenter')
   return estimatePaidPublicDatacenter(options);
  return estimateRoutePricing(options);
 }
 paidHttpRequested(project,profile,route,raw){
  const explicit=raw.max_transfer_mb!==undefined||raw.max_credits!==undefined;
  if(explicit&&!this.controlCredits.managed(project))fail('paid_credit_route_forbidden',403);
  return this.controlCredits.managed(project)&&(explicit||isPublicUrlProfile(profile)||route.class==='residential');
 }
 publicUrlPolicy(project){
  if(!this.controlCredits.managed(project)||!this.config.projects?.[project]||!reviewedPaidDns(this.config))return null;
  const reviewed=reviewedPaidCreditRoutes(this.config).some(rule=>refKey(rule.accessProfile)===refKey(PUBLIC_URL_REF)&&
   PUBLIC_URL_ROUTES.some(route=>route.class===rule.class&&route.country===rule.country&&route.provider===rule.provider));
  return reviewed?reviewedPublicUrlPolicy(this.config):null;
 }
 approvedPaidRoute(project,profile,route){
  if(!this.controlCredits.managed(project)||!reviewedPaidDns(this.config)||profile.kind==='discovery'||
   !profile.proxy_classes.includes(route.class)||route.class!=='direct'&&!profile.countries.includes(route.country))return false;
  const provider=route.class==='datacenter'?'oxylabs':route.provider;
  if(isPublicUrlProfile(profile)){
   if(!this.publicUrlPolicy(project)||!PUBLIC_URL_ROUTES.some(rule=>rule.class===route.class&&rule.country===route.country&&rule.provider===provider))return false;
  }else if(!this.config.projects[project]?.v2_access_profiles?.includes(refKey(profile)))return false;
  if(!reviewedPaidCreditRoutes(this.config).some(rule=>refKey(rule.accessProfile)===refKey(profile)&&
   rule.class===route.class&&rule.country===route.country&&rule.provider===provider))return false;
  if(route.class==='datacenter'){
   const {pricing,estimated_micro_usd}=this.pricing(project,profile,route,0);
   return estimated_micro_usd===0&&pricing?.provider==='oxylabs';
  }
  return true;
 }
 residentialProvider(profile,country,project){
  return ['evomi','dataimpulse'].find(provider=>{
   const settings=this.config.residential?.providers?.[provider],route={class:'residential',country,provider};
   return settings?.enabled&&settings.username&&settings.password&&(!settings.countries||settings.countries.includes(country))&&
    (!this.controlCredits.managed(project)||this.approvedPaidRoute(project,profile,route));
  });
 }
 async paidCreditReady(project,{purchaseCredits=0,pendingLiabilityBytes=0,outstandingLiabilityBytes=null,
  proxyClass,publicOnly=false,client=this.store.pool}={}){
  if(!this.controlCredits.managed(project)||!reviewedPaidDns(this.config))return false;
  const validBytes=n=>typeof n==='bigint'?n>=0n:Number.isSafeInteger(n)&&n>=0;
  if(!Number.isSafeInteger(purchaseCredits)||purchaseCredits<0||!validBytes(pendingLiabilityBytes)||
   outstandingLiabilityBytes!==null&&!validBytes(outstandingLiabilityBytes))return false;
  const rules=reviewedPaidCreditRoutes(this.config);
  if(!rules.length)return false;
  const active=(await client.query('SELECT status FROM control_projects WHERE id=$1',[project])).rows[0];
  if(active?.status!=='active')return false;
  if(purchaseCredits>0&&await this.controlPaidCredits.paymentHeld(project,client))return false;
  for(const rule of rules){
   if(proxyClass&&rule.class!==proxyClass||purchaseCredits>0&&rule.class!=='residential')continue;
   const key=refKey(rule.accessProfile),builtIn=key===refKey(PUBLIC_URL_REF);
   if(publicOnly&&!builtIn)continue;
   if(builtIn?!this.publicUrlPolicy(project):!this.config.projects[project]?.v2_access_profiles?.includes(key))continue;
   try{
    const profile=builtIn?publicUrlProfile():normalizeProfile(this.config.v2?.accessProfiles?.[key]);
    if(refKey(profile)!==key)continue;
    const registered=(await client.query("SELECT hash FROM v2_registry WHERE kind='access_profile' AND key=$1",[key])).rows[0];
    if(registered&&registered.hash!==sha(canonical(profile)))continue;
    const route=this.route(profile,{class:rule.class,country:rule.country,affinity:'session'},project);
    if(!this.approvedPaidRoute(project,profile,route))continue;
    if(route.class!=='residential')return true;
    const {max_transfer_bytes}=quotePaidHttpCredits({route});
    const accounted=await this.reserveResidential(client,project,null,route,max_transfer_bytes+PAID_WIRE_READ_BYTES,purchaseCredits>0&&outstandingLiabilityBytes===null);
    if(purchaseCredits===0)return true;
    const required=BigInt(purchaseCredits)*BigInt(PAID_CREDIT_RESIDENTIAL_LIABILITY_BYTES)+BigInt(pendingLiabilityBytes)+BigInt(outstandingLiabilityBytes??accounted.prepaid_obligations);
    const settings=this.config.residential,provider=settings.providers[route.provider];
    const priors=Object.values(settings.providers).map(p=>p.priorReservedBytes??0);
    if(priors.some(n=>!Number.isSafeInteger(n)||n<0))continue;
    const globalRemaining=BigInt(settings.maxTotalBytes)-BigInt(accounted.total)-priors.reduce((sum,n)=>sum+BigInt(n),0n);
    const providerRemaining=BigInt(provider.maxTotalBytes)-BigInt(accounted.provider_total)-BigInt(provider.priorReservedBytes??0);
    if(globalRemaining>=required&&providerRemaining>=required)return true;
   }catch(error){if(!(error instanceof GatewayError))throw error;}
  }
  return false;
 }
 publicProfile(p,project,publicClasses=[]){
   const {id,version,origins,paths,method_paths,methods,headers,proxy_classes,countries,limits}=p;
   const selfService=this.controlCredits.managed(project),publicUrl=isPublicUrlProfile(p);
   const bytes=limits.max_tunnel_bytes*(limits.max_redirects+1),route_reservations=[];
   for(const cls of publicUrl?publicClasses:proxy_classes)for(const country of cls==='direct'?[null]:countries){
    const provider=cls==='direct'?'direct':cls==='residential'?this.residentialProvider(p,country,project):'configured_datacenter';
    if(cls==='residential'&&selfService&&!provider)continue;
    const route={class:cls,country,provider},paid=selfService&&this.approvedPaidRoute(project,p,route);
    const trial=selfService&&!publicUrl&&Object.hasOwn(reviewedCreditPolicy(this.config).weights,cls);
    if(selfService&&!paid&&!trial)continue;
    const quote=paid?quotePaidHttpCredits({route}):null;
    const reserved=cls==='direct'?0:quote?quote.max_transfer_bytes+PAID_WIRE_READ_BYTES:bytes;
    const decision=this.pricing(project,p,route,reserved);
    route_reservations.push({...route,provider:provider??null,reserved_tunnel_bytes:reserved,estimated_micro_usd:decision.estimated_micro_usd,
     ...(quote?{paid_credit_reservation:quote}:decision.customer_traffic_reservation?{customer_traffic_reservation:decision.customer_traffic_reservation}:{}),...(decision.pricing?{pricing:providerPricing(decision.pricing,quote)}:{})});
   }
   const classes=[...new Set(route_reservations.map(route=>route.class))];
   const browser_probe=selfService?{enabled:false}:p.browser_probe?{...p.browser_probe,...(p.browser_probe.enabled?{route_reservations:route_reservations.map(r=>{const n=r.class==='direct'?0:p.browser_probe.max_network_bytes,decision=this.pricing(project,p,r,n,'browser');const {pricing,customer_traffic_reservation,...base}=r;return {...base,reserved_tunnel_bytes:n,estimated_micro_usd:decision.estimated_micro_usd,...(decision.customer_traffic_reservation?{customer_traffic_reservation:decision.customer_traffic_reservation}:{}),...(decision.pricing?{pricing:decision.pricing}:{})};})}:{})}:undefined;
   return {id,version,origins,paths:paths??null,method_paths:method_paths??null,methods,headers,proxy_classes:classes,countries,limits,route_reservations,...(browser_probe?{browser_probe}:{}),...(p.kind==='discovery'?{kind:'discovery',max_paid_cost_micro_usd:0}:{}),
    ...(publicUrl?{kind:PUBLIC_URL_KIND,transfer_limits:PUBLIC_URL_TRANSFER_LIMITS,max_daily_operations:this.publicUrlPolicy(project)?.maxDailyOperations??null}:{})};
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
   if(old){if(old.input_hash!==inputHash)fail('idempotency_conflict',409);if(sha(canonical(old.profile))!==old.profile_hash)fail('discovery_profile_invalid',503);return {access_profile:{id:old.id,version:old.version},profile:this.publicProfile(old.profile,project),created_at:old.created_at};}
   if(raw.origins.length>policy.max_origins)fail('discovery_origins_limit',400);
   const count=Number((await c.query('SELECT count(*) AS n FROM v2_discovery_profiles WHERE project=$1',[project])).rows[0].n);if(count>=policy.max_profiles)fail('discovery_profiles_limit',429);
   const id=DISCOVERY_PREFIX+randomUUID(),profile=normalizeProfile(discoveryProfileBody(id,origins,policy));
   const row=(await c.query('INSERT INTO v2_discovery_profiles(id,version,project,key,input_hash,profile,profile_hash) VALUES($1,1,$2,$3,$4,$5,$6) RETURNING created_at',[id,project,raw.idempotency_key,inputHash,profile,sha(canonical(profile))])).rows[0];
   return {access_profile:{id,version:1},profile:this.publicProfile(profile,project),created_at:row.created_at};
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
 route(p,proxy,project){
  if(!exact(proxy,['class','country','affinity'])||!['direct','datacenter','residential'].includes(proxy.class)||proxy.affinity!=='session')fail('capability_unsupported',409);
  if(!p.proxy_classes.includes(proxy.class))fail('proxy_class_forbidden',403);
  if(proxy.class==='direct'){if(proxy.country!==null)fail('direct_country_unverified');return {...proxy,provider:'direct',proxy_id:null};}
  if(typeof proxy.country!=='string'||!p.countries.includes(proxy.country))fail('country_forbidden',403);
  if(proxy.class==='datacenter'){
   const route={...proxy,provider:'configured_datacenter'};
   if(isPublicUrlProfile(p)&&!this.approvedPaidRoute(project,p,route))fail('paid_credit_route_forbidden',403);
   const pool=(this.config.proxies??[]).filter(x=>x.country===proxy.country);
   if(!pool.length)fail('country_pool_unavailable',503);
   const selected=pool[Math.floor(Math.random()*pool.length)];this.checkProxy(selected);
   return {...route,proxy_id:selected.id};
  }
  const provider=this.residentialProvider(p,proxy.country,project);
  if(!provider&&this.controlCredits.managed(project))fail(isPublicUrlProfile(p)?'paid_credit_route_forbidden':'credit_route_forbidden',403);
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
 sessionView(row){const r=this.sealer.open(row.route);return {id:row.id,access_profile:{id:row.policy.id,version:row.policy.version},transport:'http',proxy:{class:r.class,country:r.country,affinity:r.affinity,provider:r.provider},state:new Date(row.expires_at)<=new Date()?'expired':row.state,expires_at:row.expires_at,requests:row.requests,encoded_bytes:Number(row.encoded_bytes),state_support:{cookie_jar:!isPublicUrlProfile(row.policy),local_storage:false,live_connection:false}};}
 async session(project,raw,{paid=false}={}){
  if(!exact(raw,['idempotency_key','access_profile','transport','proxy']))fail('session_invalid');key(raw.idempotency_key);
  if(raw.transport!=='http')fail('capability_unsupported',409);
  const p=await this.profile(project,raw.access_profile),hash=sha(canonical(raw));
  if(this.controlCredits.managed(project)&&!paid&&!isPublicUrlProfile(p)&&raw.proxy?.class!=='residential')
   this.controlCredits.quote({route:raw.proxy,transport:raw.transport,estimatedMicroUsd:0});
  return this.store.tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(2002)');
   const old=(await c.query('SELECT * FROM v2_sessions WHERE project=$1 AND key=$2',[project,raw.idempotency_key])).rows[0];
   if(old){if(old.input_hash!==hash)fail('idempotency_conflict',409);return this.sessionView(old);}
   const route=this.route(p,raw.proxy,project),id=randomUUID();
   if((paid||isPublicUrlProfile(p)||this.controlCredits.managed(project)&&route.class==='residential')&&!this.approvedPaidRoute(project,p,route))
    fail('paid_credit_route_forbidden',403);
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
  const input={url:raw.url,method,headers:raw.headers??{},body};
  if(isPublicUrlProfile(p)){
   const policy=reviewedPublicUrlPolicy(this.config);
   if(!policy)fail('access_profile_forbidden',403);
   const url=checkedPublicSourceUrl(raw.url,policy);
   this.headers(input,p,url);
  }
  return input;
 }
 headers(input,p,url){
  if(!p.methods.includes(input.method)||p.method_paths&&!(p.method_paths[input.method]??[]).some(pattern=>new RegExp(pattern).test(url.pathname)))fail('endpoint_method_rejected');
  for(const name of Object.keys(input.headers))if(/^(?:cookie|set-cookie|x-forwarded-|forwarded$)/i.test(name))fail('headers_rejected');
  const credentials=p.credential_headers??[];
  const rules=credentials.includes('authorization')?[{host:url.hostname,method:input.method,path:'.*',query:'.*'}]:[];
  const headers=checkedHeaders(input.headers,{headers:p.headers,guestAuth:rules},url,input.method);
  for(const [name,value]of Object.entries(headers)){
   if(/\bfx[ks]_[A-Za-z0-9_-]{20,}/.test(value))fail('credential_scope_rejected');
   if(/^(?:authorization|x-api-key|api-key|x-auth-)/i.test(name)&&!credentials.includes(name))fail('credential_scope_rejected');
   for(const config of Object.values(this.config.projects))if(sha(value.trim().replace(/^Bearer\s+/i,''))===config.tokenHash)fail('credential_scope_rejected');
  }
  return {...headers,'accept-encoding':headers['accept-encoding']??'gzip, br, deflate'};
 }
 async rejectControlCredentials(headers){
  for(const value of Object.values(headers)){
   if(typeof value!=='string')continue;
   if(/\bfx[ks]_[A-Za-z0-9_-]{20,}/.test(value))fail('credential_scope_rejected');
   if(this.gateway.controlIdentity){
    const candidates=new Set([value.trim(),value.trim().replace(/^Bearer\s+/i,''),...value.split(';').map(v=>v.trim().replace(/^[^=]*=/,''))]);
    for(const candidate of candidates)if(await this.gateway.controlIdentity.isCredential(candidate))fail('credential_scope_rejected');
   }
  }
 }
 async reserveResidential(c,project,session,route,bytes,includePrepaidObligations=false){
  if(route.class!=='residential')return null;
  const settings=this.config.residential,pc=settings?.providers?.[route.provider];this.resolveProxy(route);
  const row=(await c.query(`SELECT COALESCE(sum(accounted_bytes),0) total,
   COALESCE(sum(accounted_bytes) FILTER(WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) daily,
   COALESCE(sum(accounted_bytes) FILTER(WHERE project=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) project_daily,
   COALESCE(sum(accounted_bytes) FILTER(WHERE provider=$2),0) provider_total
   ${includePrepaidObligations?`,(${outstandingPaidCreditLiabilitySql}) AS prepaid_obligations`:''} FROM (
    SELECT project,provider,accounted_bytes,created_at FROM residential_usage UNION ALL
    SELECT project,provider,accounted_tunnel_bytes AS accounted_bytes,created_at FROM v2_ledger WHERE proxy_class='residential') u`,[project,route.provider])).rows[0];
  const prior=Object.values(settings.providers).reduce((sum,p)=>sum+(p.priorReservedBytes??0),0);
  for(const [used,cap]of [[Number(row.total)+prior,settings.maxTotalBytes],[Number(row.daily),settings.maxDailyBytes],[Number(row.project_daily),this.config.projects[project].maxDailyResidentialBytes??settings.maxDailyBytes],[Number(row.provider_total)+(pc.priorReservedBytes??0),pc.maxTotalBytes]])if(used+bytes>positive(cap,'residential_budget_unconfigured'))fail('residential_budget_exhausted',429);
  if((await c.query("SELECT 1 FROM attempts WHERE provider=$1 AND error=ANY($2::text[]) UNION ALL SELECT 1 FROM v2_operations o JOIN v2_ledger l ON l.operation=o.id WHERE l.provider=$1 AND o.error=ANY($2::text[]) LIMIT 1",[route.provider,['provider_account_rejected','sensitive_provider_response','cost_overrun']])).rowCount)fail('residential_provider_held',409);
  if(!Number.isSafeInteger(pc.microUsdPerGB)||pc.microUsdPerGB<0)fail('residential_rate_unconfigured',503);
  return row;
 }
 async reserveHttpArtifactCapacity(c,bytes){
  // Admission runs under the existing V2 advisory lock. For each active
  // operation count at least its commitment, and count any larger stored size.
  const {n}=(await c.query(`WITH active AS (
   SELECT o.id,COALESCE((e.detail->>'artifact_bytes')::bigint,CASE WHEN o.kind='browser_probe' THEN
    ceil(((s.policy->'browser_probe'->>'max_decoded_bytes')::bigint+(s.policy->'browser_probe'->>'max_dom_bytes')::bigint)*1.4)
     +l.reserved_requests*131072
    ELSE ceil((l.reserved_encoded_bytes+(s.policy->'limits'->>'max_decoded_bytes')::bigint*
     ((s.policy->'limits'->>'max_redirects')::int+1))*1.4)+65536 END) AS bytes
   FROM v2_operations o JOIN v2_ledger l ON l.operation=o.id JOIN v2_sessions s ON s.id=o.session_id
   LEFT JOIN v2_ledger_events e ON e.operation=o.id AND e.event='reserve'
   WHERE o.state IN ('reserved','running')
  ), stored AS (
   SELECT operation,sum(octet_length(body)) AS bytes FROM v2_artifacts GROUP BY operation
  )
  SELECT COALESCE(sum(GREATEST(stored.bytes,active.bytes)),0) AS n FROM stored FULL JOIN active ON stored.operation=active.id`)).rows[0];
  if(Number(n)+bytes>(this.config.v2?.maxArtifactBytes??256*1024*1024))fail('artifact_quota',507);
 }
 async operation(project,raw,identity){
  const keyId=this.controlCredits.keyId(project,identity);
  if(!exact(raw,['idempotency_key','session_id','request','recipe','max_estimated_micro_usd','max_transfer_mb','max_credits','retry']))fail('operation_invalid');key(raw.idempotency_key);uuid(raw.session_id);
  if(raw.retry!==undefined&&typeof raw.retry!=='boolean')fail('request_invalid');
  if(raw.retry===false){raw={...raw};delete raw.retry;}
  if(raw.max_estimated_micro_usd!==undefined&&(!Number.isSafeInteger(raw.max_estimated_micro_usd)||raw.max_estimated_micro_usd<0))fail('cost_ceiling_invalid');
  const hash=sha(canonical(raw));
  const prior=(await this.store.pool.query('SELECT * FROM v2_operations WHERE project=$1 AND key=$2',[project,raw.idempotency_key])).rows[0];
  if(prior){if(prior.input_hash!==hash)fail('idempotency_conflict',409);return this.operationView(prior);}
  const session=await this.owned(project,raw.session_id),p=await this.profile(project,{id:session.policy.id,version:session.policy.version});
  const input=this.request(raw.request,p),recipe=await this.recipe(project,raw.recipe,p);let route=this.sealer.open(session.route);
  await this.rejectControlCredentials(input.headers);
  const id=randomUUID(),hops=p.limits.max_redirects+1,publicUrl=isPublicUrlProfile(p);
  const paid=this.paidHttpRequested(project,p,route,raw);
  if(paid&&raw.retry===true)fail('paid_credit_retry_unsupported',409);
  if(paid){
   let url;try{url=new URL(input.url);}catch{fail('destination_rejected');}
   await this.rejectControlCredentials(this.headers(input,p,url));
  }
  let reused,pricingDecision,paidQuote,publicBodyLimit=null,retryPlan=raw.retry===true?{requested:true,eligible:false,stop_reason:'retry_ineligible'}:null,reservationRequests=hops;
  await this.store.tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(1002)');
   const old=(await c.query('SELECT * FROM v2_operations WHERE project=$1 AND key=$2',[project,raw.idempotency_key])).rows[0];if(old){if(old.input_hash!==hash)fail('idempotency_conflict',409);reused=old;return;}
   const locked=(await c.query('SELECT * FROM v2_sessions WHERE id=$1 AND project=$2 FOR UPDATE',[session.id,project])).rows[0];
   route=this.sealer.open(locked.route);Object.assign(session,locked);
   if(locked.state!=='open'||new Date(locked.expires_at)<=new Date())fail('session_expired',409);
   if((await c.query("SELECT 1 FROM v2_operations WHERE session_id=$1 AND state IN ('reserved','running','unknown')",[session.id])).rowCount)fail('session_busy_or_unknown',409);
   if(retryPlan&&pristineNativeRetry({...locked,cookie_jar:this.sealer.open(locked.cookie_jar)},input,recipe,p)&&!(await c.query('SELECT 1 FROM v2_operations WHERE session_id=$1 LIMIT 1',[session.id])).rowCount){
    const nextRoute=distinctNativeRetryRoute(this.config,route);
    retryPlan={requested:true,eligible:!!nextRoute,next_route:nextRoute,identity_binding:nativeRetryIdentityBinding(this.config,route),stop_reason:nextRoute?null:'retry_route_unavailable'};
    Object.assign(session,locked);
   }
   if(paid){
    if(!this.approvedPaidRoute(project,p,route))fail('paid_credit_route_forbidden',403);
    paidQuote=quotePaidHttpCredits({route,maxTransferMb:raw.max_transfer_mb,maxCredits:raw.max_credits});
   }
   if(publicUrl)publicBodyLimit=Math.min(PUBLIC_URL_MAX_BODY_BYTES,paidQuote.max_transfer_bytes);
   const reservedBytes=publicBodyLimit??p.limits.max_encoded_bytes*hops;
   const reservedTunnel=route.class==='direct'?0:paidQuote?paidQuote.max_transfer_bytes+PAID_WIRE_READ_BYTES:p.limits.max_tunnel_bytes*hops;
   pricingDecision=this.pricing(project,p,route,reservedTunnel);
   if(retryPlan?.eligible&&(!pricingDecision.binding||pricingDecision.estimated_micro_usd!==0||pricingDecision.pricing?.provider!=='oxylabs'||pricingDecision.pricing?.basis!=='operator_fixed_fee_pool'))retryPlan={...retryPlan,eligible:false,stop_reason:'retry_ineligible'};
   if(retryPlan?.eligible)reservationRequests=Math.min(hops+1,p.limits.max_requests-locked.requests);
   if(locked.requests+reservationRequests>p.limits.max_requests||reservationRequests<1||Number(locked.encoded_bytes)+reservedBytes>p.limits.max_session_encoded_bytes)fail('session_limit',429);
   const usage=(await c.query(`SELECT count(*)::int AS n FROM v2_operations o JOIN v2_sessions s ON s.id=o.session_id
    WHERE o.project=$1 AND o.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    AND ((s.policy->>'id'=$2) IS TRUE)=$3`,[project,PUBLIC_URL_ID,publicUrl])).rows[0];
   if(publicUrl){
    const policy=this.publicUrlPolicy(project);if(!policy)fail('paid_credit_route_forbidden',403);
    if(usage.n>=policy.maxDailyOperations)fail('paid_public_url_daily_quota_exhausted',429);
   }else{
    const entitlement=this.entitlement(project);if(entitlement.mode==='metered'&&usage.n>=entitlement.max_daily_operations)fail('client_quota_exhausted',429);
   }
   const active=(await c.query("SELECT count(*)::int n FROM v2_operations WHERE state IN ('reserved','running')")).rows[0].n+Number((await c.query("SELECT count(*) AS n FROM attempts WHERE state IN ('reserved','sent')")).rows[0].n);
   if(active>=(this.config.maxConcurrentRequests??4))fail('capacity_wait',503);
   const artifactBytes=publicUrl?Math.ceil((reservedBytes+publicBodyLimit)*1.4)+hops*512*1024:
    Math.ceil((reservedBytes+p.limits.max_decoded_bytes*hops)*1.4)+65536;
   await this.reserveHttpArtifactCapacity(c,artifactBytes);
   await this.reserveResidential(c,project,session,route,reservedTunnel);
   const estimated=pricingDecision.estimated_micro_usd;
   if(raw.max_estimated_micro_usd!==undefined){if(estimated===null)fail('cost_estimate_unavailable',409);if(estimated>raw.max_estimated_micro_usd||!paid&&(pricingDecision.customer_traffic_reservation?.max_estimated_micro_usd??0)>raw.max_estimated_micro_usd)fail('cost_ceiling_exceeded',429);}
   await c.query('INSERT INTO v2_operations(id,project,key_id,key,session_id,input_hash,input,recipe) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,project,keyId,raw.idempotency_key,session.id,hash,this.sealer.seal(raw),recipe]);
   if(paidQuote)await this.controlPaidCredits.reserve(c,{project,operation:id,keyId,quote:paidQuote});
   else await this.controlCredits.reserve(c,{project,operation:id,keyId,route,profile:p,transport:'http',estimatedMicroUsd:estimated});
   await c.query('INSERT INTO v2_ledger(operation,project,session_id,provider,proxy_class,reserved_requests,accounted_requests,reserved_encoded_bytes,accounted_encoded_bytes,reserved_tunnel_bytes,accounted_tunnel_bytes,estimated_micro_usd,customer_traffic,customer_traffic_reservation) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$7,$8,$8,$9,$10,$11)',[id,project,session.id,route.provider,route.class,reservationRequests,reservedBytes,reservedTunnel,estimated,route.class==='residential'&&!paid?residentialTrafficCharge({status:'pending'}):null,paid?null:pricingDecision.customer_traffic_reservation??null]);
   await c.query("INSERT INTO v2_ledger_events(operation,event,detail) VALUES($1,'reserve',$2)",[id,{requests:reservationRequests,encoded_bytes:reservedBytes,tunnel_bytes:reservedTunnel,artifact_bytes:artifactBytes,pricing_decision:pricingDecision,...(publicUrl?{body_limits:{max_encoded_bytes:publicBodyLimit,max_decoded_bytes:publicBodyLimit}}:{}),...(paidQuote?{paid_credit_quote:paidQuote}:{}),...(retryPlan?{native_retry:{requested:true,eligible:retryPlan.eligible,stop_reason:retryPlan.stop_reason}}:{})}]);
   await c.query('UPDATE v2_sessions SET requests=requests+$2,encoded_bytes=encoded_bytes+$3 WHERE id=$1',[session.id,reservationRequests,reservedBytes]);
  });
  if(reused)return this.operationView(reused);
  await this.execute(project,id,session,p,route,input,recipe,pricingDecision,retryPlan?{...retryPlan,request_limit:reservationRequests}:null,paidQuote,publicBodyLimit);
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
 assertPricingDispatch(project,context){
  if(!context?.decision?.binding)return;
  const {profile,route,decision}=context;
  if(Date.now()>=decision.dispatch_deadline_ms)fail('pricing_dispatch_deadline',409);
  const current=this.pricing(project,profile,route,0,'http',0);
  if(current.estimated_micro_usd!==0||canonical(current.pricing)!==canonical(decision.pricing)||canonical(current.binding)!==canonical(decision.binding))fail('pricing_attestation_unavailable',409);
 }
 async dispatchable(project,id,session,url,pricingContext){
  this.assertPricingDispatch(project,pricingContext);
  await this.store.tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(1002)');
   const row=(await c.query('SELECT s.state,s.expires_at,o.state AS operation_state FROM v2_sessions s JOIN v2_operations o ON o.session_id=s.id WHERE s.id=$1 AND s.project=$2 AND o.id=$3',[session,project,id])).rows[0];
   if(!row||!['reserved','running'].includes(row.operation_state))fail('operation_not_dispatchable',409);
   if(row.state!=='open'||new Date(row.expires_at)<=new Date())fail('session_expired',409);
   if((await c.query('SELECT 1 FROM source_limits WHERE source=$1 AND cooldown_until>now()',['origin:'+url.hostname])).rowCount)fail('source_cooldown',429);
   if(pricingContext?.paidQuote){
    if(!this.approvedPaidRoute(project,pricingContext.profile,pricingContext.route))fail('paid_credit_route_forbidden',403);
    await this.controlPaidCredits.assertDispatch(c,{project,operation:id});
   }
   this.assertPricingDispatch(project,pricingContext);
   await c.query("UPDATE v2_operations SET state='running' WHERE id=$1",[id]);
  });
  this.assertPricingDispatch(project,pricingContext);
 }
 async destination(raw,p,deadline,context){
  if(isPublicUrlProfile(p)){
   const policy=reviewedPublicUrlPolicy(this.config);
   if(!policy)fail('paid_credit_route_forbidden',403);
   const url=checkedPublicSourceUrl(raw,policy);
   const addresses=checkedPublicAddresses(await context.paidResolve(url.hostname));
   const selected=addresses[0];
   return {url,address:selected.address,family:selected.family,dns_diagnostics:addresses.dns_diagnostics};
  }
  if(context?.paidResolve)return pinnedDestination(raw,p,context.paidResolve);
  const resolve=(host,options)=>this.resolve(host,options,context);
  // Paid DNS owns a cancelling native transport deadline and metering; racing
  // it here would finalize accounting before its transport has settled.
  if(context?.proxy){
   let host;try{host=new URL(raw).hostname;}catch{}
   if(this.config.v2?.dns?.allowed_hosts?.includes(host)&&this.config.v2.dns.fallback_resolvers?.length)return pinnedDestination(raw,p,resolve,{addressPreference:context?.addressPreference});
  }
  let timer;
  try{return await Promise.race([pinnedDestination(raw,p,resolve,{addressPreference:context?.addressPreference}),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new GatewayError('dns_deadline',504)),Math.max(1,deadline-Date.now()));})]);}
  finally{clearTimeout(timer);}
 }
 async cooldown(url,response){
  if(response.status!==429&&!response.headers['retry-after'])return;
  const raw=response.headers['retry-after'],s=/^\d+$/.test(raw??'')?Number(raw):Math.ceil((Date.parse(raw)-Date.now())/1000);
  const until=new Date(Date.now()+Math.min(3600,Math.max(1,Number.isFinite(s)?s:60))*1000);
  await this.store.pool.query('INSERT INTO source_limits(source,next_at,cooldown_until) VALUES($1,$2,$2) ON CONFLICT(source) DO UPDATE SET next_at=GREATEST(source_limits.next_at,EXCLUDED.next_at),cooldown_until=GREATEST(source_limits.cooldown_until,EXCLUDED.cooldown_until)',['origin:'+url.hostname,until]);
 }
 async admitNativeRetry(project,id,session,p,route,plan,pricingContext,deadline,attempt){
  if(Date.now()>=deadline)fail('retry_deadline',504);
  const currentProfile=await this.profile(project,{id:p.id,version:p.version});
  if(canonical(currentProfile)!==canonical(p))fail('retry_policy_changed',409);
  const next=distinctNativeRetryRoute(this.config,route);
  if(!next||canonical(next)!==canonical(plan.next_route)||nativeRetryIdentityBinding(this.config,route)!==plan.identity_binding)fail('retry_route_unavailable',409);
  if(!p.proxy_classes.includes(next.class)||!p.countries.includes(next.country))fail('retry_policy_changed',403);
  this.resolveProxy(next);
  const nextPricing={...pricingContext,route:next};this.assertPricingDispatch(project,nextPricing);
  await this.store.tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(1002)');
   const locked=(await c.query('SELECT * FROM v2_sessions WHERE id=$1 AND project=$2 FOR UPDATE',[session.id,project])).rows[0];
   const operation=(await c.query('SELECT * FROM v2_operations WHERE id=$1 AND project=$2 FOR UPDATE',[id,project])).rows[0];
   if(!locked||locked.state!=='open'||new Date(locked.expires_at)<=new Date())fail('session_expired',409);
   if(!operation||operation.state!=='running'||operation.session_id!==session.id||canonical(this.sealer.open(locked.route))!==canonical(route))fail('operation_not_dispatchable',409);
   if((await c.query('SELECT 1 FROM v2_operations WHERE session_id=$1 AND id<>$2 LIMIT 1',[session.id,id])).rowCount)fail('retry_ineligible',409);
   const cookies=CookieJar.deserializeSync(this.sealer.open(locked.cookie_jar)).serializeSync().cookies;
   if(cookies.length)fail('retry_ineligible',409);
   if((await c.query('SELECT 1 FROM source_limits WHERE source=$1 AND cooldown_until>now()',['origin:'+new URL(attempt.url).hostname])).rowCount)fail('source_cooldown',429);
   this.assertPricingDispatch(project,nextPricing);
   const admitted=await c.query("INSERT INTO v2_ledger_events(operation,event,detail) VALUES($1,'native_retry_admitted',$2) ON CONFLICT DO NOTHING RETURNING id",[id,{attempt:1,route_changed:true,reason:attempt.reason,diagnostics:attempt.diagnostics}]);
   if(admitted.rowCount!==1)fail('retry_already_admitted',409);
   await c.query('UPDATE v2_sessions SET route=$2 WHERE id=$1',[session.id,this.sealer.seal(next)]);
  });
  return next;
 }
 async execute(project,id,session,p,route,input,recipe,pricingDecision,retryPlan=null,paidQuote=null,publicBodyLimit=null){
  const jar=CookieJar.deserializeSync(this.sealer.open(session.cookie_jar));
  const deadline=Math.min(Date.now()+p.limits.timeout_ms,pricingDecision?.binding?pricingDecision.dispatch_deadline_ms:Infinity),pricingContext={profile:p,route,decision:pricingDecision,paidQuote},artifacts=[],dns=[],attempts=[];
  const hops=p.limits.max_redirects+1,tunnelBudget=p.limits.max_tunnel_bytes*hops,encodedBudget=publicBodyLimit??p.limits.max_encoded_bytes*hops,decodedBudget=publicBodyLimit??p.limits.max_decoded_bytes*hops,retryEnabled=!!retryPlan?.eligible;
  let requests=0,nativeDispatches=0,dnsRequests=0,dnsNotDispatched=0,dnsUncertain=false,encoded=0,decoded=0,tunnel=route.class==='direct'?null:0,error=null,unknown=false,last=null,stage='route',failure=null,finalArtifact=null,routeChanged=false,stopReason=retryPlan?.stop_reason??null;
  const remainingTunnel=()=>tunnel===null?0:Math.max(0,tunnelBudget-tunnel),remainingEncoded=()=>Math.max(0,encodedBudget-encoded);
  const publicUrl=isPublicUrlProfile(p),wireCap=paidQuote?.max_transfer_bytes;
  let wire=0,wireLower=0,paidUnknown=false;
  const validBytes=value=>Number.isSafeInteger(value)&&value>=0;
  const remainingWire=()=>wire===null?0:Math.max(0,wireCap-wire);
  const observeWire=(observed,lower)=>{
   wire=wire!==null&&validBytes(observed)?wire+observed:null;
   if(validBytes(lower))wireLower+=lower;
   if(route.class!=='direct')tunnel=wire;
  };
  const requireWire=()=>{
   if(wire===null)fail('source_meter_unknown',502);
   if(remainingWire()<=0)fail('max_transfer_bytes_exceeded',502);
  };
  const paidHttp=async(http,request,destination,limits,proxy)=>{
   const remaining=remainingWire();
   let response;
   try{
    response=await http(request,destination,{...limits,max_tunnel_bytes:Math.min(remaining,p.limits.max_tunnel_bytes)},{proxy,wireMeter:true});
   }catch(error){
    observeWire(error.observed_wire_bytes,error.wire_bytes_lower_bound);
    if(error.code==='tunnel_byte_limit'&&remaining<=p.limits.max_tunnel_bytes)error.code='max_transfer_bytes_exceeded';
    if(error.wire_dispatched!==false&&(/unknown|incomplete/.test(error.code??'')||wire===null))paidUnknown=true;
    throw error;
   }
   observeWire(response.wire_bytes,response.wire_bytes_lower_bound);
   if(wire===null){paidUnknown=true;fail('source_meter_unknown',502);}
   if(wire>wireCap)fail('max_transfer_bytes_exceeded',502);
   return response;
  };
  for(let attempt=1;attempt<=2;attempt++){
   const start={requests,dnsRequests,encoded,decoded,tunnel,dns:dns.length,artifacts:artifacts.length};let caught=null;
   try{
    this.assertPricingDispatch(project,pricingContext);
    const proxy=this.resolveProxy(route),addressPreference=paidQuote?undefined:reviewedAddressPreference(this.config,project,p,route);
    let current=input,checkedDestination=null;
    const resolver=paidQuote?reviewedPaidDns(this.config):null;
    if(paidQuote&&!resolver)fail('paid_dns_unavailable',503);
    const dnsContext=paidQuote?{paidResolve:host=>resolvePaidSource(host,{resolver,request:async(dnsInput,dnsDestination,limits)=>{
     requireWire();
     await this.dispatchable(project,id,session.id,new URL(`https://${host}/`),pricingContext);
     const timeout=deadline-Date.now();if(timeout<=0)fail('source_deadline',504);
     dnsRequests++;
     try{
      return await paidHttp(this.dnsHttp,dnsInput,dnsDestination,{...limits,timeout_ms:timeout},proxy);
     }catch(error){
      if(error.wire_dispatched===false||proxyRefusedBeforeConnect(error))dnsNotDispatched++;
      throw error;
     }
    }})}:proxy&&this.config.v2?.dns?.use_session_proxy?{
     proxy,deadline,remainingTunnel,addressPreference,...(retryEnabled?{retry_enabled:true,remainingEncoded}:{}),
     beforeDispatch:async host=>{
      if(retryEnabled){await this.pace(new URL(`https://${host}/`),p.limits,deadline);if(deadline<=Date.now())fail('source_deadline',504);}
      await this.dispatchable(project,id,session.id,new URL(`https://${host}/`),pricingContext);dnsRequests++;
     },
     observe:(bytes,{uncertain,dispatched=true,encoded_bytes=0})=>{
      if(!dispatched)dnsNotDispatched++;
      if(tunnel!==null)tunnel=Number.isSafeInteger(bytes)&&bytes>=0&&Number.isSafeInteger(tunnel+bytes)?tunnel+bytes:null;
      if(retryEnabled){if(!Number.isSafeInteger(encoded_bytes)||encoded_bytes<0)fail('source_dns_meter_unknown',502);encoded+=encoded_bytes;}
      if(uncertain)dnsUncertain=true;
      if(tunnel===null){dnsUncertain=true;fail('source_dns_meter_unknown',502);}
      if(tunnel>tunnelBudget)fail('cost_overrun',502);
      if(retryEnabled&&encoded>encodedBudget)fail('encoded_body_limit',502);
     }
    }:addressPreference?{addressPreference}:undefined;
    for(let hop=0;;hop++){
     stage='dns';
     const destination=checkedDestination??await this.destination(current.url,p,deadline,dnsContext);checkedDestination=null;
     if(destination.dns_diagnostics)dns.push(destination.dns_diagnostics);
     stage='request_policy';
     if(recipe?.request&&(recipe.request.method&&recipe.request.method!==current.method||recipe.request.path_pattern&&!new RegExp(recipe.request.path_pattern).test(destination.url.pathname)))fail('recipe_request_mismatch');
     const headers=this.headers(current,p,destination.url),cookies=publicUrl?null:await jar.getCookieString(destination.url.href);if(cookies)headers.cookie=cookies;
     await this.rejectControlCredentials(headers);
     stage='pacing';
     await this.pace(destination.url,p.limits,deadline);
     if(deadline<=Date.now())fail('source_deadline',504);
     stage='dispatch_admission';
     if(paidQuote)requireWire();
     else if(proxy&&remainingTunnel()<=0)fail('tunnel_byte_limit',502);
     if(retryEnabled&&requests>=retryPlan.request_limit)fail('retry_request_limit',429);
     if(retryEnabled&&remainingEncoded()<=0)fail('encoded_body_limit',502);
     await this.dispatchable(project,id,session.id,destination.url,pricingContext);
     const timeout=deadline-Date.now();if(timeout<=0)fail('source_deadline',504);
     requests++;nativeDispatches++;
     stage='transport';
     let response;
     try{
      const encodedLimit=publicUrl?Math.min(remainingEncoded(),remainingWire()):retryEnabled?
       Math.min(p.limits.max_encoded_bytes,remainingEncoded()):p.limits.max_encoded_bytes;
      const limits={...p.limits,timeout_ms:timeout,max_encoded_bytes:encodedLimit,
       ...(proxy&&!paidQuote?{max_tunnel_bytes:Math.min(p.limits.max_tunnel_bytes,remainingTunnel())}:{})};
      response=paidQuote?await paidHttp(this.http,{...current,headers},destination,limits,proxy):
       await this.http({...current,headers},destination,limits,{proxy});
     }catch(e){
      if(proxyRefusedBeforeConnect(e)||paidQuote&&e.wire_dispatched===false){requests--;nativeDispatches--;}
      else if(retryEnabled&&transientNativeTransport(e))requests--;
      encoded+=e.observed_encoded_bytes??0;
      if(!paidQuote&&tunnel!==null)tunnel=Number.isSafeInteger(e.observed_tunnel_bytes)&&e.observed_tunnel_bytes>=0&&Number.isSafeInteger(tunnel+e.observed_tunnel_bytes)?tunnel+e.observed_tunnel_bytes:null;
      throw e;
     }
     encoded+=response.encoded.length;
     if(publicUrl&&encoded>encodedBudget)fail('encoded_body_limit',502);
     if(!paidQuote&&tunnel!==null)tunnel=Number.isSafeInteger(response.tunnel_bytes)&&response.tunnel_bytes>=0&&Number.isSafeInteger(tunnel+response.tunnel_bytes)?tunnel+response.tunnel_bytes:null;
     stage='response_accounting';
     if(!publicUrl)for(const value of response.headers['set-cookie']??[])await jar.setCookie(value,destination.url.href,{ignoreError:true});
     await this.cooldown(destination.url,response);
     let body=null,decodingError=null;
     stage='content_decoding';
     try{
      const remainingDecoded=Math.max(0,decodedBudget-decoded);
      const maxDecodedBytes=publicUrl?Math.max(1,remainingDecoded):retryEnabled?
       Math.min(p.limits.max_decoded_bytes,remainingDecoded):p.limits.max_decoded_bytes;
      const output=current.method==='HEAD'||[204,205,304].includes(response.status)?Buffer.alloc(0):
       decodeNative(response.encoded,response.headers['content-encoding'],{...p.limits,max_decoded_bytes:maxDecodedBytes});
      if(publicUrl&&output.length>remainingDecoded)fail('decoded_body_limit',502);
      body=output;decoded+=body.length;
     }catch(e){decodingError=e instanceof GatewayError?e.code:'content_decoding_failed';}
     const artifact={id:randomUUID(),operation_id:id,kind:/attachment/i.test(response.headers['content-disposition']??'')?'download':'native_response',url:current.url,method:current.method,status:response.status,headers:response.headers,raw_headers:response.raw_headers??null,captured_at:new Date().toISOString(),content_encoding:response.headers['content-encoding']??'identity',encoded_body_base64:response.encoded.toString('base64'),decoded_body_base64:body?.toString('base64')??null,encoded_bytes:response.encoded.length,decoded_bytes:body?.length??null,encoded_sha256:sha(response.encoded),decoded_sha256:body?sha(body):null,tunnel_bytes:response.tunnel_bytes??null,provider_status:response.provider_status??null,decoding_error:decodingError,...(retryPlan?{attempt}:{})};
     this.rejectSecrets(artifact);
     stage='artifact_storage';
     await this.store.pool.query('INSERT INTO v2_artifacts(id,operation,project,body) VALUES($1,$2,$3,$4)',[artifact.id,id,project,this.sealer.seal(artifact,{compress:true})]);
     artifacts.push({id:artifact.id,kind:artifact.kind,status:artifact.status,encoded_bytes:artifact.encoded_bytes,decoded_bytes:artifact.decoded_bytes,content_encoding:artifact.content_encoding,...(retryPlan?{attempt}:{})});
     last={response,body,url:current.url};finalArtifact=artifact.id;
     stage='session_state';
     if(!publicUrl)await this.store.pool.query('UPDATE v2_sessions SET cookie_jar=$2 WHERE id=$1',[session.id,this.sealer.seal(jar.serializeSync())]);
     if(decodingError)fail(decodingError,502);
     if(retryEnabled&&(encoded>encodedBudget||tunnel===null||tunnel>tunnelBudget))fail(tunnel===null?'source_meter_unknown':tunnel>tunnelBudget?'cost_overrun':'encoded_body_limit',502);
     if([301,302,303,307,308].includes(response.status)&&response.headers.location){
      stage='redirect_policy';
      if(hop>=p.limits.max_redirects)fail('redirect_limit',502);
      if(retryEnabled&&requests>=retryPlan.request_limit)fail('retry_request_limit',429);
      const target=(publicUrl?checkedPublicRedirect(response.headers.location,destination.url,reviewedPublicUrlPolicy(this.config)):new URL(response.headers.location,destination.url)).href;
      stage='dns';const checked=await this.destination(target,p,deadline,dnsContext);stage='redirect_policy';
      if(checked.url.origin!==destination.url.origin&&!(p.id.startsWith(DISCOVERY_PREFIX)&&p.kind==='discovery'))fail('redirect_origin_rejected');
      const toGet=response.status===303&&current.method!=='HEAD'||[301,302].includes(response.status)&&current.method==='POST';
      checkedDestination=checked;
      current={...current,url:target,...(toGet?{method:'GET',body:null,headers:Object.fromEntries(Object.entries(current.headers).filter(([k])=>!['content-type','content-length'].includes(k.toLowerCase())))}:{})};
      continue;
     }
     break;
    }
   }catch(e){caught=e;error=e instanceof GatewayError?e.code:'operation_internal_error';if(proxyRefusedBeforeConnect(e))stage='proxy_connect';failure=safeFailure(e,stage,{dispatched:requests>start.requests});unknown=paidQuote?paidUnknown||(nativeDispatches>0||dnsRequests>dnsNotDispatched)&&error==='operation_internal_error':dnsUncertain||requests>0&&/unknown|incomplete|internal_error/.test(error);}
   const report={attempt,route_changed:attempt>1,stage:failure?.stage??'completed',error,failure,source_status:last?.response.status??null,provider_status:failure?.provider_status??last?.response.provider_status??null,physical_requests:requests-start.requests,dns_requests:dnsRequests-start.dnsRequests,encoded_bytes:encoded-start.encoded,decoded_bytes:decoded-start.decoded,tunnel_bytes:tunnel===null||start.tunnel===null?null:tunnel-start.tunnel,dns:dns.slice(start.dns),artifacts:artifacts.slice(start.artifacts).map(a=>a.id)};
   if(retryPlan)attempts.push(report);
   if(!retryPlan)break;
   const transient=caught?transientNativeTransport(caught):artifacts.length-start.artifacts===1&&transientNativeResponse(last?.response,last?.body,last?.url);
   if(!retryEnabled){stopReason=retryPlan.stop_reason;break;}
   if(!transient){stopReason=!error&&successfulNativeResponse(last?.response,last?.body,last?.url)?null:'retry_not_transient';break;}
   if(attempt===2){stopReason='retry_limit';break;}
   // Only the first target request may be repeated. Any earlier redirect,
   // source response, cookie mutation or uncertain meter ends the retry scope.
   if(unknown||dnsUncertain||requests-start.requests>1||artifacts.length-start.artifacts>1||caught&&(requests!==start.requests||artifacts.length!==start.artifacts)||jar.serializeSync().cookies.length){stopReason='retry_not_transient';break;}
   if(requests>=retryPlan.request_limit){stopReason='retry_request_limit';break;}
   if(tunnel===null||remainingTunnel()<=0||remainingEncoded()<=0){stopReason='retry_byte_limit';break;}
   if(Date.now()>=deadline){stopReason='retry_deadline';break;}
   try{
    route=await this.admitNativeRetry(project,id,session,p,route,retryPlan,pricingContext,deadline,{url:input.url,reason:caught?error:'source_http_transient',diagnostics:report});
    pricingContext.route=route;routeChanged=true;error=null;unknown=false;failure=null;last=null;finalArtifact=null;stage='route';
   }catch(e){stopReason=e instanceof GatewayError?e.code:'retry_admission_failed';break;}
  }
  let extracted={};
  if(!error&&recipe?.json_pointers){try{const value=JSON.parse(last.body.toString('utf8'));extracted=Object.fromEntries(Object.entries(recipe.json_pointers).map(([name,path])=>[name,pointer(value,path)]));}catch{error='recipe_json_invalid';}}
  const result={status:last?.response.status??null,final_url:last?.url??null,artifacts,extracted,physical_requests:requests,dns_requests:dnsRequests,encoded_bytes:encoded,decoded_bytes:decoded,tunnel_bytes:tunnel,...(paidQuote?{wire_bytes:wire,wire_bytes_lower_bound:wireLower}:{}),provider_status:failure?.provider_status??last?.response.provider_status??null,retry_after:last?.response.headers['retry-after']??null,diagnostics:{stage:failure?.stage??'completed',failure,dns,...(retryPlan?{attempts}:{})},...(retryPlan?{final_artifact_id:finalArtifact,retry:{requested:true,attempts:attempts.length,route_changed:routeChanged,effective_session_id:session.id,stop_reason:stopReason}}:{})};
  await this.store.tx(async c=>{
   const ledger=(await c.query('SELECT * FROM v2_ledger WHERE operation=$1 FOR UPDATE',[id])).rows[0];
   const held=unknown;const requestsAccounted=held?ledger.reserved_requests:requests,encodedAccounted=held?Number(ledger.reserved_encoded_bytes):encoded;
   // Paid tunnel reservations are never released from a local byte observation.
   const providerDispatched=nativeDispatches>0||dnsRequests>dnsNotDispatched;
   const accountedTunnel=providerDispatched?Math.max(Number(ledger.reserved_tunnel_bytes),tunnel??0):0;
   const partialTraffic=['encoded_body_limit','tunnel_byte_limit','source_body_incomplete'].includes(error);
   if(tunnel!==null&&tunnel>Number(ledger.reserved_tunnel_bytes))error='cost_overrun';
   const customerTraffic=finishResidentialTrafficCharge(ledger.customer_traffic,{dispatched:providerDispatched,unknown,partial:partialTraffic,bytes:tunnel,maxBillableBytes:Number(ledger.customer_traffic_reservation?.reserved_bytes??ledger.reserved_tunnel_bytes)});
   const state=unknown?'unknown':error?'failed':'completed';
   await c.query('UPDATE v2_operations SET state=$2,error=$3,result=$4,summary=$5,finished_at=clock_timestamp() WHERE id=$1',[id,state,error,this.sealer.seal(result,{compress:true}),operationSummary(result)]);
   await c.query('UPDATE v2_ledger SET state=$2,accounted_requests=$3,accounted_encoded_bytes=$4,observed_tunnel_bytes=$5,accounted_tunnel_bytes=$6,estimated_micro_usd=CASE WHEN $7 THEN estimated_micro_usd ELSE 0 END,customer_traffic=$8 WHERE operation=$1',[id,unknown?'unknown':providerDispatched?'unreconciled':'cancelled_before_dispatch',requestsAccounted,encodedAccounted,tunnel,accountedTunnel,providerDispatched,customerTraffic]);
   if(paidQuote){
    const invalidDestination=nativeDispatches===0&&(error==='destination_rejected'||stage==='request_policy');
    const fetchxFailure=['operation_internal_error','sensitive_provider_response','provider_account_rejected','proxy_configuration_invalid','proxy_configuration_unavailable','paid_dns_unavailable','proxy_response_invalid','pricing_attestation_unavailable'].includes(error);
    await this.controlPaidCredits.finish(c,{project,operation:id,dispatched:providerDispatched&&!invalidDestination,unknown,measuredBytes:wire,confirmedAtCap:wireLower>=wireCap,fetchxFailure});
   }else await this.controlCredits.finish(c,{project,operation:id,dispatched:providerDispatched,unknown});
   await c.query("INSERT INTO v2_ledger_events(operation,event,detail) VALUES($1,'finish',$2)",[id,{state,error,physical_requests:requests,dns_requests:dnsRequests,encoded_bytes:encoded,observed_tunnel_bytes:tunnel,...(retryPlan?{retry:result.retry,attempts}:{}),...(customerTraffic?{customer_traffic:customerTraffic}:{})}]);
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
  const pricing=(await this.store.pool.query("SELECT detail->'pricing_decision'->'pricing' AS pricing FROM v2_ledger_events WHERE operation=$1 AND event='reserve'",[row.id])).rows[0]?.pricing;
  let result=row.result?this.sealer.open(row.result):null;
  if(!result&&row.state==='unknown'){
   const retained=(await this.store.pool.query('SELECT body FROM v2_artifacts WHERE operation=$1 AND project=$2 ORDER BY created_at,id',[row.id,row.project])).rows.map(r=>this.sealer.open(r.body));
   if(retained.length){const last=retained.at(-1);result={status:last.status,final_url:last.url,artifacts:retained.map(a=>({id:a.id,kind:a.kind,status:a.status,encoded_bytes:a.encoded_bytes,decoded_bytes:a.decoded_bytes,content_encoding:a.content_encoding})),extracted:{},physical_requests:null,encoded_bytes:retained.reduce((n,a)=>n+a.encoded_bytes,0),decoded_bytes:retained.reduce((n,a)=>n+(a.decoded_bytes??0),0),tunnel_bytes:ledger.observed_tunnel_bytes===null?null:Number(ledger.observed_tunnel_bytes),provider_status:last.provider_status,retry_after:null,partial:true,additional_dispatches_unknown:true};}
   if(row.kind==='browser_probe')result={kind:'browser_network_probe',status:null,final_url:null,artifacts:result?.artifacts??[],physical_requests:null,blocked_requests:null,blocked_reasons:{},capture_complete:false,encoded_bytes:null,decoded_bytes:retained.filter(a=>a.kind==='browser_response').reduce((n,a)=>n+(a.decoded_bytes??0),0),dom_bytes:retained.filter(a=>a.kind==='rendered_dom').reduce((n,a)=>n+(a.decoded_bytes??0),0),tunnel_bytes:ledger.observed_tunnel_bytes===null?null:Number(ledger.observed_tunnel_bytes),provider_status:null,retry_after:null,partial:true,additional_dispatches_unknown:true};
   else if(this.sealer.open(row.input)?.retry===true){
    const admission=(await this.store.pool.query("SELECT detail FROM v2_ledger_events WHERE operation=$1 AND event='native_retry_admitted'",[row.id])).rows[0]?.detail;
    const incomplete={attempt:admission?2:1,route_changed:!!admission,stage:'unknown',error:'interrupted_unknown',failure:null,source_status:null,provider_status:null,physical_requests:null,dns_requests:null,encoded_bytes:null,decoded_bytes:null,tunnel_bytes:null,dns:[],artifacts:[]};
    result={...result,status:null,final_url:null,final_artifact_id:null,artifacts:retained.map(a=>({id:a.id,kind:a.kind,status:a.status,encoded_bytes:a.encoded_bytes,decoded_bytes:a.decoded_bytes,content_encoding:a.content_encoding,attempt:a.attempt??1})),physical_requests:null,dns_requests:null,partial:true,additional_dispatches_unknown:true,diagnostics:{stage:'unknown',failure:null,dns:[],attempts:[...(admission?.diagnostics?[admission.diagnostics]:[]),incomplete]},retry:{requested:true,attempts:admission?2:1,route_changed:!!admission,effective_session_id:row.session_id,stop_reason:'interrupted_unknown'}};
   }
  }
  const requestCredits=await this.controlCredits.operation(row.project,row.id);
  const paidCredits=this.controlCredits.managed(row.project)?await this.controlPaidCredits.operation(row.project,row.id):null;
  const traffic=ledger.customer_traffic;
  const billing=paidCredits?{paid_credits:paidCredits}:traffic?{customer_traffic:traffic,customer_traffic_reservation:ledger.customer_traffic_reservation}:{};
  return {id:row.id,key_id:row.key_id,idempotency_key:row.key,session_id:row.session_id,state:row.state,error:row.error??null,access_profile:{id:session.policy.id,version:session.policy.version},recipe:row.recipe?{id:row.recipe.id,version:row.recipe.version}:null,created_at:row.created_at,finished_at:row.finished_at??null,result,accounting:{provider:ledger.provider,reserved_tunnel_bytes:Number(ledger.reserved_tunnel_bytes),observed_tunnel_bytes:ledger.observed_tunnel_bytes===null?null:Number(ledger.observed_tunnel_bytes),estimated_micro_usd:ledger.estimated_micro_usd===null?null:Number(ledger.estimated_micro_usd),invoice_micro_usd:ledger.invoice_micro_usd===null?null:Number(ledger.invoice_micro_usd),basis:ledger.proxy_class==='direct'?'direct_no_provider_invoice':'conservative_bandwidth_reservation_not_invoice',...(requestCredits?{request_credits:requestCredits}:{}),...(pricing?{pricing:providerPricing(pricing,paidCredits)}:{}),...billing}};
 }
 async readOperation(project,id){const row=(await this.store.pool.query('SELECT * FROM v2_operations WHERE id=$1 AND project=$2',[uuid(id),project])).rows[0];if(!row)fail('operation_not_found',404);return this.operationView(row);}
 async lookup(project,k){const row=(await this.store.pool.query('SELECT * FROM v2_operations WHERE project=$1 AND key=$2',[project,key(k)])).rows[0];if(!row)fail('operation_not_found',404);return this.operationView(row);}
 async artifact(project,id){const row=(await this.store.pool.query('SELECT body FROM v2_artifacts WHERE id=$1 AND project=$2',[uuid(id),project])).rows[0];if(!row)fail('artifact_not_found',404);return this.sealer.open(row.body);}
 async recentOperations(project,query={}){
  if(!exact(query,['limit'])||query.limit!==undefined&&(typeof query.limit!=='string'||!/^\d{1,2}$/.test(query.limit)))fail('recent_operations_query_invalid');
  const limit=query.limit===undefined?25:Number(query.limit);if(limit<1||limit>50)fail('recent_operations_query_invalid');
  const rows=(await this.store.pool.query(`SELECT o.id,o.key_id,o.state,o.error,o.created_at,o.finished_at,o.summary,
   CASE WHEN o.summary IS NULL THEN o.result ELSE NULL END AS legacy_result,
   s.policy->>'id' AS profile_id,s.policy->'version' AS profile_version,s.route,l.provider,l.estimated_micro_usd,l.invoice_micro_usd,
   CASE WHEN o.finished_at IS NOT NULL THEN GREATEST(0,extract(epoch FROM o.finished_at-o.created_at)*1000) ELSE NULL END AS latency_ms
   FROM v2_operations o JOIN v2_sessions s ON s.id=o.session_id JOIN v2_ledger l ON l.operation=o.id
   WHERE o.project=$1 ORDER BY o.created_at DESC,o.id DESC LIMIT $2`,[project,limit])).rows;
  const operations=[];
  for(const row of rows){
   const route=this.sealer.open(row.route),requestCredits=await this.controlCredits.operation(project,row.id);
   const paidCredits=this.controlCredits.managed(project)?await this.controlPaidCredits.operation(project,row.id):null;
   operations.push({id:row.id,key_id:row.key_id,state:row.state,error:row.error,created_at:row.created_at,finished_at:row.finished_at,latency_ms:row.latency_ms===null?null:Number(row.latency_ms),routing:{class:route.class,country:route.country,provider:route.provider},access_profile:{id:row.profile_id,version:row.profile_version},...(row.summary??operationSummary(row.legacy_result?this.sealer.open(row.legacy_result):null)),provider:row.provider,estimated_micro_usd:row.estimated_micro_usd===null?null:Number(row.estimated_micro_usd),invoice_micro_usd:row.invoice_micro_usd===null?null:Number(row.invoice_micro_usd),...(requestCredits?{request_credits:requestCredits}:{}),...(paidCredits?{paid_credits:paidCredits}:{})});
  }
  return {operations,scope:'v2_project_recent',limit};
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
  const credits=await this.controlCredits.usage(project);
  const paidCredits=credits?await this.controlPaidCredits.usage(project):null;
  return {project,key_id:this.config.projects[project].keyId??project,entitlement:this.entitlement(project),outcomes:outcome,outcomes_by_key:byKey,by_key_and_state:usage,
   ...(credits?{request_credits:credits}:{}),...(paidCredits?{paid_credits:paidCredits}:{}),
   scope:'v2_project_lifetime',application_acceptance:'not_measured',invoice_basis:'unknown_until_authoritative_reconciliation'};
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
 app.post('/v2/operations',req=>v2.operation(req.project,req.body,{keyId:req.apiKeyId}));
 app.post('/v2/browser-probes',req=>v2.browserProbe(req.project,req.body));
 app.get('/v2/operations',req=>v2.recentOperations(req.project,req.query));
 app.get('/v2/operations/by-key/:key',req=>v2.lookup(req.project,req.params.key));
 app.get('/v2/operations/:id',req=>v2.readOperation(req.project,req.params.id));
 app.get('/v2/artifacts/:id',req=>v2.artifact(req.project,req.params.id));
}
