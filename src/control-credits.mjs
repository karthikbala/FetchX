import {ID,fail} from './policy.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_CREDITS=1_000_000_000;
const MAX_WEIGHT=1_000_000;
const ROUTES=['direct','datacenter','residential'];
const TRANSPORTS=['http','browser'];
export const TRIAL_CREDITS_PER_ACCOUNT=1000;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const creditAmount=v=>Number.isSafeInteger(v)&&v>=0&&v<=MAX_CREDITS;
const managed=project=>typeof project==='string'&&project.startsWith('cp_');
const unit=transport=>transport==='browser'?'logical_browser_operation':'logical_http_operation';
const view=row=>row?{credits:Number(row.credits),state:row.state,key_id:row.key_id,policy_version:row.policy_version,unit:unit(row.transport)}:null;
const validWeights=(value,routes)=>plain(value)&&Object.entries(value).every(([route,weight])=>routes.includes(route)&&Number.isSafeInteger(weight)&&weight>=1&&weight<=MAX_WEIGHT);

export async function initControlCredits(pool){
 await pool.query(`
  SELECT pg_advisory_xact_lock(170017,2);
  CREATE TABLE IF NOT EXISTS control_credit_accounts(project text PRIMARY KEY,granted_credits bigint NOT NULL CHECK(granted_credits>=0 AND granted_credits<=1000000000),created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS control_credit_reservations(operation uuid PRIMARY KEY REFERENCES v2_operations(id),project text NOT NULL REFERENCES control_credit_accounts(project),key_id text NOT NULL,credits bigint NOT NULL CHECK(credits>0 AND credits<=1000000),state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','held','released')),policy_version text NOT NULL,proxy_class text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz);
  DO $$ BEGIN
   IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='control_credit_reservations'::regclass AND attname='transport' AND NOT attisdropped) THEN
    ALTER TABLE control_credit_reservations ADD COLUMN transport text NOT NULL DEFAULT 'http' CHECK(transport IN ('http','browser'));
    ALTER TABLE control_credit_reservations DROP CONSTRAINT IF EXISTS control_credit_reservations_proxy_class_check;
    ALTER TABLE control_credit_reservations ADD CONSTRAINT control_credit_reservation_route_check CHECK(proxy_class IN ('direct','datacenter','residential'));
   END IF;
  END $$;
  CREATE INDEX IF NOT EXISTS control_credit_project_state ON control_credit_reservations(project,state);
  CREATE TABLE IF NOT EXISTS control_trial_grant_receipts(
   user_id uuid NOT NULL REFERENCES control_users(id) ON DELETE CASCADE,
   target_credits bigint NOT NULL CHECK(target_credits BETWEEN 0 AND 1000),project text NOT NULL,
   prior_granted bigint NOT NULL CHECK(prior_granted>=0),granted_credits bigint NOT NULL,
   created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(user_id,target_credits),
   CHECK(granted_credits=GREATEST(target_credits-prior_granted,0))
  );
 `);
}

// The caller owns the project-creation transaction. Repeating creation never
// tops up an existing account, even when an operator later changes trial size.
export async function grantInitialCredits(c,project,amount){
 if(!managed(project)||!creditAmount(amount))fail('credit_grant_invalid',503);
 await c.query('INSERT INTO control_credit_accounts(project,granted_credits) VALUES($1,$2) ON CONFLICT DO NOTHING',[project,amount]);
}

// Create or top up only the oldest eligible project. The immutable receipt
// belongs to the verified user and survives removal of the original project.
export async function grantAccountTrialCredits(c,{userId,targetCredits,templateHash}){
 if(typeof userId!=='string'||!UUID.test(userId)||!creditAmount(targetCredits)||targetCredits>TRIAL_CREDITS_PER_ACCOUNT||
  typeof templateHash!=='string'||!/^[a-f0-9]{64}$/.test(templateHash))fail('credit_grant_invalid',503);
 if(!(await c.query('SELECT id FROM control_users WHERE id=$1 FOR UPDATE',[userId])).rowCount)fail('unauthorized',401);
 const existing=(await c.query(`SELECT project,prior_granted,granted_credits FROM control_trial_grant_receipts
  WHERE user_id=$1 AND target_credits=$2`,[userId,targetCredits])).rows[0];
 if(existing)return {project:existing.project,granted:0,replayed:true};
 const project=(await c.query(`SELECT id FROM control_projects WHERE user_id=$1 AND template_hash=$2 AND status='active'
  AND left(id,3)='cp_' ORDER BY created_at,id LIMIT 1 FOR SHARE`,[userId,templateHash])).rows[0]?.id;
 if(!project)return null;
 const prior=(await c.query(`SELECT GREATEST(
  (SELECT COALESCE(sum(a.granted_credits),0) FROM control_credit_accounts a JOIN control_projects p ON p.id=a.project
   WHERE p.user_id=$1 AND left(p.id,3)='cp_'),
  (SELECT COALESCE(max(prior_granted+granted_credits),0) FROM control_trial_grant_receipts WHERE user_id=$1)
 ) AS credits`,[userId])).rows[0].credits;
 const used=BigInt(prior),target=BigInt(targetCredits);
 const add=used<target?Number(target-used):0;
 await grantInitialCredits(c,project,0);
 if(add>0)await c.query('UPDATE control_credit_accounts SET granted_credits=granted_credits+$2 WHERE project=$1',[project,add]);
 await c.query(`INSERT INTO control_trial_grant_receipts(user_id,target_credits,project,prior_granted,granted_credits)
  VALUES($1,$2,$3,$4,$5)`,[userId,targetCredits,project,prior,add]);
 return {project,granted:add,replayed:false};
}

