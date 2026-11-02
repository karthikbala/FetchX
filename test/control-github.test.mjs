import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import Fastify from 'fastify';
import {createControlGithub,githubConfiguration,githubSettings,githubAuthorizationUrl} from '../src/control-github.mjs';
import {ControlIdentity} from '../src/control-identity.mjs';
import {registerControl,CONTROL_COOKIE,CONTROL_GITHUB_COOKIE,controlCsrf} from '../src/control.mjs';
import {Store} from '../src/store.mjs';

const origin='https://fetchx.ai',secret='synthetic-github-bridge-secret-at-least-32-bytes';
const clientId='Ov23liSyntheticClient',clientSecret='synthetic-github-client-secret-1234567890';
const callback=origin+'/api/control/auth/github/callback';
const random=()=>randomBytes(32).toString('base64url');
const hasCode=code=>error=>error?.code===code;
const tokenResponse=extra=>({access_token:'gho_synthetic_provider_token',token_type:'bearer',scope:'user:email',...extra});
const emails=(email='builder@example.com',extra={})=>[{email,primary:true,verified:true,...extra}];
function config(){return {projects:{},v2:{accessProfiles:{'synthetic@1':{id:'synthetic',version:1}}},controlPlane:{enabled:true,origins:[origin],bridgeSecret:secret,github:{enabled:true,clientId,clientSecretEnv:'FETCHX_GITHUB_CLIENT_SECRET',redirectUri:callback},projectTemplate:{id:'synthetic',v2_access_profiles:['synthetic@1'],v2_entitlement:{mode:'metered',max_daily_operations:10}},creditPolicy:{reviewed:true,version:'test-v1',trialCredits:12,weights:{direct:1},maxEstimatedMicroUsdPerOperation:0}}};}
function env(t){const before=process.env.FETCHX_GITHUB_CLIENT_SECRET;process.env.FETCHX_GITHUB_CLIENT_SECRET=clientSecret;t.after(()=>{if(before===undefined)delete process.env.FETCHX_GITHUB_CLIENT_SECRET;else process.env.FETCHX_GITHUB_CLIENT_SECRET=before;});}
function provider({subject=101,email='builder@example.com',responses,timeoutMs}={}){
 const calls=[];const github=createControlGithub({timeoutMs,fetchImpl:async(url,input)=>{
  calls.push({url,input});if(responses)return responses(calls.length,url,input);
  return Response.json(url.includes('/access_token')?tokenResponse():url.includes('/user/emails')?emails(email):{id:subject,type:'User',email:'untrusted-profile@example.com'});
 }});return {github,calls};
}
const verification={clientId,clientSecret,redirectUri:callback,verifier:random()};

test('GitHub configuration is disabled without dedicated environment credentials and exact approved callback',t=>{
 env(t);assert.deepEqual(githubConfiguration(config()),{enabled:true});assert.deepEqual(githubConfiguration({}),{enabled:false});
 const baseline=config();
 for(const change of [{enabled:false},{clientId:'invalid\n'},{clientId:1234567890},{clientSecretEnv:'GOOGLE_CLIENT_SECRET'},{clientSecret:'inline-secret'},{redirectUri:callback+'?next=attacker'},{redirectUri:callback+'#hash'},{redirectUri:'https://attacker.example/api/control/auth/github/callback'},{redirectUri:'https://fetchx.ai/other'},{redirectUri:'http://localhost:4321/api/control/auth/github/callback'}]){
  const value=structuredClone(baseline);Object.assign(value.controlPlane.github,change);assert.deepEqual(githubConfiguration(value),{enabled:false},JSON.stringify(change));
 }
 const local=config();local.controlPlane.origins=['http://127.0.0.1:4321'];local.controlPlane.github.redirectUri=local.controlPlane.origins[0]+'/api/control/auth/github/callback';
 assert.deepEqual(githubConfiguration(local),{enabled:false});local.controlPlane.allowLoopbackDevelopment=true;assert.deepEqual(githubConfiguration(local),{enabled:true});
 local.controlPlane.origins.push(origin);assert.deepEqual(githubConfiguration(local),{enabled:false});
 delete process.env.FETCHX_GITHUB_CLIENT_SECRET;assert.deepEqual(githubConfiguration(config()),{enabled:false});
 process.env.FETCHX_GITHUB_CLIENT_SECRET='bad\nsecret';assert.deepEqual(githubConfiguration(config()),{enabled:false});
});

