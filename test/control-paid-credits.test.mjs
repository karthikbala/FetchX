import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ControlPaidCredits,initControlPaidCredits,outstandingPaidCreditLiabilitySql,paidCreditPack,quotePaidHttpCredits,
 recoverControlPaidCredits,reviewedPaidCreditRoutes} from '../src/control-paid-credits.mjs';
import {ControlCredits,grantInitialCredits} from '../src/control-credits.mjs';
import {sha} from '../src/crypto.mjs';
import {Store} from '../src/store.mjs';

const accessProfile={id:'synthetic-paid',version:1};
const paidCreditPolicy={reviewed:true,version:'synthetic-v1',routes:[
 {accessProfile,class:'direct',provider:'direct',country:null},
 {accessProfile,class:'datacenter',provider:'oxylabs',country:'US'},
 {accessProfile,class:'residential',provider:'evomi',country:'US'}
]};
const config={controlPlane:{enabled:true,paidCreditPolicy}};
const quote=(route='residential',maxTransferMb,maxCredits)=>quotePaidHttpCredits({route,maxTransferMb,maxCredits});
const random=()=>randomUUID().replaceAll('-','');
const purchase=(project,amountMinor=200)=>({project,amountMinor,mode:'live',accountId:'acct_synthetic',
 checkoutSessionId:'cs_live_'+random(),paymentIntentId:'pi_'+random(),currency:'usd',credits:paidCreditPack(amountMinor)});

test('approved packs and HTTP tariffs compute exact decimal byte and credit ceilings',()=>{
 assert.deepEqual([200,800,2000,10000].map(value=>paidCreditPack(value)),[10_000,50_000,150_000,1_000_000]);
 for(const value of [2,199,'200',null,NaN])assert.equal(paidCreditPack(value),null);
 assert.deepEqual([17500,75000,180000,900000].map(value=>paidCreditPack(value,'inr')),[10000,50000,150000,1000000]);
 for(const [amount,currency] of [[17500,'usd'],[200,'inr'],[17500,'eur'],['17500','inr']])assert.equal(paidCreditPack(amount,currency),null);
 for(const route of ['direct','datacenter'])assert.deepEqual(quote(route),{
  tariff_version:'paid-http-v1',route_class:route,block_bytes:1e6,credits_per_block:1,max_transfer_bytes:1e6,reserved_credits:1
 });
 assert.deepEqual(quote(),{tariff_version:'paid-http-v1',route_class:'residential',block_bytes:250_000,
  credits_per_block:5,max_transfer_bytes:250_000,reserved_credits:5});
 assert.equal(quote('datacenter',0.25).reserved_credits,1);
 assert.equal(quote('datacenter',1.25).reserved_credits,2);
 assert.equal(quote('residential',0.5,10).reserved_credits,10);
 assert.equal(quote('residential',20,400).reserved_credits,400);
 for(const value of ['0.25',0,0.3,0.2500000001,20.25,null,NaN,Infinity])
  assert.throws(()=>quote('residential',value),{code:'max_transfer_mb_invalid'});
 for(const value of [0,1.5,'10',null,NaN])assert.throws(()=>quote('residential',0.5,value),{code:'max_credits_invalid'});
 assert.throws(()=>quote('residential',0.5,9),{code:'max_credits_exceeded',status:429});
 assert.throws(()=>quote('browser'),{code:'paid_credit_route_forbidden'});
 assert.deepEqual(reviewedPaidCreditRoutes(config),paidCreditPolicy.routes);
 const invalid=structuredClone(config);
 invalid.controlPlane.paidCreditPolicy.routes[1].provider='unreviewed';
 assert.deepEqual(reviewedPaidCreditRoutes(invalid),[]);
});