export async function migrateAccountTrialCredits(store,{targetCredits,templateHash}){
 if(targetCredits!==TRIAL_CREDITS_PER_ACCOUNT)fail('credit_grant_invalid',503);
 let cursor=null,accounts=0,granted=0;
 for(;;){
  const {rows}=await store.pool.query(`SELECT DISTINCT p.user_id FROM control_projects p
   WHERE p.status='active' AND left(p.id,3)='cp_' AND p.template_hash=$1 AND ($3::uuid IS NULL OR p.user_id>$3::uuid)
   AND NOT EXISTS(SELECT 1 FROM control_trial_grant_receipts r WHERE r.user_id=p.user_id AND r.target_credits=$2)
   ORDER BY p.user_id LIMIT 250`,[templateHash,targetCredits,cursor]);
  if(!rows.length)break;
  for(const {user_id:userId} of rows){
   const receipt=await store.tx(c=>grantAccountTrialCredits(c,{userId,targetCredits,templateHash}));
   if(receipt&&!receipt.replayed){accounts++;granted+=receipt.granted;}
   cursor=userId;
  }
 }
 return {accounts,granted};
}

export function reviewedCreditPolicy(config){
 const policy=config.controlPlane?.creditPolicy;
 if(config.controlPlane?.enabled!==true||!plain(policy)||policy.reviewed!==true)fail('credit_policy_unreviewed',503);
 const trialCredits=policy.trialCredits===undefined?TRIAL_CREDITS_PER_ACCOUNT:policy.trialCredits;
 if(typeof policy.version!=='string'||!ID.test(policy.version)||!creditAmount(trialCredits)||trialCredits>TRIAL_CREDITS_PER_ACCOUNT||!validWeights(policy.weights,['direct','datacenter'])||
  !Object.hasOwn(policy.weights,'direct')||!Number.isSafeInteger(policy.maxEstimatedMicroUsdPerOperation)||policy.maxEstimatedMicroUsdPerOperation<0)fail('credit_policy_invalid',503);
 const mode=policy.modeWeights;
 if(mode!==undefined&&(!plain(mode)||Object.keys(mode).some(key=>!['reviewed','version',...TRANSPORTS].includes(key))||mode.reviewed!==true||
  typeof mode.version!=='string'||!ID.test(mode.version)||mode.version===policy.version||
  TRANSPORTS.some(transport=>mode[transport]!==undefined&&!validWeights(mode[transport],ROUTES))))fail('credit_policy_invalid',503);
 return trialCredits===policy.trialCredits?policy:{...policy,trialCredits};
}

export function creditWeight(policy,transport,routeClass,playground=false){
 const mode=policy.modeWeights;
 if(playground&&Object.hasOwn(mode?.[transport]??{},routeClass))return {credits:mode[transport][routeClass],policyVersion:mode.version};
 if(transport==='http'&&Object.hasOwn(policy.weights,routeClass))return {credits:policy.weights[routeClass],policyVersion:policy.version};
 return null;
}

export async function recoverControlCredits(c){
 // Gateway recovery marks provably undispatched operations and their provider
 // ledger together. All other interrupted reservations remain held.
 await c.query(`UPDATE control_credit_reservations r SET state=CASE WHEN o.error='interrupted_before_dispatch' AND l.state='cancelled_before_dispatch' THEN 'released' ELSE 'held' END,finished_at=clock_timestamp()
  FROM v2_operations o JOIN v2_ledger l ON l.operation=o.id WHERE r.operation=o.id AND r.state='reserved'`);
}

// Keep the project and key authorization locked through either form of admission.
export async function lockActiveCreditProject(c,project,keyId,{userId,requireSoleKey}={}){
 const active=(await c.query('SELECT status FROM control_projects WHERE id=$1 FOR SHARE',[project])).rows[0];
 if(!active||active.status!=='active')fail('project_inactive',403);
 if(userId&&!(await c.query('SELECT 1 FROM control_memberships WHERE project=$1 AND user_id=$2 FOR SHARE',[project,userId])).rowCount)
  fail('project_not_found',404);
 if(keyId==='console')return;
 const key=(await c.query(`SELECT revoked_at,scopes FROM control_keys WHERE id=$1 AND project=$2 FOR ${userId?'UPDATE':'SHARE'}`,[keyId,project])).rows[0];
 if(!key||key.revoked_at||!Array.isArray(key.scopes)||!key.scopes.includes('fetch:write'))fail('api_key_forbidden',403);
 if(requireSoleKey&&(await c.query("SELECT count(*)::int AS eligible FROM control_keys WHERE project=$1 AND revoked_at IS NULL AND scopes ? 'fetch:write'",[project])).rows[0].eligible!==1)
  fail('playground_key_selection_required',409);
}

