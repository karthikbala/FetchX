import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import ipaddr from 'ipaddr.js';
import {recipeInput} from './browser-recipes.mjs';
export class GatewayError extends Error {
  constructor(code, status=400){super(code);this.code=code;this.status=status;}
}
export const fail=(code,status)=>{throw new GatewayError(code,status);};
export const ID=/^[A-Za-z0-9_.:-]{1,160}$/;
// Missing receipts retain their reservation but do not suspend the paid account.
export const METERED_BLOCKING_ERRORS=Object.freeze(['cost_overrun','provider_account_rejected','sensitive_provider_response']);
export function publicIP(ip){
  try{return ipaddr.parse(ip).range()==='unicast';}catch{return false;}
}
export async function checkedURL(raw, profile, resolve=lookup){
  // WHATWG URL silently rewrites backslashes and strips whitespace/control bytes;
  // curl and provider-side URL parsers can then reach a different host/path.
  if(typeof raw!=='string'||/[\s\u0000-\u001f\u007f\\]/u.test(raw))fail('destination_rejected');
  let u;try{u=new URL(raw);}catch{fail('destination_rejected');}
  if(u.protocol!=='https:'||u.port&&u.port!=='443'||u.username||u.password||u.hash
      ||isIP(u.hostname)||!profile.hosts.includes(u.hostname)){
    const e=new GatewayError('destination_rejected');e.details={host:u.hostname};throw e;
  }
  const rawPath=raw.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1];
  if(rawPath===undefined||(rawPath||'/')!==u.pathname)fail('destination_rejected');
  if(profile.paths&&!profile.paths.some(p=>new RegExp(p).test(u.pathname)))fail('endpoint_rejected');
  const addresses=await resolve(u.hostname,{all:true,verbatim:true});
  if(!addresses.length||addresses.some(a=>!publicIP(a.address)))fail('destination_rejected');
  return u;
}
export function checkedHeaders(input,profile,u,method){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('headers_rejected');
  const out={};let bytes=0;
  for(const [key,value] of Object.entries(input)){
    const name=key.toLowerCase();
    if(typeof value!=='string'||/[\u0000-\u0008\u000a-\u001f\u007f\u0100-\uffff]/.test(value)||!(/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)))fail('headers_rejected');
    bytes+=Buffer.byteLength(name)+Buffer.byteLength(value);
    if(bytes>32768)fail('headers_rejected');
    if(['host','connection','content-length','proxy-authorization','proxy-server','transfer-encoding','upgrade'].includes(name)||name.startsWith('sd-')||name.startsWith('x-gateway'))fail('headers_rejected');
    if(name==='authorization'&&!profile.guestAuth?.some(r=>r.host===u.hostname&&r.method===method&&new RegExp(r.path).test(u.pathname)&&(r.query?new RegExp(r.query).test(u.search):!u.search)))fail('credential_scope_rejected');
    if(!profile.headers.includes(name)&&(!profile.forwardBrowserHeaders||/^(?:x-api-key|api-key|x-auth-)/i.test(name))){const e=new GatewayError('headers_rejected');e.details={host:u.hostname,header:name.slice(0,80)};throw e;}
    out[name]=value;
  }
  return out;
}
export function requestInput(input,profile){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['idempotency_key','url','method','headers','body_base64','resource_type','main_document','zipcode','browser'].includes(k)))fail('request_invalid');
  if(typeof input.idempotency_key!=='string'||!ID.test(input.idempotency_key)||typeof input.url!=='string'||input.url.length>12000)fail('request_invalid');
  const method=input.method===undefined?'GET':input.method;if(typeof method!=='string'||!profile.methods.includes(method))fail('method_rejected');
  if(input.headers!==undefined&&(!input.headers||typeof input.headers!=='object'||Array.isArray(input.headers)))fail('headers_rejected');
  if(input.main_document!==undefined&&typeof input.main_document!=='boolean')fail('request_invalid');
  if(input.resource_type!==undefined&&(typeof input.resource_type!=='string'||!/^[a-z_]{1,40}$/.test(input.resource_type)))fail('request_invalid');
  if(input.body_base64!==undefined&&input.body_base64!==null&&(typeof input.body_base64!=='string'||input.body_base64.length>4*Math.ceil(profile.maxInputBytes/3)||!(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.body_base64))))fail('body_rejected');
  const body=input.body_base64?Buffer.from(input.body_base64,'base64'):null;
  if(body&&body.toString('base64')!==input.body_base64)fail('body_rejected');
  if(body&&body.length>profile.maxInputBytes||body&&['GET','HEAD'].includes(method))fail('body_rejected');
  if(input.zipcode!==undefined&&(typeof input.zipcode!=='string'||!/^[1-9]\d{5}$/.test(input.zipcode)))fail('request_invalid');
  if(profile.amazonZipPlugin&&input.main_document&&!input.zipcode)fail('zipcode_required');
  const browser=recipeInput(input.browser,profile);
  return {...input,...(browser?{browser}:{}),method,headers:input.headers??{},body};
}
export const FALLBACK_FAILURES=new Set(['proxy_connect_failed','source_denied','source_challenge']);
