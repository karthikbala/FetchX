import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ControlStripe} from '../src/control-stripe.mjs';
import {grantInitialCredits} from '../src/control-credits.mjs';
import {sha} from '../src/crypto.mjs';
import {Gateway} from '../src/gateway.mjs';
import {GatewayError} from '../src/policy.mjs';
import {reviewedPaidResidentialBudget} from '../src/residential.mjs';
import {Store} from '../src/store.mjs';
import {PAID_WIRE_READ_BYTES} from '../src/v2-http.mjs';
import {PublicFetchGateway} from '../src/v2-public-fetch.mjs';
import {PUBLIC_URL_REF} from '../src/v2-public-url.mjs';
import {V2Gateway} from '../src/v2.mjs';

const route={class:'residential',country:'US'};
const paidBudget={reviewed:true,provider:'evomi',maxTotalBytes:60_000_000_000,maxDailyBytes:1_000_000_000,microUsdPerGB:1_000_000};
const paidHoldBytes=250_000+PAID_WIRE_READ_BYTES;
const plans=[[200,10000],[800,50000],[2000,150000],[10000,1000000]].map(([amountMinor,credits])=>({
 id:'credits-'+credits,name:credits.toLocaleString('en-US')+' credits',priceId:'price_fixture'+amountMinor,amountMinor,currency:'usd',credits
}));

test('paid residential budget requires reviewed bounded Evomi capacity and the separate paid rate',()=>{
 const get=budget=>reviewedPaidResidentialBudget({controlPlane:{enabled:true,paidCreditPolicy:{reviewed:true,residentialBudget:budget}}});
 assert.equal(get(paidBudget),paidBudget);
 for(const patch of [{reviewed:false},{provider:'dataimpulse'},{maxTotalBytes:60_000_000_001},{maxDailyBytes:1_000_000_001},
  {maxDailyBytes:0},{maxTotalBytes:20_000},{microUsdPerGB:990_000},{priorReservedBytes:1}])assert.equal(get({...paidBudget,...patch}),null);
});

