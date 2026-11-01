import {isIP} from 'node:net';
import {fail} from './policy.mjs';
import {browserProbePolicy} from './v2-browser-policy.mjs';

export const DISCOVERY_PREFIX='discovery:';
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const DEFAULT_LIMITS=Object.freeze({max_requests:8,max_encoded_bytes:1048576,max_decoded_bytes:4194304,max_session_encoded_bytes:8388608,max_redirects:0,max_expansion_ratio:100,timeout_ms:20000,min_interval_ms:1000,ttl_seconds:900});
const CEILINGS=Object.freeze({max_requests:100,max_encoded_bytes:2097152,max_decoded_bytes:8388608,max_session_encoded_bytes:67108864,max_redirects:3,max_expansion_ratio:100,timeout_ms:30000,min_interval_ms:60000,ttl_seconds:900});
const INTERNAL_SUFFIXES=['localhost','local','localdomain','internal','intranet','lan','home','corp','invalid','test','example','onion','alt','arpa'];

export function discoveryPolicy(config,project){
 const raw=config.projects[project]?.v2_discovery_policy;
 if(raw===undefined)return {enabled:false};
 if(!plain(raw)||Object.keys(raw).some(k=>!['enabled','max_profiles','max_origins','limits','browser_probe'].includes(k))||typeof raw.enabled!=='boolean')fail('discovery_policy_configuration',503);
 if(!raw.enabled)return {enabled:false};
 if(!Number.isSafeInteger(raw.max_profiles)||raw.max_profiles<1||raw.max_profiles>1000||!Number.isSafeInteger(raw.max_origins)||raw.max_origins<1||raw.max_origins>20||raw.limits!==undefined&&!plain(raw.limits))fail('discovery_policy_configuration',503);
 if(Object.keys(raw.limits??{}).some(k=>!Object.hasOwn(DEFAULT_LIMITS,k)))fail('discovery_policy_configuration',503);
 const limits={...DEFAULT_LIMITS,...raw.limits,max_input_bytes:1,max_tunnel_bytes:1};
 for(const [name,max]of Object.entries(CEILINGS))if(!Number.isSafeInteger(limits[name])||limits[name]<(name==='max_redirects'?0:name==='min_interval_ms'?250:1)||limits[name]>max)fail('discovery_policy_configuration',503);
 if(limits.max_requests<limits.max_redirects+1||limits.max_session_encoded_bytes<limits.max_encoded_bytes*(limits.max_redirects+1))fail('discovery_policy_configuration',503);
 const browser_probe=browserProbePolicy(raw.browser_probe);if(browser_probe&&(browser_probe.max_requests>limits.max_requests||browser_probe.max_network_bytes>limits.max_session_encoded_bytes||browser_probe.max_decoded_bytes>limits.max_decoded_bytes))fail('discovery_policy_configuration',503);
 return {enabled:true,max_profiles:raw.max_profiles,max_origins:raw.max_origins,limits,...(browser_probe?{browser_probe}:{})};
}

// Provisioning is syntax-only and performs no DNS/source requests. Public DNS
// checks on every dispatch remain the authoritative network security boundary.
export function discoveryOrigins(raw){
 if(!Array.isArray(raw)||raw.length<1||raw.length>20)fail('discovery_origins_invalid');
 const origins=raw.map(value=>{
  if(typeof value!=='string'||value.length>300||/[\s\u0000-\u001f\u007f\\]/u.test(value))fail('discovery_origin_rejected');
  let u;try{u=new URL(value);}catch{fail('discovery_origin_rejected');}
  const host=u.hostname,unbracketed=host.replace(/^\[|\]$/g,'');
  if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||u.search||u.hash||isIP(unbracketed)||host.length>253||!host.includes('.')||host.endsWith('.')||!host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))||INTERNAL_SUFFIXES.some(suffix=>host===suffix||host.endsWith('.'+suffix))||value!==u.origin&&value!==u.origin+':443')fail('discovery_origin_rejected');
  return u.origin;
 });
 return [...new Set(origins)].sort();
}

export function discoveryProfileBody(id,origins,policy){
 return {id,version:1,kind:'discovery',origins,paths:['^/'],method_paths:{GET:['^/'],HEAD:['^/']},methods:['GET','HEAD'],headers:['accept','accept-language','user-agent'],credential_headers:[],proxy_classes:['direct'],countries:[],max_paid_cost_micro_usd:0,limits:{...policy.limits},...(policy.browser_probe?{browser_probe:policy.browser_probe}:{})};
}

export function assertDiscoveryCeiling(profile,policy){
 if(!policy.enabled)fail('access_profile_forbidden',403);
 if(profile.origins.length>policy.max_origins||Object.entries(policy.limits).some(([name,value])=>name==='min_interval_ms'?profile.limits[name]<value:profile.limits[name]>value))fail('discovery_policy_changed',409);
 if(profile.browser_probe?.enabled&&(!policy.browser_probe||Object.entries(profile.browser_probe).some(([name,value])=>name!=='enabled'&&value>policy.browser_probe[name])))fail('discovery_policy_changed',409);
}
