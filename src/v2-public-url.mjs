import {isIP} from 'node:net';
import ipaddr from 'ipaddr.js';
import {fail,publicIP} from './policy.mjs';

export const PUBLIC_URL_ID='public-url-http';
export const RESERVED_PUBLIC_URL_IDS=Object.freeze([PUBLIC_URL_ID,'public-url-residential']);
export const PUBLIC_URL_KIND='public_url_http';
export const PUBLIC_URL_REF=Object.freeze({id:PUBLIC_URL_ID,version:1});
export const PUBLIC_URL_MAX_BODY_BYTES=20_000_000;
export const PUBLIC_URL_TRANSFER_LIMITS=Object.freeze({
 min_transfer_mb:0.25,max_transfer_mb:20,step_mb:0.25,
 max_encoded_bytes:PUBLIC_URL_MAX_BODY_BYTES,max_decoded_bytes:PUBLIC_URL_MAX_BODY_BYTES,
 body_limit_basis:'aggregate_authorized_transfer_ceiling'
});
export const PUBLIC_URL_ROUTES=Object.freeze([
 Object.freeze({class:'datacenter',country:'US',provider:'oxylabs'}),
 Object.freeze({class:'residential',country:'US',provider:'evomi'})
]);
const LABEL=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UNROUTABLE_NAMES=['localhost','local','localdomain','internal','intranet','lan','home','corp','invalid','test','example','onion','alt','arpa'];
const BAD_URL_BYTES=/[\s\u0000-\u001f\u007f\\]/u;
const GLOBAL_IPV6=ipaddr.parse('2000::');
const DOCUMENTATION_IPV6=ipaddr.parse('3fff::');
const matchesHost=(host,suffix)=>host===suffix||host.endsWith('.'+suffix);
const dnsName=host=>typeof host==='string'&&host.length<=253&&host.includes('.')&&!isIP(host)&&host.split('.').every(label=>LABEL.test(label));

export function isPublicUrlProfile(profile){
 return profile?.id===PUBLIC_URL_ID&&profile.version===PUBLIC_URL_REF.version&&profile.kind===PUBLIC_URL_KIND;
}

export function publicUrlProfile(){
 return {...PUBLIC_URL_REF,kind:PUBLIC_URL_KIND,origins:[],paths:['^/'],methods:['GET','HEAD'],
  headers:['accept','accept-language','user-agent'],credential_headers:[],proxy_classes:['datacenter','residential'],countries:['US'],
  limits:{max_requests:30,max_encoded_bytes:PUBLIC_URL_MAX_BODY_BYTES,max_decoded_bytes:PUBLIC_URL_MAX_BODY_BYTES,max_session_encoded_bytes:60_000_000,
   max_input_bytes:1,max_tunnel_bytes:PUBLIC_URL_MAX_BODY_BYTES,max_redirects:2,max_expansion_ratio:100,
   timeout_ms:15000,min_interval_ms:250,ttl_seconds:900}};
}

export function reviewedPublicUrlPolicy(config){
 const control=config.controlPlane,policy=control?.paidCreditPolicy?.publicUrl;
 if(control?.enabled!==true||policy?.reviewed!==true||!Number.isSafeInteger(policy.maxDailyOperations)||
  policy.maxDailyOperations<1||policy.maxDailyOperations>10_000)return null;
 const blocked=policy.blockedHosts??[],origins=control.origins??[];
 if(!Array.isArray(blocked)||blocked.length>100||blocked.some(host=>!dnsName(host))||!Array.isArray(origins))return null;
 const blockedHosts=new Set(['fetchx.ai',...blocked]);
 for(const origin of origins){
  try{blockedHosts.add(new URL(origin).hostname.toLowerCase().replace(/\.$/,''));}catch{return null;}
 }
 return {maxDailyOperations:policy.maxDailyOperations,blockedHosts};
}

export function checkedPublicSourceUrl(raw,policy){
 if(typeof raw!=='string'||raw.length>4096||BAD_URL_BYTES.test(raw)||raw.includes('#'))fail('destination_rejected');
 const authority=raw.match(/^https:\/\/([a-z0-9.-]+)(?::443)?(?=[/?]|$)/i);
 if(!authority)fail('destination_rejected');
 let url,decoded;
 try{url=new URL(raw);decoded=decodeURIComponent(raw);}catch{fail('destination_rejected');}
 const host=url.hostname;
 if(authority[1].toLowerCase()!==host||!dnsName(host)||UNROUTABLE_NAMES.some(suffix=>matchesHost(host,suffix))||
  [...policy.blockedHosts].some(suffix=>matchesHost(host,suffix)))fail('destination_rejected');
 const path=raw.slice(authority[0].length).split('?')[0];
 if((path||'/')!==url.pathname)fail('destination_rejected');
 if(/\bfx[ks]_[A-Za-z0-9_-]{20,}/.test(decoded))fail('credential_scope_rejected');
 return url;
}

export function checkedPublicRedirect(location,source,policy){
 if(typeof location!=='string'||location.length>4096||BAD_URL_BYTES.test(location)||location.includes('#'))fail('destination_rejected');
 let target;try{target=new URL(location,source);}catch{fail('destination_rejected');}
 if(target.origin!==source.origin)fail('redirect_origin_rejected');
 return checkedPublicSourceUrl(target.href,policy);
}

export function isPublicAddress(value){
 const address=value?.address,family=isIP(address??'');
 if(!family||value.family!==family||!publicIP(address)||address==='168.63.129.16')return false;
 if(family===4)return true;
 const ip=ipaddr.parse(address);
 return ip.match(GLOBAL_IPV6,3)&&!ip.match(DOCUMENTATION_IPV6,20);
}

export function checkedPublicAddresses(answers){
 if(!answers.length||answers.some(answer=>!isPublicAddress(answer)))fail('destination_rejected');
 return answers;
}