test('paid residential capacity and pending Checkout stay separate from both legacy transports and durable provider holds',
 {skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const dir=await mkdtemp(join(tmpdir(),'fetchx-paid-budget-')),store=new Store(process.env.TEST_DATABASE_URL);
 const buyerIds=Array.from({length:4},()=>'cp_'+randomUUID()),paidProject='cp_'+randomUUID(),user=randomUUID();
 const legacy='legacy-budget',legacyRef={id:'private-budget',version:1},legacyHost='private-budget.sample.net';
 const legacyV1Profile={hosts:[legacyHost],methods:['GET'],headers:[],country:'US',maxConcurrent:1,maxRequests:12,
  maxInputBytes:1024,maxResponseBytes:1024,maxBytes:1_000_000,ttlSeconds:120,minIntervalMs:0,maxFallbackCredits:0,
  maxAttemptBytes:100_000,maxResidentialBytes:400_000};
 const config={release:'paid-budget-fixture',artifactDir:dir,artifactKey:'d4'.repeat(32),proxies:[],defaultRouting:'residential-v1',
  maxDailyFallbackCredits:0,projects:{[legacy]:{profiles:['native'],v2_access_profiles:['private-budget@1'],maxDailyResidentialBytes:400_000}},
  residential:{maxTotalBytes:450_000,maxDailyBytes:400_000,providers:{evomi:{
   enabled:true,username:'fixture-legacy',password:'fixture-provider',countries:['US'],maxTotalBytes:450_000,priorReservedBytes:50_000,microUsdPerGB:990_000}}},
  v2:{accessProfiles:{'private-budget@1':{...legacyRef,origins:[`https://${legacyHost}`],methods:['GET'],headers:[],proxy_classes:['residential'],countries:['US'],
   limits:{max_tunnel_bytes:200_000,max_redirects:0,min_interval_ms:0}}}},
  controlPlane:{enabled:true,creditPolicy:{reviewed:true,version:'trial-fixture',trialCredits:1000,weights:{direct:1},maxEstimatedMicroUsdPerOperation:0},
   paidCreditPolicy:{reviewed:true,version:'paid-fixture',residentialBudget:{...paidBudget},
    routes:[{accessProfile:PUBLIC_URL_REF,...route,provider:'evomi'}],
    dns:{reviewed:true,endpoint:'https://resolver.sample.net/resolve',address:'1.1.1.1'},publicUrl:{reviewed:true,maxDailyOperations:100}}}};
 let v1Dispatches=0,legacyV2Dispatches=0,paidDispatches=0,paidMode='refund',checkoutGate;
 const gateway=new Gateway({store,config,profiles:{native:legacyV1Profile},resolve:async()=>[{address:'93.184.216.34'}],
  transport:{residential:async()=>{
   v1Dispatches++;
   return {status:200,headers:{},body:Buffer.from('legacy-v1'),wireBytes:33,proxyTraffic:{status:'measured',bytes:33}};
  }}});
 const v2=new V2Gateway(gateway,{
  dnsHttp:async(_input,destination,_limits,{wireMeter})=>{
   assert.equal(wireMeter,true);
   const name=destination.url.searchParams.get('name'),type=Number(destination.url.searchParams.get('type'));
   const encoded=Buffer.from(JSON.stringify({Status:0,Question:[{name,type}],Answer:type===1?[{name,type,data:'93.184.216.34'}]:[]}));
   return {status:200,headers:{},encoded,wire_bytes:1000,wire_bytes_lower_bound:1000};
  },
  http:async(_input,_destination,_limits,{wireMeter})=>{
   if(!wireMeter){legacyV2Dispatches++;return {status:200,headers:{},encoded:Buffer.from('legacy-v2'),tunnel_bytes:25};}
   paidDispatches++;
   if(paidMode==='success')return {status:200,headers:{},encoded:Buffer.from('paid success'),wire_bytes:1000,wire_bytes_lower_bound:1000};
   if(paidMode==='refund')throw Error('fixture gateway failure');
   throw Object.assign(new GatewayError('source_timeout_unknown',502),{wire_dispatched:true,observed_wire_bytes:null,wire_bytes_lower_bound:10});
  }
 });
 const fetch=new PublicFetchGateway(v2),identity={keyId:'console'};
 const paid=key=>fetch.fetch(paidProject,{idempotency_key:key,url:'https://paid-budget.sample.net/',proxy:route},identity);
 const legacyV2=key=>fetch.fetch(legacy,{idempotency_key:key,access_profile:legacyRef,url:`https://${legacyHost}/`,proxy:route});
 const legacyV1=async key=>{
  const workflow=await gateway.workflow(legacy,{profile:'native',idempotency_key:key+'-workflow'});
  return gateway.operation(legacy,workflow.id,{idempotency_key:key,url:`https://${legacyHost}/`,main_document:true});
 };
 const stripe=new ControlStripe({store,config,paidCredits:v2.controlPaidCredits,paidCreditReady:async(...args)=>{
  if(checkoutGate){checkoutGate.reached();await checkoutGate.wait;}
  return v2.paidCreditReady(...args);
 },fetchStripe:()=>assert.fail('No Stripe network call belongs in this fixture')});
 const checkout=(index,plan)=>stripe.prepareOrder(buyerIds[index],{mode:'live',accountId:'acct_fixture'},plan,randomUUID(),'https://fixture.sample.net');
 v2.pace=async()=>{};
 try{
  await store.init();
  await store.pool.query('TRUNCATE workflows,v2_operations,control_stripe_orders,paid_credit_grants CASCADE');
  await store.tx(async c=>{
   await c.query('INSERT INTO control_users(id,email) VALUES($1,$2)',[user,`budget-${user}@example.test`]);
   for(const project of [...buyerIds,paidProject]){
    config.projects[project]={profiles:[],v2_access_profiles:[],v2_entitlement:{mode:'unmetered'}};
    await c.query('INSERT INTO control_projects(id,user_id,name,template_hash) VALUES($1,$2,$3,$4)',[project,user,'Budget test',sha('test')]);
    await grantInitialCredits(c,project,0);
   }
  });
  assert.equal((await legacyV1('legacy-first')).status,200);
  const firstLegacy=(await store.pool.query('SELECT attempt,accounted_bytes,estimated_micro_usd FROM residential_usage')).rows[0];
  assert.equal(Number(firstLegacy.accounted_bytes),100_000);
  assert.equal(Number(firstLegacy.estimated_micro_usd),99);
  assert.equal((await legacyV2('legacy-v2-first')).usage.accounting.estimated_micro_usd,198);

  const budget=config.controlPlane.paidCreditPolicy.residentialBudget;
  budget.maxDailyBytes=1_000_000;
  budget.maxTotalBytes=500_000_000;
  await assert.rejects(checkout(0,plans[0]),{code:'paid_credit_capacity_unavailable'});
  budget.maxTotalBytes=508_200_000;
  assert.equal((await checkout(0,plans[0])).state,'creating');
  assert.deepEqual(await stripe.salesObligations(store.pool),{pendingLiabilityBytes:508_200_000n,outstandingLiabilityBytes:0n});
  await store.pool.query("UPDATE control_stripe_orders SET state='expired' WHERE project=$1",[buyerIds[0]]);
  Object.assign(budget,paidBudget);

  for(const {credits} of plans)assert.equal(await v2.paidCreditReady(paidProject,{publicOnly:true,purchaseCredits:credits}),true);
  for(let i=0;i<3;i++)assert.equal((await checkout(i,plans[i])).state,'creating');
  assert.equal((await stripe.salesObligations(store.pool)).pendingLiabilityBytes,10_672_200_000n);
  await assert.rejects(checkout(3,plans[3]),{code:'paid_credit_capacity_unavailable'});
  await store.pool.query("UPDATE control_stripe_orders SET state='expired' WHERE project=ANY($1)",[buyerIds]);

  await store.tx(c=>v2.controlPaidCredits.grantPaidCredits(c,{project:paidProject,mode:'live',accountId:'acct_fixture',
   checkoutSessionId:'cs_live_budgetfixture',paymentIntentId:'pi_budgetfixture',credits:10000,amountMinor:200,currency:'usd'}));
  config.controlPlane.paidCreditPolicy.residentialBudget.maxDailyBytes=paidHoldBytes*2;
  const {promise:started,resolve:reached}=Promise.withResolvers(),{promise:wait,resolve:release}=Promise.withResolvers();
  checkoutGate={reached,wait};
  const order=checkout(0,plans[3]);
  let refundRequest;
  try{
   await Promise.race([started,order.then(()=>assert.fail('Checkout must hold the sales lock'))]);
   refundRequest=paid('paid-refund');
   let waiting=false;
   for(let attempt=0;attempt<100&&!waiting;attempt++){
    waiting=(await store.pool.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
     AND classid=170017 AND objid=6 AND NOT granted) AS waiting`)).rows[0].waiting;
    if(!waiting)await delay(10);
   }
   assert.equal(waiting,true);
   assert.equal(paidDispatches,0);
  }finally{checkoutGate=null;release();await order;}
  const refunded=await refundRequest;
  assert.equal(refunded.usage.accounting.paid_credits.state,'released');
  assert.equal(refunded.usage.accounting.estimated_micro_usd,255);
  paidMode='unknown';
  const unknown=await paid('paid-unknown');
  assert.equal(unknown.usage.accounting.paid_credits.state,'held');
  assert.equal(unknown.usage.accounting.paid_credits.reserved_credits,5);
  assert.deepEqual(await stripe.salesObligations(store.pool),{pendingLiabilityBytes:50_820_000_000n,outstandingLiabilityBytes:508_200_000n});
  const providerHolds=(await store.pool.query('SELECT state,accounted_tunnel_bytes FROM v2_ledger WHERE operation=ANY($1)',[[refunded.operation_id,unknown.operation_id]])).rows;
  assert.equal(providerHolds.length,2);
  assert.ok(providerHolds.every(row=>row.state==='unknown'&&Number(row.accounted_tunnel_bytes)===paidHoldBytes));
  await store.tx(async c=>{
   await c.query('DELETE FROM paid_credit_allocations WHERE operation=$1',[refunded.operation_id]);
   await c.query('DELETE FROM paid_credit_reservations WHERE operation=$1',[refunded.operation_id]);
  });
  await assert.rejects(paid('paid-exhausted'),{code:'residential_budget_exhausted'});

  config.controlPlane.paidCreditPolicy.residentialBudget.maxDailyBytes=paidBudget.maxDailyBytes;
  await store.pool.query("UPDATE attempts SET error='provider_account_rejected' WHERE id=$1",[firstLegacy.attempt]);
  await assert.rejects(paid('paid-provider-held'),{code:'residential_provider_held'});
  await assert.rejects(legacyV1('legacy-provider-held'),{code:'residential_provider_held'});
  await store.pool.query('UPDATE attempts SET error=NULL WHERE id=$1',[firstLegacy.attempt]);

  assert.equal((await legacyV1('legacy-second')).status,200);
  await assert.rejects(legacyV1('legacy-v1-exhausted'),{code:'residential_budget_exhausted'});
  await assert.rejects(legacyV2('legacy-v2-exhausted'),{code:'residential_budget_exhausted'});
  assert.equal(v1Dispatches,2);
  assert.equal(legacyV2Dispatches,1);
  assert.equal(paidDispatches,2);

  // Scale the newly funded balance to two default requests without running an entire pack.
  const redeemProject=buyerIds[1];
  await store.pool.query(`INSERT INTO paid_credit_grants(project,account_id,mode,checkout_session_id,payment_intent_id,credits,amount_minor,currency)
   VALUES($1,'acct_fixture','live','cs_live_redeemfixture','pi_redeemfixture',10,200,'usd')`,[redeemProject]);
  assert.equal((await stripe.salesObligations(store.pool)).outstandingLiabilityBytes,508_708_200n);
  budget.maxTotalBytes=budget.maxDailyBytes=2*paidHoldBytes+508_200;
  paidMode='success';
  for(const [key,outstanding] of [['redeem-first',508_454_100n],['redeem-second',508_200_000n]]){
   const result=await fetch.fetch(redeemProject,{idempotency_key:key,url:'https://paid-budget.sample.net/',proxy:route},identity);
   assert.equal(result.state,'completed');
   assert.equal(result.usage.accounting.paid_credits.used_credits,5);
   assert.equal(result.usage.accounting.paid_credits.max_transfer_bytes,250_000);
   const {rows:[ledger]}=await store.pool.query('SELECT state,accounted_tunnel_bytes FROM v2_ledger WHERE operation=$1',[result.operation_id]);
   assert.deepEqual(ledger,{state:'unreconciled',accounted_tunnel_bytes:String(paidHoldBytes)});
   assert.equal((await stripe.salesObligations(store.pool)).outstandingLiabilityBytes,outstanding);
  }
  assert.equal((await v2.controlPaidCredits.usage(redeemProject)).available,0);
  assert.equal(paidDispatches,4);
 }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});
