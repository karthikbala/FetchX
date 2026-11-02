import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {exportJWK,generateKeyPair,SignJWT} from 'jose';
import {createControlGoogle,googleConfiguration} from '../src/control-google.mjs';
import {ControlIdentity} from '../src/control-identity.mjs';
import {registerControl,CONTROL_COOKIE,CONTROL_GOOGLE_COOKIE,controlCsrf} from '../src/control.mjs';
import {Store} from '../src/store.mjs';

const clientId='123456789012-synthetic-web-client.apps.googleusercontent.com';
const issuer='https://accounts.google.com',origin='https://fetchx.ai';
const secret='synthetic-google-bridge-secret-at-least-32-bytes';
const nonce=()=>randomBytes(32).toString('base64url');
const hasCode=code=>error=>error?.code===code;
const pair=await generateKeyPair('RS256',{extractable:true});
const publicKey={...await exportJWK(pair.publicKey),kid:'synthetic-key',alg:'RS256',use:'sig'};
const keyResponse=(keys=[publicKey],headers={})=>Response.json({keys},{headers:{'cache-control':'public, max-age=3600',...headers}});
async function token(challengeNonce,extra={},key=pair.privateKey,header={}){
 const now=Math.floor(Date.now()/1000);
 return new SignJWT({iss:issuer,aud:clientId,sub:'google-subject-one',iat:now,exp:now+3600,email:'builder@workspace.example',email_verified:true,hd:'workspace.example',nonce:challengeNonce,...extra}).setProtectedHeader({alg:'RS256',kid:publicKey.kid,...header}).sign(key);
}
function verifier(options={}){
 const calls=[];
 const google=createControlGoogle({fetchImpl:async(url,input)=>{calls.push({url,input});return keyResponse();},...options});
 return {google,calls};
}
function config(){return {projects:{},v2:{accessProfiles:{'synthetic@1':{id:'synthetic',version:1}}},controlPlane:{enabled:true,origins:[origin],bridgeSecret:secret,google:{enabled:true,clientId},projectTemplate:{id:'synthetic',v2_access_profiles:['synthetic@1'],v2_entitlement:{mode:'metered',max_daily_operations:10}},creditPolicy:{reviewed:true,version:'test-v1',trialCredits:12,weights:{direct:1},maxEstimatedMicroUsdPerOperation:0}}};}

test('Google sign-in is disabled unless a Google web client is explicitly configured',async()=>{
 assert.deepEqual(googleConfiguration({}),{enabled:false,client_id:null});
 for(const google of [{enabled:false,clientId},{enabled:true,clientId:'attacker.example'},{enabled:true,clientId:clientId+'\n'}])assert.deepEqual(googleConfiguration({controlPlane:{google}}),{enabled:false,client_id:null});
 assert.deepEqual(googleConfiguration(config()),{enabled:true,client_id:clientId});
 const identity=new ControlIdentity({store:{},config:{controlPlane:{enabled:true,bridgeSecret:secret}}});
 await assert.rejects(identity.requestGoogleChallenge({ip:'127.0.0.1'}),hasCode('google_disabled'));
});

test('Google verifier validates signed identity claims and caches only fixed-origin public keys',async()=>{
 const {google,calls}=verifier(),n=nonce();
 const claims=await google.verify(await token(n),{clientId});
 assert.deepEqual(claims,{issuer,subject:'google-subject-one',email:'builder@workspace.example',nonce:n,authoritative:true});
 const gmail=await google.verify(await token(n,{iss:'accounts.google.com',email:'Builder@gmail.com',hd:undefined}),{clientId});
 assert.equal(gmail.issuer,issuer);assert.equal(gmail.email,'builder@gmail.com');assert.equal(gmail.authoritative,true);
 const external=await google.verify(await token(n,{email:'external@other.example',hd:undefined}),{clientId});assert.equal(external.authoritative,false);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://www.googleapis.com/oauth2/v3/certs');assert.equal(calls[0].input.redirect,'manual');assert.equal(calls[0].input.headers.accept,'application/json');
 assert.ok(calls[0].input.signal instanceof AbortSignal);assert.equal(JSON.stringify(calls).includes(n),false);
});

