import {ID,fail} from './policy.mjs';
import {datacenterPoolFingerprint} from './v2-pricing.mjs';

const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string'&&ID.test(v);
const ref=v=>exact(v,['id','version'])&&id(v.id)&&Number.isSafeInteger(v.version)&&v.version>0;
const fields=['schema_version','id','reviewed','project','access_profiles','country','provider','pool_id','pool_fingerprint_sha256','transport','preference'];
function valid(p){
 return exact(p,fields)&&p.schema_version===1&&id(p.id)&&p.reviewed===true&&id(p.project)&&Array.isArray(p.access_profiles)&&p.access_profiles.length>0&&p.access_profiles.length<=100&&p.access_profiles.every(ref)&&new Set(p.access_profiles.map(r=>`${r.id}@${r.version}`)).size===p.access_profiles.length&&typeof p.country==='string'&&/^[A-Z]{2}$/.test(p.country)&&p.provider==='oxylabs'&&id(p.pool_id)&&typeof p.pool_fingerprint_sha256==='string'&&/^[a-f0-9]{64}$/.test(p.pool_fingerprint_sha256)&&p.transport==='http'&&p.preference==='ipv4';
}

// Operator configuration only. This selects one already validated address; it
// grants no route, pricing entitlement, retry, DNS endpoint or source authority.
export function reviewedAddressPreference(config,project,profile,route){
 const policies=config.v2?.datacenterAddressPreferences;
 if(policies===undefined)return undefined;
 if(!Array.isArray(policies)||policies.length>100||policies.some(p=>!valid(p))||new Set(policies.map(p=>p.id)).size!==policies.length)fail('address_preference_configuration',503);
 if(route.class!=='datacenter'||route.provider!=='configured_datacenter')return undefined;
 const member=config.proxies?.find(p=>p.id===route.proxy_id&&p.country===route.country);
 if(member?.provider!=='oxylabs')return undefined;
 const scoped=policies.filter(p=>p.project===project&&p.country===route.country&&p.pool_id===member.pool_id&&p.access_profiles.some(r=>r.id===profile.id&&r.version===profile.version));
 if(!scoped.length)return undefined;
 if(scoped.length!==1)fail('address_preference_ambiguous',503);
 if(profile.kind==='discovery'||!profile.proxy_classes?.includes('datacenter')||!profile.countries?.includes(route.country)||!config.projects?.[project]?.v2_access_profiles?.includes(`${profile.id}@${profile.version}`))fail('address_preference_profile_forbidden',503);
 const policy=scoped[0],pool=config.proxies.filter(p=>p.country===route.country);
 if(datacenterPoolFingerprint(config.proxies,route.country)!==policy.pool_fingerprint_sha256||pool.some(p=>p.provider!=='oxylabs'||p.pool_id!==policy.pool_id))fail('address_preference_pool_changed',503);
 return 'ipv4';
}
