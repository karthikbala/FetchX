import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {admissionStatus,projectLimits} from '../src/admission.mjs';
const enabled=!!process.env.TEST_DATABASE_URL;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const response=()=>({status:200,headers:{},cookies:[],body:Buffer.from('fixture')});
const request=key=>({idempotency_key:key,url:'https://source.example/data',headers:{}});
async function fixture(run){
 const url=new URL(process.env.TEST_DATABASE_URL);assert.match(url.pathname,/^\/(?:gateway_conformance|gateway_test)(?:_[A-Za-z0-9]+)?$/);
 const admin=new Store(url.href),schema='admission_'+randomUUID().replaceAll('-','');await admin.pool.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema);
 const store=new Store(url.href),root=await mkdtemp(join(tmpdir(),'gateway-admission-'));
 const config={release:'test',artifactDir:root,artifactKey:'11'.repeat(32),maxConcurrentRequests:1,maxDailyFallbackCredits:5,scrapeDoToken:'fixture-secret',projects:{a:{profiles:['source']},b:{profiles:['source']}},proxies:[{id:'one',country:'IN',url:'http://private.example'}]};
 const profile={hosts:['source.example'],methods:['GET'],headers:[],country:'IN',maxConcurrent:4,maxRequests:20,maxInputBytes:1024,maxResponseBytes:1024,maxBytes:30000,ttlSeconds:120,minIntervalMs:0,maxFallbackCredits:20,fallbackMaxCost:1};
 const calls=[],transport={oxylabs:async input=>{calls.push(input.idempotency_key);return response();},scrapedo:async input=>{calls.push(input.idempotency_key);return {...response(),credits:1};}};
 try{await store.init();const g=new Gateway({store,config,profiles:{source:profile},resolve:async()=>[{address:'93.184.216.34'}],transport});
  const workflow=async(project,key,paid=false)=>{const w=await g.workflow(project,{profile:'source',idempotency_key:key});if(paid)await store.pool.query("UPDATE workflows SET route='scrapedo' WHERE id=$1",[w.id]);return w;};
  await run({g,store,config,transport,calls,workflow});
 }finally{await store.close();await admin.pool.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();await rm(root,{recursive:true,force:true});}
}
async function until(fn){for(let i=0;i<400;i++){if(await fn())return;await sleep(5);}assert.fail('expected bounded admission event');}
const waitQueue=(store,n)=>until(async()=>Number((await store.pool.query('SELECT count(*) AS n FROM admission_queue')).rows[0].n)===n);

test('fair admission serves another project before an existing project backlog',{skip:!enabled},async()=>fixture(async({g,store,transport,calls,workflow})=>{
 const a1=await workflow('a','a1'),a2=await workflow('a','a2'),a3=await workflow('a','a3'),b=await workflow('b','b');
 let release;const gate=new Promise(r=>release=r);
 transport.oxylabs=async input=>{calls.push(input.idempotency_key);if(input.idempotency_key==='a1')await gate;return response();};
 const first=g.operation('a',a1.id,request('a1'));await until(()=>calls.length===1);
 const second=g.operation('a',a2.id,request('a2'));await waitQueue(store,1);
 const third=g.operation('a',a3.id,request('a3'));await waitQueue(store,2);
 const other=g.operation('b',b.id,request('b'));await waitQueue(store,3);
 release();await Promise.all([first,second,third,other]);
 assert.deepEqual(calls,['a1','b','a2','a3']);
 assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM admission_queue')).rows[0].n,0);
}));

test('a waiting paid request cannot block available native capacity',{skip:!enabled},async()=>fixture(async({g,store,config,transport,calls,workflow})=>{
 config.maxConcurrentRequests=2;
 const p1=await workflow('a','p1',true),p2=await workflow('a','p2',true),native=await workflow('b','native');
 let release;const gate=new Promise(r=>release=r);
 transport.scrapedo=async input=>{calls.push(input.idempotency_key);if(input.idempotency_key==='p1')await gate;return {...response(),credits:1};};
 const first=g.operation('a',p1.id,request('p1'));await until(()=>calls.length===1);
 const waiting=g.operation('a',p2.id,request('p2'));await waitQueue(store,1);
 try{await g.operation('b',native.id,request('native'));assert.deepEqual(calls,['p1','native']);}
 finally{release();await Promise.all([first,waiting]);}
 assert.deepEqual(calls,['p1','native','p2']);
}));

test('project concurrency caps preserve capacity for another project',{skip:!enabled},async()=>fixture(async({g,store,config,transport,calls,workflow})=>{
 config.maxConcurrentRequests=2;config.projects.a.maxConcurrentRequests=1;
 const a1=await workflow('a','a1'),a2=await workflow('a','a2'),b=await workflow('b','b');
 let release;const gate=new Promise(r=>release=r);
 transport.oxylabs=async input=>{calls.push(input.idempotency_key);if(input.idempotency_key==='a1')await gate;return response();};
 const first=g.operation('a',a1.id,request('a1'));await until(()=>calls.length===1);
 const waiting=g.operation('a',a2.id,request('a2'));await waitQueue(store,1);
 try{await g.operation('b',b.id,request('b'));assert.deepEqual(calls,['a1','b']);}
 finally{release();await Promise.all([first,waiting]);}
}));

