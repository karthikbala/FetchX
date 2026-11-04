import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {ControlCredits,TRIAL_CREDITS_PER_ACCOUNT,grantInitialCredits,migrateAccountTrialCredits,reviewedCreditPolicy} from '../src/control-credits.mjs';
import {ControlIdentity} from '../src/control-identity.mjs';
import {sha} from '../src/crypto.mjs';
import {Store} from '../src/store.mjs';

const settings=()=>({projects:{},v2:{accessProfiles:{'synthetic-trial@1':{id:'synthetic-trial',version:1}}},
 controlPlane:{enabled:true,bridgeSecret:'fixture-private-bridge-secret-not-real',projectTemplate:{
  id:'synthetic-template',v2_access_profiles:['synthetic-trial@1'],v2_entitlement:{mode:'metered',max_daily_operations:25}
 },creditPolicy:{reviewed:true,version:'trial-v1',weights:{direct:1},maxEstimatedMicroUsdPerOperation:0}}});

test('the reviewed free offer defaults to 1,000 credits and keeps residential excluded',()=>{
 const config=settings();
 assert.equal(reviewedCreditPolicy(config).trialCredits,TRIAL_CREDITS_PER_ACCOUNT);
 const credits=new ControlCredits({config});
 assert.throws(()=>credits.quote({route:{class:'residential'},estimatedMicroUsd:0}),{code:'credit_route_forbidden'});
 config.controlPlane.creditPolicy.trialCredits=1001;
 assert.throws(()=>reviewedCreditPolicy(config),{code:'credit_policy_invalid'});
});

