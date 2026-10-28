import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {initDiagnostics,classifyOutcome,operationDiagnostics,projectDiagnostics,recordOutcome} from '../src/diagnostics.mjs';
import {classifyProtection,observeProtection} from '../src/protection.mjs';

const enabled=!!process.env.TEST_DATABASE_URL;
async function fixture(run){
 const url=new URL(process.env.TEST_DATABASE_URL);
 assert.match(url.pathname,/^\/(?:gateway_conformance|gateway_test)(?:_[A-Za-z0-9]+)?$/,'diagnostics require a disposable gateway database');
 const schema='diagnostics_'+randomUUID().replaceAll('-',''),admin=new Store(url.href);
 await admin.pool.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema);
 const store=new Store(url.href),root=await mkdtemp(join(tmpdir(),'gateway-diagnostics-'));
 try{
  await store.init();await initDiagnostics(store.pool);await initDiagnostics(store.pool);
  const workflow=async(project,profile)=>{
   const id=randomUUID();
   await store.pool.query("INSERT INTO workflows(id,project,key,profile,config,proxy_id,expires_at) VALUES($1,$2,$3,$4,$5,'secret-proxy-user:password',now()+interval '1 hour')",[id,project,'secret-key',profile,{private:'secret-cookie'}]);
   return id;
  };
  const operation=async(workflow,{captured=true,missingFile=false}={})=>{
   const id=randomUUID(),path=captured?join(root,id+'.bin'):null;
   if(captured&&!missingFile)await writeFile(path,'encrypted-private-capture');
   await store.pool.query('INSERT INTO operations(id,workflow,key,input,state,result_path,error) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,workflow,'https://private.example/?token=secret-'+id,Buffer.from('private-body-and-headers'),captured?'captured':'running',path,'untrusted error secret-cookie']);
   return id;
  };
  const attempt=async(operation,workflow,{provider='oxylabs',state='settled',reserved=0,credits=null,category=null,reason=null,queue=null,dispatch=null,finish=null,nativeStatus=200}={})=>{
   const id=randomUUID();
   await store.pool.query(`INSERT INTO attempts(id,operation,workflow,provider,state,reserved_credits,credits,native_status,provider_status,bytes,error,outcome_category,routing_reason,queued_at,dispatched_at,finished_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,200,100,'untrusted provider secret-cookie',$9,$10,$11,$12,$13)`,[id,operation,workflow,provider,state,reserved,credits,nativeStatus,category,reason,queue,dispatch,finish]);
   return id;
  };
  await run({store,workflow,operation,attempt,root});
 }finally{await store.close();await admin.pool.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();await rm(root,{recursive:true,force:true});}
}

test('response categories are bounded and distinguish access, transport, rate limits and billing uncertainty',()=>{
 assert.equal(classifyOutcome({status:200}), 'success');
 assert.equal(classifyOutcome({status:302}), 'success');
 assert.equal(classifyOutcome({status:403}), 'source_denied');
 assert.equal(classifyOutcome({status:429}), 'rate_limited');
 assert.equal(classifyOutcome({status:503}), 'upstream_error');
 assert.equal(classifyOutcome({status:null,error:'proxy_connect_failed'}), 'transport_failure');
 assert.equal(classifyOutcome({status:null,error:'metered_outcome_unknown'}), 'transport_failure');
 assert.equal(classifyOutcome({status:200,error:'provider_unattested'}), 'unknown');
 assert.equal(classifyOutcome({status:404}), 'unknown');
 assert.equal(classifyOutcome({status:null,error:'a secret token'}), 'unknown');
 const challenge={status:200,headers:{'content-type':'text/html'},body:Buffer.from('<title>Robot Check</title>private token')};
 assert.equal(classifyOutcome(challenge,{main_document:true}),'source_challenge');
 assert.equal(classifyOutcome(challenge,{main_document:false}),'success');
 assert.equal(classifyOutcome({...challenge,headers:{'content-type':'application/json'}},{main_document:true}),'success');
 assert.equal(classifyOutcome({...challenge,body:Buffer.from('x'.repeat(12001)+'<title>Robot Check</title>')},{main_document:true}),'success');
});

