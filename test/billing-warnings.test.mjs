import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';

const enabled=!!process.env.TEST_DATABASE_URL;
const input=key=>({idempotency_key:key,url:'https://source.example/data',headers:{}});
const reply=(credits=1,error=null)=>({status:error?null:200,providerStatus:error?502:200,headers:{},cookies:[],body:Buffer.from(error?'provider failed':'fixture'),credits,error});
async function fixture(run,{workflowLimit=8,dailyLimit=16}={}){
 const url=new URL(process.env.TEST_DATABASE_URL);
 assert.match(url.pathname,/^\/(?:gateway_conformance|gateway_test)(?:_[A-Za-z0-9]+)?$/,'billing tests require a disposable gateway database');
 const admin=new Store(url.href),schema='billing_'+randomUUID().replaceAll('-','');
 await admin.pool.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema);
 const store=new Store(url.href),root=await mkdtemp(join(tmpdir(),'gateway-billing-'));
 const profile={hosts:['source.example'],methods:['GET'],headers:[],country:'IN',maxConcurrent:4,maxRequests:30,maxInputBytes:1024,maxResponseBytes:1024,maxBytes:60000,ttlSeconds:120,minIntervalMs:0,maxFallbackCredits:workflowLimit,fallbackMaxCost:1};
 const config={release:'billing-test',artifactDir:root,artifactKey:'11'.repeat(32),maxDailyFallbackCredits:dailyLimit,scrapeDoToken:'private-fixture-token',projects:{a:{profiles:['source']},b:{profiles:['source']}},proxies:[{id:'in-1',country:'IN',url:'https://proxy.example'}]};
 const calls=[],transport={
  oxylabs:async request=>{calls.push({provider:'oxylabs',key:request.idempotency_key});return {...reply(),credits:null};},
  scrapedo:async(request,session)=>{calls.push({provider:'scrapedo',key:request.idempotency_key,session});return reply();},
 };
 try{
  await store.init();
  const gateway=new Gateway({store,config,profiles:{source:profile},resolve:async()=>[{address:'93.184.216.34'}],transport});
  const workflow=await gateway.workflow('a',{profile:'source',idempotency_key:'fixture'});
  const paid=async workflow=>store.pool.query("UPDATE workflows SET route='scrapedo' WHERE id=$1",[workflow.id]);
  await run({gateway,workflow,store,transport,calls,paid});
 }finally{await store.close();await admin.pool.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();await rm(root,{recursive:true,force:true});}
}

test('unknown billing preserves the original result and allows later requests and other projects within budget',{skip:!enabled},async()=>fixture(async({gateway,workflow,store,transport,calls})=>{
 transport.oxylabs=async request=>{calls.push({provider:'oxylabs',key:request.idempotency_key});return {...reply(),status:403,credits:null};};
 transport.scrapedo=async(request,session)=>{calls.push({provider:'scrapedo',key:request.idempotency_key,session});return request.idempotency_key==='uncertain'?reply(null,'provider_unattested'):reply();};
 const original=await gateway.operation('a',workflow.id,input('uncertain'));
 assert.equal(original.error,'provider_unattested');assert.equal(original.credits,null);
 const attempt=(await store.pool.query("SELECT * FROM attempts WHERE operation=$1 AND provider='scrapedo'",[original.id])).rows[0];
 const ledger=(await store.pool.query('SELECT * FROM ledger WHERE attempt=$1 ORDER BY id',[attempt.id])).rows;
 assert.equal(attempt.state,'unknown');assert.equal(attempt.credits,null);assert.equal(attempt.reserved_credits,1);
 assert.deepEqual(ledger.map(row=>row.event),['reserve','held_unknown']);
 await store.recover();
 assert.deepEqual(await gateway.operation('a',workflow.id,input('uncertain')),original);
 assert.deepEqual(await gateway.lookup('a',workflow.id,'uncertain'),original);
 assert.equal(calls.length,2,'repeat submission and lookup must not replay the uncertain dispatch');
 const later=await gateway.operation('a',workflow.id,input('later'));
 assert.equal(later.provider,'scrapedo');assert.equal(later.credits,1);assert.equal(later.error,null);
 const other=await gateway.workflow('b',{profile:'source',idempotency_key:'independent'});
 const independent=await gateway.operation('b',other.id,input('other-project'));
 assert.equal(independent.provider,'scrapedo');assert.equal(independent.error,null);
 assert.deepEqual((await store.pool.query('SELECT * FROM attempts WHERE id=$1',[attempt.id])).rows[0],attempt);
 assert.deepEqual((await store.pool.query('SELECT * FROM ledger WHERE attempt=$1 ORDER BY id',[attempt.id])).rows,ledger);
 const sameSession=calls.filter(call=>call.provider==='scrapedo'&&['uncertain','later'].includes(call.key));
 assert.equal(sameSession.length,2);assert.equal(sameSession[0].session,sameSession[1].session);
 const billing=(await gateway.read('a',workflow.id)).billing.find(row=>row.provider==='scrapedo'&&row.state==='unknown');
 assert.equal(billing.held_credits,1);
}));

