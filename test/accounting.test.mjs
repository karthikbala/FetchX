import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {sha} from '../src/crypto.mjs';
import {pruneArtifacts} from '../src/artifacts.mjs';

const enabled=!!process.env.TEST_DATABASE_URL;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const reply=(status=200)=>({status,headers:{},cookies:[],body:Buffer.from('fixture')});
const request=key=>({idempotency_key:key,url:'https://source.example/data',headers:{}});
async function fixture(run,overrides={}){
 const url=new URL(process.env.TEST_DATABASE_URL);
 assert.match(url.pathname,/^\/(?:gateway_conformance|gateway_test)(?:_[A-Za-z0-9]+)?$/,'accounting tests require a disposable gateway database');
 const admin=new Store(url.href),schema='accounting_'+randomUUID().replaceAll('-','');
 await admin.pool.query('CREATE SCHEMA '+schema);
 url.searchParams.set('options','-c search_path='+schema);
 const store=new Store(url.href),root=await mkdtemp(join(tmpdir(),'gateway-accounting-'));
 const profile={hosts:['source.example'],methods:['GET'],headers:[],country:'IN',maxConcurrent:4,maxRequests:20,maxInputBytes:1024,maxResponseBytes:1024,maxBytes:30000,ttlSeconds:120,minIntervalMs:0,maxFallbackCredits:4,fallbackMaxCost:1,...overrides};
 const config={release:'test',artifactDir:root,artifactKey:'11'.repeat(32),maxDailyFallbackCredits:10,scrapeDoToken:'private-fixture-token',projects:{a:{profiles:['source']}},proxies:[{id:'in-1',country:'IN',url:'https://proxy.example'}]};
 const calls=[],transport={oxylabs:async input=>{calls.push(input.idempotency_key);return reply();},scrapedo:async input=>{calls.push('paid:'+input.idempotency_key);return {...reply(),providerStatus:200,credits:1};}};
 try{
  await store.init();
  const gateway=new Gateway({store,config,profiles:{source:profile},resolve:async()=>[{address:'93.184.216.34'}],transport});
  const workflow=await gateway.workflow('a',{profile:'source',idempotency_key:'fixture'});
  await run({gateway,workflow,store,transport,calls,config});
 }finally{await store.close();await admin.pool.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();await rm(root,{recursive:true,force:true});}
}
async function reserved(store,key){
 for(let i=0;i<200;i++){
  if((await store.pool.query("SELECT 1 FROM attempts a JOIN operations o ON o.id=a.operation WHERE o.key=$1 AND a.state='reserved'",[key])).rowCount)return;
  await pause(5);
 }
 assert.fail('attempt never entered reserved state');
}

test('a gateway bearer token cannot be forwarded through an approved guest header scope',{skip:!enabled},async()=>fixture(async({gateway,workflow,calls,store})=>{
 gateway.config.projects.a.tokenHash=sha('private-gateway-token');
 for(const value of ['Bearer private-gateway-token','private-gateway-token','  Bearer private-gateway-token  ']){
  await assert.rejects(gateway.operation('a',workflow.id,{...request('must-not-forward'),headers:{authorization:value}}),/credential_scope_rejected/);
 }
 assert.deepEqual(calls,[]);
 assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM operations')).rows[0].n,0);
 await gateway.operation('a',workflow.id,{...request('guest-token'),headers:{authorization:'Bearer actual-source-guest-token'}});
 assert.deepEqual(calls,['guest-token']);
},{headers:['authorization'],guestAuth:[{host:'source.example',method:'GET',path:'^/data$'}]}));

test('initial operation completes its fallback decision before any concurrent workflow request',{skip:!enabled},async()=>fixture(async({gateway,workflow,transport,calls})=>{
 let entered,release;
 const started=new Promise(resolve=>{entered=resolve;}),response=new Promise(resolve=>{release=resolve;});
 transport.oxylabs=async input=>{calls.push(input.idempotency_key);if(input.idempotency_key==='initial'){entered();return response;}return reply();};
 const initial=gateway.operation('a',workflow.id,request('initial'));
 try{
  await started;
  await assert.rejects(gateway.operation('a',workflow.id,request('concurrent')),/workflow_busy/);
 }finally{release(reply(403));await initial;}
 const result=await initial;
 assert.equal(result.provider,'scrapedo');
 assert.deepEqual(calls,['initial','paid:initial']);
 const after=await gateway.operation('a',workflow.id,request('after'));
 assert.equal(after.provider,'scrapedo');
}));