test('passive protection persists after settlement, isolates projects and leaves old attempts unobserved',{skip:!enabled},async()=>fixture(async({store,workflow,operation,attempt})=>{
 const own=await workflow('a','source'),other=await workflow('b','private-source');
 const op=await operation(own),otherOp=await operation(other);
 const aid=await attempt(op,own,{provider:'scrapedo',credits:1,reserved:1}),legacy=await attempt(op,own);
 const privateAid=await attempt(otherOp,other);
 const response={status:403,headers:{'cf-mitigated':'challenge','set-cookie':'private_cookie=secret'}};
 await observeProtection(store,{attemptId:aid,response,input:{main_document:true}});
 await observeProtection(store,{attemptId:privateAid,response,input:{main_document:true}});
 await observeProtection(store,{attemptId:aid,response:{status:200},input:{}});
 const row=(await store.pool.query('SELECT * FROM attempts WHERE id=$1',[aid])).rows[0];
 assert.equal(row.credits,1);assert.equal(row.state,'settled');assert.equal(row.protection.vendor,'cloudflare','first evidence is immutable');
 const result=await operationDiagnostics(store.pool,'a',op);
 assert.deepEqual(result.attempts.find(a=>a.id===aid).protection,classifyProtection(response,{main_document:true}));
 assert.equal(result.attempts.find(a=>a.id===legacy).protection,null);
 const status=await projectDiagnostics(store.pool,'a');
 assert.deepEqual(status.protection.groups,[
  {profile:'source',provider:'oxylabs',kind:'unobserved',vendor:'unknown',attempts:1},
  {profile:'source',provider:'scrapedo',kind:'challenge',vendor:'cloudflare',attempts:1},
 ]);
 assert.equal(JSON.stringify(status).includes('private-source'),false);
 await store.pool.query("UPDATE attempts SET protection=protection || '{\"vendor\":\"private-value\",\"extra\":\"private-value\"}'::jsonb WHERE id=$1",[aid]);
 assert.equal(JSON.stringify(await operationDiagnostics(store.pool,'a',op)).includes('private-value'),false);
 assert.equal(JSON.stringify(await projectDiagnostics(store.pool,'a')).includes('private-value'),false);
}));

test('operation diagnostics isolate projects, preserve held credits and never expose source or credential data',{skip:!enabled},async()=>fixture(async({store,workflow,operation,attempt,root})=>{
 const own=await workflow('a','source'),other=await workflow('b','private-source');
 const op=await operation(own),privateOp=await operation(other);
 const start=new Date(Date.now()-3000),sent=new Date(+start+100),end=new Date(+sent+600);
 await attempt(op,own,{category:'source_denied',reason:'oxylabs_default',queue:start,dispatch:sent,finish:end,nativeStatus:403});
 await attempt(op,own,{provider:'scrapedo',state:'unknown',reserved:1,category:'transport_failure',reason:'fallback_source_denied',queue:end,dispatch:new Date(+end+200),finish:new Date(+end+500),nativeStatus:null});
 await attempt(privateOp,other,{provider:'scrapedo',reserved:50,credits:50});
 const result=await operationDiagnostics(store.pool,'a',op);
 assert.equal(result.id,op);assert.equal(result.capture_available,true);assert.equal(result.attempts.length,2);
 assert.deepEqual(result.billing,{known_credits:0,held_credits:1});
 assert.equal(result.attempts[0].queue_wait_ms,100);assert.equal(result.attempts[0].provider_time_ms,600);
 assert.equal(result.attempts[1].routing_reason,'fallback_source_denied');
 assert.equal(result.attempts[1].held_credits,1);assert.equal(result.attempts[1].known_credits,null);
 assert.equal(result.outcome,null);
 const cancelled=await operation(own);
 await attempt(cancelled,own,{provider:'scrapedo',state:'cancelled',reserved:1,credits:0,category:'cancelled'});
 const cancelledTimeline=(await operationDiagnostics(store.pool,'a',cancelled)).attempts[0];
 assert.equal(cancelledTimeline.outcome_category,'cancelled');assert.equal(cancelledTimeline.held_credits,0);
 const cancellationMetrics=(await projectDiagnostics(store.pool,'a')).attempts.find(row=>row.outcome_category==='cancelled');
 assert.equal(cancellationMetrics.attempts,1);assert.equal(cancellationMetrics.known_credits,0);assert.equal(cancellationMetrics.held_credits,0);
 const serialized=JSON.stringify(result);
 for(const secret of ['secret-cookie','secret-proxy','private-body','private.example','private-source',privateOp,other,root,'untrusted'])assert.ok(!serialized.includes(secret),secret);
 await assert.rejects(operationDiagnostics(store.pool,'a',privateOp),error=>error.code==='operation_not_found'&&error.status===404);
 await assert.rejects(operationDiagnostics(store.pool,'a','not-an-id'),/request_invalid/);
}));

