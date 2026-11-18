import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sha} from '../src/crypto.mjs';
import {grantAccountTrialCredits,grantInitialCredits} from '../src/control-credits.mjs';
import {ControlPaidCredits,outstandingPaidCreditLiabilitySql,PAID_CREDIT_RESIDENTIAL_LIABILITY_BYTES,
 quotePaidHttpCredits,recoverControlPaidCredits,restoreReleasedTrialCredits,unifiedCreditsEnabled} from '../src/control-paid-credits.mjs';
import {Store} from '../src/store.mjs';

const token=()=>randomUUID().replaceAll('-','');
const templateHash=sha('unified-ledger-fixture');
const route={class:'direct',provider:'direct',country:null};
const config={controlPlane:{enabled:true,unifiedCredits:{enabled:true},paidCreditPolicy:{reviewed:true,version:'paid-fixture',
 routes:[{...route,accessProfile:{id:'fixture',version:1}}]}}};

test('verified live purchases irreversibly unify the project credit ledger',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const store=new Store(process.env.TEST_DATABASE_URL);
 const paid=new ControlPaidCredits({store,config});
 const disabled=new ControlPaidCredits({store,config:{controlPlane:{...config.controlPlane,unifiedCredits:{enabled:'true'}}}});
 const projects=[],users=[];
 const makeProject=async(credits,user=randomUUID())=>{
  const project='cp_'+randomUUID(),session=randomUUID();
  await store.tx(async c=>{
   await c.query('INSERT INTO control_users(id,email) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[user,user+'@example.test']);
   await c.query('INSERT INTO control_projects(id,user_id,name,template_hash) VALUES($1,$2,$3,$4)',[project,user,'Credit fixture',templateHash]);
   await grantInitialCredits(c,project,credits);
   await c.query(`INSERT INTO v2_sessions(id,project,key,input_hash,policy,route,cookie_jar,expires_at)
    VALUES($1,$2,'fixture','fixture','{}',$3,$3,clock_timestamp()+interval '1 hour')`,[session,project,Buffer.from('fixture')]);
  });
  projects.push(project);users.push(user);
  return {project,session,user};
 };
 const makePurchase=(project,mode='live')=>({project,mode,accountId:'acct_fixture',credits:10_000,amountMinor:200,currency:'usd',
  checkoutSessionId:'cs_'+mode+'_'+token(),paymentIntentId:'pi_'+token()});
 const addReceipt=(input,state='paid',intent=input.paymentIntentId)=>store.tx(async c=>{
  const {project,mode,accountId,checkoutSessionId}=input,order=randomUUID();
  await c.query(`INSERT INTO control_stripe_customers(mode,account_id,project,creation_key,api_version,request_body)
   VALUES($1,$2,$3,$4,'fixture','{}') ON CONFLICT(mode,project) DO NOTHING`,[mode,accountId,project,randomUUID()]);
  await c.query(`INSERT INTO control_stripe_orders(id,mode,account_id,project,operation_key,plan,return_origin,api_version,state,session_id)
   VALUES($1,$2,$3,$4,$5,'{}','https://example.test','fixture','complete',$6)`,[order,mode,accountId,project,randomUUID(),checkoutSessionId]);
  await c.query(`INSERT INTO control_stripe_purchases(mode,account_id,session_id,order_id,project,payment_intent_id,charge_id,state,paid_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())`,[mode,accountId,checkoutSessionId,order,project,intent,'ch_'+token(),state]);
 });
 const grant=input=>store.tx(c=>paid.grantPaidCredits(c,input));
 const upgrade=project=>store.tx(c=>paid.upgradeEligibleProject(c,project));
 const purchase=async project=>{
  const input=makePurchase(project);
  await addReceipt(input);await grant(input);
  return input;
 };
 const makeOperation=async(c,{project,session},kind='http')=>{
  const operation=randomUUID();
  await c.query(`INSERT INTO v2_operations(id,project,key_id,key,session_id,input_hash,input,kind)
   VALUES($1::uuid,$2,'console',$1::uuid::text,$3,'fixture',$4,$5)`,[operation,project,session,Buffer.from('fixture'),kind]);
  return operation;
 };
 const legacy=(a,credits,state)=>store.tx(c=>insertLegacy(c,a,credits,state));
 const insertLegacy=async(c,a,credits,state)=>{
  const operation=await makeOperation(c,a);
  await c.query(`INSERT INTO control_credit_reservations(operation,project,key_id,credits,state,policy_version,proxy_class)
   VALUES($1,$2,'console',$3,$4,'legacy-fixture','direct')`,[operation,a.project,credits,state]);
  return operation;
 };
 const fixed=(a,credits,kind='http')=>store.tx(async c=>{
  const operation=await makeOperation(c,a,kind);
  await paid.reserveFixed(c,{project:a.project,operation,keyId:'console',route,weight:{credits,policyVersion:'logical-fixture'}});
  return operation;
 });
 const finish=(project,operation,options)=>store.tx(c=>paid.finish(c,{project,operation,...options}));
 const signup=async project=>(await store.pool.query(`SELECT credits,account_id,mode,checkout_session_id,payment_intent_id,amount_minor,currency,revoked_at
  FROM paid_credit_grants WHERE project=$1 AND source='signup_trial'`,[project])).rows;
 const outstanding=async()=>BigInt((await store.pool.query(outstandingPaidCreditLiabilitySql)).rows[0].bytes);
 const liability=credits=>BigInt(credits)*BigInt(PAID_CREDIT_RESIDENTIAL_LIABILITY_BYTES);
 try{
  await store.init();
  await t.test('requires a matching nonrevoked verified live purchase and creates one receipt under concurrency',async()=>{
   const a=await makeProject(1000),b=await makeProject(0,a.user);
   const live=makePurchase(a.project),test=makePurchase(a.project,'test'),reversed=makePurchase(a.project),mismatch=makePurchase(a.project);
   assert.equal(unifiedCreditsEnabled(config),true);assert.equal(unifiedCreditsEnabled(disabled.config),false);
   await addReceipt(test,'test_paid_unapplied');
   await grant(reversed);await addReceipt(reversed,'reversed');
   await grant(mismatch);await addReceipt(mismatch,'paid','pi_'+token());
   await grant(live);
   assert.equal(await paid.isUnified(a.project),false);
   assert.equal(await upgrade(a.project),false);
   await assert.rejects(fixed(a,1),{code:'paid_credit_reservation_unavailable'});
   await addReceipt(live);
   assert.equal(await store.tx(c=>disabled.upgradeEligibleProject(c,a.project)),false);
   assert.equal(await paid.isUnified(a.project),false);
   assert.deepEqual((await Promise.all([upgrade(a.project),upgrade(a.project)])).sort(),[false,true]);
   assert.equal(await disabled.isUnified(a.project),true);
   assert.equal(await paid.isUnified(b.project),false);
   await assert.rejects(legacy(a,1,'reserved'),{code:'23514',constraint:'legacy_credit_reservation_closed'});
   const receipt=(await store.pool.query(`SELECT g.checkout_session_id,u.trial_granted_credits FROM control_credit_upgrades u
    JOIN paid_credit_grants g ON g.id=u.verified_purchase_grant_id WHERE u.project=$1`,[a.project])).rows;
   assert.deepEqual(receipt,[{checkout_session_id:live.checkoutSessionId,trial_granted_credits:'1000'}]);
   assert.deepEqual(await signup(a.project),[{credits:'1000',account_id:null,mode:null,checkout_session_id:null,
    payment_intent_id:null,amount_minor:null,currency:null,revoked_at:null}]);
   const revoked=await makePurchase(b.project);
   await grant(revoked);await addReceipt(revoked);await store.tx(c=>paid.revokePaidCredits(c,revoked));
   assert.equal(await upgrade(b.project),false);
  });

  await t.test('moves only unused legacy credit, restores pending releases once, and preserves the account receipt',async()=>{
   const a=await makeProject(0),b=await makeProject(0,a.user);
   const issue=()=>store.tx(c=>grantAccountTrialCredits(c,{userId:a.user,targetCredits:1000,templateHash}));
   assert.deepEqual(await issue(),{project:a.project,granted:1000,replayed:false});
   await legacy(a,250,'settled');
   await legacy(a,200,'held');
   const pending=await legacy(a,300,'reserved');
   await legacy(a,50,'released');
   const input=await purchase(a.project),before=await outstanding();
   assert.equal(await upgrade(a.project),true);
   assert.equal((await signup(a.project))[0].credits,'250');
   assert.equal((await paid.usage(a.project)).available,10_250);
   const after=await outstanding();
   assert.equal(after-before,liability(750));
   await store.tx(async c=>{
    await c.query("UPDATE control_credit_reservations SET state='released' WHERE operation=$1",[pending]);
    assert.equal(await restoreReleasedTrialCredits(c,a.project),true);
    assert.equal(await restoreReleasedTrialCredits(c,a.project),false);
   });
   assert.equal((await signup(a.project))[0].credits,'550');
   assert.equal(await outstanding(),after);
   assert.deepEqual(await issue(),{project:a.project,granted:0,replayed:true});
   assert.deepEqual((await store.pool.query(`SELECT project,target_credits,granted_credits FROM control_trial_grant_receipts WHERE user_id=$1`,[a.user])).rows,
    [{project:a.project,target_credits:'1000',granted_credits:'1000'}]);
   await store.tx(async c=>{
    await paid.revokePaidCredits(c,input);
    await c.query("UPDATE control_stripe_purchases SET state='reversed' WHERE session_id=$1",[input.checkoutSessionId]);
   });
   assert.equal(await paid.isUnified(a.project),true);
   assert.equal(await upgrade(a.project),false);
   assert.equal((await paid.usage(a.project)).available,550);
   assert.equal((await paid.usage(a.project)).revoked_unused,10_000);
   await purchase(b.project);assert.equal(await upgrade(b.project),true);
   assert.equal(await store.tx(c=>restoreReleasedTrialCredits(c,b.project)),false);
   assert.deepEqual(await signup(b.project),[]);
   assert.equal((await paid.usage(b.project)).available,10_000);
  });

  await t.test('a legacy release racing upgrade is imported even when initial availability is zero',async()=>{
   const a=await makeProject(5),operation=await legacy(a,5,'reserved');
   await purchase(a.project);
   const stale=await store.pool.connect();
   const ready=Promise.withResolvers(),resume=Promise.withResolvers();
   const release=store.tx(async c=>{
    await c.query("UPDATE control_credit_reservations SET state='released' WHERE operation=$1",[operation]);
    ready.resolve();
    await resume.promise;
    assert.equal(await restoreReleasedTrialCredits(c,a.project),true);
   });
   try{
    await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    assert.equal(await paid.isUnified(a.project,stale),false);
    await Promise.race([ready.promise,release]);
    assert.equal(await upgrade(a.project),true);
    assert.deepEqual(await signup(a.project),[]);
    await assert.rejects(insertLegacy(stale,a,1,'reserved'),{code:'40001'});
   }finally{
    resume.resolve();
    try{await release;}finally{await stale.query('ROLLBACK');stale.release();}
   }
   assert.equal((await signup(a.project))[0].credits,'5');
   assert.equal((await paid.usage(a.project)).available,10_005);
  });

  await t.test('fixed and wire reservations share allocations, holds and recovery with distinct evidence',async()=>{
   const a=await makeProject(5),payment=await purchase(a.project);
   assert.equal(await upgrade(a.project),true);
   const split=await fixed(a,7,'browser_probe');
   const allocations=(await store.pool.query(`SELECT g.source,a.credits,a.offset_credits FROM paid_credit_allocations a
    JOIN paid_credit_grants g ON g.id=a.grant_id WHERE a.operation=$1 ORDER BY a.offset_credits`,[split])).rows;
   assert.deepEqual(allocations,[{source:'signup_trial',credits:'5',offset_credits:'0'},{source:'stripe',credits:'2',offset_credits:'5'}]);
   const hold={...payment,holdId:'dp_fixture'};
   await store.tx(c=>paid.setPaymentHold(c,{...hold,active:true}));
   assert.equal((await paid.usage(a.project)).available,0);
   await assert.rejects(fixed(a,1),{code:'paid_credit_payment_hold'});
   await assert.rejects(store.tx(c=>paid.assertDispatch(c,{project:a.project,operation:split})),{code:'paid_credit_payment_hold'});
   await store.tx(c=>paid.setPaymentHold(c,{...hold,active:false}));
   await store.tx(c=>paid.revokePaidCredits(c,payment));
   await assert.rejects(store.tx(c=>paid.assertDispatch(c,{project:a.project,operation:split})),{code:'paid_credit_reservation_unavailable'});
   const release=await finish(a.project,split,{dispatched:false});
   assert.equal(release.state,'released');assert.equal(release.used_credits,0);assert.equal(release.billable_bytes,null);
   const race=await Promise.allSettled([fixed(a,3),fixed(a,3)]);
   assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
   assert.equal(race.find(r=>r.status==='rejected').reason.code,'paid_credit_balance_exhausted');
   const winner=race.find(r=>r.status==='fulfilled').value;
   const settled=await finish(a.project,winner,{dispatched:true,measuredBytes:0});
   assert.equal(settled.basis,'prepaid_logical_operation_credits');assert.equal(settled.settlement_basis,'logical_operation');
   assert.equal(settled.used_credits,3);assert.equal(settled.billable_bytes,null);assert.equal(settled.max_transfer_bytes,null);

   const wire=await store.tx(async c=>{
    const operation=await makeOperation(c,a);
    await paid.reserve(c,{project:a.project,operation,keyId:'console',quote:quotePaidHttpCredits({route})});
    return operation;
   });
   const metered=await finish(a.project,wire,{dispatched:true,measuredBytes:1});
   assert.equal(metered.basis,'prepaid_http_wire_credits');assert.equal(metered.billable_bytes,1);assert.equal(metered.used_credits,1);
   const uncertain=await fixed(a,1);
   assert.equal((await finish(a.project,uncertain,{dispatched:false,unknown:true})).state,'held');
   await assert.rejects(store.tx(c=>paid.reconcileHeld(c,{project:a.project,operation:uncertain,metered_bytes:0,
    evidence:'sha256:'+'0'.repeat(64),reason:'no_traffic_verified',operator:'fixture',attested:true})),
   {code:'paid_credit_reconciliation_not_byte_metered'});
   assert.equal((await paid.usage(a.project)).available,0);

   await purchase(a.project);
   const unsent=await fixed(a,2),possiblySent=await fixed(a,2,'browser_probe');
   await store.tx(async c=>{
    for(const [operation,state,error] of [[unsent,'cancelled_before_dispatch','interrupted_before_dispatch'],[possiblySent,'unknown','interrupted_unknown']]){
     await c.query('UPDATE v2_operations SET error=$2 WHERE id=$1',[operation,error]);
     await c.query(`INSERT INTO v2_ledger(operation,project,session_id,provider,proxy_class,state,reserved_requests,accounted_requests,
      reserved_encoded_bytes,accounted_encoded_bytes,reserved_tunnel_bytes,accounted_tunnel_bytes)
      VALUES($1,$2,$3,'direct','direct',$4,1,1,10,10,10,10)`,[operation,a.project,a.session,state]);
    }
    await recoverControlPaidCredits(c);await recoverControlPaidCredits(c);
   });
   const recovered=await paid.operation(a.project,unsent);
   assert.equal(recovered.state,'released');assert.equal(recovered.billable_bytes,null);assert.equal(recovered.used_credits,0);
   assert.equal((await paid.operation(a.project,possiblySent)).state,'held');
   assert.equal((await paid.usage(a.project)).held,3);
  });
 }finally{
  for(const table of ['control_stripe_purchases','control_stripe_orders','control_stripe_customers',
   'paid_credit_allocations','paid_credit_reservations','control_credit_upgrades','paid_credit_grants','paid_credit_payment_holds',
   'control_credit_reservations','v2_ledger','v2_operations','v2_sessions','control_credit_accounts'])
   await store.pool.query(`DELETE FROM ${table} WHERE project=ANY($1)`,[projects]);
  await store.pool.query('DELETE FROM control_projects WHERE id=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM control_users WHERE id=ANY($1)',[users]);
  await store.close();
 }
});