test('GitHub authorization uses only user:email, random state and S256 proof without exposing verifier or secret',t=>{
 env(t);const state=random(),verifier=random(),url=new URL(githubAuthorizationUrl(githubSettings(config()),{state,verifier}));
 assert.equal(url.origin+url.pathname,'https://github.com/login/oauth/authorize');
 assert.deepEqual([...url.searchParams.keys()].sort(),['client_id','code_challenge','code_challenge_method','redirect_uri','scope','state']);
 assert.equal(url.searchParams.get('scope'),'user:email');assert.equal(url.searchParams.get('state'),state);assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 assert.equal(url.searchParams.get('code_challenge'),createHash('sha256').update(verifier).digest('base64url'));
 assert.ok(!url.href.includes(verifier));assert.ok(!url.href.includes(clientSecret));
});

test('GitHub verifier performs exactly one exchange and fixed bounded identity reads with no token retention',async()=>{
 const {github,calls}=provider();assert.deepEqual(await github.verify('synthetic-code',verification),{subject:'101',email:'builder@example.com'});
 assert.deepEqual(calls.map(call=>call.url),['https://github.com/login/oauth/access_token','https://api.github.com/user','https://api.github.com/user/emails?per_page=100']);
 assert.equal(calls[0].input.body.get('code_verifier'),verification.verifier);assert.equal(calls[0].input.body.get('client_secret'),clientSecret);assert.equal(calls[0].input.body.get('redirect_uri'),callback);
 assert.ok(calls.every(call=>call.input.redirect==='error'&&call.input.signal instanceof AbortSignal));
 assert.equal(calls[1].input.headers.authorization,'Bearer gho_synthetic_provider_token');
 assert.equal(calls[1].input.headers['x-github-api-version'],'2026-03-10');
 const expiring=provider({responses:n=>Response.json(n===1?tokenResponse({refresh_token:'ghr_discarded_refresh_secret',expires_in:28800,refresh_token_expires_in:15897600}):n===2?{id:101,type:'User'}:emails())});
 assert.deepEqual(await expiring.github.verify('code',verification),{subject:'101',email:'builder@example.com'});
});

test('GitHub verifier rejects broad scopes, invalid identities, unverified primary email and pagination',async()=>{
 for(const changed of [tokenResponse({scope:'repo,user:email'}),tokenResponse({scope:'user'}),tokenResponse({scope:'user:email,offline_access'}),tokenResponse({token_type:5}),tokenResponse({access_token:'bad\ntoken'}),{error:'bad_verification_code'}]){
  const {github,calls}=provider({responses:()=>Response.json(changed)});await assert.rejects(github.verify('code',verification),hasCode('github_verification_invalid'));assert.equal(calls.length,1);
 }
 for(const user of [{id:'101',type:'User'},{id:0,type:'User'},{id:Number.MAX_SAFE_INTEGER+1,type:'User'},{id:101,type:'Organization'}]){
  const {github}=provider({responses:n=>Response.json(n===1?tokenResponse():user)});await assert.rejects(github.verify('code',verification),hasCode('github_verification_invalid'));
 }
 for(const values of [[],emails('builder@example.com',{verified:false}),emails('builder@example.com',{primary:false}),emails('bad\naddress@example.com'),[...emails(),...emails('other@example.com')]]){
  const {github}=provider({responses:n=>Response.json(n===1?tokenResponse():n===2?{id:101,type:'User'}:values)});await assert.rejects(github.verify('code',verification),hasCode('github_email_verification_required'));
 }
 const paged=provider({responses:n=>Response.json(n===1?tokenResponse():n===2?{id:101,type:'User'}:emails(),{headers:n===3?{link:'<https://attacker.example>; rel="next"'}:{}})});
 await assert.rejects(paged.github.verify('code',verification),hasCode('github_verification_invalid'));assert.equal(paged.calls.length,3);
});

test('GitHub provider failures are bounded, sanitized and never retried',async()=>{
 for(const response of [new Response('',{status:302,headers:{location:'https://attacker.example'}}),new Response('secret-provider-body',{status:500}),new Response('not-json',{headers:{'content-type':'text/plain'}}),new Response('{',{headers:{'content-type':'application/json'}}),new Response('x'.repeat(16385),{headers:{'content-type':'application/json'}}),Response.json({}, {headers:{'content-length':'999999'}})]){
  const {github,calls}=provider({responses:()=>response});await assert.rejects(github.verify('code',verification),hasCode('github_unavailable'));assert.equal(calls.length,1);
 }
 let sent=0;const hanging=createControlGithub({timeoutMs:20,fetchImpl:async()=>{sent++;return new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}});}});
 const keepAlive=setTimeout(()=>{},1000);try{await assert.rejects(hanging.verify('code',verification),hasCode('github_unavailable'));}finally{clearTimeout(keepAlive);}assert.equal(sent,1);
 const unavailable=createControlGithub({fetchImpl:async()=>{throw Error('private provider token and message');}});await assert.rejects(unavailable.verify('code',verification),hasCode('github_unavailable'));
});