test('Google verifier rejects audience, issuer, authorized party, lifetime, signature and claim confusion',async()=>{
 const {google,calls}=verifier(),n=nonce(),now=Math.floor(Date.now()/1000);
 for(const extra of [
  {aud:'987654321000-other-client.apps.googleusercontent.com'},
  {iss:'https://accounts.google.com.attacker.example'},
  {azp:'987654321000-other-client.apps.googleusercontent.com'},
  {aud:[clientId,'other-client']},
  {exp:now-1,iat:now-3600},
  {iat:now+120,exp:now+3600},
  {iat:undefined},{exp:undefined},{exp:now+7200},
  {sub:''},{sub:'subject\nforged'},{sub:'s'.repeat(256)},
  {nonce:undefined},{nonce:'short'},
  {email_verified:false},{email_verified:'true'},
  {email:'address\r\n@workspace.example'},{email:'x'.repeat(65)+'@workspace.example'},
  {hd:'not a domain'},
 ])await assert.rejects(google.verify(await token(n,extra),{clientId}),hasCode('google_verification_invalid'));
 const wrong=await generateKeyPair('RS256');await assert.rejects(google.verify(await token(n,{},wrong.privateKey),{clientId}),hasCode('google_verification_invalid'));
 const hmac=new SignJWT({}).setProtectedHeader({alg:'HS256',kid:publicKey.kid});
 await assert.rejects(google.verify(await hmac.sign(randomBytes(32)),{clientId}),hasCode('google_verification_invalid'));
 for(const value of ['broken','x'.repeat(17000),'e30.e30.signature'])await assert.rejects(google.verify(value,{clientId}),hasCode('google_verification_invalid'));
 assert.equal(calls.length,1);
});

test('Google public-key retrieval is bounded, rejects redirects and hides provider errors',async()=>{
 const n=nonce(),signed=await token(n);
 for(const response of [
  ()=>new Response(null,{status:302,headers:{location:'https://attacker.example/keys'}}),
  ()=>new Response('upstream private detail',{status:503}),
  ()=>new Response('private detail',{headers:{'content-type':'text/plain'}}),
  ()=>new Response('{',{headers:{'content-type':'application/json'}}),
  ()=>Response.json({keys:[]}),
  ()=>Response.json({keys:Array.from({length:21},()=>publicKey)}),
  ()=>new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}}),
 ]){
  let calls=0;const google=createControlGoogle({fetchImpl:async()=>{calls++;return response();}});
  await assert.rejects(google.verify(signed,{clientId}),error=>error.code==='google_unavailable'&&!error.message.includes('private'));assert.equal(calls,1);
 }
 const unavailable=createControlGoogle({fetchImpl:async()=>{throw Error('private provider details');}});
 await assert.rejects(unavailable.verify(signed,{clientId}),hasCode('google_unavailable'));
});

test('Google key cache respects expiry and refreshes once for key rotation after cooldown',async()=>{
 let clock=Date.now(),calls=0;const next=await generateKeyPair('RS256',{extractable:true});
 const rotated={...await exportJWK(next.publicKey),kid:'rotated',alg:'RS256',use:'sig'};
 const google=createControlGoogle({now:()=>clock,fetchImpl:async()=>{calls++;return keyResponse(calls===1?[publicKey]:[publicKey,rotated],{'cache-control':'max-age=60'});}});
 const n=nonce();await google.verify(await token(n),{clientId});
 const newer=await token(n,{},next.privateKey,{kid:rotated.kid});
 await assert.rejects(google.verify(newer,{clientId}),hasCode('google_verification_invalid'));assert.equal(calls,1);
 clock+=31000;await google.verify(newer,{clientId});assert.equal(calls,2);
 clock+=61000;await google.verify(await token(n),{clientId});assert.equal(calls,3);
});

