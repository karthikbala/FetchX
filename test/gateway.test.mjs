import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {server} from '../src/main.mjs';
import {sha} from '../src/crypto.mjs';
import {pruneArtifacts} from '../src/artifacts.mjs';
const enabled=!!process.env.TEST_DATABASE_URL;
test('durable workflow, sticky session, idempotency, fallback accounting and restart recovery',{skip:!enabled},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/(?:gateway_conformance|gateway_test)(?:_[A-Za-z0-9]+)?$/,'conformance requires an explicitly named disposable gateway database');
 const root=await mkdtemp(join(tmpdir(),'gateway-test-')),store=new Store(process.env.TEST_DATABASE_URL);
 await store.init();await store.pool.query('TRUNCATE ledger,attempts,operations,workflows,source_limits RESTART IDENTITY CASCADE');
 const base={hosts:['source.example'],methods:['GET','POST'],headers:['cookie','content-type'],country:'IN',maxConcurrent:4,maxRequests:20,maxInputBytes:1024,maxResponseBytes:1024,maxBytes:30000,ttlSeconds:120,minIntervalMs:0,maxFallbackCredits:4,fallbackMaxCost:1};
 const config={release:'test',artifactDir:root,artifactKey:'11'.repeat(32),maxDailyFallbackCredits:10,scrapeDoToken:'private-provider',projects:{a:{tokenHash:sha('secret-a'),profiles:['source']},b:{tokenHash:sha('secret-b'),profiles:['source']}},proxies:[{id:'in-1',country:'IN',url:'private1'},{id:'in-2',country:'IN',url:'private2'}]};
 const calls=[],transport={oxylabs:async(input,proxy)=>{calls.push({provider:'oxylabs',proxy:proxy.id,cookie:input.headers.cookie});if(input.url.endsWith('/denied'))return {status:403,headers:{},cookies:[],body:Buffer.from('denied')};return {status:200,headers:{'content-type':'text/html'},cookies:['sid=1; Path=/; Secure'],body:Buffer.from('source')};},scrapedo:async()=>{calls.push({provider:'scrapedo'});return {status:200,providerStatus:200,headers:{},cookies:[],body:Buffer.from('fallback'),credits:1};}};
 const g=new Gateway({store,config,profiles:{source:base},resolve:async()=>[{address:'93.184.216.34'}],transport});const app=server(g);
 try{
  const denied=await app.inject({method:'POST',url:'/v1/workflows',payload:{profile:'source',idempotency_key:'test'}});assert.equal(denied.statusCode,401);
  const w=await g.workflow('a',{profile:'source',idempotency_key:'one'});
  const session=(await g.owned('a',w.id)).config.providerSession;assert.ok(Number.isInteger(session)&&session>=0&&session<=1000000);
  assert.equal((await g.workflow('a',{profile:'source',idempotency_key:'one'})).id,w.id);
  const input={idempotency_key:'req1',url:'https://source.example/one',headers:{}};
  const first=await g.operation('a',w.id,input);assert.equal(first.provider,'oxylabs');assert.equal(first.credits,null);
  assert.deepEqual(await g.operation('a',w.id,input),first);assert.equal(calls.length,1);
  assert.deepEqual(await g.lookup('a',w.id,'req1'),first);assert.equal(calls.length,1);
  await assert.rejects(g.lookup('b',w.id,'req1'),/workflow_not_found/);
  await assert.rejects(g.operation('a',w.id,{...input,url:'https://source.example/changed'}),/idempotency_conflict/);
  // Losing optional diagnostic storage must not lose a source capture, settle
  // twice, retry a provider, or break an established browser cookie session.
  await store.pool.query(`CREATE FUNCTION reject_protection_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'diagnostic storage unavailable'; END $$;
   CREATE TRIGGER reject_protection_for_test BEFORE UPDATE OF protection ON attempts FOR EACH ROW EXECUTE FUNCTION reject_protection_for_test()`);
  let second;
  try{second=await g.operation('a',w.id,{...input,idempotency_key:'req2',headers:{cookie:'sid=1'}});}
  finally{await store.pool.query('DROP TRIGGER reject_protection_for_test ON attempts; DROP FUNCTION reject_protection_for_test()');}
  assert.equal(Buffer.from(second.body_base64,'base64').toString(),'source');
  const observed=(await store.pool.query('SELECT a.state,a.protection,(SELECT count(*)::int FROM ledger l WHERE l.attempt=a.id) AS ledger_events FROM attempts a WHERE operation=$1',[second.id])).rows;
  assert.equal(observed.length,1);assert.equal(observed[0].state,'settled');assert.equal(observed[0].protection,null);assert.equal(observed[0].ledger_events,2);
  assert.equal(calls[0].proxy,calls[1].proxy);assert.equal(calls[1].cookie,'sid=1');
  await assert.rejects(g.result('b',first.id),/operation_not_found/);
  await g.close('a',w.id);await assert.rejects(g.operation('a',w.id,{...input,idempotency_key:'req3'}),/workflow_closed/);
  const other=await g.workflow('a',{profile:'source',idempotency_key:'two'});
  await g.operation('a',other.id,{...input,url:'https://source.example/one'});assert.notEqual(calls[0].proxy,calls[2].proxy);
  // Later denial must not change the established IP/provider/session.
  const later=await g.operation('a',other.id,{...input,idempotency_key:'later',url:'https://source.example/denied'});assert.equal(later.provider,'oxylabs');assert.equal(later.status,403);
  const fallback=await g.workflow('a',{profile:'source',idempotency_key:'fallback'});
  const fall=await g.operation('a',fallback.id,{...input,url:'https://source.example/denied'});assert.equal(fall.provider,'scrapedo');assert.equal(fall.credits,1);
  assert.equal((await g.read('a',fallback.id)).route,'scrapedo');
  transport.scrapedo=async()=>{await new Promise(r=>setTimeout(r,30));return {status:200,providerStatus:200,headers:{},cookies:[],body:Buffer.from('paid'),credits:1};};
  const simultaneous=await Promise.all([g.operation('a',fallback.id,{...input,idempotency_key:'paid-a'}),g.operation('a',fallback.id,{...input,idempotency_key:'paid-b'})]);
  assert.equal(simultaneous.length,2);assert.ok(simultaneous.every(x=>x.credits===1));
  // Unknown billing remains reserved across restart and cannot be duplicated by the same operation.
  transport.scrapedo=async()=>({status:null,providerStatus:502,headers:{},cookies:[],body:Buffer.alloc(0),credits:null,error:'metered_outcome_unknown'});
  const unknown=await g.operation('a',fallback.id,{...input,idempotency_key:'unknown'});assert.equal(unknown.error,'metered_outcome_unknown');
  await store.recover();assert.deepEqual(await g.operation('a',fallback.id,{...input,idempotency_key:'unknown'}),unknown);
  await assert.rejects(g.operation('a',fallback.id,{...input,idempotency_key:'no-extra'}),/fallback_limit/);
  const ledger=(await store.pool.query("SELECT * FROM ledger WHERE event='held_unknown'")).rows;assert.equal(ledger.length,1);
  // Resource concurrency must not multiply request or byte allowance.
  config.projects.a.profiles.push('parallel');g.profiles.parallel={...base,maxRequests:3,maxConcurrent:4,maxBytes:10000};
  const parallel=await g.workflow('a',{profile:'parallel',idempotency_key:'parallel'});
  await g.operation('a',parallel.id,{...input,idempotency_key:'bootstrap'});
  const before=calls.length;
  const results=await Promise.allSettled(Array.from({length:5},(_,i)=>g.operation('a',parallel.id,{...input,idempotency_key:'asset'+i})));
  assert.equal(calls.length-before,2);assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
  assert.equal((await g.read('a',parallel.id)).requests,3);
  await g.close('a',other.id);g.profiles.source.allowFallbackRestart=true;
  await store.pool.query("UPDATE workflows SET config=config || '{\"allowFallbackRestart\":true}'::jsonb WHERE id=$1",[other.id]);
  const retained=(await g.read('a',other.id)).requests;
  const restarted=await g.fallback('a',other.id,{reason:'native_flow_incomplete',evidence:'sha256:'+'a'.repeat(64)});
  assert.equal(restarted.id,other.id);assert.equal(restarted.route,'scrapedo');assert.equal(restarted.requests,retained);
  await assert.rejects(g.fallback('a',other.id,{reason:'native_flow_incomplete',evidence:'sha256:'+'a'.repeat(64)}),/fallback_restart_rejected/);
  // Storage pressure rejects work before dispatch; expiry does not erase the ledger or reissue a request.
  config.maxArtifactBytes=1;
  const beforeQuota=calls.length;
  await assert.rejects(g.operation('a',parallel.id,{...input,idempotency_key:'quota'}),/workflow_closed|workflow_limit|artifact_quota/);
  const quota=await g.workflow('a',{profile:'source',idempotency_key:'quota'});
  await assert.rejects(g.operation('a',quota.id,input),/artifact_quota/);assert.equal(calls.length,beforeQuota);
  delete config.maxArtifactBytes;
  await store.pool.query("UPDATE operations SET created_at=now()-interval '8 days' WHERE id=$1",[first.id]);
  assert.equal(await pruneArtifacts(store,config),1);
  await assert.rejects(g.result('a',first.id),/capture_expired/);
  await assert.rejects(g.operation('a',w.id,input),/capture_expired/);assert.equal(calls.length,beforeQuota);
  const cooldown=await g.workflow('a',{profile:'source',idempotency_key:'cooldown'});
  transport.oxylabs=async()=>({status:429,headers:{'retry-after':'120'},cookies:[],body:Buffer.alloc(0)});
  await g.operation('a',cooldown.id,input);
  await assert.rejects(g.operation('a',cooldown.id,{...input,idempotency_key:'cooldown-followup'}),/source_cooldown/);
 }finally{await app.close();await store.close();await rm(root,{recursive:true,force:true});}
});