async function fixture(t){
 env(t);assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 const cleanup=()=>store.pool.query('TRUNCATE control_users,control_codes,control_rates,control_github_challenges,control_credit_accounts CASCADE');await cleanup();
 const settings=config(),sent=[],calls=[],proofs=new Map();
 const github={verify:async(code,options)=>{calls.push({code,options});const value=proofs.get(code);if(value instanceof Error)throw value;return value??{subject:'101',email:'builder@example.com'};}};
 const identity=new ControlIdentity({store,config:settings,github,mail:{configured:true,sendCode:async value=>sent.push(value)}});
 const app=Fastify();app.decorate('v2',{});app.decorate('publicFetch',{});registerControl(app,{config:settings},{identity,credits:{usage:async()=>({})}});await app.ready();
 t.after(async()=>{await app.close();await cleanup();await store.close();});
 let address=1;
 const send=(method,path,payload,cookie='',extra={})=>app.inject({method,url:'/control'+path,headers:{origin,'x-fetchx-control-secret':secret,cookie,'x-fetchx-client-ip':'127.0.0.'+(address++),...extra},...(payload===undefined?{}:{payload})});
 const start=async(mode='login',session='',binding='',csrf)=>{
  const response=await send('POST','/auth/github/start',{mode},[session,binding].filter(Boolean).join('; '),csrf?{'x-csrf-token':csrf}:{});assert.equal(response.statusCode,200,response.body);
  const value=response.json(),url=new URL(value.authorization_url);assert.deepEqual(Object.keys(value).sort(),['authorization_url','expires_in']);assert.equal(value.expires_in,300);
  assert.match(response.headers['set-cookie'],/^fetchx_github=fxh_[A-Za-z0-9_-]{43}; Path=\/api\/control; HttpOnly; SameSite=Lax; Secure; Expires=/);
  return {...value,state:url.searchParams.get('state'),proof:url.searchParams.get('code_challenge'),cookie:response.headers['set-cookie'].split(';')[0]};
 };
 const complete=(challenge,code='code',session='',extra={},body)=>send('POST','/auth/github/complete',body??{code,state:challenge.state},[session,challenge.cookie].filter(Boolean).join('; '),extra);
 const emailLogin=async(email)=>{const challenge=await identity.requestCode({email,ip:'127.0.1.'+(address++)});const result=await identity.verifyCode({email,challenge_id:challenge.challenge_id,code:sent.at(-1).code,ip:'127.0.1.'+(address++)});return {...result,cookie:CONTROL_COOKIE+'='+result.session.token,csrf:controlCsrf(result.session.token,secret)};};
 return {store,settings,identity,app,send,start,complete,emailLogin,calls,proofs,sent};
}

