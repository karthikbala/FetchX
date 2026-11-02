import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ControlCredits,grantInitialCredits,initControlCredits,reviewedCreditPolicy} from '../src/control-credits.mjs';
import {initControlIdentity} from '../src/control-identity.mjs';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {GatewayError} from '../src/policy.mjs';
import {sha} from '../src/crypto.mjs';
import {V2Gateway,recoverV2} from '../src/v2.mjs';
import {PublicFetchGateway} from '../src/v2-public-fetch.mjs';

const policy=()=>({reviewed:true,version:'trial-v1',trialCredits:10,weights:{direct:1},maxEstimatedMicroUsdPerOperation:0});
const direct={class:'direct',country:null};

test('request credits require reviewed bounded operator weights and keep historical projects unchanged',()=>{
 const config={projects:{legacy:{keyId:'legacy-key'}},controlPlane:{enabled:true,creditPolicy:policy()}},credits=new ControlCredits({store:{},config});
 assert.equal(credits.keyId('legacy'), 'legacy-key');
 assert.throws(()=>credits.keyId('cp_'+randomUUID()),{code:'api_key_identity_required'});
 assert.deepEqual(credits.quote({route:direct,estimatedMicroUsd:0}),{credits:1,policyVersion:'trial-v1'});
 for(const route of [{class:'residential'},{class:'datacenter'}])assert.throws(()=>credits.quote({route,estimatedMicroUsd:0}),{code:'credit_route_forbidden'});
 assert.throws(()=>credits.quote({route:direct,transport:'browser',estimatedMicroUsd:0}),{code:'credit_route_forbidden'});
 assert.throws(()=>credits.quote({route:direct,estimatedMicroUsd:null}),{code:'cost_estimate_unavailable'});
 assert.throws(()=>credits.quote({route:direct,estimatedMicroUsd:1}),{code:'cost_ceiling_exceeded'});
 for(const change of [{reviewed:false},{weights:{direct:0}},{weights:{direct:1,residential:25}},{weights:{direct:1_000_001}},{trialCredits:-1},{maxEstimatedMicroUsdPerOperation:null}]){
  config.controlPlane.creditPolicy={...policy(),...change};assert.throws(()=>reviewedCreditPolicy(config),{code:change.reviewed===false?'credit_policy_unreviewed':'credit_policy_invalid'});
 }
});

