import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {sha} from '../src/crypto.mjs';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {V2Gateway} from '../src/v2.mjs';
import {PublicFetchGateway} from '../src/v2-public-fetch.mjs';
import {ControlIdentity} from '../src/control-identity.mjs';
import {ControlCredits} from '../src/control-credits.mjs';
import {registerControl,controlCsrf} from '../src/control.mjs';
import {playgroundDestination,playgroundPolicy,selectPlaygroundKey} from '../src/control-playground.mjs';
import {datacenterPoolFingerprint,fixedFeePoolFingerprint} from '../src/v2-pricing.mjs';

const direct={class:'direct',country:null};
const datacenter={class:'datacenter',country:'US'};
const creditPolicy={reviewed:true,version:'synthetic-legacy',trialCredits:12,weights:{direct:1,datacenter:2},maxEstimatedMicroUsdPerOperation:30_000,
 modeWeights:{reviewed:true,version:'synthetic-modes',http:{residential:3},browser:{direct:4,datacenter:5,residential:6}}};
const playground={enabled:true,reviewed:true,version:'synthetic-playground-v1',maxProfilesPerProject:8,routes:{http:{direct:true,datacenter:['US','GB']},browser:{direct:true,datacenter:['US']}}};
const projectScopes=['fetch:read','fetch:write'];

test('playground validates public URL syntax and selects only active write keys',()=>{
 assert.equal(playgroundDestination('https://Example.com/api?q=sample').href,'https://example.com/api?q=sample');
 for(const value of [
  'http://example.com/','https://example.com:8080/','https://user:pass@example.com/','https://example.com/#',
  'https://127.0.0.1/','https://2130706433/','https://[::1]/','https://private.local/','https://localhost/',
  'https://example.com/%2e%2e/private','https://example.com/white space','https://example.com\\bad'
 ])assert.throws(()=>playgroundDestination(value),{code:/playground_(?:destination_rejected|url_invalid)/});
 const key={id:randomUUID(),scopes:projectScopes},other={id:randomUUID(),scopes:projectScopes},read={id:randomUUID(),scopes:['fetch:read']},revoked={...other,revoked_at:'2026-11-04'};
 assert.equal(selectPlaygroundKey([key,read,revoked]).key.id,key.id);
 assert.equal(selectPlaygroundKey([read,revoked]).error,'playground_key_required');
 assert.equal(selectPlaygroundKey([key,other]).error,'playground_key_selection_required');
 assert.equal(selectPlaygroundKey([key,other],other.id).key.id,other.id);
 assert.equal(selectPlaygroundKey([key,read],read.id).error,'api_key_forbidden');
 assert.equal(selectPlaygroundKey([key,revoked],revoked.id).error,'api_key_forbidden');
 assert.equal(selectPlaygroundKey([key],other.id).error,'api_key_forbidden');
 assert.equal(selectPlaygroundKey([key],'console').error,'playground_key_invalid');
});