test('GitHub durable browser binding, state, expiry and concurrency consume before dispatch',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const f=await fixture(t),{store,send,start,complete,calls}=f;
 assert.deepEqual((await send('GET','/status')).json().github,{enabled:true});
 for(const headers of [{origin:'https://attacker.example'},{'x-fetchx-control-secret':'wrong'}])assert.equal((await send('POST','/auth/github/start',{mode:'login'},'',headers)).statusCode,403);
 for(const body of [{},{mode:'other'},{mode:'login',redirect_uri:'https://attacker.example'}])assert.equal((await send('POST','/auth/github/start',body)).statusCode,400);
 const challenge=await start(),row=(await store.pool.query('SELECT * FROM control_github_challenges')).rows[0];
 assert.ok(!JSON.stringify(row).includes(challenge.state));assert.ok(!JSON.stringify(row).includes(challenge.cookie.split('=')[1]));assert.ok(!Object.hasOwn(row,'verifier'));assert.ok(!JSON.stringify(row).includes(clientSecret));
 for(const cookie of ['',challenge.cookie+'; '+challenge.cookie,'fetchx_github=fxh_'+'x'.repeat(43)])assert.equal((await send('POST','/auth/github/complete',{code:'code',state:challenge.state},cookie)).statusCode,401);
 assert.equal((await complete(challenge,'code','',{}, {code:'code',state:random()})).statusCode,401);assert.equal(calls.length,0);
 const race=await Promise.all([complete(challenge),complete(challenge)]);assert.equal(race.filter(r=>r.statusCode===200).length,1);assert.equal(race.filter(r=>r.statusCode===401).length,1);assert.equal(calls.length,1);
 assert.equal(createHash('sha256').update(calls[0].options.verifier).digest('base64url'),challenge.proof);
 const accepted=race.find(r=>r.statusCode===200);assert.equal(accepted.json().mode,'login');assert.deepEqual(accepted.json().auth_methods,{github:true});assert.deepEqual(accepted.json().projects,[]);assert.ok(!accepted.body.includes(clientSecret));assert.ok(!accepted.body.includes(calls[0].options.verifier));
 const cookies=accepted.headers['set-cookie'];assert.ok(cookies.some(value=>value.startsWith(CONTROL_GITHUB_COOKIE+'=;')&&value.includes('Max-Age=0')));
 const session=cookies.find(value=>value.startsWith(CONTROL_COOKIE+'=')).split(';')[0];assert.deepEqual((await send('GET','/session',undefined,session)).json().auth_methods,{github:true});
 assert.equal((await complete(challenge)).statusCode,401);assert.equal(calls.length,1);
 const expired=await start();await store.pool.query("UPDATE control_github_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE consumed_at IS NULL");assert.equal((await complete(expired)).statusCode,401);
 const replaced=await start();await start('login','',replaced.cookie);assert.equal((await complete(replaced)).statusCode,401);
 const cancelled=await start();const cancellation=await complete(cancelled,undefined,'',{}, {error:'access_denied',state:cancelled.state});assert.equal(cancellation.statusCode,400);assert.equal(cancellation.json().error.code,'github_cancelled');assert.equal((await complete(cancelled)).statusCode,401);
 const malformed=await start();assert.equal((await complete(malformed,'code','',{}, {code:'code',error:'access_denied',state:malformed.state})).statusCode,400);assert.equal((await complete(malformed,'code','',{}, {error:'private provider error',state:malformed.state})).statusCode,400);
 const changed=await start();f.settings.controlPlane.github.clientId='Ov23liOtherSynthetic';assert.equal((await complete(changed)).statusCode,401);f.settings.controlPlane.github.clientId=clientId;
 const counts=(await store.pool.query('SELECT (SELECT count(*) FROM control_users)::int users,(SELECT count(*) FROM control_sessions)::int sessions,(SELECT count(*) FROM control_projects)::int projects,(SELECT count(*) FROM control_keys)::int keys,(SELECT count(*) FROM control_credit_accounts)::int credit_accounts')).rows[0];assert.deepEqual(counts,{users:1,sessions:1,projects:0,keys:0,credit_accounts:0});
});

