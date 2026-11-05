import {sha} from './crypto.mjs';
import {ID} from './policy.mjs';
import {residentialTrafficReservation} from './customer-traffic.mjs';

const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const identifier=v=>typeof v==='string'&&ID.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const MAX_VALIDITY_MS=31*24*60*60*1000;
const ordered=v=>Array.isArray(v)?v.map(ordered):plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
const ref=v=>exact(v,['id','version'])&&identifier(v.id)&&Number.isSafeInteger(v.version)&&v.version>0;
const instant=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v)&&Number.isFinite(Date.parse(v))&&[new Date(Date.parse(v)).toISOString(),new Date(Date.parse(v)).toISOString().replace('.000Z','Z')].includes(v);
const fields=['schema_version','id','reviewed','provider','pool_id','country','project','access_profiles','transport','cost_scope','fixed_subscription_allocation_micro_usd','valid_from','expires_at','provenance','pool_fingerprint_sha256'];
function validGrant(g){
 return exact(g,fields)&&(g.schema_version===1&&g.transport==='http'||g.schema_version===2&&['http','browser'].includes(g.transport))&&identifier(g.id)&&g.reviewed===true&&g.provider==='oxylabs'&&identifier(g.pool_id)&&typeof g.country==='string'&&/^[A-Z]{2}$/.test(g.country)&&identifier(g.project)&&
  Array.isArray(g.access_profiles)&&g.access_profiles.length>0&&g.access_profiles.length<=100&&g.access_profiles.every(ref)&&new Set(g.access_profiles.map(r=>`${r.id}@${r.version}`)).size===g.access_profiles.length&&
  g.cost_scope==='incremental_traffic_only'&&g.fixed_subscription_allocation_micro_usd===null&&instant(g.valid_from)&&instant(g.expires_at)&&Date.parse(g.expires_at)>Date.parse(g.valid_from)&&
  exact(g.provenance,['id','sha256','reviewed_at'])&&identifier(g.provenance.id)&&digest(g.provenance.sha256)&&instant(g.provenance.reviewed_at)&&Date.parse(g.provenance.reviewed_at)<=Date.parse(g.valid_from)&&Date.parse(g.valid_from)-Date.parse(g.provenance.reviewed_at)<=MAX_VALIDITY_MS&&Date.parse(g.expires_at)-Date.parse(g.valid_from)<=MAX_VALIDITY_MS&&digest(g.pool_fingerprint_sha256);
}