test('playground and credit policies require explicit review and preserve legacy HTTP quotes',()=>{
 const policy={...creditPolicy,modeWeights:{...creditPolicy.modeWeights,http:{...creditPolicy.modeWeights.http,direct:7}}};
 const config={controlPlane:{enabled:true,playground,creditPolicy:policy}};
 const credits=new ControlCredits({config});
 const httpProfile={id:'playground:synthetic-http',kind:'playground',playground_execution:'http'};
 const browserProfile={id:'playground:synthetic-browser',kind:'playground',playground_execution:'browser'};
 assert.equal(playgroundPolicy(config).routes.http.datacenter.join(','),'GB,US');
 assert.equal(playgroundPolicy({controlPlane:{playground:{enabled:false}}}),null);
 assert.throws(()=>playgroundPolicy({controlPlane:{playground:{...playground,reviewed:false}}}),{code:'playground_policy_invalid'});
 assert.throws(()=>playgroundPolicy({controlPlane:{playground:{...playground,routes:{http:{direct:true,residential:null}}}}}),{code:'playground_policy_invalid'});
 assert.deepEqual(credits.quote({route:direct,estimatedMicroUsd:0}),{credits:1,policyVersion:'synthetic-legacy'});
 assert.deepEqual(credits.quote({profile:httpProfile,route:direct,estimatedMicroUsd:0}),{credits:7,policyVersion:'synthetic-modes'});
 assert.deepEqual(credits.quote({profile:browserProfile,route:direct,transport:'browser',estimatedMicroUsd:0}),{credits:4,policyVersion:'synthetic-modes'});
 assert.deepEqual(credits.quote({profile:httpProfile,route:{class:'residential'},estimatedMicroUsd:20_000}),{credits:3,policyVersion:'synthetic-modes'});
 assert.throws(()=>credits.quote({profile:browserProfile,route:datacenter,transport:'browser',estimatedMicroUsd:30_001}),{code:'cost_ceiling_exceeded'});
 for(const args of [{route:direct,transport:'browser'},{route:{class:'residential'}},{profile:httpProfile,route:direct,transport:'browser'}])
  assert.throws(()=>credits.quote({...args,estimatedMicroUsd:0}),{code:'credit_route_forbidden'});
 config.controlPlane.creditPolicy={...creditPolicy,modeWeights:undefined};
 assert.throws(()=>credits.quote({profile:browserProfile,route:direct,transport:'browser',estimatedMicroUsd:0}),{code:'credit_route_forbidden'});
});