test('trial upgrades and simultaneous project creation respect one lifetime grant per verified account',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const store=new Store(process.env.TEST_DATABASE_URL),config=settings(),identity=new ControlIdentity({store,config});
 const credits=new ControlCredits({store,config}),users=[],projects=[];
 const templateHash=identity.template().hash;
 const targetCredits=TRIAL_CREDITS_PER_ACCOUNT;
 const migrate=()=>migrateAccountTrialCredits(store,{targetCredits,templateHash});
 const makeUser=async()=>{
  const id=randomUUID();users.push(id);
  await store.pool.query('INSERT INTO control_users(id,email) VALUES($1,$2)',[id,`trial-${id}@example.test`]);
  return id;
 };
 const makeLegacy=(user,amount,time,{status='active',hash=templateHash}={})=>store.tx(async c=>{
  const project='cp_'+randomUUID();projects.push(project);
  await c.query('INSERT INTO control_projects(id,user_id,name,template_hash,status,created_at) VALUES($1,$2,$3,$4,$5,$6)',
   [project,user,'Legacy fixture',hash,status,time]);
  await grantInitialCredits(c,project,amount);
  return project;
 });
 const create=async(user,name)=>{
  const project=await identity.createProject(user,{name});projects.push(project.id);return project.id;
 };
 const dropProject=async project=>{
  await store.pool.query('DELETE FROM control_memberships WHERE project=$1',[project]);
  await store.pool.query('DELETE FROM control_credit_accounts WHERE project=$1',[project]);
  await store.pool.query('DELETE FROM control_projects WHERE id=$1',[project]);
 };
 try{
  await store.init();
  await t.test('upgrade counts all old allocations, tops up the oldest eligible project and preserves usage',async()=>{
   const user=await makeUser();
   const disabled=await makeLegacy(user,10,'2025-01-01T00:00:00Z',{status:'disabled'});
   const incompatible=await makeLegacy(user,5,'2025-01-02T00:00:00Z',{hash:sha('other template')});
   const oldest=await makeLegacy(user,25,'2025-01-03T00:00:00Z');
   const newer=await makeLegacy(user,0,'2025-01-04T00:00:00Z');
   const session=randomUUID();
   await store.tx(async c=>{
    await c.query(`INSERT INTO v2_sessions(id,project,key,input_hash,policy,route,cookie_jar,expires_at)
     VALUES($1,$2,'synthetic','fixture','{}',$3,$3,clock_timestamp()+interval '1 hour')`,[session,oldest,Buffer.from('fixture')]);
    for(const [state,amount] of [['held',1],['reserved',2],['settled',3]]){
     const operation=randomUUID();
     await c.query(`INSERT INTO v2_operations(id,project,key_id,key,session_id,input_hash,input)
      VALUES($1::uuid,$2,'console',$1::uuid::text,$3,'synthetic',$4)`,[operation,oldest,session,Buffer.from('fixture')]);
     await c.query(`INSERT INTO control_credit_reservations(operation,project,key_id,credits,state,policy_version,proxy_class)
      VALUES($1,$2,'console',$3,$4,'trial-v1','direct')`,[operation,oldest,amount,state]);
    }
   });
   const history=async()=>(await store.pool.query('SELECT * FROM control_credit_reservations WHERE project=$1 ORDER BY operation',[oldest])).rows;
   const before=await history();
   const results=await Promise.all([migrate(),migrate()]);
   assert.equal(results.reduce((sum,r)=>sum+r.accounts,0),1);
   assert.equal(results.reduce((sum,r)=>sum+r.granted,0),960);
   assert.deepEqual(await migrate(),{accounts:0,granted:0});
   assert.deepEqual(await history(),before);
   assert.equal((await credits.usage(oldest)).granted,985);
   assert.equal((await credits.usage(oldest)).available,979);
   assert.deepEqual(await Promise.all([disabled,incompatible,newer].map(async id=>(await credits.usage(id)).granted)),[10,5,0]);
   assert.equal((await identity.hydrateProject(oldest)).v2_entitlement.max_daily_operations,25);
   assert.equal(identity.template().hash,templateHash);
  });
  await t.test('parallel first-project requests and project recreation cannot duplicate the offer',async()=>{
   const user=await makeUser();
   const first=await Promise.all([create(user,'First request'),create(user,'Second request')]);
   const balances=await Promise.all(first.map(async id=>(await credits.usage(id)).granted));
   assert.deepEqual(balances.sort((a,b)=>a-b),[0,1000]);
   for(const id of first)await dropProject(id);
   const next=await create(user,'Replacement project');
   assert.equal((await credits.usage(next)).granted,0);
   const receipt=(await store.pool.query('SELECT project,granted_credits FROM control_trial_grant_receipts WHERE user_id=$1',[user])).rows;
   assert.equal(receipt.length,1);assert.equal(receipt[0].granted_credits,'1000');
   assert.ok(first.includes(receipt[0].project));
  });
  await t.test('earlier receipt survives deleted project and the upgraded limit fills only the difference',async()=>{
   const user=await makeUser();
   config.controlPlane.creditPolicy.trialCredits=25;
   const old=await create(user,'Prior offer');
   assert.equal((await credits.usage(old)).granted,25);
   await dropProject(old);
   config.controlPlane.creditPolicy.trialCredits=1000;
   assert.equal(identity.template().hash,templateHash);
   const next=await create(user,'After trial upgrade');
   assert.equal((await credits.usage(next)).granted,975);
   const another=await create(user,'No extra trial');
   assert.equal((await credits.usage(another)).granted,0);
  });
  await t.test('authenticated hydration upgrades an old active account without a new project',async()=>{
   const user=await makeUser(),old=await makeLegacy(user,25,'2025-01-01T00:00:00Z');
   await Promise.all([identity.hydrateProject(old),identity.hydrateProject(old)]);
   assert.equal((await credits.usage(old)).granted,1000);
   const receipt=(await store.pool.query('SELECT granted_credits FROM control_trial_grant_receipts WHERE user_id=$1',[user])).rows;
   assert.deepEqual(receipt,[{granted_credits:'975'}]);
  });
 }finally{
  await store.pool.query('DELETE FROM control_credit_reservations WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM v2_operations WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM v2_sessions WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM control_memberships WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM control_credit_accounts WHERE project=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM control_projects WHERE id=ANY($1)',[projects]);
  await store.pool.query('DELETE FROM control_users WHERE id=ANY($1)',[users]);
  await store.close();
 }
});
