import {createHmac,createHash,timingSafeEqual} from 'node:crypto';
import {GatewayError,fail} from './policy.mjs';
import {usageReport} from './api/v1.mjs';
import {googleConfiguration} from './control-google.mjs';
import {githubConfiguration} from './control-github.mjs';
import {CONNECT_INTERVAL,ControlConnect,connectApiBase} from './control-connect.mjs';
import {registerAdminRoutes} from './control-admin.mjs';

export const CONTROL_COOKIE='fetchx_session';
export const CONTROL_GOOGLE_COOKIE='fetchx_google';
export const CONTROL_GITHUB_COOKIE='fetchx_github';
export const CONTROL_BRIDGE_HEADER='x-fetchx-control-secret';
const BODY_LIMIT=96*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PROJECT=/^cp_[a-f0-9-]{36}$/i;
const SESSION=/^fxs_[A-Za-z0-9_-]{43}$/;
const GOOGLE_BINDING=/^fxg_[A-Za-z0-9_-]{43}$/;
const GITHUB_BINDING=/^fxh_[A-Za-z0-9_-]{43}$/;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>plain(v)&&Object.keys(v).every(k=>keys.includes(k));
const pick=(v,keys)=>Object.fromEntries(keys.filter(k=>v?.[k]!==undefined).map(k=>[k,v[k]]));
const safeUser=v=>pick(v,['id','email','verified_at','created_at']);
const safeProject=v=>pick(v,['id','name','status','created_at']);
const safeKey=v=>pick(v,['id','project','name','prefix','scopes','limits','created_at','last_used_at','revoked_at']);
export const isControlRequest=req=>/^\/control(?:\/|\?|$)/.test(req.url);
const constantEqual=(a,b)=>typeof a==='string'&&typeof b==='string'&&timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
export const controlCsrf=(token,secret)=>createHmac('sha256',secret).update('fetchx-control-csrf\0'+token).digest('base64url');
const loopback=origin=>{try{const u=new URL(origin);return ['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&['http:','https:'].includes(u.protocol)&&u.origin===origin;}catch{return false;}};

function cookieToken(req,name=CONTROL_COOKIE,pattern=SESSION){
 const matches=String(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));
 if(matches.length!==1)return null;
 const token=matches[0].slice(name.length+1);return pattern.test(token)?token:null;
}
function githubSessionToken(req){
 const token=cookieToken(req);
 if(!token&&String(req.headers.cookie??'').split(';').some(value=>value.trim().startsWith(CONTROL_COOKIE+'=')))fail('unauthorized',401);
 return token;
}
function setCookie(reply,token,config,expires,name=CONTROL_COOKIE){
 const secure=config.sessionSecure!==false;
 const parts=[`${name}=${token??''}`,'Path=/api/control','HttpOnly','SameSite=Lax'];
 if(secure)parts.push('Secure');
 if(token){const date=new Date(expires);if(!Number.isFinite(date.getTime()))fail('session_invalid',503);parts.push('Expires='+date.toUTCString());}
 else parts.push('Max-Age=0','Expires=Thu, 01 Jan 1970 00:00:00 GMT');
 reply.header('Set-Cookie',parts.join('; '));
}
function message(code){
 if(code==='github_account_link_required')return 'Sign in with your existing method, then connect GitHub from your account.';
 if(code==='github_identity_conflict')return 'This GitHub identity cannot be connected to this account.';
 if(code==='github_session_conflict')return 'Use the account that started this GitHub connection, or sign out before signing in with GitHub.';
 if(code==='github_email_verification_required')return 'Verify your primary email address on GitHub, then try again.';
 if(code==='github_disabled'||code==='github_unavailable')return 'GitHub sign-in is currently unavailable. You can use an email code.';
 if(code==='github_verification_invalid')return 'GitHub sign-in could not be verified. Start again or use an email code.';
 if(code==='github_cancelled')return 'GitHub sign-in was cancelled. You can try again or use an email code.';
 if(code==='google_email_verification_required')return 'Use an email code to verify this address and sign in.';
 if(code==='google_identity_conflict')return 'Use your existing sign-in method for this account.';
 if(code==='google_disabled'||code==='google_unavailable')return 'Google sign-in is currently unavailable. You can use an email code.';
 if(code==='google_verification_invalid')return 'Google sign-in could not be verified. Try again or use an email code.';
 if(code==='unauthorized'||code==='session_invalid')return 'Sign in to continue.';
 if(code==='bridge_rejected'||code==='origin_rejected'||code==='csrf_rejected')return 'This request could not be authorized.';
 if(code==='control_disabled'||code==='control_configuration_invalid')return 'Account access is currently unavailable.';
 if(code==='connect_disabled')return 'FetchX Connect is currently unavailable.';
 if(code==='connect_slow_down')return 'Wait before checking this connection again.';
 if(code==='connect_request_closed')return 'This connection request is closed. Start a new one from your agent if needed.';
 if(code==='stripe_checkout_disabled')return 'Checkout is unavailable for this project.';
 if(code==='stripe_checkout_already_open')return 'This project already has an open checkout.';
 if(code==='stripe_checkout_unconfirmed'||code==='stripe_provider_unconfirmed')return 'Stripe could not confirm the request. Recover it with the original request key.';
 if(code==='stripe_checkout_reconciliation_required')return 'The saved Stripe request needs operator reconciliation.';
 if(code==='stripe_checkout_conflict')return 'Use the original plan and request key to recover this checkout.';
 if(code==='paid_credit_payment_hold')return 'Paid credits are on hold pending payment review.';
 if(code==='budget_version_conflict')return 'This budget changed since you loaded it. Reload and try again.';
 if(code==='budget_value_invalid')return 'That value is outside the limits for this budget.';
 if(code==='budget_reason_required')return 'Give a reason; it is recorded in the audit log.';
 if(code==='budget_not_overridden')return 'This budget already uses its configured value.';
 if(code==='budget_unknown')return 'This budget does not exist.';
 if(code==='notice_resolved')return 'This notice is already resolved.';
 if(code==='notice_pause_api_invalid')return 'Only a maintenance notice can pause the API.';
 if(code==='notice_not_found')return 'This notice does not exist.';
 if(code==='feedback_not_found')return 'This report does not exist.';
 if(code==='feedback_status_invalid')return 'Choose received, reviewing, resolved or dismissed.';
 if(code==='feedback_reply_invalid')return 'A reply is at most 2,000 characters.';
 if(code==='feedback_review_required')return 'Change the status or the reply.';
 if(code==='key_limits_invalid')return 'Credit limits must be whole numbers from 1 to 100,000,000, or empty for no limit.';
 if(code==='key_expiry_invalid')return 'The expiry must be a date and time in the future, at most 5 years away.';
 if(code==='key_revoked')return 'This key is revoked.';
 if(code==='project_limit')return 'This account has reached its project limit. Use an existing project.';
 if(code==='project_name_invalid')return 'Give the project a name of up to 80 characters.';
 if(/rate|limit/.test(code))return 'This request exceeds an account limit. Try again later.';
 if(/not_found|forbidden|membership/.test(code))return 'This resource is unavailable for this account.';
 if(/code|challenge/.test(code))return 'The verification code could not be accepted. Request a new code if needed.';
 if(/invalid|required|rejected|scope/.test(code))return 'Check the submitted request.';
 if(code==='internal_error')return 'The account service could not complete this request.';
 return 'This account request could not be completed.';
}
export function controlFailure(error){
 const client=[400,413,415].includes(error?.statusCode)||error?.validation;
 const code=error instanceof GatewayError&&/^[a-z][a-z0-9_]{0,80}$/.test(error.code)?error.code:client?'request_invalid':'internal_error';
 const status=error instanceof GatewayError&&Number.isInteger(error.status)?error.status:client?(error.statusCode??400):500;
 return {status,body:{error:{code,message:message(code)}}};
}
function input(req,keys){if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))fail('request_invalid',415);if(!exact(req.body,keys))fail('request_invalid');return req.body;}
function query(req,keys=[]){if(!exact(req.query??{},keys))fail('request_invalid');}
const pathId=(value,re)=>{if(typeof value!=='string'||!re.test(value))fail('identifier_invalid');return value;};
// The console's API (/api/control on the website, /control here): sign-in,
// projects, keys, billing, the playground and request history (both through
// the same fetch service as the public API), Connect and the admin portal.
export function registerControl(app,gateway,{identity=gateway.controlIdentity,ledger,service,stripe}={}){
 const config=gateway.config.controlPlane??{};
 const connect=identity?.store?new ControlConnect(identity):null;
 const connectBase=req=>connect&&connectApiBase(config,req.headers.origin);
 function requireConnect(req){const base=connectBase(req);if(!base)fail('connect_disabled',503);return base;}
 app.register(async control=>{
  control.setErrorHandler((error,req,reply)=>{
   const result=controlFailure(error);
   if(result.body.error.code==='connect_slow_down')reply.header('Retry-After',String(CONNECT_INTERVAL));
   reply.code(result.status).send(result.body);
  });
  control.addHook('onRequest',async(req,reply)=>{
   reply.header('Cache-Control','no-store').header('Pragma','no-cache').header('X-Content-Type-Options','nosniff').header('X-Robots-Tag','noindex, nofollow');
   if(!config.enabled)return reply.code(503).send(req.url.split('?')[0]==='/control/status'?{enabled:false,mail_configured:false,google:{enabled:false,client_id:null},github:{enabled:false},api_base_url:null}:{error:{code:'control_disabled',message:message('control_disabled')}});
   if(typeof config.bridgeSecret!=='string'||Buffer.byteLength(config.bridgeSecret)<32||!Array.isArray(config.origins)||!config.origins.length||!identity||!ledger||config.sessionSecure===false&&!(config.allowLoopbackDevelopment===true&&config.origins.every(loopback)))fail('control_configuration_invalid',503);
   if(!constantEqual(req.headers[CONTROL_BRIDGE_HEADER],config.bridgeSecret))fail('bridge_rejected',403);
   const origin=req.headers.origin;
   if(typeof origin!=='string'||!config.origins.includes(origin))fail('origin_rejected',403);
   try{if(new URL(origin).origin!==origin)fail('origin_rejected',403);}catch{fail('origin_rejected',403);}
  });
  async function authenticated(req){
   const token=cookieToken(req);if(!token)fail('unauthorized',401);
   const result=await identity.session(token);if(!result?.user?.id)fail('unauthorized',401);
   if(!['GET','HEAD'].includes(req.method)&&!constantEqual(req.headers['x-csrf-token'],controlCsrf(token,config.bridgeSecret)))fail('csrf_rejected',403);
   return {...result,token};
  }
  async function member(req){
   const auth=await authenticated(req),id=pathId(req.params.id,PROJECT);
   const project=await identity.requireProject(auth.user.id,id);
   await identity.hydrateProject(id);
   return {...auth,project,id};
  }
  const route=(method,url,handler)=>control.route({method,url,bodyLimit:BODY_LIMIT,handler});
  route('GET','/status',async req=>{
   query(req);
   const localMail=config.allowLoopbackDevelopment===true&&config.origins.every(loopback)&&identity.mail?.delivery==='local_private_mailbox'&&(identity.mailConfigured===true||identity.mail?.configured===true);
   return {enabled:true,mail_configured:identity.mailConfigured===true||identity.mail?.configured===true,google:googleConfiguration(gateway.config),github:githubConfiguration(gateway.config),...(localMail?{mail_delivery:'local_private_mailbox'}:{}),...(connectBase(req)?{connect_enabled:true}:{}),api_base_url:config.apiBaseUrl??null};
  });
  const clientIp=req=>typeof req.headers['x-fetchx-client-ip']==='string'&&/^[a-fA-F0-9:.]{3,64}$/.test(req.headers['x-fetchx-client-ip'])?req.headers['x-fetchx-client-ip']:req.ip;
  route('POST','/connect/start',async req=>{
   requireConnect(req);query(req);const body=input(req,['client_name','limits']);
   return connect.start({...body,origin:req.headers.origin,ip:clientIp(req)});
  });
  route('POST','/connect/claim',async req=>{
   const apiBaseUrl=requireConnect(req);query(req);const body=input(req,['request_id','device_code']);
   return connect.claim({...body,origin:req.headers.origin,apiBaseUrl,ip:clientIp(req)});
  });
  route('POST','/connect/review',async req=>{
   requireConnect(req);query(req);const auth=await authenticated(req),body=input(req,['request_id']);
   return connect.review({...body,origin:req.headers.origin,userId:auth.user.id,ip:clientIp(req)});
  });
  route('POST','/connect/decision',async req=>{
   requireConnect(req);query(req);const auth=await authenticated(req),body=input(req,['request_id','user_code','decision','project_id','project_name','limits']);
   return connect.decision({...body,origin:req.headers.origin,userId:auth.user.id,ip:clientIp(req)});
  });
  route('POST','/auth/code',async req=>{query(req);const body=input(req,['email']);return identity.requestCode({email:body.email,ip:clientIp(req)});});
  route('POST','/auth/verify',async(req,reply)=>{
   query(req);const body=input(req,['email','challenge_id','code']),result=await identity.verifyCode({...body,ip:clientIp(req)});
   if(!SESSION.test(result.session?.token??''))fail('session_invalid',503);
   setCookie(reply,result.session.token,config,result.session.expires_at);
   return {user:safeUser(result.user),csrf_token:controlCsrf(result.session.token,config.bridgeSecret),projects:(await identity.projects(result.user.id)).map(safeProject),auth_methods:await identity.authMethods(result.user.id)};
  });
  route('POST','/auth/google/challenge',async(req,reply)=>{
   query(req);input(req,[]);
   const result=await identity.requestGoogleChallenge({ip:clientIp(req),binding:cookieToken(req,CONTROL_GOOGLE_COOKIE,GOOGLE_BINDING)});
   if(!GOOGLE_BINDING.test(result.binding??''))fail('session_invalid',503);
   setCookie(reply,result.binding,config,result.expires_at,CONTROL_GOOGLE_COOKIE);
   return pick(result,['challenge_id','nonce','client_id','expires_in']);
  });
  route('POST','/auth/google/verify',async(req,reply)=>{
   query(req);const body=input(req,['challenge_id','credential']);
   const result=await identity.verifyGoogle({...body,binding:cookieToken(req,CONTROL_GOOGLE_COOKIE,GOOGLE_BINDING),ip:clientIp(req)});
   if(!SESSION.test(result.session?.token??''))fail('session_invalid',503);
   setCookie(reply,result.session.token,config,result.session.expires_at);
   setCookie(reply,null,config,undefined,CONTROL_GOOGLE_COOKIE);
   return {user:safeUser(result.user),csrf_token:controlCsrf(result.session.token,config.bridgeSecret),projects:(await identity.projects(result.user.id)).map(safeProject),auth_methods:await identity.authMethods(result.user.id)};
  });
  route('POST','/auth/github/start',async(req,reply)=>{
   query(req);const body=input(req,['mode']);if(!['login','link'].includes(body.mode))fail('request_invalid');
   const sessionToken=body.mode==='link'?(await authenticated(req)).token:githubSessionToken(req);
   const result=await identity.requestGithubStart({...body,sessionToken,csrfVerified:body.mode==='link',ip:clientIp(req),binding:cookieToken(req,CONTROL_GITHUB_COOKIE,GITHUB_BINDING)});
   if(!GITHUB_BINDING.test(result.binding??''))fail('session_invalid',503);
   setCookie(reply,result.binding,config,result.expires_at,CONTROL_GITHUB_COOKIE);
   return pick(result,['authorization_url','expires_in']);
  });
  route('POST','/auth/github/complete',async(req,reply)=>{
   query(req);const body=input(req,['code','state','error']);
   if(!(exact(body,['code','state'])&&Object.hasOwn(body,'code')&&Object.hasOwn(body,'state')||exact(body,['error','state'])&&body.error==='access_denied'&&Object.hasOwn(body,'state')))fail('request_invalid');
   const sessionToken=githubSessionToken(req),csrfVerified=!!sessionToken&&constantEqual(req.headers['x-csrf-token'],controlCsrf(sessionToken,config.bridgeSecret));
   let result;
   try{result=await identity.completeGithub({...body,sessionToken,csrfVerified,binding:cookieToken(req,CONTROL_GITHUB_COOKIE,GITHUB_BINDING),ip:clientIp(req)});}
   catch(error){setCookie(reply,null,config,undefined,CONTROL_GITHUB_COOKIE);throw error;}
   if(!SESSION.test(result.session?.token??''))fail('session_invalid',503);
   setCookie(reply,result.session.token,config,result.session.expires_at);setCookie(reply,null,config,undefined,CONTROL_GITHUB_COOKIE);
   return {user:safeUser(result.user),csrf_token:controlCsrf(result.session.token,config.bridgeSecret),projects:(await identity.projects(result.user.id)).map(safeProject),auth_methods:await identity.authMethods(result.user.id),mode:result.mode};
  });
  route('GET','/session',async req=>{query(req);const auth=await authenticated(req);return {user:safeUser(auth.user),csrf_token:controlCsrf(auth.token,config.bridgeSecret),projects:(await identity.projects(auth.user.id)).map(safeProject),auth_methods:await identity.authMethods(auth.user.id)};});
  route('POST','/auth/logout',async(req,reply)=>{query(req);input(req,[]);const auth=await authenticated(req);await identity.revokeSession(auth.token);setCookie(reply,null,config);return {logged_out:true};});
  route('GET','/projects',async req=>{query(req);const auth=await authenticated(req);return {projects:(await identity.projects(auth.user.id)).map(safeProject)};});
  route('POST','/projects',async req=>{query(req);const body=input(req,['name']),auth=await authenticated(req);return {project:safeProject(await identity.createProject(auth.user.id,body))};});
  route('GET','/projects/:id',async req=>{query(req);const auth=await member(req);return {project:safeProject(auth.project)};});
  route('GET','/projects/:id/keys',async req=>{query(req);const auth=await member(req);return {keys:(await identity.keys(auth.user.id,auth.id)).map(safeKey)};});
  route('POST','/projects/:id/keys',async req=>{query(req);const body=input(req,['name','scopes','limits']),auth=await member(req),result=await identity.createKey(auth.user.id,auth.id,body);return {key:safeKey(result),token:result.token};});
  route('POST','/projects/:id/keys/:key/rotate',async req=>{query(req);input(req,[]);const auth=await member(req),result=await identity.rotateKey(auth.user.id,auth.id,pathId(req.params.key,UUID));return {key:safeKey(result),token:result.token};});
  // A key's credit limits per day and month and its expiry (null fields remove them).
  route('PUT','/projects/:id/keys/:key/limits',async req=>{query(req);const body=input(req,['credits_per_day','credits_per_month','expires_at']),auth=await member(req);return {key:safeKey(await identity.setKeyLimits(auth.user.id,auth.id,pathId(req.params.key,UUID),body))};});
  route('DELETE','/projects/:id/keys/:key',async req=>{query(req);if(req.body!==undefined)input(req,[]);const auth=await member(req);await identity.revokeKey(auth.user.id,auth.id,pathId(req.params.key,UUID));return {revoked:true};});
  // The playground and request history use the public API's fetch service.
  const requestId=req=>pathId(req.params.rid,UUID);
  route('POST','/projects/:id/fetch',async(req,reply)=>{query(req);const auth=await member(req);const view=await service.submit(auth.id,req.body,{keyId:'console'});return reply.code(view.status==='pending'?202:200).send(view);});
  route('GET','/projects/:id/fetch',async req=>{const auth=await member(req);return service.list(auth.id,req.query??{});});
  route('GET','/projects/:id/fetch/:rid',async(req,reply)=>{const auth=await member(req);const view=await service.get(auth.id,requestId(req),{includeBody:req.query?.include_body!=='false'});return reply.code(view.status==='pending'?202:200).send(view);});
  route('DELETE','/projects/:id/fetch/:rid',async req=>{query(req);const auth=await member(req);await service.remove(auth.id,requestId(req));return {deleted:true};});
  route('GET','/projects/:id/usage',async req=>{const auth=await member(req);return usageReport({service,ledger},auth.id,req.query??{});});
  route('GET','/projects/:id/webhook-secret',async req=>{query(req);const auth=await member(req);return {secret:await service.webhookSecret(auth.id)};});
  route('POST','/projects/:id/webhook-secret/rotate',async req=>{query(req);input(req,[]);const auth=await member(req);return {secret:await service.webhookSecret(auth.id,{rotate:true})};});
  route('GET','/projects/:id/billing',async req=>{
   query(req);const auth=await member(req);
   const [balance,payment]=await Promise.all([ledger.balance(auth.id),stripe?.billing(auth.id,{country:req.headers['x-fetchx-client-country']})]);
   return {balance,prices:ledger.prices,...(payment?{stripe:payment}:{})};
  });
  route('POST','/projects/:id/billing/stripe/checkout',async req=>{
   query(req);const auth=await member(req),body=input(req,['plan_id','idempotency_key']);
   if(!stripe)fail('stripe_checkout_disabled',404);
   return stripe.checkout({project:auth.id,planId:body.plan_id,key:body.idempotency_key,origin:req.headers.origin,country:req.headers['x-fetchx-client-country']});
  });
  route('GET','/projects/:id/billing/stripe/checkout/:key',async req=>{
   query(req);const auth=await member(req);if(!stripe)fail('stripe_checkout_disabled',404);
   return stripe.status(auth.id,req.params.key);
  });
  // Admin portal API (operator role only; disabled unless controlPlane.admin.enabled).
  registerAdminRoutes(route,{gateway,config,authenticated,body:input,noQuery:query});
  control.all('/*',async()=>fail('not_found',404));
 },{prefix:'/control'});
 return app;
}
