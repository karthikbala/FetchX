import {createHmac,createHash,timingSafeEqual} from 'node:crypto';
import {GatewayError,fail} from './policy.mjs';
import {TRIAL_CREDITS_PER_ACCOUNT,reviewedCreditPolicy} from './control-credits.mjs';
import {PublicFetchGateway,publicFetchFailure} from './v2-public-fetch.mjs';
import {googleConfiguration} from './control-google.mjs';
import {githubConfiguration} from './control-github.mjs';

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
const safeKey=v=>pick(v,['id','project','name','prefix','scopes','created_at','last_used_at','revoked_at']);
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
 if(code==='stripe_checkout_disabled')return 'Checkout is unavailable for this project.';
 if(code==='stripe_checkout_already_open')return 'This project already has an open checkout.';
 if(code==='stripe_checkout_unconfirmed'||code==='stripe_provider_unconfirmed')return 'Stripe could not confirm the request. Recover it with the original request key.';
 if(code==='stripe_checkout_reconciliation_required')return 'The saved Stripe request needs operator reconciliation.';
 if(code==='stripe_checkout_conflict')return 'Use the original plan and request key to recover this checkout.';
 if(code==='paid_credit_route_unavailable')return 'Paid credits are unavailable until this project has a ready public HTTP route.';
 if(code==='paid_credit_capacity_unavailable')return 'This credit pack is unavailable at current capacity.';
 if(code==='paid_credit_payment_hold')return 'Paid credits are on hold pending payment review.';
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
function routes(config){return ['direct','datacenter'].filter(r=>Object.hasOwn(config.creditPolicy?.weights??{},r));}
function trialTerms(v2,project,config){
 if(config.creditPolicy?.reviewed!==true||(config.creditPolicy.trialCredits??TRIAL_CREDITS_PER_ACCOUNT)!==TRIAL_CREDITS_PER_ACCOUNT)return null;
 const {trialCredits}=reviewedCreditPolicy({controlPlane:config});
 return {trial_target:trialCredits,grant_scope:'account',grant_frequency:'once',
  eligible_routes:routes(config),max_daily_operations:v2.entitlement(project).max_daily_operations};
}
async function capabilities(v2,project,config){
 const value=await v2.capabilities(project),allowed=routes(config);
 for(const cls of ['datacenter','residential']){
  if(value.paid_http?.proxy_classes?.[cls]===true&&value.proxy_classes?.[cls]===true&&!allowed.includes(cls))allowed.push(cls);
 }
 return {...value,native_http:true,render:false,routes:allowed,transports:{...value.transports,http:true,browser:false},
  proxy_classes:{direct:allowed.includes('direct'),datacenter:allowed.includes('datacenter'),residential:allowed.includes('residential')},
  features:{...value.features,browser_network_probe:false},browser_probe:{available:false,reason:'self_service_http_only'}};
}
async function profiles(v2,project,allowed){
 const value=await v2.profiles(project);
 return value.access_profiles.map(({browser_probe,...p})=>({...p,proxy_classes:p.proxy_classes.filter(c=>allowed.includes(c)),
  route_reservations:p.route_reservations?.filter(r=>allowed.includes(r.class)),...(browser_probe?{browser_probe:{enabled:false}}:{})}));
}
function recovery(value,project,{key,id}={}){
 if(!value?.retry)return value;
 return {...value,retry:{...value.retry,lookup_url:key?`/api/control/projects/${project}/fetch/${encodeURIComponent(key)}`:id?`/api/control/projects/${project}/requests/${id}`:null}};
}
async function history(v2,project,raw){
 if(!exact(raw,['limit'])||raw.limit!==undefined&&(typeof raw.limit!=='string'||!/^\d{1,2}$/.test(raw.limit)))fail('request_invalid');
 const limit=raw.limit===undefined?25:Number(raw.limit);if(limit<1||limit>50)fail('request_invalid');
 const value=await v2.recentOperations(project,raw);
 return {operations:value.operations.map(r=>({...pick(r,['id','key_id','state','created_at','finished_at','latency_ms','source_http_status','physical_requests','encoded_bytes','decoded_bytes','tunnel_bytes','estimated_micro_usd','invoice_micro_usd']),
  error:r.error&&/^[a-z][a-z0-9_]{0,80}$/.test(r.error)?r.error:null,
  access_profile:pick(r.access_profile,['id','version']),routing:pick(r.routing,['class','country','provider']),
  ...(r.request_credits?{request_credits:pick(r.request_credits,['credits','state','key_id','policy_version','unit'])}:{})})),limit,scope:'v2_project_recent'};
}
async function usage(v2,credits,project,config){
 const gateway=await v2.usage(project),account=await credits.usage(project);
 const row=(await v2.store.pool.query(`SELECT count(*)::int AS completed_operations,
  avg(EXTRACT(EPOCH FROM (finished_at-created_at))*1000)::float8 AS mean,
  percentile_cont(0.5) WITHIN GROUP(ORDER BY EXTRACT(EPOCH FROM (finished_at-created_at))*1000)::float8 AS p50,
  percentile_cont(0.95) WITHIN GROUP(ORDER BY EXTRACT(EPOCH FROM (finished_at-created_at))*1000)::float8 AS p95
  FROM v2_operations WHERE project=$1 AND finished_at IS NOT NULL`,[project])).rows[0];
 const trial=trialTerms(v2,project,config);
 return {gateway:{...gateway,latency_ms:row??{completed_operations:0,mean:null,p50:null,p95:null}},credits:account,
  ...(gateway.paid_credits?{paid_credits:gateway.paid_credits}:{}),...(trial?{trial}:{})};
}