test('project and global paid budgets share the same known and unknown reservations',{skip:!enabled},async()=>fixture(async({g,store,config,transport,calls,workflow})=>{
 config.projects.a.maxDailyFallbackCredits=1;config.maxDailyFallbackCredits=2;
 const a=await workflow('a','a',true),b=await workflow('b','b',true);
 transport.scrapedo=async input=>{calls.push(input.idempotency_key);return {...response(),credits:null,error:'metered_outcome_unknown'};};
 const unknown=await g.operation('a',a.id,request('unknown'));
 await assert.rejects(g.operation('a',a.id,request('blocked-a')),/project_fallback_limit/);
 assert.deepEqual(await g.lookup('a',a.id,'unknown'),unknown);assert.equal(calls.length,1);
 transport.scrapedo=async input=>{calls.push(input.idempotency_key);return {...response(),credits:1};};
 await g.operation('b',b.id,request('b'));
 await assert.rejects(g.operation('b',b.id,request('global-blocked')),/fallback_limit/);
 assert.deepEqual(calls,['unknown','b']);
 const aStatus=await admissionStatus(store.pool,config,'a');assert.equal(aStatus.projects.length,1);assert.equal(aStatus.projects[0].daily_reserved_or_spent,1);assert.equal(aStatus.projects[0].daily_remaining_credits,0);
 assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM ledger WHERE event='reserve'")).rows[0].n,2);
}));

test('queue limits reject before dispatch and queued close removes waiting work',{skip:!enabled},async()=>fixture(async({g,store,config,transport,calls,workflow})=>{
 config.maxQueuedRequests=4;config.projects.a.maxQueuedRequests=1;
 const firstW=await workflow('a','first'),waitingW=await workflow('a','waiting'),overflowW=await workflow('a','overflow');
 let release;const gate=new Promise(r=>release=r);
 transport.oxylabs=async input=>{calls.push(input.idempotency_key);await gate;return response();};
 const first=g.operation('a',firstW.id,request('first'));await until(()=>calls.length===1);
 const waiting=g.operation('a',waitingW.id,request('waiting'));const rejected=assert.rejects(waiting,/workflow_limit/);await waitQueue(store,1);
 try{
  await assert.rejects(g.operation('a',overflowW.id,request('overflow')),/admission_queue_full/);
  await g.close('a',waitingW.id);await rejected;
  assert.deepEqual(calls,['first']);await waitQueue(store,0);
 }finally{release();await first;}
 assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM attempts')).rows[0].n,1);
}));

test('invalid project configuration cannot expand global financial or concurrency limits',()=>{
 const config={maxDailyFallbackCredits:10,maxConcurrentRequests:4,projects:{a:{maxDailyFallbackCredits:11}}};
 assert.throws(()=>projectLimits(config,'a'),/project_admission_config_invalid/);
 config.projects.a={maxConcurrentRequests:5};assert.throws(()=>projectLimits(config,'a'),/project_admission_config_invalid/);
 config.projects.a={maxDailyFallbackCredits:0};assert.equal(projectLimits(config,'a').max_daily_fallback_credits,0);
});

test('exhausted paid admission rejects promptly without waiting for an occupied global slot',{skip:!enabled},async()=>fixture(async({g,store,config,transport,calls,workflow})=>{
 config.projects.b.maxDailyFallbackCredits=0;
 const a=await workflow('a','active'),b=await workflow('b','exhausted',true);
 let release;const gate=new Promise(r=>release=r);
 transport.oxylabs=async input=>{calls.push(input.idempotency_key);await gate;return response();};
 const active=g.operation('a',a.id,request('active'));await until(()=>calls.length===1);
 try{await assert.rejects(g.operation('b',b.id,request('exhausted')),/project_fallback_limit/);await waitQueue(store,0);assert.deepEqual(calls,['active']);}
 finally{release();await active;}
}));

test('route health bookkeeping failure preserves the captured result and settled accounting',{skip:!enabled},async()=>fixture(async({g,store,calls,workflow})=>{
 const w=await workflow('a','health-error');
 await store.pool.query('ALTER TABLE route_health_workflows RENAME TO offline_route_health_workflows');
 try{
  const result=await g.operation('a',w.id,request('health-error'));
  assert.equal(result.status,200);assert.deepEqual(await g.lookup('a',w.id,'health-error'),result);
  assert.equal((await store.pool.query('SELECT state FROM attempts')).rows[0].state,'settled');
  assert.deepEqual(calls,['health-error']);
 }finally{await store.pool.query('ALTER TABLE offline_route_health_workflows RENAME TO route_health_workflows');}
}));