test('acceptance outcomes require an owned retained capture and are immutable under concurrent replay',{skip:!enabled},async()=>fixture(async({store,workflow,operation,attempt})=>{
 const own=await workflow('a','source'),other=await workflow('b','private-source');
 const op=await operation(own),privateOp=await operation(other),pending=await operation(own,{captured:false}),missing=await operation(own,{missingFile:true});
 await attempt(op,own,{provider:'scrapedo',reserved:1,credits:1});
 const input={accepted_records:2,rejected_records:1,reason_code:'partial'};
 await assert.rejects(recordOutcome(store.pool,'a',privateOp,input),error=>error.code==='operation_not_found'&&error.status===404);
 await assert.rejects(recordOutcome(store.pool,'a',pending,input),/capture_required/);
 await assert.rejects(recordOutcome(store.pool,'a',missing,input),error=>error.code==='capture_expired'&&error.status===410);
 for(const invalid of [null,{}, {...input,accepted_records:-1},{...input,rejected_records:0.5},{...input,accepted_records:1000000,rejected_records:1},{...input,reason_code:'secret-cookie'},{...input,body:'private source body'}])await assert.rejects(recordOutcome(store.pool,'a',op,invalid),/outcome_invalid/);
 const before=(await store.pool.query('SELECT * FROM attempts WHERE operation=$1',[op])).rows;
 const results=await Promise.all(Array.from({length:4},()=>recordOutcome(store.pool,'a',op,input)));
 assert.ok(results.every(result=>JSON.stringify(result)===JSON.stringify(results[0])));
 assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM operation_outcomes')).rows[0].n,1);
 await assert.rejects(recordOutcome(store.pool,'a',op,{...input,accepted_records:3}),error=>error.code==='outcome_conflict'&&error.status===409);
 assert.deepEqual((await store.pool.query('SELECT * FROM attempts WHERE operation=$1',[op])).rows,before);
 assert.equal((await operationDiagnostics(store.pool,'a',op)).outcome.accepted_records,2);
 await store.pool.query("UPDATE operations SET state='expired',result_path=NULL WHERE id=$1",[op]);
 assert.deepEqual(await recordOutcome(store.pool,'a',op,input),results[0],'previous outcome replay remains stable after capture retention expires');
}));

test('diagnostic aggregates use measured timing only, isolate projects and count fallback cost once per accepted operation',{skip:!enabled},async()=>fixture(async({store,workflow,operation,attempt})=>{
 const own=await workflow('a','source'),other=await workflow('b','private-source');
 const op=await operation(own),legacy=await operation(own),privateOp=await operation(other);
 const start=new Date(Date.now()-3000),sent=new Date(+start+100),end=new Date(+sent+600);
 await attempt(op,own,{category:'source_denied',reason:'oxylabs_default',queue:start,dispatch:sent,finish:end,nativeStatus:403});
 await attempt(op,own,{provider:'scrapedo',reserved:1,credits:1,category:'success',reason:'fallback_source_denied',queue:end,dispatch:new Date(+end+200),finish:new Date(+end+500)});
 await attempt(legacy,own,{provider:'scrapedo',state:'unknown',reserved:1,category:'not-a-public-category',reason:'private-credential-value'});
 await attempt(privateOp,other,{provider:'scrapedo',reserved:50,credits:50,category:'success'});
 await recordOutcome(store.pool,'a',op,{accepted_records:2,rejected_records:0,reason_code:'accepted'});
 await recordOutcome(store.pool,'a',legacy,{accepted_records:0,rejected_records:1,reason_code:'source_unavailable'});
 await recordOutcome(store.pool,'b',privateOp,{accepted_records:100,rejected_records:0,reason_code:'accepted'});
 const result=await projectDiagnostics(store.pool,'a');
 assert.equal(result.window_hours,24);assert.equal(result.attempts.length,3);
 const native=result.attempts.find(row=>row.provider==='oxylabs');
 assert.equal(native.queue_samples,1);assert.equal(native.queue_wait_ms_avg,100);assert.equal(native.queue_wait_ms_p95,100);
 assert.equal(native.provider_time_ms_avg,600);assert.equal(native.provider_time_ms_p95,600);
 const old=result.attempts.find(row=>row.outcome_category==='unknown');
 assert.equal(old.queue_samples,0);assert.equal(old.queue_wait_ms_avg,null);assert.equal(old.provider_time_ms_avg,null);assert.equal(old.held_credits,1);
 assert.deepEqual(result.outcomes,[{profile:'source',operations_with_outcome:2,accepted_records:2,rejected_records:1,known_credits:1,held_credits:1,known_credits_per_accepted_record:0.5}]);
 const oldTimeline=(await operationDiagnostics(store.pool,'a',legacy)).attempts[0];
 assert.equal(oldTimeline.queue_wait_ms,null);assert.equal(oldTimeline.provider_time_ms,null);assert.equal(oldTimeline.routing_reason,null);assert.equal(oldTimeline.outcome_category,null);
 for(const secret of ['private-source',privateOp,other,'secret-cookie','private-credential'])assert.ok(!JSON.stringify(result).includes(secret));
 const global=await projectDiagnostics(store.pool,null);assert.equal(global.outcomes.length,2);
 await store.pool.query("UPDATE operation_outcomes SET created_at=now()-interval '25 hours' WHERE operation=$1",[op]);
 const recent=await projectDiagnostics(store.pool,'a');assert.equal(recent.outcomes[0].accepted_records,0);assert.equal(recent.outcomes[0].known_credits_per_accepted_record,null);
}));