// Operator helper only: never put this digest, its input, or provenance in an
// API response. The exact URL includes credentials, so credential rotation also
// requires a newly reviewed binding. Every eligible country member is included.
export function datacenterPoolFingerprint(proxies,country){
 if(!Array.isArray(proxies)||typeof country!=='string'||!/^[A-Z]{2}$/.test(country))return null;
 const pool=proxies.filter(p=>p?.country===country);
 if(!pool.length||pool.some(p=>!identifier(p.id)||!identifier(p.provider)||!identifier(p.pool_id)||typeof p.url!=='string')||new Set(pool.map(p=>p.id)).size!==pool.length)return null;
 for(const p of pool){try{const u=new URL(p.url);if(u.protocol!=='http:'||u.pathname!=='/'||u.search||u.hash)return null;}catch{return null;}}
 const members=pool.map(({id,country,provider,pool_id,url})=>({id,country,provider,pool_id,url})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 return sha(JSON.stringify(members));
}

const unavailable=reason=>({estimated_micro_usd:null,pricing:{status:'unavailable',reason},dispatch_deadline_ms:null,binding:null});

const poolPolicyFields=['schema_version','id','reviewed','provider','pool_id','countries','cost_scope','fixed_subscription_allocation_micro_usd','provenance','pool_fingerprint_sha256'];
const countries=v=>Array.isArray(v)&&v.length>0&&v.length<=250&&v.every(c=>typeof c==='string'&&/^[A-Z]{2}$/.test(c))&&new Set(v).size===v.length;
function validPoolPolicy(p){
 const scope=p?.schema_version===1?exact(p,poolPolicyFields):p?.schema_version===2&&exact(p,[...poolPolicyFields,'transports'])&&Array.isArray(p.transports)&&p.transports.length>0&&new Set(p.transports).size===p.transports.length&&p.transports.every(t=>['http','browser'].includes(t));
 return scope&&identifier(p.id)&&p.reviewed===true&&p.provider==='oxylabs'&&identifier(p.pool_id)&&countries(p.countries)&&p.cost_scope==='incremental_traffic_only'&&p.fixed_subscription_allocation_micro_usd===null&&
  exact(p.provenance,['id','sha256','reviewed_at'])&&identifier(p.provenance.id)&&digest(p.provenance.sha256)&&instant(p.provenance.reviewed_at)&&digest(p.pool_fingerprint_sha256);
}

// Private operator helper. Bind every configured member across every assigned
// country together, so a change in an unselected member also invalidates pricing.
// Unlike the legacy single-country helper, this is a separate policy contract.
export function fixedFeePoolFingerprint(proxies,assignedCountries){
 if(!Array.isArray(proxies)||!countries(assignedCountries))return null;
 if(proxies.some(p=>!identifier(p?.id)||typeof p.country!=='string'||!/^[A-Z]{2}$/.test(p.country))||new Set(proxies.map(p=>p.id)).size!==proxies.length)return null;
 const members=[];
 for(const country of [...assignedCountries].sort()){
  if(!datacenterPoolFingerprint(proxies,country))return null;
  members.push(...proxies.filter(p=>p?.country===country).map(({id,country,provider,pool_id,url})=>({id,country,provider,pool_id,url})));
 }
 if(new Set(members.map(p=>p.id)).size!==members.length)return null;
 members.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 return sha(JSON.stringify(members));
}

function estimateFixedFeePool({config,route,transport,now_ms,duration_ms}){
 const p=config.datacenterFixedFeePool;
 if(!validPoolPolicy(p)||!Number.isSafeInteger(now_ms)||!Number.isSafeInteger(duration_ms)||duration_ms<0||!Number.isSafeInteger(now_ms+duration_ms)||Date.parse(p.provenance.reviewed_at)>now_ms)return unavailable('fixed_fee_pool_policy_invalid');
 const transports=p.schema_version===1?['http']:p.transports;
 if(!transports.includes(transport)||!p.countries.includes(route.country))return unavailable('fixed_fee_pool_scope_mismatch');
 const fingerprint=fixedFeePoolFingerprint(config.proxies,p.countries),members=Array.isArray(config.proxies)?config.proxies.filter(m=>p.countries.includes(m?.country)):[];
 if(!fingerprint||fingerprint!==p.pool_fingerprint_sha256||members.some(m=>m.provider!==p.provider||m.pool_id!==p.pool_id)||config.proxies.some(m=>m?.pool_id===p.pool_id&&!p.countries.includes(m.country))||route.proxy_id!==undefined&&!members.some(m=>m.id===route.proxy_id&&m.country===route.country))return unavailable('pool_binding_mismatch');
 return {estimated_micro_usd:0,pricing:{status:'valid',basis:'operator_fixed_fee_pool',provider:p.provider,cost_scope:p.cost_scope,fixed_subscription_allocation_micro_usd:null,invoice_micro_usd:null,customer_traffic_charge_micro_usd:0,policy_id:p.id},dispatch_deadline_ms:now_ms+duration_ms,binding:{pool_fingerprint_sha256:fingerprint,policy_id:p.id,policy_sha256:sha(JSON.stringify(ordered(p))),provenance:{...p.provenance}}};
}

// Paid public HTTP has an isolated policy. The legacy proxy inventory stays
// untouched, and its full US candidate set must match the reviewed binding.
export function estimatePaidPublicDatacenter({config,route,transport='http',now_ms=Date.now(),duration_ms=0}){
 if(transport!=='http'||route.class!=='datacenter'||route.provider!=='configured_datacenter'||route.country!=='US')
  return unavailable('fixed_fee_pool_scope_mismatch');
 const reviewed=config.controlPlane?.paidCreditPolicy?.datacenterPool;
 if(!exact(reviewed,['proxyIds','pricing'])||!Array.isArray(reviewed.proxyIds)||!reviewed.proxyIds.length||reviewed.proxyIds.length>100||
  !reviewed.proxyIds.every(identifier)||new Set(reviewed.proxyIds).size!==reviewed.proxyIds.length||
  !validPoolPolicy(reviewed.pricing)||reviewed.pricing.countries.length!==1||reviewed.pricing.countries[0]!=='US')
  return unavailable('fixed_fee_pool_policy_invalid');
 const {proxyIds,pricing}=reviewed,approved=new Set(proxyIds);
 const members=Array.isArray(config.proxies)?config.proxies.filter(proxy=>proxy&&(
  proxy.country==='US'||approved.has(proxy.id)||proxy.pool_id===pricing.pool_id)):[];
 if(members.length!==approved.size||new Set(members.map(proxy=>proxy.id)).size!==approved.size||
  members.some(proxy=>proxy.country!=='US'||!approved.has(proxy.id)||
   proxy.provider!==undefined&&proxy.provider!==pricing.provider||proxy.pool_id!==undefined&&proxy.pool_id!==pricing.pool_id))
  return unavailable('pool_binding_mismatch');
 const proxies=members.map(proxy=>({...proxy,provider:pricing.provider,pool_id:pricing.pool_id}));
 return estimateFixedFeePool({config:{proxies,datacenterFixedFeePool:pricing},route,transport,now_ms,duration_ms});
}

// Pure, shared quotation/admission estimator. This policy only attests included
// incremental traffic; it does not estimate a subscription or reconcile invoices.
export function estimateRoutePricing({config,project,profile,route,transport='http',reserved_tunnel_bytes,now_ms=Date.now(),duration_ms=0}){
 if(route.class==='direct')return {estimated_micro_usd:0,pricing:null,dispatch_deadline_ms:null,binding:null};
 if(route.class==='residential'){
  const rate=config.residential?.providers?.[route.provider]?.microUsdPerGB;
  return {estimated_micro_usd:Number.isSafeInteger(rate)&&rate>=0?Math.ceil(reserved_tunnel_bytes/1e9*rate):null,customer_traffic_reservation:residentialTrafficReservation(reserved_tunnel_bytes),pricing:null,dispatch_deadline_ms:null,binding:null};
 }
 if(route.class!=='datacenter'||route.provider!=='configured_datacenter')return unavailable('route_unpriced');
 // Presence is intentional opt-in. An invalid/revoked replacement cannot fall
 // through to a narrower legacy grant and silently retain a zero charge.
 if(Object.hasOwn(config,'datacenterFixedFeePool'))return estimateFixedFeePool({config,route,transport,now_ms,duration_ms});
 const grants=config.v2?.datacenterPricingAttestations;
 if(!Array.isArray(grants)||!grants.length)return unavailable('attestation_missing');
 if(grants.length>100||grants.some(g=>!validGrant(g))||new Set(grants.map(g=>g.id)).size!==grants.length)return unavailable('attestation_invalid');
 if(!Number.isSafeInteger(now_ms)||!Number.isSafeInteger(duration_ms)||duration_ms<0)return unavailable('attestation_invalid');
 const scoped=grants.filter(g=>g.project===project&&g.country===route.country&&g.transport===transport&&g.access_profiles.some(r=>r.id===profile.id&&r.version===profile.version));
 if(scoped.length!==1)return unavailable(scoped.length?'attestation_ambiguous':'attestation_scope_mismatch');
 const g=scoped[0],fingerprint=datacenterPoolFingerprint(config.proxies,route.country),pool=Array.isArray(config.proxies)?config.proxies.filter(p=>p?.country===route.country):[];
 if(!fingerprint||fingerprint!==g.pool_fingerprint_sha256||pool.some(p=>p.provider!==g.provider||p.pool_id!==g.pool_id)||route.proxy_id!==undefined&&!pool.some(p=>p.id===route.proxy_id))return unavailable('pool_binding_mismatch');
 const start=Date.parse(g.valid_from),end=Date.parse(g.expires_at);
 if(now_ms<start)return unavailable('attestation_not_yet_valid');
 if(now_ms>=end)return unavailable('attestation_expired');
 const pricing={status:'valid',basis:'operator_attested_prepaid_included_traffic',provider:g.provider,cost_scope:g.cost_scope,fixed_subscription_allocation_micro_usd:null,invoice_micro_usd:null,attestation_id:g.id,valid_from:g.valid_from,expires_at:g.expires_at};
 // No shortened quote is presented as the profile's full bounded reservation.
 if(now_ms+duration_ms>=end)return {...unavailable('insufficient_validity'),pricing:{...pricing,status:'unavailable',reason:'insufficient_validity'}};
 return {estimated_micro_usd:0,pricing:{...pricing,customer_traffic_charge_micro_usd:0},dispatch_deadline_ms:now_ms+duration_ms,binding:{pool_fingerprint_sha256:fingerprint,attestation_id:g.id,attestation_sha256:sha(JSON.stringify(ordered(g))),provenance:{...g.provenance}}};
}