test('closing a paced paid attempt cancels before dispatch and releases its reservation',{skip:!enabled},async()=>fixture(async({gateway,workflow,store,calls})=>{
 await gateway.operation('a',workflow.id,request('bootstrap'));
 await store.pool.query("UPDATE workflows SET route='scrapedo' WHERE id=$1",[workflow.id]);
 await store.pool.query("UPDATE source_limits SET next_at=now()+interval '400 milliseconds'");
 const pending=gateway.operation('a',workflow.id,request('close-pending'));
 const rejected=assert.rejects(pending,/workflow_closed/);
 await reserved(store,'close-pending');
 await gateway.close('a',workflow.id);
 await rejected;
 assert.deepEqual(calls,['bootstrap']);
 const attempt=(await store.pool.query("SELECT a.* FROM attempts a JOIN operations o ON o.id=a.operation WHERE o.key='close-pending'")).rows[0];
 assert.equal(attempt.state,'cancelled');assert.equal(attempt.credits,0);
 assert.equal((await gateway.read('a',workflow.id)).state,'closed');
 assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM ledger WHERE attempt=$1 AND event='cancel_before_dispatch'",[attempt.id])).rows[0].n,1);
}));

test('a workflow expiring during pacing does not dispatch its reserved attempt',{skip:!enabled},async()=>fixture(async({gateway,workflow,store,calls})=>{
 await gateway.operation('a',workflow.id,request('bootstrap'));
 await store.pool.query("UPDATE workflows SET expires_at=now()+interval '150 milliseconds' WHERE id=$1",[workflow.id]);
 await store.pool.query("UPDATE source_limits SET next_at=now()+interval '400 milliseconds'");
 await assert.rejects(gateway.operation('a',workflow.id,request('expiry-pending')), /workflow_closed/);
 assert.deepEqual(calls,['bootstrap']);
}));

test('a new source 429 cancels requests still waiting for their dispatch time',{skip:!enabled},async()=>fixture(async({gateway,workflow,store,transport,calls})=>{
 await gateway.operation('a',workflow.id,request('bootstrap'));
 let entered,release;
 const started=new Promise(resolve=>{entered=resolve;}),response=new Promise(resolve=>{release=resolve;});
 transport.oxylabs=async input=>{calls.push(input.idempotency_key);if(input.idempotency_key==='blocker'){entered();return response;}return reply();};
 const blocker=gateway.operation('a',workflow.id,request('blocker'));await started;
 await store.pool.query("UPDATE source_limits SET next_at=now()+interval '400 milliseconds'");
 const pending=gateway.operation('a',workflow.id,request('cooldown-pending'));
 const rejected=assert.rejects(pending,/source_cooldown/);
 await reserved(store,'cooldown-pending');release({...reply(429),headers:{'retry-after':'120'}});
 await blocker;await rejected;
 assert.deepEqual(calls,['bootstrap','blocker']);
}));

test('only one process owns restart recovery and losing its connection is observable',{skip:!enabled},async()=>fixture(async({store})=>{
 const contender=new Store(store.url);let lost;
 const loss=new Promise(resolve=>{lost=resolve;});
 try{
  await store.acquireRunnerLock(lost);
  await assert.rejects(contender.acquireRunnerLock(),/gateway_runner_already_active/);
  await store.pool.query('SELECT pg_terminate_backend($1)',[store.runner.processID]);
  const error=await Promise.race([loss,pause(1000).then(()=>{throw Error('ownership loss was not reported');})]);
  assert.equal(error.message,'gateway_runner_lock_lost');
  await contender.acquireRunnerLock();
 }finally{await contender.close();}
}));

