import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {readPaidCreditReconciliationFile} from '../src/paid-credit-reconcile-cli.mjs';
import {ControlPaidCredits,quotePaidHttpCredits} from '../src/control-paid-credits.mjs';
import {grantInitialCredits} from '../src/control-credits.mjs';
import {sha} from '../src/crypto.mjs';
import {Store} from '../src/store.mjs';

const run=promisify(execFile);
const cli=fileURLToPath(new URL('../src/paid-credit-reconcile-cli.mjs',import.meta.url));
const fixture=(project='cp_'+randomUUID(),operation=randomUUID())=>({
 project,operation,metered_bytes:250_001,evidence:'sha256:'+'a'.repeat(64),reason:'provider_usage_verified',
 operator:'synthetic.operator',attested:true
});
const privateJson=(path,value)=>writeFile(path,JSON.stringify(value),{mode:0o600});

test('paid credit reconciliation requires a bounded private file and a complete attestation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fetchx-paid-credit-input-'));
 const path=join(root,'input.json'),input=fixture();
 try{
  await privateJson(path,input);
  assert.deepEqual(await readPaidCreditReconciliationFile(path),input);
  await chmod(path,0o640);
  await assert.rejects(readPaidCreditReconciliationFile(path),{code:'paid_credit_reconciliation_file_invalid'});
  await chmod(path,0o600);
  const link=join(root,'link.json');
  await symlink(path,link);
  await assert.rejects(readPaidCreditReconciliationFile(link),{code:'paid_credit_reconciliation_file_invalid'});
  await assert.rejects(readPaidCreditReconciliationFile(root),{code:'paid_credit_reconciliation_file_invalid'});
  await writeFile(path,' '.repeat(4097));
  await assert.rejects(readPaidCreditReconciliationFile(path),{code:'paid_credit_reconciliation_file_invalid'});
  for(const change of [{attested:false},{operator:'arbitrary@address.test'},{operation:'invalid'},
   {metered_bytes:2.5},{reason:'no_traffic_verified'},{evidence:'no-digest'},{capture:'SYNTHETIC_CAPTURE_MUST_NOT_APPEAR'}]){
   await privateJson(path,{...input,...change});
   await assert.rejects(readPaidCreditReconciliationFile(path),{code:'paid_credit_reconciliation_invalid'});
  }
  await assert.rejects(run(process.execPath,[cli,path],{env:{...process.env,DATABASE_URL:''}}),error=>{
   assert.equal(error.stdout,'');
   assert.equal(error.stderr,'paid_credit_reconciliation_invalid\n');
   return true;
  });
 }finally{await rm(root,{recursive:true,force:true});}
});