test('multiple unknown receipts still consume the workflow fallback allowance',{skip:!enabled},async()=>fixture(async({gateway,workflow,store,transport,calls,paid})=>{
 await paid(workflow);
 transport.scrapedo=async request=>{calls.push({provider:'scrapedo',key:request.idempotency_key});return reply(null,'metered_outcome_unknown');};
 await gateway.operation('a',workflow.id,input('unknown-one'));
 await gateway.operation('a',workflow.id,input('unknown-two'));
 await assert.rejects(gateway.operation('a',workflow.id,input('over-workflow-budget')),/fallback_limit/);
 assert.equal(calls.length,2);
 assert.equal((await store.pool.query("SELECT sum(coalesce(credits,reserved_credits))::int AS total FROM attempts WHERE provider='scrapedo'")).rows[0].total,2);
 assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM attempts WHERE state='unknown' AND credits IS NULL")).rows[0].n,2);
},{workflowLimit:2}));

test('unknown reservations across projects still consume the shared daily fallback allowance',{skip:!enabled},async()=>fixture(async({gateway,workflow,store,transport,calls,paid})=>{
 await paid(workflow);
 transport.scrapedo=async request=>{calls.push({provider:'scrapedo',key:request.idempotency_key});return reply(null,'metered_outcome_unknown');};
 await gateway.operation('a',workflow.id,input('unknown-one'));
 await gateway.operation('a',workflow.id,input('unknown-two'));
 const other=await gateway.workflow('b',{profile:'source',idempotency_key:'other-budget'});await paid(other);
 await gateway.operation('b',other.id,input('unknown-three'));
 await assert.rejects(gateway.operation('b',other.id,input('over-daily-budget')),/fallback_limit/);
 assert.equal(calls.length,3);
 assert.equal((await store.pool.query("SELECT sum(coalesce(credits,reserved_credits))::int AS total FROM attempts WHERE provider='scrapedo'")).rows[0].total,3);
 assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM ledger WHERE event='held_unknown'")).rows[0].n,3);
},{workflowLimit:4,dailyLimit:3}));

for(const failure of ['cost_overrun','provider_account_rejected','sensitive_provider_response']){
 test(`${failure} still blocks paid admission while unrelated prepaid work continues`,{skip:!enabled},async()=>fixture(async({gateway,workflow,transport,calls,paid})=>{
  await paid(workflow);
  transport.scrapedo=async request=>{calls.push({provider:'scrapedo',key:request.idempotency_key});return failure==='cost_overrun'?reply(2):reply(null,failure);};
  const failed=await gateway.operation('a',workflow.id,input('hard-failure'));assert.equal(failed.error,failure);
  await assert.rejects(gateway.operation('a',workflow.id,input('same-workflow-paid')),/metered_(?:held|account_busy_or_held)/);
  const other=await gateway.workflow('b',{profile:'source',idempotency_key:'other-paid'});await paid(other);
  await assert.rejects(gateway.operation('b',other.id,input('other-paid')),/metered_account_busy_or_held/);
  const prepaid=await gateway.workflow('b',{profile:'source',idempotency_key:'prepaid'});
  const captured=await gateway.operation('b',prepaid.id,input('prepaid'));
  assert.equal(captured.provider,'oxylabs');assert.equal(captured.status,200);
  assert.deepEqual(calls.map(call=>call.provider),['scrapedo','oxylabs']);
 }));
}