test('discarded source body bytes still consume workflow allowance',{skip:!enabled},async()=>fixture(async({gateway,workflow,transport,store})=>{
 transport.oxylabs=async()=>({...reply(),body:Buffer.alloc(0),receivedBytes:2048,error:'response_too_large'});
 await gateway.operation('a',workflow.id,request('oversized'));
 assert.equal((await gateway.read('a',workflow.id)).bytes,2048);
 assert.equal(Number((await store.pool.query('SELECT bytes FROM attempts')).rows[0].bytes),2048);
}));

test('restart cancels provably unsent reservations but preserves sent and existing unknown holds',{skip:!enabled},async()=>fixture(async({gateway,workflow,store,calls})=>{
 const ids={};
 for(const state of ['reserved','sent','unknown']){
  const operation=randomUUID(),attempt=randomUUID();ids[state]=attempt;
  await store.pool.query("INSERT INTO operations(id,workflow,key,input,state) VALUES($1,$2,$3,$4,'running')",[operation,workflow.id,state,gateway.sealer.seal('{}')]);
  await store.pool.query("INSERT INTO attempts(id,operation,workflow,provider,state,reserved_credits,error) VALUES($1,$2,$3,'scrapedo',$4,1,$5)",[attempt,operation,workflow.id,state,state==='unknown'?'original_unknown':null]);
  await store.pool.query("INSERT INTO ledger(attempt,event,credits) VALUES($1,'reserve',1)",[attempt]);
 }
 await store.pool.query('UPDATE workflows SET requests=3 WHERE id=$1',[workflow.id]);
 const prior=(await store.pool.query('SELECT * FROM attempts WHERE id=$1',[ids.unknown])).rows[0];
 await store.recover();await store.recover();
 const cancelled=(await store.pool.query('SELECT * FROM attempts WHERE id=$1',[ids.reserved])).rows[0];
 assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.credits,0);
 const sent=(await store.pool.query('SELECT * FROM attempts WHERE id=$1',[ids.sent])).rows[0];
 assert.equal(sent.state,'unknown');assert.equal(sent.credits,null);assert.equal(sent.reserved_credits,1);
  assert.equal(sent.finished_at,null,'restart cannot invent the unknown provider completion time');
 assert.deepEqual((await store.pool.query('SELECT * FROM attempts WHERE id=$1',[ids.unknown])).rows[0],prior);
 assert.equal((await gateway.read('a',workflow.id)).requests,2);
 assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM ledger WHERE event='cancel_before_dispatch'")).rows[0].n,1);
 assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM ledger WHERE event='held_unknown'")).rows[0].n,1);
 await assert.rejects(gateway.lookup('a',workflow.id,'reserved'),/interrupted_before_dispatch/);
 assert.deepEqual(calls,[]);
}));

test('restart recovers an authenticated capture after a database failure following rename',{skip:!enabled},async()=>fixture(async({gateway,workflow,store,calls,config})=>{
 const realTx=store.tx.bind(store);let crashed=false;
 store.tx=async fn=>{
  if(crashed)throw Error('fixture database disconnected');
  return realTx(c=>fn({query:async(...args)=>{
   if(args[0].startsWith('UPDATE operations SET state=$2')){crashed=true;throw Error('fixture database disconnected');}
   return c.query(...args);
  }}));
 };
 try{await assert.rejects(gateway.operation('a',workflow.id,request('recover')),/fixture database disconnected/);}
 finally{store.tx=realTx;}
 const op=(await store.pool.query("SELECT * FROM operations WHERE key='recover'")).rows[0];
 assert.equal(op.state,'running');assert.equal(op.result_path,null);
 const capture=gateway.sealer.open(await readFile(join(config.artifactDir,op.id+'.bin')));
 const ledger=(await store.pool.query('SELECT * FROM ledger ORDER BY id')).rows;
 await store.recover();assert.deepEqual(await gateway.recoverCaptures(),{recovered:1,missing:0,invalid:0});
 assert.deepEqual(await gateway.lookup('a',workflow.id,'recover'),capture);
 assert.deepEqual(await gateway.operation('a',workflow.id,request('recover')),capture);
 assert.deepEqual((await store.pool.query('SELECT * FROM ledger ORDER BY id')).rows,ledger);
 assert.deepEqual(calls,['recover']);
}));