test('operator reconciliation records one held customer debit and preserves provider accounting',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const databaseUrl=process.env.TEST_DATABASE_URL;
 assert.match(new URL(databaseUrl).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const root=await mkdtemp(join(tmpdir(),'fetchx-paid-credit-reconcile-')),store=new Store(databaseUrl);
 const user=randomUUID(),projects=['cp_'+randomUUID(),'cp_'+randomUUID()],project=projects[0],session=randomUUID();
 const accountId='acct_synthetic',mode='live';
 const config={controlPlane:{enabled:true,paidCreditPolicy:{reviewed:true,version:'paid-credit-v1',
  routes:[{accessProfile:{id:'synthetic',version:1},class:'residential',provider:'evomi',country:'US'}]}}};
 const paidCredits=new ControlPaidCredits({store,config});
 const grant={project,mode,accountId,amountMinor:200,credits:10_000,currency:'usd',
  checkoutSessionId:'cs_live_'+randomUUID().replaceAll('-',''),paymentIntentId:'pi_'+randomUUID().replaceAll('-','')};
 const operation=async(maxTransferMb,traffic)=>{
  const op=randomUUID();
  await store.tx(async c=>{
   await c.query(`INSERT INTO v2_operations(id,project,key_id,key,session_id,input_hash,input,state,error)
    VALUES($1::uuid,$2,'console',$1::uuid::text,$3,'synthetic',$4,'unknown','interrupted_unknown')`,[op,project,session,Buffer.from('fixture')]);
   const quote=quotePaidHttpCredits({route:'residential',maxTransferMb});
   await paidCredits.reserve(c,{project,operation:op,keyId:'console',quote});
   if(traffic)await paidCredits.finish(c,{project,operation:op,...traffic});
  });
  return op;
 };
 const reconcile=input=>store.tx(c=>paidCredits.reconcileHeld(c,input));
 try{
  await store.init();
  await store.pool.query('INSERT INTO control_users(id,email) VALUES($1,$2)',[user,`reconcile-${user}@example.test`]);
  await store.tx(async c=>{
   for(const id of projects){
    await c.query('INSERT INTO control_projects(id,user_id,name,template_hash) VALUES($1,$2,$3,$4)',[id,user,'Reconciliation fixture',sha('fixture')]);
    await grantInitialCredits(c,id,0);
   }
   await c.query(`INSERT INTO v2_sessions(id,project,key,input_hash,policy,route,cookie_jar,expires_at)
    VALUES($1,$2,'synthetic','fixture','{}',$3,$3,clock_timestamp()+interval '1 hour')`,[session,project,Buffer.from('fixture')]);
  });
  await store.tx(c=>paidCredits.grantPaidCredits(c,grant));
  const settled=await operation(0.25,{dispatched:true,measuredBytes:1});
  const held=await operation(1,{dispatched:true,unknown:true});
  const reserved=await operation(0.25),released=await operation(0.25,{dispatched:false});
  const zero=await operation(0.25,{dispatched:true,unknown:true});
  await store.pool.query(`INSERT INTO v2_ledger(operation,project,session_id,provider,proxy_class,state,reserved_requests,accounted_requests,
   reserved_encoded_bytes,accounted_encoded_bytes,reserved_tunnel_bytes,accounted_tunnel_bytes,estimated_micro_usd)
   VALUES($1,$2,$3,'evomi','residential','unknown',1,1,20,20,1000000,1000000,1000)`,[held,project,session]);
  const before=async()=>(await store.pool.query(`SELECT row_to_json(l) AS provider,row_to_json(o) AS operation,
   row_to_json(s) AS session FROM v2_ledger l JOIN v2_operations o ON o.id=l.operation
   JOIN v2_sessions s ON s.id=l.session_id WHERE l.operation=$1`,[held])).rows[0];
  const providerBefore=await before();
  const allocations=async()=>(await store.pool.query('SELECT * FROM paid_credit_allocations WHERE operation=$1 ORDER BY offset_credits',[held])).rows;
  const originalSplit=await allocations();
  assert.deepEqual(originalSplit.map(a=>a.credits),['20']);
  const holdTime=(await store.pool.query('SELECT finished_at FROM paid_credit_reservations WHERE operation=$1',[held])).rows[0].finished_at;
  const input=fixture(project,held);
  for(const op of [reserved,released,settled])await assert.rejects(reconcile({...input,operation:op}),{code:'paid_credit_reconciliation_not_held'});
  await assert.rejects(reconcile({...input,project:projects[1]}),{code:'paid_credit_reconciliation_not_found'});
  await assert.rejects(reconcile({...input,metered_bytes:1_000_001}),{code:'paid_credit_reconciliation_exceeds_reservation'});
  await store.tx(async c=>{
   await paidCredits.revokePaidCredits(c,grant);
   await paidCredits.setPaymentHold(c,{project,mode,accountId,holdId:'dp_fixture',active:true});
  });
  const path=join(root,'verified.json');
  await privateJson(path,input);
  const call=()=>run(process.execPath,[cli,path],{env:{...process.env,DATABASE_URL:databaseUrl}});
  const results=await Promise.all([call(),call()]);
  assert.ok(results.every(result=>result.stderr===''));
  assert.deepEqual(results.map(result=>JSON.parse(result.stdout)).sort((a,b)=>Number(a.replayed)-Number(b.replayed)),
   [{replayed:false,used_credits:10},{replayed:true,used_credits:10}]);
  await assert.rejects(reconcile({...input,metered_bytes:250_000}),{code:'paid_credit_reconciliation_conflict'});
  await assert.rejects(reconcile({...input,evidence:'sha256:'+'b'.repeat(64)}),{code:'paid_credit_reconciliation_conflict'});
  const receipts=(await store.pool.query('SELECT * FROM paid_credit_reconciliations WHERE operation=$1',[held])).rows;
  assert.equal(receipts.length,1);
  assert.equal(receipts[0].prior_state,'held');assert.equal(receipts[0].reserved_credits,'20');
  assert.equal(receipts[0].metered_bytes,'250001');assert.equal(receipts[0].evidence,input.evidence);
  assert.equal(receipts[0].operator_id,input.operator);assert.equal(receipts[0].attested,true);
  const after=(await store.pool.query('SELECT state,finished_at,used_credits FROM paid_credit_reservations WHERE operation=$1',[held])).rows[0];
  assert.deepEqual(after,{state:'settled',finished_at:holdTime,used_credits:'10'});
  assert.deepEqual(await allocations(),originalSplit);assert.deepEqual(await before(),providerBefore);
  await reconcile({...input,operation:zero,metered_bytes:0,reason:'no_traffic_verified'});
  assert.equal((await paidCredits.operation(project,zero)).used_credits,0);
  assert.equal((await paidCredits.usage(project)).payment_hold,true);
  await store.tx(c=>paidCredits.setPaymentHold(c,{project,mode,accountId,holdId:'dp_fixture',active:false}));
  const usage=await paidCredits.usage(project);
  assert.equal(usage.used,15);
  assert.equal(usage.available,0);
  assert.equal(usage.revoked_unused,9980);
  assert.equal(usage.held,0);
  const reversed=(await store.pool.query('SELECT revoked_at FROM paid_credit_grants WHERE checkout_session_id=$1',[grant.checkoutSessionId])).rows[0];
  assert.ok(reversed.revoked_at);
 }finally{
  await store.pool.query('DELETE FROM paid_credit_reconciliations WHERE project=ANY($1)',[projects]);
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
  await store.close();await rm(root,{recursive:true,force:true});
 }
});