export function registerControl(app,gateway,{identity=gateway.controlIdentity,credits=gateway.controlCredits??app.v2?.controlCredits,paidCredits,stripe}={}){
 const config=gateway.config.controlPlane??{},v2=app.v2,fetch=app.publicFetch??new PublicFetchGateway(v2);
 app.register(async control=>{
  control.setErrorHandler((error,req,reply)=>{const result=controlFailure(error);reply.code(result.status).send(result.body);});
  control.addHook('onRequest',async(req,reply)=>{
   reply.header('Cache-Control','no-store').header('Pragma','no-cache').header('X-Content-Type-Options','nosniff').header('X-Robots-Tag','noindex, nofollow');
   if(!config.enabled)return reply.code(503).send(req.url.split('?')[0]==='/control/status'?{enabled:false,mail_configured:false,google:{enabled:false,client_id:null},github:{enabled:false},api_base_url:null,capabilities:{native_http:false,render:false,routes:[]}}:{error:{code:'control_disabled',message:message('control_disabled')}});
   if(typeof config.bridgeSecret!=='string'||Buffer.byteLength(config.bridgeSecret)<32||!Array.isArray(config.origins)||!config.origins.length||!identity||!credits||config.sessionSecure===false&&!(config.allowLoopbackDevelopment===true&&config.origins.every(loopback)))fail('control_configuration_invalid',503);
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
   return {enabled:true,mail_configured:identity.mailConfigured===true||identity.mail?.configured===true,google:googleConfiguration(gateway.config),github:githubConfiguration(gateway.config),...(localMail?{mail_delivery:'local_private_mailbox'}:{}),api_base_url:config.apiBaseUrl??null,capabilities:{native_http:true,render:false,routes:routes(config)}};
  });
  const clientIp=req=>typeof req.headers['x-fetchx-client-ip']==='string'&&/^[a-fA-F0-9:.]{3,64}$/.test(req.headers['x-fetchx-client-ip'])?req.headers['x-fetchx-client-ip']:req.ip;
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
  route('GET','/projects/:id',async req=>{
   query(req);const auth=await member(req),available=await capabilities(v2,auth.id,config);
   return {project:safeProject(auth.project),capabilities:available,access_profiles:await profiles(v2,auth.id,available.routes)};
  });
  route('GET','/projects/:id/keys',async req=>{query(req);const auth=await member(req);return {keys:(await identity.keys(auth.user.id,auth.id)).map(safeKey)};});
  route('POST','/projects/:id/keys',async req=>{query(req);const body=input(req,['name','scopes']),auth=await member(req),result=await identity.createKey(auth.user.id,auth.id,body);return {key:safeKey(result),token:result.token};});
  route('POST','/projects/:id/keys/:key/rotate',async req=>{query(req);input(req,[]);const auth=await member(req),result=await identity.rotateKey(auth.user.id,auth.id,pathId(req.params.key,UUID));return {key:safeKey(result),token:result.token};});
  route('DELETE','/projects/:id/keys/:key',async req=>{query(req);if(req.body!==undefined)input(req,[]);const auth=await member(req);await identity.revokeKey(auth.user.id,auth.id,pathId(req.params.key,UUID));return {revoked:true};});
  route('POST','/projects/:id/fetch',async(req,reply)=>{
   query(req);const auth=await member(req);
   try{input(req,['idempotency_key','access_profile','url','proxy','session_id','method','headers','body_base64','max_estimated_micro_usd','max_transfer_mb','max_credits','retry','render','browser','javascript','js_render','wait_for','waitFor','screenshot','screenshots','formats','actions','script','selectors','extract','transport']);return recovery(await fetch.fetch(auth.id,req.body,{keyId:'console'}),auth.id,{key:req.body.idempotency_key});}
   catch(error){const value=publicFetchFailure(error,{key:req.body?.idempotency_key});return reply.code(value.gateway_http_status).send(recovery(value,auth.id,{key:value.idempotency_key}));}
  });
  route('GET','/projects/:id/fetch/:key',async(req,reply)=>{query(req);const auth=await member(req);try{return recovery(await fetch.lookup(auth.id,req.params.key),auth.id,{key:req.params.key});}catch(error){const value=publicFetchFailure(error,{key:req.params.key});return reply.code(value.gateway_http_status).send(recovery(value,auth.id,{key:value.idempotency_key}));}});
  route('GET','/projects/:id/requests',async req=>{const auth=await member(req);return history(v2,auth.id,req.query??{});});
  route('GET','/projects/:id/requests/:operationId',async(req,reply)=>{query(req);const auth=await member(req),id=pathId(req.params.operationId,UUID);try{return recovery(await fetch.lookupOperation(auth.id,id),auth.id,{id});}catch(error){const value=publicFetchFailure(error);return reply.code(value.gateway_http_status).send(recovery(value,auth.id,{id}));}});
  route('GET','/projects/:id/usage',async req=>{query(req);const auth=await member(req);return usage(v2,credits,auth.id,config);});
  route('GET','/projects/:id/billing',async req=>{
   query(req);const auth=await member(req);
   const [account,payment,paid]=await Promise.all([credits.usage(auth.id),stripe?.billing(auth.id),paidCredits?.usage(auth.id)]);
   const trial=trialTerms(v2,auth.id,config);
   return {status:Number(account.available??account.available_credits??0)>0?'trial':'approval_required',credits:account,
    commercial_enabled:payment?.mode==='live'&&(payment.can_checkout||payment.can_resume_checkout===true||payment.purchases.length>0),...(payment?{stripe:payment}:{}),
    ...(paid&&(payment||paid.granted>0||paid.payment_hold)?{paid_credits:paid}:{}),...(trial?{trial}:{})};
  });
  route('POST','/projects/:id/billing/stripe/checkout',async req=>{
   query(req);const auth=await member(req),body=input(req,['plan_id','idempotency_key']);
   if(!stripe)fail('stripe_checkout_disabled',404);
   return stripe.checkout({project:auth.id,planId:body.plan_id,key:body.idempotency_key,origin:req.headers.origin});
  });
  route('GET','/projects/:id/billing/stripe/checkout/:key',async req=>{
   query(req);const auth=await member(req);if(!stripe)fail('stripe_checkout_disabled',404);
   return stripe.status(auth.id,req.params.key);
  });
  control.all('/*',async()=>fail('not_found',404));
 },{prefix:'/control'});
 return app;
}