test('paid credit purchases, allocation, settlement and recovery are durable and isolated',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const store=new Store(process.env.TEST_DATABASE_URL),user=randomUUID(),projects=[];
 const paid=new ControlPaidCredits({store,config}),trial=new ControlCredits({store,config});
 const grant=input=>store.tx(c=>paid.grantPaidCredits(c,input));
 const revoke=input=>store.tx(c=>paid.revokePaidCredits(c,input));
 const makeProject=async()=>{
  const project='cp_'+randomUUID(),session=randomUUID();
  projects.push(project);
  await store.tx(async c=>{
   await c.query('INSERT INTO control_projects(id,user_id,name,template_hash) VALUES($1,$2,$3,$4)',[project,user,'Paid fixture',sha('fixture')]);
   await grantInitialCredits(c,project,2);
   await c.query(`INSERT INTO v2_sessions(id,project,key,input_hash,policy,route,cookie_jar,expires_at)
    VALUES($1,$2,'synthetic','fixture','{}',$3,$3,clock_timestamp()+interval '1 hour')`,[session,project,Buffer.from('fixture')]);
  });
  return {project,session};
 };
 const insertOperation=async(c,{project,session})=>{
  const operation=randomUUID();
  await c.query(`INSERT INTO v2_operations(id,project,key_id,key,session_id,input_hash,input)
   VALUES($1::uuid,$2,'console',$1::uuid::text,$3,'synthetic',$4)`,[operation,project,session,Buffer.from('fixture')]);
  return operation;
 };
 const reserve=(project,operation,terms=quote())=>store.tx(c=>paid.reserve(c,{project,operation,keyId:'console',quote:terms}));
 const finish=(project,operation,traffic)=>store.tx(c=>paid.finish(c,{project,operation,...traffic}));
 const allocate=async(a,terms=quote())=>store.tx(async c=>{
  const operation=await insertOperation(c,a);
  await paid.reserve(c,{project:a.project,operation,keyId:'console',quote:terms});
  return operation;
 });
 const outstanding=async()=>BigInt((await store.pool.query(outstandingPaidCreditLiabilitySql)).rows[0].bytes);
 try{
  await store.init();await initControlPaidCredits(store.pool);
  await store.pool.query('INSERT INTO control_users(id,email) VALUES($1,$2)',[user,`paid-credit-${user}@example.test`]);
  await t.test('only verified live purchases grant credits and reversals prevent later grants',async()=>{
   const a=await makeProject(),b=await makeProject(),live=purchase(a.project),early=purchase(a.project);
   await assert.rejects(grant({...live,mode:'test'}),{code:'paid_credit_grant_invalid'});
   await assert.rejects(grant({...live,credits:1}),{code:'paid_credit_grant_invalid'});
   await assert.rejects(grant({...live,currency:'inr'}),{code:'paid_credit_grant_invalid'});
   await assert.rejects(store.tx(async c=>{await paid.grantPaidCredits(c,live);throw Error('rollback');}),{message:'rollback'});
   assert.equal((await paid.usage(a.project)).available,0);
   assert.deepEqual((await Promise.all([grant(live),grant(live)])).sort(),[false,true]);
   await assert.rejects(grant({...live,project:b.project}),{code:'paid_credit_grant_conflict'});
   await assert.rejects(grant({...live,paymentIntentId:'pi_'+random()}),{code:'paid_credit_grant_conflict'});
   await assert.rejects(grant({...live,checkoutSessionId:'cs_live_'+random()}),{code:'paid_credit_grant_conflict'});
   await assert.rejects(grant({...live,amountMinor:800,credits:50_000}),{code:'paid_credit_grant_conflict'});
   await assert.rejects(grant({...live,currency:'inr',amountMinor:17500}),{code:'paid_credit_grant_conflict'});
   assert.equal(await revoke(early),false);assert.equal(await revoke(early),false);
   await assert.rejects(grant(early),{code:'paid_credit_grant_reversed'});
   await assert.rejects(grant({...early,project:b.project}),{code:'paid_credit_grant_conflict'});
   const scoped=await grant({...early,project:b.project,accountId:'acct_other'});
   assert.equal(scoped,true);assert.equal((await paid.usage(b.project)).available,10_000);
   assert.equal(await outstanding(),1_016_400_000n);
   assert.equal(await revoke(live),true);
   assert.equal(await grant(live),false);
   assert.deepEqual(await paid.usage(a.project),{unit:'credits',granted:10_000,available:0,reserved:0,used:0,held:0,revoked_unused:10_000,payment_hold:false});
   assert.equal((await trial.usage(a.project)).available,2);
  });
  await t.test('reserved credit ceilings cannot be overspent and actual charges use the saved grant split',async()=>{
   const a=await makeProject(),one=purchase(a.project),five=purchase(a.project,800);
   await grant(one);
   await store.tx(async c=>{
    for(let i=0;i<25;i++){
     const terms=quote('residential',i===24?19.75:20);
     const operation=await insertOperation(c,a);
     await paid.reserve(c,{project:a.project,operation,keyId:'console',quote:terms});
     await paid.finish(c,{project:a.project,operation,dispatched:true,measuredBytes:terms.max_transfer_bytes});
    }
   });
   assert.equal((await paid.usage(a.project)).available,5);
   const [first,second]=await store.tx(async c=>[await insertOperation(c,a),await insertOperation(c,a)]);
   const results=await Promise.allSettled([reserve(a.project,first),reserve(a.project,second)]);
   assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
   assert.equal(results.find(result=>result.status==='rejected').reason.code,'paid_credit_balance_exhausted');
   const winner=results[0].status==='fulfilled'?first:second;
   await assert.rejects(reserve(a.project,winner,quote('residential',0.5)),{code:'paid_credit_reservation_conflict'});
   await finish(a.project,winner,{dispatched:false});
   await grant(five);
   const split=await allocate(a,quote('residential',1));
   const saved=(await store.pool.query('SELECT credits,offset_credits FROM paid_credit_allocations WHERE operation=$1 ORDER BY offset_credits',[split])).rows;
   assert.deepEqual(saved,[{credits:'5',offset_credits:'0'},{credits:'15',offset_credits:'5'}]);
   const settled=await finish(a.project,split,{dispatched:true,measuredBytes:250_001});
   assert.equal(settled.used_credits,10);assert.equal(settled.billable_bytes,250_001);
   await revoke(one);
   assert.equal((await paid.usage(a.project)).available,49_995);
   assert.equal((await paid.usage(a.project)).revoked_unused,0);
   await revoke(five);
   const revoked=await paid.usage(a.project);
   assert.equal(revoked.available,0);assert.equal(revoked.used,10_005);assert.equal(revoked.revoked_unused,49_995);
  });
  await t.test('holds, no-dispatch releases and FetchX refunds preserve saved tariff and provider evidence',async()=>{
   const a=await makeProject(),pack=purchase(a.project),scope={project:a.project,mode:'live',accountId:pack.accountId};
   await grant(pack);
   const terms=quote('datacenter',1.25,2);
   const aReserved=await allocate(a,terms),before=await outstanding();
   await store.tx(c=>paid.setPaymentHold(c,{...scope,holdId:'dp_fixture',active:true}));
   await assert.rejects(store.tx(c=>paid.assertDispatch(c,{project:a.project,operation:aReserved})),{code:'paid_credit_payment_hold'});
   await assert.rejects(allocate(a),{code:'paid_credit_payment_hold'});
   assert.equal((await paid.usage(a.project)).available,0);
   await store.tx(async c=>{
    await paid.setPaymentHold(c,{...scope,holdId:'dp_fixture',active:false});
    await paid.setPaymentHold(c,{...scope,holdId:'dp_fixture',active:true});
    await paid.assertDispatch(c,{project:a.project,operation:aReserved});
   });
   const unknown=await finish(a.project,aReserved,{dispatched:true,unknown:true,measuredBytes:1_250_000});
   assert.equal(unknown.state,'held');assert.equal(unknown.used_credits,null);assert.equal(unknown.reserved_credits,2);
   assert.equal(await outstanding(),before);
   assert.equal(await finish(a.project,aReserved,{dispatched:false}),null);
   const lost=await allocate(a),noTraffic=await allocate(a),atCap=await allocate(a,quote('residential',0.5));
   const platform=await finish(a.project,lost,{dispatched:true,unknown:true,fetchxFailure:true});
   assert.equal(platform.settlement_basis,'fetchx_failure_refund');assert.equal(platform.used_credits,0);
   assert.equal((await finish(a.project,noTraffic,{dispatched:false})).settlement_basis,'verified_no_dispatch');
   const proven=await finish(a.project,atCap,{dispatched:true,unknown:true,confirmedAtCap:true});
   assert.equal(proven.settlement_basis,'confirmed_cap');assert.equal(proven.used_credits,10);assert.equal(proven.billable_bytes,500_000);
   assert.equal(await outstanding(),before-508_200n);
   const saved=await allocate(a,quote('direct',1));
   await assert.rejects(reserve(a.project,saved,{...quote('direct'),reserved_credits:0}),{code:'paid_credit_reservation_invalid'});
   assert.equal((await finish(a.project,saved,{dispatched:true,measuredBytes:0})).used_credits,0);
   const unsent=await allocate(a),possiblySent=await allocate(a);
   await store.tx(async c=>{
    for(const [operation,state,error] of [[unsent,'cancelled_before_dispatch','interrupted_before_dispatch'],[possiblySent,'unknown','interrupted_unknown']]){
     await c.query('UPDATE v2_operations SET error=$2 WHERE id=$1',[operation,error]);
     await c.query(`INSERT INTO v2_ledger(operation,project,session_id,provider,proxy_class,state,reserved_requests,accounted_requests,
      reserved_encoded_bytes,accounted_encoded_bytes,reserved_tunnel_bytes,accounted_tunnel_bytes)
      VALUES($1,$2,$3,'evomi','residential',$4,1,1,10,10,250000,250000)`,[operation,a.project,a.session,state]);
    }
    await recoverControlPaidCredits(c);await recoverControlPaidCredits(c);
   });
   assert.equal((await paid.operation(a.project,unsent)).state,'released');
   assert.equal((await paid.operation(a.project,possiblySent)).state,'held');
   assert.equal((await paid.usage(a.project)).held,7);
   const revoked=await allocate(a);
   await revoke(pack);
   await assert.rejects(store.tx(c=>paid.assertDispatch(c,{project:a.project,operation:revoked})),{code:'paid_credit_reservation_unavailable'});
  });
 }finally{
  await store.pool.query('DELETE FROM paid_credit_allocations WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM paid_credit_reservations WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM paid_credit_grants WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM paid_credit_payment_holds WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM v2_ledger WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM v2_operations WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM v2_sessions WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM control_credit_accounts WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM control_projects WHERE id=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM control_users WHERE id=$1',[user]);
  await store.close();
 }
});
