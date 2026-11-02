import {createLocalJWKSet,errors,jwtVerify} from 'jose';
import {GatewayError,fail} from './policy.mjs';

const KEYS_URL='https://www.googleapis.com/oauth2/v3/certs';
const ISSUER='https://accounts.google.com';
const CLIENT_ID=/^[0-9]{6,30}-[A-Za-z0-9_-]{6,200}\.apps\.googleusercontent\.com$/;
const NONCE=/^[A-Za-z0-9_-]{43}$/;
const KEY_LIMIT=64*1024,KEY_TIMEOUT=5000,KEY_COOLDOWN=30000;
const domain=value=>typeof value==='string'&&value.length<=253&&value.includes('.')&&value.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));

export function googleConfiguration(config){
 const value=config.controlPlane?.google;
 return value?.enabled===true&&typeof value.clientId==='string'&&CLIENT_ID.test(value.clientId)
  ?{enabled:true,client_id:value.clientId}:{enabled:false,client_id:null};
}

async function readKeys(response,signal){
 if(!response.ok||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||Number(response.headers.get('content-length')??0)>KEY_LIMIT){void response.body?.cancel().catch(()=>{});throw new Error('invalid_key_response');}
 if(!response.body)throw new Error('empty_key_response');
 const reader=response.body.getReader(),parts=[];let size=0,abort;
 const cancelled=new Promise((_,reject)=>{abort=()=>{reject(new Error('key_timeout'));void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 try{
  for(;;){const {done,value}=await Promise.race([reader.read(),cancelled]);if(done)break;size+=value.byteLength;if(size>KEY_LIMIT){void reader.cancel().catch(()=>{});throw new Error('key_response_too_large');}parts.push(value);}
 }finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
 const jwks=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 if(!jwks||!Array.isArray(jwks.keys)||!jwks.keys.length||jwks.keys.length>20||jwks.keys.some(key=>!key||typeof key!=='object'||typeof key.kid!=='string'||!key.kid.length||key.kid.length>256))throw new Error('invalid_key_set');
 return jwks;
}

// A single gateway identity service retains only Google's public verification
// keys. Browser tokens and claims are never retained by this cache.
export function createControlGoogle({fetchImpl=globalThis.fetch,now=()=>Date.now()}={}){
 let cache=null,inflight=null,lastRefresh=-Infinity;
 async function refresh(){
  if(inflight)return inflight;
  inflight=(async()=>{
   const signal=AbortSignal.timeout(KEY_TIMEOUT);let response;
   try{
    response=await fetchImpl(KEYS_URL,{headers:{accept:'application/json'},redirect:'manual',signal});
    const jwks=await readKeys(response,signal);
    const maxAge=Number((response.headers.get('cache-control')??'').match(/(?:^|,)\s*max-age\s*=\s*(\d+)(?:\s*,|\s*$)/i)?.[1]??0);
    const age=Number(response.headers.get('age')??0);
    const ttl=Math.max(0,Math.min(3600000,(maxAge-(Number.isFinite(age)&&age>=0?age:0))*1000));
    cache={keys:createLocalJWKSet(jwks),expires:now()+ttl};lastRefresh=now();
   }catch{fail('google_unavailable',503);}
  })();
  try{await inflight;}finally{inflight=null;}
 }
 async function key(protectedHeader,token){
  if(!cache||cache.expires<=now())await refresh();
  try{return await cache.keys(protectedHeader,token);}
  catch(error){
   if(!(error instanceof errors.JWKSNoMatchingKey)||now()-lastRefresh<KEY_COOLDOWN)throw error;
   await refresh();return cache.keys(protectedHeader,token);
  }
 }
 return {async verify(credential,{clientId}){
  if(typeof credential!=='string'||credential.length>16384||!/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(credential)||!CLIENT_ID.test(clientId))fail('google_verification_invalid',401);
  let payload;
  try{
   ({payload}=await jwtVerify(credential,key,{algorithms:['RS256'],issuer:[ISSUER,'accounts.google.com'],audience:clientId,requiredClaims:['iss','aud','sub','exp','iat','nonce','email','email_verified'],clockTolerance:30,maxTokenAge:3600,currentDate:new Date(now())}));
  }catch(error){if(error instanceof GatewayError)throw error;fail('google_verification_invalid',401);}
  const seconds=now()/1000;
  if(!Number.isSafeInteger(payload.iat)||!Number.isSafeInteger(payload.exp)||payload.iat<=0||payload.exp<=payload.iat||payload.exp-payload.iat>3900||payload.iat>seconds+30||payload.exp<=seconds||typeof payload.sub!=='string'||!/^[-_A-Za-z0-9]{1,255}$/.test(payload.sub)||typeof payload.nonce!=='string'||!NONCE.test(payload.nonce)||payload.email_verified!==true||payload.azp!==undefined&&payload.azp!==clientId||Array.isArray(payload.aud)&&payload.aud.length>1&&payload.azp!==clientId)fail('google_verification_invalid',401);
  if(typeof payload.email!=='string'||payload.email.length>254||payload.email!==payload.email.trim()||! /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(payload.email)||payload.email.split('@')[0].length>64||payload.email.includes('..')||payload.hd!==undefined&&!domain(payload.hd))fail('google_verification_invalid',401);
  const email=payload.email.toLowerCase();
  return {issuer:ISSUER,subject:payload.sub,email,nonce:payload.nonce,authoritative:email.endsWith('@gmail.com')||domain(payload.hd)};
 }};
}