test('credit reservations follow real v2 admission, concurrency, replay, isolation and restart recovery',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const root=await mkdtemp(join(tmpdir(),'fetchx-control-credits-')),store=new Store(process.env.TEST_DATABASE_URL);
 await store.init();await initControlIdentity(store.pool);await initControlCredits(store.pool);
 const user=randomUUID(),projects=[];
 await store.pool.query('INSERT INTO control_users(id,email) VALUES($1,$2)',[user,`credits-${user}@example.test`]);
 const profile={id:'credit-source',version:1,origins:['https://credit-source.example'],paths:['^/'],methods:['GET'],headers:['accept','x-source'],proxy_classes:['direct','datacenter','residential'],countries:['US'],limits:{max_requests:100,max_encoded_bytes:4096,max_decoded_bytes:8192,max_session_encoded_bytes:65536,max_input_bytes:1024,max_tunnel_bytes:8192,max_redirects:0,max_expansion_ratio:100,timeout_ms:4000,min_interval_ms:0,ttl_seconds:900}};
 const config={release:'credit-test',artifactDir:root,artifactKey:'a9'.repeat(32),maxDailyFallbackCredits:0,maxConcurrentRequests:8,projects:{},proxies:[],v2:{accessProfiles:{'credit-source@1':profile}},controlPlane:{enabled:true,creditPolicy:policy()}};
 let calls=0,mode='success',entered,unblock;
 const gateway=new Gateway({store,config,profiles:{},resolve:async host=>[{address:host==='private.credit-source.example'?'127.0.0.1':'93.184.216.34',family:4}]});
 gateway.v2=new V2Gateway(gateway,{http:async()=>{
  calls++;
  if(mode==='block'){entered();await new Promise(resolve=>{unblock=resolve;});}
  if(mode==='unknown')throw new GatewayError('source_timeout_unknown',504);
  return {status:200,headers:{'content-type':'text/plain'},raw_headers:['content-type','text/plain'],encoded:Buffer.from('synthetic'),tunnel_bytes:null,provider_status:null};
 }});
 const v2=gateway.v2,fetch=new PublicFetchGateway(v2),credits=v2.controlCredits;
 const makeProject=async amount=>{
  const project='cp_'+randomUUID(),keyId=randomUUID();projects.push(project);
  config.projects[project]={profiles:[],v2_access_profiles:['credit-source@1'],v2_entitlement:{mode:'unmetered'}};
  await store.tx(async c=>{
   await c.query('INSERT INTO control_projects(id,user_id,name,template_hash) VALUES($1,$2,$3,$4)',[project,user,'Synthetic credit project',sha('synthetic-template')]);
   await c.query('INSERT INTO control_keys(id,project,name,prefix,token_hash,scopes) VALUES($1,$2,$3,$4,$5,$6)',[keyId,project,'Synthetic key','fxk_test',sha(keyId),JSON.stringify(['fetch:read','fetch:write'])]);
   await grantInitialCredits(c,project,amount);
  });
  return {project,keyId};
 };
 const payload=key=>({idempotency_key:key,access_profile:{id:profile.id,version:1},url:'https://credit-source.example/data',proxy:direct});
 const submit=(identity,key,extra={})=>fetch.fetch(identity.project,{...payload(key),...extra},{keyId:identity.keyId});
 try{
  await t.test('one logical operation charges once, stores the authenticated key and stays isolated',async()=>{
   const a=await makeProject(2),b=await makeProject(2),before=calls;
   const first=await submit(a,'same-key'),again=await submit(a,'same-key');
   assert.equal(first.state,'completed');assert.equal(first.operation_id,again.operation_id);assert.equal(calls,before+1);
   assert.equal((await v2.readOperation(a.project,first.operation_id)).key_id,a.keyId);
   assert.equal(first.usage.accounting.request_credits.state,'settled');assert.equal(first.usage.accounting.request_credits.credits,1);
   assert.equal((await credits.usage(a.project)).available,1);assert.equal((await credits.usage(b.project)).available,2);
   await assert.rejects(v2.readOperation(b.project,first.operation_id),{code:'operation_not_found'});
   await assert.rejects(submit(a,'same-key',{url:'https://credit-source.example/changed'}),{code:'idempotency_conflict'});
   await store.tx(c=>grantInitialCredits(c,a.project,100));assert.equal((await credits.usage(a.project)).granted,2);
  });
  await t.test('concurrent operations cannot spend the same remaining credit',async()=>{
   const a=await makeProject(1),before=calls;mode='block';
   const started=new Promise(resolve=>{entered=resolve;}),first=submit(a,'concurrent-first');
   await started;
   let replay;
   try{replay=await submit(a,'concurrent-first');assert.equal(replay.state,'running');await assert.rejects(submit(a,'concurrent-second'),{code:'credit_balance_exhausted'});assert.equal((await credits.usage(a.project)).reserved,1);assert.equal(calls,before+1);}
   finally{unblock();}
   assert.equal((await first).operation_id,replay.operation_id);mode='success';assert.equal((await credits.usage(a.project)).settled,1);assert.equal((await credits.usage(a.project)).available,0);
  });
  await t.test('uncertain transport retains its hold and same-key recovery never redispatches',async()=>{
   const a=await makeProject(2);mode='unknown';const first=await submit(a,'unknown'),before=calls;
   assert.equal(first.state,'unknown');assert.equal(first.usage.accounting.request_credits.state,'held');
   assert.equal((await submit(a,'unknown')).operation_id,first.operation_id);assert.equal(calls,before);
   await store.tx(c=>credits.finish(c,{project:a.project,operation:first.operation_id,dispatched:false,unknown:false}));assert.equal((await credits.operation(a.project,first.operation_id)).state,'held');
   const restarted=new ControlCredits({store,config});assert.equal((await restarted.usage(a.project)).held,1);assert.equal((await restarted.usage(a.project)).available,1);mode='success';
  });
  await t.test('known predispatch rejection releases credits and leaves a retained operation',async()=>{
   const a=await makeProject(1),before=calls;
   const first=await submit(a,'rejected-destination',{url:'https://credit-source.example/%2e%2e/private'});
   assert.equal(first.state,'failed');assert.equal(calls,before);assert.equal(first.usage.accounting.request_credits.state,'released');assert.equal((await credits.usage(a.project)).available,1);
   await submit(a,'rejected-destination',{url:'https://credit-source.example/%2e%2e/private'});assert.equal(calls,before);
  });
  await t.test('revoked, cross-project and read-only identities cannot pass operation admission',async()=>{
   const a=await makeProject(3),b=await makeProject(3),before=calls;
   await store.pool.query('UPDATE control_keys SET revoked_at=now() WHERE id=$1',[a.keyId]);
   await assert.rejects(submit(a,'revoked'),{code:'api_key_forbidden'});
   await assert.rejects(submit({...a,keyId:b.keyId},'wrong-project-key'),{code:'api_key_forbidden'});
   await store.pool.query('UPDATE control_keys SET scopes=$2 WHERE id=$1',[b.keyId,JSON.stringify(['fetch:read'])]);
   await assert.rejects(submit(b,'read-only'),{code:'api_key_forbidden'});
   await assert.rejects(fetch.fetch(b.project,payload('missing-identity')),{code:'api_key_identity_required'});
   assert.equal(calls,before);assert.equal((await credits.usage(a.project)).available,3);
   assert.equal(Number((await store.pool.query('SELECT count(*) AS n FROM v2_operations WHERE project=$1',[a.project])).rows[0].n),0);
  });
  await t.test('self-service browser, paid routes and credentials in source headers fail closed',async()=>{
   const a=await makeProject(3),before=calls;
   await assert.rejects(v2.browserProbe(a.project,{}),{code:'self_service_http_only'});
   await assert.rejects(submit(a,'residential',{proxy:{class:'residential',country:'US'}}),{code:'credit_route_forbidden'});
   await assert.rejects(submit(a,'key-header',{headers:{'x-source':'fxk_'+'A'.repeat(43)}}),{code:'credential_scope_rejected'});
   gateway.controlIdentity={isCredential:async value=>value==='synthetic-durable-secret'};
   await assert.rejects(submit(a,'durable-header',{headers:{'x-source':'Bearer synthetic-durable-secret'}}),{code:'credential_scope_rejected'});
   delete gateway.controlIdentity;
   const capabilities=await v2.capabilities(a.project);assert.equal(capabilities.browser_probe.available,false);assert.equal(capabilities.proxy_classes.residential,false);
   const visible=(await v2.profiles(a.project)).access_profiles[0];assert.deepEqual(visible.proxy_classes,['direct']);assert.equal(visible.browser_probe.enabled,false);
   assert.equal(calls,before);assert.equal((await credits.usage(a.project)).available,3);
  });
  await t.test('restart releases only provably undispatched work and holds possible dispatches',async()=>{
   const a=await makeProject(3),execute=v2.execute;v2.execute=async()=>{};
   let reserved,running;
   try{
    reserved=await submit(a,'restart-before-dispatch');running=await submit(a,'restart-possible-dispatch');
   }finally{v2.execute=execute;}
   await store.pool.query("UPDATE v2_operations SET state='running' WHERE id=$1",[running.operation_id]);
   await recoverV2(store.pool);await recoverV2(store.pool);
   assert.equal((await credits.operation(a.project,reserved.operation_id)).state,'released');assert.equal((await credits.operation(a.project,running.operation_id)).state,'held');
   const usage=await credits.usage(a.project);assert.equal(usage.available,2);assert.equal(usage.held,1);assert.equal(usage.released,1);
   const before=calls;await submit(a,'restart-possible-dispatch');assert.equal(calls,before);
  });
 }finally{
  unblock?.();
  await store.pool.query('DELETE FROM control_credit_reservations WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM v2_ledger_events WHERE operation IN (SELECT id FROM v2_operations WHERE project=ANY($1))',[projects]);
  await store.pool.query('DELETE FROM v2_artifacts WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM v2_ledger WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM v2_operations WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM v2_sessions WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM control_credit_accounts WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM control_keys WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM control_projects WHERE id=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM control_users WHERE id=$1',[user]);
  await store.close();await rm(root,{recursive:true,force:true});
 }
});