test('capture recovery preserves an unknown paid hold and rejects a swapped artifact identity',{skip:!enabled},async()=>fixture(async({gateway,workflow,store,transport,config})=>{
 transport.oxylabs=async()=>reply(403);
 transport.scrapedo=async()=>({...reply(),providerStatus:200,credits:null,error:'metered_outcome_unknown'});
 const captured=await gateway.operation('a',workflow.id,request('unknown'));
 const ledger=(await store.pool.query('SELECT * FROM ledger ORDER BY id')).rows;
 const reset=()=>store.pool.query("UPDATE operations SET state='unknown',error='interrupted_unknown',result_path=NULL WHERE id=$1",[captured.id]);
 await reset();assert.equal((await gateway.recoverCaptures()).recovered,1);
 assert.deepEqual(await gateway.lookup('a',workflow.id,'unknown'),captured);
 assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM attempts WHERE provider='scrapedo' AND state='unknown' AND credits IS NULL")).rows[0].n,1);
 await reset();await writeFile(join(config.artifactDir,captured.id+'.bin'),gateway.sealer.seal({...captured,id:randomUUID()}));
 assert.equal((await gateway.recoverCaptures()).invalid,1);
 await assert.rejects(gateway.lookup('a',workflow.id,'unknown'),/interrupted_unknown/);
 assert.deepEqual((await store.pool.query('SELECT * FROM ledger ORDER BY id')).rows,ledger);
}));

test('retention keeps all financial holds while deleting only settled eligible captures',{skip:!enabled},async()=>fixture(async({gateway,workflow,store,config})=>{
 const errors=['cost_overrun','provider_account_rejected','sensitive_provider_response','unknown',null];
 const captures=[];
 for(let i=0;i<errors.length;i++)captures.push(await gateway.operation('a',workflow.id,request('retention'+i)));
 for(let i=0;i<errors.length;i++){
  await store.pool.query("UPDATE attempts SET provider='scrapedo',state=$2,error=$3,credits=$4,reserved_credits=1 WHERE operation=$1",[captures[i].id,errors[i]==='unknown'?'unknown':'settled',errors[i]==='unknown'?null:errors[i],errors[i]==='unknown'?null:1]);
 }
 await gateway.close('a',workflow.id);
 await store.pool.query("UPDATE operations SET created_at=now()-interval '8 days'");
 assert.equal(await pruneArtifacts(store,config),1);
 for(const capture of captures.slice(0,4))assert.deepEqual(await gateway.result('a',capture.id),capture);
 await assert.rejects(gateway.result('a',captures[4].id),/capture_expired/);
}));

test('workflow and fallback contracts reject arrays and coercible identifiers',{skip:!enabled},async()=>fixture(async({gateway,workflow})=>{
 for(const input of [[],false,1,{profile:'source',idempotency_key:123},{profile:['source'],idempotency_key:'x'}])await assert.rejects(gateway.workflow('a',input),/workflow_invalid/);
 for(const input of [[],false,{reason:'native_flow_incomplete',evidence:['sha256:'+'a'.repeat(64)]},{reason:'native_flow_incomplete',evidence:'sha256:'+'a'.repeat(64),super:true}])await assert.rejects(gateway.fallback('a',workflow.id,input),/fallback_proof_required/);
}));

test('ordinary lookup verifies capture ownership after decryption',{skip:!enabled},async()=>fixture(async({gateway,workflow,config})=>{
 const first=await gateway.operation('a',workflow.id,request('one'));
 const second=await gateway.operation('a',workflow.id,request('two'));
 await writeFile(join(config.artifactDir,first.id+'.bin'),await readFile(join(config.artifactDir,second.id+'.bin')));
 await assert.rejects(gateway.lookup('a',workflow.id,'one'),/capture_invalid/);
}));