test('self-service playground reuses exact-origin profiles, checks signed-in attribution and preserves retained operations',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const db=process.env.TEST_DATABASE_URL;
 assert.match(new URL(db).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const store=new Store(db),root=await mkdtemp(join(tmpdir(),'fetchx-playground-test-')),app=Fastify();
 const site='https://fetchx.test',secret='synthetic-playground-bridge-secret-32-bytes';
 const user=randomUUID(),secondUser=randomUUID(),token='fxs_'+'f'.repeat(43);
 const projectIds=[];
 t.after(async()=>{
  await app.close();
  if(projectIds.length)await store.tx(async c=>{
   await c.query('DELETE FROM control_credit_reservations WHERE project=ANY($1)',[projectIds]);
   await c.query('DELETE FROM v2_ledger_events WHERE operation IN (SELECT id FROM v2_operations WHERE project=ANY($1))',[projectIds]);
   for(const table of ['v2_artifacts','v2_ledger','v2_operations','v2_sessions','control_credit_accounts','control_playground_profiles','control_keys','control_memberships'])
    await c.query(`DELETE FROM ${table} WHERE project=ANY($1)`,[projectIds]);
   await c.query('DELETE FROM control_projects WHERE id=ANY($1)',[projectIds]);
  });
  await store.pool.query('DELETE FROM control_sessions WHERE user_id=$1',[user]);
  await store.pool.query('DELETE FROM control_users WHERE id=ANY($1)',[[user,secondUser]]);
  await store.close();await rm(root,{recursive:true,force:true});
 });
 await store.init();
 const proxies=[{id:'test-us-proxy',provider:'oxylabs',pool_id:'test-us-pool',country:'US',url:'http://username:password@127.0.0.1:10001/'}];
 const config={release:'playground-test',artifactDir:root,artifactKey:'b7'.repeat(32),maxConcurrentRequests:4,projects:{},proxies,v2:{accessProfiles:{}},
  datacenterFixedFeePool:{schema_version:1,id:'test-us-pricing',reviewed:true,provider:'oxylabs',pool_id:'test-us-pool',countries:['US'],cost_scope:'incremental_traffic_only',
   fixed_subscription_allocation_micro_usd:null,provenance:{id:'test-pricing-evidence',sha256:'a'.repeat(64),reviewed_at:'2026-01-01T00:00:00Z'},pool_fingerprint_sha256:fixedFeePoolFingerprint(proxies,['US'])},
  controlPlane:{enabled:true,origins:[site],bridgeSecret:secret,projectTemplate:{id:'synthetic-existing-template',v2_access_profiles:[],v2_entitlement:{mode:'metered',max_daily_operations:40}},creditPolicy,playground:structuredClone(playground)}};
 let dns=0,network=0,lastProxy=null;
 const gateway=new Gateway({store,config,profiles:{},resolve:async host=>{dns++;return [{address:host==='private.example.com'?'127.0.0.1':'93.184.216.34',family:4}];}});
 const v2=new V2Gateway(gateway,{browserRuntime:async()=>({available:true}),http:async(input,destination,limits,{proxy})=>{
  network++;lastProxy=proxy?.id??null;
  return {status:200,headers:{'content-type':'text/plain'},raw_headers:['content-type','text/plain'],encoded:Buffer.from('synthetic source body'),tunnel_bytes:proxy?2048:null,provider_status:proxy?200:null};
 }});
 const identity=new ControlIdentity({store,config});
 app.decorate('v2',v2);app.decorate('publicFetch',new PublicFetchGateway(v2));
 registerControl(app,gateway,{identity});await app.ready();
 await store.pool.query('INSERT INTO control_users(id,email) VALUES($1,$2),($3,$4)',[user,`${user}@example.com`,secondUser,`${secondUser}@example.com`]);
 await store.pool.query("INSERT INTO control_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[randomUUID(),user,sha(token)]);
 const project=(await identity.createProject(user,{name:'Playground'})).id;projectIds.push(project);
 const foreign=(await identity.createProject(secondUser,{name:'Other project'})).id;projectIds.push(foreign);
 const foreignKey=await identity.createKey(secondUser,foreign,{name:'Other write key',scopes:projectScopes});
 const prepareBody={url:'https://sample.example.com/resource?test=synthetic',execution:'http',method:'GET',proxy:direct};
 const call=(method,route,payload,{projectId=project,csrf=controlCsrf(token,secret)}={})=>app.inject({
  method,url:`/control/projects/${projectId}${route}`,headers:{origin:site,'x-fetchx-control-secret':secret,cookie:`fetchx_session=${token}`,'x-csrf-token':csrf},
  ...(payload===undefined?{}:{payload})
 });
 const prepare=(extra={},options)=>call('POST','/playground/prepare',{...prepareBody,...extra},options);
 const submit=(key,body,keyId,options)=>call('POST','/fetch',{idempotency_key:key,access_profile:body.access_profile,url:body.url,proxy:direct,method:'GET',...(keyId?{key_id:keyId}:{})},options);
 const profiles=async(projectId=project)=>Number((await store.pool.query('SELECT count(*) AS n FROM control_playground_profiles WHERE project=$1',[projectId])).rows[0].n);
 let writeKey,otherKey,prepared,retained;
 await t.test('prepare is read-only, reports correct key availability and authorizes the project',async()=>{
  assert.equal((await prepare({},{csrf:''})).statusCode,403);
  assert.equal((await prepare({},{projectId:foreign})).statusCode,404);
  assert.equal((await prepare()).json().errors.find(e=>e.field==='key_id').code,'playground_key_required');
  const readKey=await identity.createKey(user,project,{name:'Read only',scopes:['fetch:read']});
  writeKey=await identity.createKey(user,project,{name:'Selected project key',scopes:projectScopes});
  for(const key of [readKey,foreignKey])assert.equal((await prepare({key_id:key.id})).json().errors.find(e=>e.field==='key_id').code,'api_key_forbidden');
  const response=await prepare();assert.equal(response.statusCode,200,response.body);
  prepared=response.json();
  assert.equal(prepared.ready,true,response.body);assert.equal(prepared.selected_key_id,writeKey.id);
  assert.deepEqual(prepared.quote,{credits:1,max_estimated_micro_usd:0});
  assert.equal(prepared.keys.length,1);assert.ok(!response.body.includes(writeKey.token));assert.ok(!response.body.includes('token_hash'));
  assert.equal((await prepare({url:'https://sample.example.com/other'})).json().access_profile.id,prepared.access_profile.id);
  assert.notEqual((await prepare({url:'https://other.example.com/'})).json().access_profile.id,prepared.access_profile.id);
  assert.equal((await prepare({url:'https://127.0.0.1/'})).json().errors.find(e=>e.field==='url').code,'playground_destination_rejected');
  assert.equal((await prepare({method:'POST'})).json().errors.find(e=>e.field==='method').code,'method_rejected');
  assert.equal(await profiles(),0);assert.equal(dns,0);assert.equal(network,0);
 });
 await t.test('route and mode matrix follows US pricing and provider quarantine without DNS',async()=>{
  const response=await prepare({proxy:datacenter});
  assert.equal(response.json().ready,true,response.body);
  assert.deepEqual(response.json().capabilities.routes.find(r=>r.class==='datacenter').countries,['US']);
  const gb=await prepare({proxy:{class:'datacenter',country:'GB'}});
  assert.equal(gb.json().errors.find(e=>e.field==='proxy').code,'country_pool_unavailable');
  const browser=await prepare({execution:'browser',proxy:datacenter});
  assert.equal(browser.json().ready,false,browser.body);
  assert.equal(browser.json().errors.find(e=>e.field==='proxy').code,'cost_estimate_unavailable');
  const details=(await call('GET','')).json().capabilities.playground;
  assert.equal(details.executions.find(mode=>mode.id==='browser').available,true);
  assert.deepEqual(details.routes.find(r=>r.class==='datacenter').executions.browser.countries,[]);
  await store.pool.query("INSERT INTO route_health(profile,proxy_id,quarantined_until) VALUES('synthetic-test',$1,now()+interval '1 hour')",[proxies[0].id]);
  try{assert.equal((await prepare({proxy:datacenter})).json().errors.find(e=>e.field==='proxy').code,'playground_route_unhealthy');}
  finally{await store.pool.query("DELETE FROM route_health WHERE profile='synthetic-test' AND proxy_id=$1",[proxies[0].id]);}
  assert.equal(dns,0);assert.equal(network,0);assert.equal(await profiles(),0);
 });
 await t.test('target-scoped pricing leaves the URL available for preparation and confirms only the scoped target',async()=>{
  const fixed=config.datacenterFixedFeePool;
  delete config.datacenterFixedFeePool;
  const now=Date.now(),instant=offset=>new Date(now+offset).toISOString();
  config.v2.datacenterPricingAttestations=[{
   schema_version:1,id:'test-target-scoped',reviewed:true,provider:'oxylabs',pool_id:proxies[0].pool_id,country:'US',project,
   access_profiles:[prepared.access_profile],transport:'http',cost_scope:'incremental_traffic_only',fixed_subscription_allocation_micro_usd:null,
   valid_from:instant(-60000),expires_at:instant(600000),
   provenance:{id:'test-target-evidence',sha256:'a'.repeat(64),reviewed_at:instant(-120000)},pool_fingerprint_sha256:datacenterPoolFingerprint(proxies,'US')
  }];
  try{
   const initial=(await call('GET','')).json().capabilities.playground.routes.find(route=>route.class==='datacenter').executions.http;
   assert.deepEqual(initial,{available:false,reason:'playground_target_required',countries:[],reviewed_countries:['GB','US']});
   const matching=(await prepare({proxy:datacenter})).json();
   assert.equal(matching.ready,true,JSON.stringify(matching));
   assert.deepEqual(matching.capabilities.routes.find(route=>route.class==='datacenter').countries,['US']);
   const other=(await prepare({url:'https://other.example.com/',proxy:datacenter})).json();
   assert.equal(other.ready,false);
   assert.equal(other.errors.find(error=>error.field==='proxy').code,'cost_estimate_unavailable');
   assert.equal(dns,0);assert.equal(network,0);assert.equal(await profiles(),0);
  }finally{
   delete config.v2.datacenterPricingAttestations;
   config.datacenterFixedFeePool=fixed;
  }
 });
 await t.test('active named key attribution, exact-origin enforcement and replay survive policy rollback',async()=>{
  otherKey=await identity.createKey(user,project,{name:'Second write key',scopes:projectScopes});
  assert.equal((await prepare()).json().errors.find(e=>e.field==='key_id').code,'playground_key_selection_required');
  assert.equal((await submit('missing-named-key',prepared)).json().error.code,'playground_key_selection_required');
  assert.equal((await submit('foreign-named-key',prepared,foreignKey.id)).json().error.code,'api_key_forbidden');
  const mismatched=await submit('foreign-origin',{...prepared,url:'https://other.example.com/'},writeKey.id);
  assert.equal(mismatched.json().error.code,'access_profile_forbidden');assert.equal(network,0);
  const first=await submit('durable-playground',prepared,writeKey.id);
  assert.equal(first.json().state,'completed',first.body);
  retained=first.json();assert.equal(retained.usage.accounting.request_credits.key_id,writeKey.id);
  assert.equal(await profiles(),1);assert.equal(network,1);
  const replay=await submit('durable-playground',prepared,otherKey.id);
  assert.equal(replay.json().operation_id,retained.operation_id);assert.equal(replay.json().usage.accounting.request_credits.key_id,writeKey.id);
  assert.equal(network,1);assert.equal((await v2.controlCredits.usage(project)).settled,1);
  const sameOrigin=(await prepare({url:'https://sample.example.com/different-path',key_id:writeKey.id})).json();
  assert.equal((await submit('durable-second-path',sameOrigin,writeKey.id)).json().state,'completed');
  assert.equal(await profiles(),1);assert.equal(network,2);
  config.controlPlane.playground.enabled=false;
  try{
   assert.equal((await call('GET','/fetch/durable-playground')).json().operation_id,retained.operation_id);
   assert.equal((await call('GET',`/requests/${retained.operation_id}`)).json().operation_id,retained.operation_id);
   assert.equal((await submit('blocked-after-rollback',prepared,writeKey.id)).json().error.code,'access_profile_forbidden');
   assert.equal(network,2);assert.equal((await v2.controlCredits.usage(project)).settled,2);
  }finally{config.controlPlane.playground.enabled=true;}
 });
 await t.test('DNS can reject private answers at dispatch and release credits before source work',async()=>{
  const privateHost=(await prepare({url:'https://private.example.com/resource',key_id:writeKey.id})).json();
  assert.equal(privateHost.ready,true);
  const beforeDns=dns,beforeNetwork=network;
  const request=await submit('private-dns',privateHost,writeKey.id);
  assert.equal(request.json().error.code,'destination_rejected',request.body);
  assert.equal(request.json().usage.accounting.request_credits.state,'released');
  assert.equal(dns,beforeDns+1);assert.equal(network,beforeNetwork);
 });
 await t.test('US datacenter dispatch uses the prepared route and named key with synthetic transport',async()=>{
  const preview=(await prepare({proxy:datacenter,key_id:writeKey.id})).json();
  assert.equal(preview.ready,true);assert.deepEqual(preview.quote,{credits:2,max_estimated_micro_usd:0});
  const before=network;
  const response=await call('POST','/fetch',{idempotency_key:'synthetic-us-datacenter',access_profile:preview.access_profile,url:preview.url,proxy:datacenter,key_id:writeKey.id,max_estimated_micro_usd:0});
  assert.equal(response.json().state,'completed',response.body);
  assert.deepEqual(response.json().routing,{class:'datacenter',country:'US',provider:'configured_datacenter'});
  assert.equal(response.json().usage.accounting.request_credits.key_id,writeKey.id);
  assert.equal(response.json().usage.accounting.request_credits.credits,2);
  assert.equal(lastProxy,proxies[0].id);assert.equal(network,before+1);
 });
 await t.test('admission rechecks the sole-key default when key inventory changes after control selected it',async()=>{
  await identity.revokeKey(user,project,otherKey.id);
  let release,entered;
  const paused=new Promise(resolve=>{entered=resolve;}),proceed=new Promise(resolve=>{release=resolve;});
  const operation=v2.operation.bind(v2);
  v2.operation=async(...args)=>{entered();await proceed;return operation(...args);};
  const before=network,pending=submit('key-selection-race',prepared);
  try{
   await Promise.race([paused,pending.then(response=>assert.fail(response.body))]);
   await identity.createKey(user,project,{name:'Concurrent key',scopes:projectScopes});
  }finally{release();v2.operation=operation;}
  const rejected=await pending;
  assert.equal(rejected.json().error.code,'playground_key_selection_required',rejected.body);assert.equal(network,before);
 });
 await t.test('admission rechecks membership after the selected key leaves the control route',async()=>{
  let release,entered;
  const paused=new Promise(resolve=>{entered=resolve;}),proceed=new Promise(resolve=>{release=resolve;});
  const operation=v2.operation.bind(v2);
  v2.operation=async(...args)=>{entered();await proceed;return operation(...args);};
  const fresh=(await prepare({url:'https://membership-race.example.com/',key_id:writeKey.id})).json();
  const before=network,beforeProfiles=await profiles(),pending=submit('membership-race',fresh,writeKey.id);
  try{
   await Promise.race([paused,pending.then(response=>assert.fail(response.body))]);
   await store.pool.query('DELETE FROM control_memberships WHERE user_id=$1 AND project=$2',[user,project]);
   release();
   const rejected=await pending;
   assert.equal(rejected.json().error.code,'project_not_found',rejected.body);assert.equal(network,before);assert.equal(await profiles(),beforeProfiles);
  }finally{
   release();v2.operation=operation;
   await store.pool.query('INSERT INTO control_memberships(user_id,project) VALUES($1,$2) ON CONFLICT DO NOTHING',[user,project]);
  }
 });
 await t.test('invalid bodies and insufficient credit leave the only origin slot free for an admitted operation',async()=>{
  const previous=config.controlPlane.playground;
  config.controlPlane.playground={...previous,version:'synthetic-playground-single-slot',maxProfilesPerProject:1};
  const limited=(await identity.createProject(user,{name:'Single origin slot'})).id;
  projectIds.push(limited);
  const key=await identity.createKey(user,limited,{name:'Write key',scopes:projectScopes}),options={projectId:limited};
  const before=network;
  try{
   const first=(await prepare({url:'https://first.example.com/'},options)).json();
   assert.equal(first.errors.find(error=>error.field==='credits').code,'credit_balance_exhausted');
   const invalid=await call('POST','/fetch',{idempotency_key:'invalid-body-no-slot',access_profile:first.access_profile,url:first.url,proxy:direct,method:'GET',body_base64:'AA=='},options);
   assert.equal(invalid.json().error.code,'body_rejected',invalid.body);
   const invalidHeaders=await call('POST','/fetch',{idempotency_key:'invalid-headers-no-slot',access_profile:first.access_profile,url:first.url,proxy:direct,headers:{'x-unapproved':'synthetic'}},options);
   assert.equal(invalidHeaders.json().error.code,'headers_rejected',invalidHeaders.body);
   const noCredit=await submit('no-credit-no-slot',first,key.id,options);
   assert.equal(noCredit.json().error.code,'credit_balance_exhausted',noCredit.body);
   assert.equal(network,before);assert.equal(await profiles(limited),0);
   await store.pool.query('UPDATE control_credit_accounts SET granted_credits=4 WHERE project=$1',[limited]);
   const second=(await prepare({url:'https://second.example.com/'},options)).json();
   assert.equal(second.ready,true,JSON.stringify(second));
   const accepted=await submit('accepted-single-slot',second,key.id,options);
   assert.equal(accepted.json().state,'completed',accepted.body);
   assert.equal(await profiles(limited),1);assert.equal(network,before+1);
   const repeated=await submit('accepted-single-slot',second,key.id,options);
   assert.equal(repeated.json().operation_id,accepted.json().operation_id);
   assert.equal(await profiles(limited),1);assert.equal(network,before+1);
   const rejected=await submit('blocked-origin-cap',first,key.id,options);
   assert.equal(rejected.json().error.code,'playground_profile_limit',rejected.body);
   assert.equal(network,before+1);assert.equal((await v2.controlCredits.usage(limited)).settled,1);
  }finally{config.controlPlane.playground=previous;}
 });
});
