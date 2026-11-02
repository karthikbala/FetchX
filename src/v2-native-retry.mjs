import {isIP} from 'node:net';
import {CookieJar} from 'tough-cookie';
import {publicIP} from './policy.mjs';
import {proxyRefusedBeforeConnect} from './v2-diagnostics.mjs';
import {hasHtmlChallenge} from './source-challenge.mjs';
import {classifyProtection} from './protection.mjs';
import {sha} from './crypto.mjs';

// Private operator metadata binds a configured endpoint (including a local
// forwarder) to its verified assigned dedicated IPv4. Never expose this value.
function identity(member){
 const ip=member?.dedicated_ip;
 return typeof ip==='string'&&isIP(ip)===4&&publicIP(ip)&&ip.split('.').map(Number).join('.')===ip?ip:null;
}
function endpoint(member){try{const u=new URL(member.url);return u.protocol==='http:'&&!u.search&&!u.hash&&u.pathname==='/'?`${u.hostname.toLowerCase()}:${u.port||80}`:null;}catch{return null;}}
export function nativeRetryIdentityBinding(config,route){return sha(JSON.stringify((config.proxies??[]).filter(p=>p.country===route.country).map(p=>({id:p.id,url:p.url,dedicated_ip:p.dedicated_ip??null,provider:p.provider,pool_id:p.pool_id})).sort((a,b)=>a.id.localeCompare(b.id))));}
export function distinctNativeRetryRoute(config,route){
 if(route.class!=='datacenter'||route.provider!=='configured_datacenter')return null;
 const member=config.proxies?.find(p=>p.id===route.proxy_id&&p.country===route.country),ip=identity(member),address=endpoint(member);
 if(!ip||!address||member.provider!=='oxylabs'||typeof member.pool_id!=='string'||!member.pool_id)return null;
 const index=config.proxies.indexOf(member),ordered=[...config.proxies.slice(index+1),...config.proxies.slice(0,index)];
 const candidate=ordered.find(p=>p.id!==member.id&&p.country===route.country&&p.provider==='oxylabs'&&p.pool_id===member.pool_id&&identity(p)&&identity(p)!==ip&&endpoint(p)&&endpoint(p)!==address);
 return candidate?{...route,proxy_id:candidate.id}:null;
}
export function pristineNativeRetry(session,input,recipe,profile){
 if(recipe||!['GET','HEAD'].includes(input.method)||input.body!==null&&input.body!==undefined||Number(session.requests)!==0||Number(session.encoded_bytes)!==0)return false;
 try{if(CookieJar.deserializeSync(session.cookie_jar).serializeSync().cookies.length)return false;}catch{return false;}
 const credentials=new Set((profile.credential_headers??[]).map(k=>k.toLowerCase()));
 if(Object.keys(input.headers??{}).some(k=>credentials.has(k.toLowerCase())||/^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-|x-csrf|x-xsrf)/i.test(k)))return false;
 try{const u=new URL(input.url);if(u.username||u.password||/(?:^|\/)(?:login|logout|sign[io]n|signout|auth|oauth|token|session|password|checkout|payment|delete|update|create|submit|confirm|approve|activate)(?:\/|$)/i.test(u.pathname)||[...u.searchParams.keys()].some(k=>/(?:auth|token|session|password|secret|credential|signature|api.?key|csrf|xsrf|nonce)|^(?:key|state)$/i.test(k)))return false;}catch{return false;}
 return true;
}
export function transientProxyRejection(error){
 return error?.code==='proxy_connect_rejected'&&[502,503,504].includes(error.provider_status)&&error.proxy_connected===true&&error.proxy_request_dispatched===true&&error.source_request_dispatched===false&&!error.proxy_retry_after&&!error.proxy_stateful_headers&&!['ERR_ACCESS_DENIED','ERR_CACHE_ACCESS_DENIED','ERR_SECURE_CONNECT_FAIL'].includes(error.provider_reason);
}
export function transientNativeTransport(error){return proxyRefusedBeforeConnect(error)||transientProxyRejection(error);}
export function successfulNativeResponse(response,body,url){
 if(!response||!(response.status>=200&&response.status<300))return false;
 const headers=Object.fromEntries(Object.entries(response.headers??{}).map(([k,v])=>[k.toLowerCase(),v]));
 return !hasHtmlChallenge({headers,body})&&classifyProtection({status:response.status,headers,body},{url,main_document:true}).kind!=='challenge';
}
export function transientNativeResponse(response,body,url){
 if(!response||!body||![502,503,504].includes(response.status))return false;
 const headers=Object.fromEntries(Object.entries(response.headers??{}).map(([k,v])=>[k.toLowerCase(),v]));
 if(['set-cookie','retry-after','location','www-authenticate','proxy-authenticate','authentication-info'].some(k=>Object.hasOwn(headers,k)))return false;
 if(hasHtmlChallenge({headers,body})||classifyProtection({status:response.status,headers,body},{url,main_document:true}).kind==='challenge')return false;
 // Treat security widgets, denial and authentication text as a stop even when
 // an upstream mislabels the response with a transient HTTP status.
 return !/(?:captcha|challenge-platform|access denied|verify (?:that )?you are|authentication required|login required)/i.test(body.subarray(0,65536).toString('utf8'));
}