test('real Google identity routes reuse the verified account and atomically bind browser, nonce and subject',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 const cleanup=()=>store.pool.query('TRUNCATE control_users,control_codes,control_rates,control_google_challenges,control_credit_accounts CASCADE');
 await cleanup();
 const settings=config(),sent=[],{google,calls}=verifier();
 const identity=new ControlIdentity({store,config:settings,google,mail:{configured:true,sendCode:async value=>sent.push(value)}});
 const mailChallenge=await identity.requestCode({email:'builder@workspace.example',ip:'127.0.0.1'});
 const existing=await identity.verifyCode({email:'builder@workspace.example',challenge_id:mailChallenge.challenge_id,code:sent[0].code,ip:'127.0.0.1'});
 const project=await identity.createProject(existing.user.id,{name:'Existing project'}),apiKey=await identity.createKey(existing.user.id,project.id,{name:'Existing key',scopes:['fetch:read']});
 await store.init();assert.equal((await identity.session(existing.session.token)).user.id,existing.user.id);
 const app=Fastify();app.decorate('v2',{});app.decorate('publicFetch',{});
 registerControl(app,{config:settings},{identity,credits:{usage:async()=>({})}});await app.ready();
 const send=(method,path,payload,cookie='',extra={})=>app.inject({method,url:'/control'+path,headers:{origin,'x-fetchx-control-secret':secret,cookie,...extra},...(payload===undefined?{}:{payload})});
 const start=async(cookie='',ip='127.0.0.2')=>{
  const response=await send('POST','/auth/google/challenge',{},cookie,{'x-fetchx-client-ip':ip});assert.equal(response.statusCode,200,response.body);
  const value=response.json(),set=response.headers['set-cookie'];assert.equal(Object.keys(value).sort().join(','),'challenge_id,client_id,expires_in,nonce');
  assert.equal(value.expires_in,300);assert.equal(value.client_id,clientId);assert.match(set,/^fetchx_google=fxg_[A-Za-z0-9_-]{43}; Path=\/api\/control; HttpOnly; SameSite=Lax; Secure; Expires=/);
  return {...value,cookie:set.split(';')[0]};
 };
 const verify=(challenge,credential,extra={})=>send('POST','/auth/google/verify',{challenge_id:challenge.challenge_id,credential},challenge.cookie,extra);
 try{
  const status=await send('GET','/status');assert.deepEqual(status.json().google,{enabled:true,client_id:clientId});
  assert.equal((await send('POST','/auth/google/challenge',{},'',{origin:'https://attacker.example'})).statusCode,403);
  assert.equal((await send('POST','/auth/google/challenge',{client_id:'attacker'})).statusCode,400);
  const challenge=await start(),signed=await token(challenge.nonce);
  const stored=(await store.pool.query('SELECT * FROM control_google_challenges WHERE id=$1',[challenge.challenge_id])).rows[0];
  assert.notEqual(stored.nonce_hash,challenge.nonce);assert.ok(!JSON.stringify(stored).includes(challenge.cookie.split('=')[1]));
  for(const cookie of ['',`${challenge.cookie}; ${challenge.cookie}`,'fetchx_google=fxg_'+'x'.repeat(43)]){
   const denied=await send('POST','/auth/google/verify',{challenge_id:challenge.challenge_id,credential:signed},cookie);assert.equal(denied.statusCode,401);
  }
  const wrongNonce=await verify(challenge,await token(nonce()));assert.equal(wrongNonce.statusCode,401);assert.equal(wrongNonce.json().error.code,'google_verification_invalid');
  const outcomes=await Promise.all([verify(challenge,signed),verify(challenge,signed)]);
  assert.equal(outcomes.filter(r=>r.statusCode===200).length,1);assert.equal(outcomes.filter(r=>r.statusCode===401).length,1);
  const accepted=outcomes.find(r=>r.statusCode===200),cookies=accepted.headers['set-cookie'];assert.ok(Array.isArray(cookies));assert.equal(cookies.length,2);
  const session=cookies.find(c=>c.startsWith(CONTROL_COOKIE+'=')).split(';')[0];
  assert.ok(cookies.some(c=>c.startsWith(CONTROL_GOOGLE_COOKIE+'=;')&&c.includes('Max-Age=0')));
  assert.equal(accepted.json().user.id,existing.user.id);assert.equal(accepted.json().projects[0].id,project.id);assert.equal(accepted.json().csrf_token,controlCsrf(session.split('=')[1],secret));
  assert.ok(!accepted.body.includes(signed));assert.ok(!accepted.body.includes(session.split('=')[1]));assert.ok(!accepted.body.includes(challenge.nonce));
  const authenticated=await send('GET','/session',undefined,session);assert.equal(authenticated.json().user.id,existing.user.id);
  assert.equal((await verify(challenge,signed)).statusCode,401);
  const counts=(await store.pool.query('SELECT (SELECT count(*) FROM control_users)::int users,(SELECT count(*) FROM control_projects)::int projects,(SELECT count(*) FROM control_keys)::int keys,(SELECT count(*) FROM control_google_identities)::int identities,(SELECT sum(granted_credits)::int FROM control_credit_accounts) credits')).rows[0];
  assert.equal(counts.users,1);assert.equal(counts.projects,1);assert.equal(counts.keys,1);assert.equal(counts.identities,1);assert.equal(counts.credits,12);
  assert.equal((await identity.authenticateKey(apiKey.token)).project,project.id);

  const changed=await start('', '127.0.0.3'),changedEmail=await verify(changed,await token(changed.nonce,{email:'new@external.example',hd:undefined}));
  assert.equal(changedEmail.statusCode,200);assert.equal(changedEmail.json().user.id,existing.user.id);assert.equal(changedEmail.json().user.email,'builder@workspace.example');
  const conflict=await start('', '127.0.0.4'),conflicted=await verify(conflict,await token(conflict.nonce,{sub:'different-google-subject'}));
  assert.equal(conflicted.statusCode,409);assert.equal(conflicted.json().error.code,'google_identity_conflict');
  const external=await start('', '127.0.0.5'),externalResult=await verify(external,await token(external.nonce,{sub:'external-subject',email:'external@other.example',hd:undefined}));
  assert.equal(externalResult.statusCode,403);assert.equal(externalResult.json().error.code,'google_email_verification_required');
  assert.equal(Number((await store.pool.query('SELECT count(*) n FROM control_users')).rows[0].n),1);
  const expired=await start('', '127.0.0.6');await store.pool.query("UPDATE control_google_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.challenge_id]);assert.equal((await verify(expired,await token(expired.nonce))).statusCode,401);
  const replaced=await start('', '127.0.0.7');await start(replaced.cookie,'127.0.0.7');assert.equal((await verify(replaced,await token(replaced.nonce))).statusCode,401);
  const exhausted=await start('', '127.0.0.8');for(let n=0;n<5;n++)assert.equal((await verify(exhausted,await token(nonce()))).statusCode,401);assert.equal((await verify(exhausted,await token(exhausted.nonce))).statusCode,401);
  const fresh=await start('', '127.0.0.9');settings.controlPlane.google.clientId='987654321000-other-web-client.apps.googleusercontent.com';assert.equal((await verify(fresh,await token(fresh.nonce))).statusCode,401);settings.controlPlane.google.clientId=clientId;
  const created=await start('', '127.0.0.10'),newUser=await verify(created,await token(created.nonce,{sub:'new-google-subject',email:'new@gmail.com',hd:undefined}));
  assert.equal(newUser.statusCode,200);assert.notEqual(newUser.json().user.id,existing.user.id);assert.deepEqual(newUser.json().projects,[]);
  const final=(await store.pool.query('SELECT (SELECT count(*) FROM control_projects)::int projects,(SELECT count(*) FROM control_keys)::int keys,(SELECT count(*) FROM control_credit_accounts)::int credit_accounts')).rows[0];assert.deepEqual(final,{projects:1,keys:1,credit_accounts:1});
  settings.controlPlane.google.enabled=false;assert.deepEqual((await send('GET','/status')).json().google,{enabled:false,client_id:null});assert.equal((await send('POST','/auth/google/challenge',{})).statusCode,503);
  assert.equal(calls.length,1);
 }finally{await app.close();await cleanup();await store.close();}
});