test('GitHub email collision requires explicit same-session connection and stable subject preserves existing account',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const f=await fixture(t),{store,identity,send,start,complete,emailLogin,proofs,calls}=f;
 const original=await emailLogin('builder@example.com'),other=await emailLogin('other@example.com');
 const project=await identity.createProject(original.user.id,{name:'Existing project'}),key=await identity.createKey(original.user.id,project.id,{name:'Existing key',scopes:['fetch:read']});
 assert.deepEqual(await identity.authMethods(original.user.id),{github:false});
 const collision=await start(),collided=await complete(collision);assert.equal(collided.statusCode,409);assert.equal(collided.json().error.code,'github_account_link_required');assert.equal((await complete(collision)).statusCode,401);
 assert.equal((await send('POST','/auth/github/start',{mode:'login'},original.cookie)).json().error.code,'github_session_conflict');
 assert.equal((await send('POST','/auth/github/start',{mode:'login'},original.cookie+'; '+original.cookie)).statusCode,401);
 assert.equal((await send('POST','/auth/github/start',{mode:'link'},original.cookie)).statusCode,403);assert.equal((await send('POST','/auth/github/start',{mode:'link'})).statusCode,401);
 const link=await start('link',original.cookie,'',original.csrf),before=calls.length;
 const switched=await complete(link,'code',other.cookie,{'x-csrf-token':other.csrf});assert.equal(switched.statusCode,409);assert.equal(calls.length,before);
 assert.equal((await complete(link,'code',original.cookie)).statusCode,403);assert.equal(calls.length,before);
 const linked=await complete(link,'code',original.cookie,{'x-csrf-token':original.csrf});assert.equal(linked.statusCode,200,linked.body);assert.equal(linked.json().mode,'link');assert.equal(linked.json().user.id,original.user.id);assert.deepEqual(linked.json().auth_methods,{github:true});
 assert.ok(linked.headers['set-cookie'].some(value=>value.startsWith(original.cookie+';')));
 const emailChallenge=await send('POST','/auth/code',{email:'builder@example.com'}),emailResponse=await send('POST','/auth/verify',{email:'builder@example.com',challenge_id:emailChallenge.json().challenge_id,code:f.sent.at(-1).code});assert.equal(emailResponse.statusCode,200);assert.deepEqual(emailResponse.json().auth_methods,{github:true});
 const same=await start('link',original.cookie,'',original.csrf);assert.equal((await complete(same,'code',original.cookie,{'x-csrf-token':original.csrf})).statusCode,200);
 const conflict=await start('link',other.cookie,'',other.csrf);assert.equal((await complete(conflict,'code',other.cookie,{'x-csrf-token':other.csrf})).json().error.code,'github_identity_conflict');
 proofs.set('different',{subject:'102',email:'builder@example.com'});const replacement=await start('link',original.cookie,'',original.csrf);assert.equal((await complete(replacement,'different',original.cookie,{'x-csrf-token':original.csrf})).json().error.code,'github_identity_conflict');
 proofs.set('changed',{subject:'101',email:'changed@example.com'});const changed=await start(),stable=await complete(changed,'changed');assert.equal(stable.statusCode,200);assert.equal(stable.json().user.id,original.user.id);assert.equal(stable.json().user.email,'builder@example.com');assert.equal(stable.json().projects[0].id,project.id);
 const newSession=await emailLogin('newsession@example.com'),revoked=await start('link',newSession.cookie,'',newSession.csrf);await identity.revokeSession(newSession.session.token);assert.equal((await complete(revoked,'code',newSession.cookie,{'x-csrf-token':newSession.csrf})).statusCode,409);
 const newer=await emailLogin('builder@example.com'),wrongSession=await start('link',original.cookie,'',original.csrf);assert.equal((await complete(wrongSession,'code',newer.cookie,{'x-csrf-token':newer.csrf})).statusCode,409);
 assert.equal((await identity.authenticateKey(key.token)).project,project.id);
 const counts=(await store.pool.query('SELECT (SELECT count(*) FROM control_github_identities)::int identities,(SELECT count(*) FROM control_projects)::int projects,(SELECT count(*) FROM control_keys)::int keys,(SELECT count(*) FROM control_credit_accounts)::int credit_accounts,(SELECT sum(granted_credits)::int FROM control_credit_accounts) credits')).rows[0];assert.deepEqual(counts,{identities:1,projects:1,keys:1,credit_accounts:1,credits:12});
 await store.init();const restart=new ControlIdentity({store,config:f.settings});assert.deepEqual(await restart.authMethods(original.user.id),{github:true});
});

test('GitHub uncertain failures stay consumed and callback rechecks session after provider work',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const f=await fixture(t),{identity,start,complete,proofs,calls,emailLogin,send}=f;
 const unavailable=new Error('private token');unavailable.code='github_unavailable';
 // Real verifier failures are already sanitized; the control boundary also hides
 // unexpected adapter failures while retaining durable consumption.
 proofs.set('failure',unavailable);const challenge=await start();assert.equal((await complete(challenge,'failure')).statusCode,500);assert.equal((await complete(challenge,'failure')).statusCode,401);assert.equal(calls.length,1);
 const actual=provider({responses:()=>new Response('private provider response and token',{status:503})});identity.github=actual.github;const failed=await start(),failure=await complete(failed);assert.equal(failure.statusCode,503);assert.equal(failure.json().error.code,'github_unavailable');assert.ok(!failure.body.includes('private provider'));assert.equal((await complete(failed)).statusCode,401);assert.equal(actual.calls.length,1);
 const original=await emailLogin('builder@example.com'),link=await start('link',original.cookie,'',original.csrf);
 identity.github={verify:async()=>{await identity.revokeSession(original.session.token);return {subject:'101',email:'builder@example.com'};}};
 assert.equal((await complete(link,'code',original.cookie,{'x-csrf-token':original.csrf})).statusCode,409);assert.deepEqual(await identity.authMethods(original.user.id),{github:false});
 f.settings.controlPlane.github.enabled=false;assert.deepEqual((await send('GET','/status')).json().github,{enabled:false});assert.equal((await send('POST','/auth/github/start',{mode:'login'})).statusCode,503);
});