export class ControlCredits{
 constructor({store,config}){this.store=store;this.config=config;}
 managed(project){return managed(project);}
 keyId(project,identity){
  if(!managed(project))return this.config.projects[project]?.keyId??project;
  reviewedCreditPolicy(this.config);
  if(!plain(identity)||Object.keys(identity).some(k=>!['keyId','userId','requireSoleKey'].includes(k))||
   (identity.keyId!=='console'&&(typeof identity.keyId!=='string'||!UUID.test(identity.keyId)))||
   (identity.userId!==undefined&&(typeof identity.userId!=='string'||!UUID.test(identity.userId)||identity.keyId==='console'))||
   (identity.requireSoleKey!==undefined&&(typeof identity.requireSoleKey!=='boolean'||!identity.userId)))fail('api_key_identity_required',401);
  return identity.keyId;
 }
 quote({profile,route,transport='http',estimatedMicroUsd}){
  const policy=reviewedCreditPolicy(this.config);
  const playground=profile?.kind==='playground'&&typeof profile.id==='string'&&profile.id.startsWith('playground:')&&profile.playground_execution===transport;
  const weight=TRANSPORTS.includes(transport)&&ROUTES.includes(route?.class)?creditWeight(policy,transport,route.class,playground):null;
  if(!weight)fail('credit_route_forbidden',403);
  if(!Number.isSafeInteger(estimatedMicroUsd)||estimatedMicroUsd<0)fail('cost_estimate_unavailable',409);
  if(estimatedMicroUsd>policy.maxEstimatedMicroUsdPerOperation)fail('cost_ceiling_exceeded',429);
  return weight;
 }
 async reserve(c,{project,operation,keyId,userId,requireSoleKey,profile,route,transport='http',estimatedMicroUsd}){
  if(!managed(project))return null;
  this.keyId(project,{keyId,userId,requireSoleKey});
  const quote=this.quote({profile,route,transport,estimatedMicroUsd});
  await lockActiveCreditProject(c,project,keyId,{userId,requireSoleKey});
  const account=(await c.query('SELECT granted_credits FROM control_credit_accounts WHERE project=$1 FOR UPDATE',[project])).rows[0];
  if(!account)fail('credit_account_unavailable',503);
  const prior=(await c.query('SELECT * FROM control_credit_reservations WHERE operation=$1 AND project=$2',[operation,project])).rows[0];
  if(prior)return view(prior);
  const used=Number((await c.query("SELECT COALESCE(sum(credits),0) AS credits FROM control_credit_reservations WHERE project=$1 AND state<>'released'",[project])).rows[0].credits);
  if(used+quote.credits>Number(account.granted_credits))fail('credit_balance_exhausted',429);
  const row=(await c.query('INSERT INTO control_credit_reservations(operation,project,key_id,credits,policy_version,proxy_class,transport) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[operation,project,keyId,quote.credits,quote.policyVersion,route.class,transport])).rows[0];
  if(userId)await c.query('UPDATE control_keys SET last_used_at=clock_timestamp() WHERE id=$1',[keyId]);
  return view(row);
 }
 async finish(c,{project,operation,dispatched,unknown}){
  if(!managed(project))return null;
  const state=unknown?'held':dispatched?'settled':'released';
  // Only pending reservations can be finalized. Recovery holds and settled
  // debits require an explicit future operator reconciliation, never a replay.
  await c.query("UPDATE control_credit_reservations SET state=$3,finished_at=clock_timestamp() WHERE operation=$1 AND project=$2 AND state='reserved'",[operation,project,state]);
  return this.operation(project,operation,c);
 }
 async operation(project,operationId,c=this.store.pool){
  if(!managed(project))return null;
  return view((await c.query('SELECT * FROM control_credit_reservations WHERE project=$1 AND operation=$2',[project,operationId])).rows[0]);
 }
 async usage(project){
  if(!managed(project))return null;
  const account=(await this.store.pool.query('SELECT granted_credits FROM control_credit_accounts WHERE project=$1',[project])).rows[0];
  if(!account)fail('credit_account_unavailable',503);
  const rows=(await this.store.pool.query('SELECT state,COALESCE(sum(credits),0) AS credits,bool_or(transport=\'browser\') AS browser FROM control_credit_reservations WHERE project=$1 GROUP BY state',[project])).rows;
  const totals={reserved:0,settled:0,held:0,released:0};
  for(const row of rows)totals[row.state]=Number(row.credits);
  const granted=Number(account.granted_credits);
  return {granted,available:granted-totals.reserved-totals.settled-totals.held,...totals,unit:rows.some(row=>row.browser)?'logical_request_operation':unit('http'),basis:'customer_request_credits_separate_from_provider_cost',commercial_enabled:false};
 }
 async recover(c){
  await recoverControlCredits(c);
 }
}
