import {createHash} from 'node:crypto';
import {GatewayError,fail} from './policy.mjs';

const CALLBACK='https://fetchx.ai/api/control/auth/github/callback';
const CALLBACK_PATH='/api/control/auth/github/callback';
const CLIENT=/^[A-Za-z0-9]{10,100}$/;
const SECRET=/^[A-Za-z0-9_-]{20,200}$/;
const RANDOM=/^[A-Za-z0-9_-]{43}$/;
const TOKEN_URL='https://github.com/login/oauth/access_token';
const USER_URL='https://api.github.com/user';
const EMAILS_URL='https://api.github.com/user/emails?per_page=100';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const loopback=origin=>{try{const url=new URL(origin);return ['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&['http:','https:'].includes(url.protocol)&&url.origin===origin;}catch{return false;}};

// The client secret is read exclusively from the gateway environment. Neither
// the public status response nor the challenge table contains it.
export function githubSettings(config){
 const control=config.controlPlane,value=control?.github;
 if(!plain(value)||value.enabled!==true||Object.keys(value).some(key=>!['enabled','clientId','clientSecretEnv','redirectUri'].includes(key))||typeof value.clientId!=='string'||!CLIENT.test(value.clientId)||value.clientSecretEnv!=='FETCHX_GITHUB_CLIENT_SECRET')return null;
 const clientSecret=process.env[value.clientSecretEnv];
 if(typeof clientSecret!=='string'||!SECRET.test(clientSecret))return null;
 let redirect;try{redirect=new URL(value.redirectUri);}catch{return null;}
 if(redirect.href!==value.redirectUri||redirect.pathname!==CALLBACK_PATH||redirect.search||redirect.hash||redirect.username||redirect.password||!Array.isArray(control.origins)||!control.origins.includes(redirect.origin))return null;
 if(value.redirectUri!==CALLBACK&&!(control.allowLoopbackDevelopment===true&&control.origins.length&&control.origins.every(loopback)&&loopback(redirect.origin)))return null;
 return {clientId:value.clientId,clientSecret,redirectUri:value.redirectUri};
}
export const githubConfiguration=config=>({enabled:githubSettings(config)!==null});
export function githubAuthorizationUrl({clientId,redirectUri},{state,verifier}){
 if(!RANDOM.test(state)||!RANDOM.test(verifier))fail('github_verification_invalid',401);
 const url=new URL('https://github.com/login/oauth/authorize');
 url.search=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,scope:'user:email',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
 return url.href;
}

async function readJson(response,signal,limit){
 if(response.status!==200||!/^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||Number(response.headers.get('content-length')??0)>limit){void response.body?.cancel().catch(()=>{});throw Error('response_invalid');}
 if(!response.body)throw Error('response_empty');
 const reader=response.body.getReader(),parts=[];let size=0,abort;
 const cancelled=new Promise((_,reject)=>{abort=()=>{reject(Error('response_timeout'));void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 try{for(;;){const {done,value}=await Promise.race([reader.read(),cancelled]);if(done)break;size+=value.byteLength;if(size>limit){void reader.cancel().catch(()=>{});throw Error('response_too_large');}parts.push(value);}}
 finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
function verifiedEmail(emails){
 if(!Array.isArray(emails)||emails.length>100||emails.some(value=>!plain(value)))fail('github_verification_invalid',401);
 const primary=emails.filter(value=>value.primary===true);
 if(primary.length!==1||primary[0].verified!==true)fail('github_email_verification_required',403);
 const email=primary[0].email;
 if(typeof email!=='string'||email!==email.trim()||email.length>254||! /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(email)||email.split('@')[0].length>64||email.includes('..'))fail('github_email_verification_required',403);
 return email.toLowerCase();
}

export function createControlGithub({fetchImpl=globalThis.fetch,timeoutMs=10000}={}){
 return {async verify(code,{clientId,clientSecret,redirectUri,verifier}){
  if(typeof code!=='string'||! /^[A-Za-z0-9_-]{1,512}$/.test(code)||!CLIENT.test(clientId)||!SECRET.test(clientSecret)||!RANDOM.test(verifier))fail('github_verification_invalid',401);
  const signal=AbortSignal.timeout(timeoutMs);
  try{
   const response=await fetchImpl(TOKEN_URL,{method:'POST',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,code,redirect_uri:redirectUri,code_verifier:verifier}),redirect:'error',signal});
   const token=await readJson(response,signal,16384);
   if(plain(token)&&['bad_verification_code','incorrect_client_credentials','redirect_uri_mismatch'].includes(token.error))fail('github_verification_invalid',401);
   if(!plain(token)||typeof token.access_token!=='string'||! /^[A-Za-z0-9_-]{10,512}$/.test(token.access_token)||typeof token.token_type!=='string'||token.token_type.toLowerCase()!=='bearer'||token.scope!=='user:email')fail('github_verification_invalid',401);
   const headers={accept:'application/vnd.github+json',authorization:`Bearer ${token.access_token}`,'user-agent':'FetchX-Control/1.0','x-github-api-version':'2026-03-10'};
   const user=await readJson(await fetchImpl(USER_URL,{headers,redirect:'error',signal}),signal,65536);
   if(!plain(user)||!Number.isSafeInteger(user.id)||user.id<=0||user.type!=='User')fail('github_verification_invalid',401);
   const emailResponse=await fetchImpl(EMAILS_URL,{headers,redirect:'error',signal});
   if(/rel\s*=\s*"?next\b/i.test(emailResponse.headers.get('link')??'')){void emailResponse.body?.cancel().catch(()=>{});fail('github_verification_invalid',401);}
   const email=verifiedEmail(await readJson(emailResponse,signal,65536));
   return {subject:String(user.id),email};
  }catch(error){if(error instanceof GatewayError)throw error;fail('github_unavailable',503);}
 }};
}
