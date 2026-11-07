import {ID,fail} from './policy.mjs';
import {lockActiveCreditProject} from './control-credits.mjs';
import {PAID_WIRE_READ_BYTES} from './paid-wire-limits.mjs';

const BYTES_PER_MB=1_000_000;
const MAX_TRANSFER_BYTES=20*BYTES_PER_MB;
const TARIFF_VERSION='paid-http-v1';
const FIXED_TARIFF_VERSION='playground-fixed-v1';
const MAX_FIXED_CREDITS=1_000_000;
const PACKAGES=new Map([[200,10_000],[800,50_000],[2000,150_000],[10000,1_000_000]]);
const TARIFFS=new Map([
 ['direct',{block_bytes:BYTES_PER_MB,credits_per_block:1}],
 ['datacenter',{block_bytes:BYTES_PER_MB,credits_per_block:1}],
 ['residential',{block_bytes:250_000,credits_per_block:5}]
]);
const residentialTariff=TARIFFS.get('residential');
export const PAID_CREDIT_RESIDENTIAL_LIABILITY_BYTES=Math.ceil(
 (residentialTariff.block_bytes+PAID_WIRE_READ_BYTES)/residentialTariff.credits_per_block
);
const ACCOUNT=/^acct_[A-Za-z0-9_]{1,200}$/;
const SESSION=/^cs_live_[A-Za-z0-9_]{1,200}$/;
const INTENT=/^pi_[A-Za-z0-9_]{1,200}$/;
const HOLD=/^[A-Za-z0-9][A-Za-z0-9_:-]{0,239}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const EVIDENCE=/^sha256:[a-f0-9]{64}$/;
const OPERATOR=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const REASONS=new Set(['provider_usage_verified','meter_evidence_verified','no_traffic_verified']);
const RECONCILIATION_FIELDS=['project','operation','metered_bytes','evidence','reason','operator','attested'];
const managed=project=>typeof project==='string'&&project.startsWith('cp_');
const matches=(value,pattern)=>typeof value==='string'&&pattern.test(value);
const validAmount=value=>Number.isSafeInteger(value)&&value>=0;

export function paidCreditPack(amountMinor){
 return PACKAGES.get(amountMinor)??null;
}

export function unifiedCreditsEnabled(config){
 return config.controlPlane?.unifiedCredits?.enabled===true;
}

function debit(bytes,blockBytes,creditsPerBlock){
 return Math.ceil(bytes/blockBytes)*creditsPerBlock;
}

export function quotePaidHttpCredits({route,maxTransferMb,maxCredits}){
 const routeClass=typeof route==='string'?route:route?.class;
 const tariff=TARIFFS.get(routeClass);
 if(!tariff)fail('paid_credit_route_forbidden',403);
 if(maxTransferMb!==undefined&&(typeof maxTransferMb!=='number'||maxTransferMb<0.25||maxTransferMb>20||!Number.isInteger(maxTransferMb*4)))
  fail('max_transfer_mb_invalid',400);
 if(maxCredits!==undefined&&(!validAmount(maxCredits)||maxCredits<1))fail('max_credits_invalid',400);
 const bytes=maxTransferMb===undefined?tariff.block_bytes:maxTransferMb*BYTES_PER_MB;
 const reserved=debit(bytes,tariff.block_bytes,tariff.credits_per_block);
 if(maxCredits!==undefined&&maxCredits<reserved)fail('max_credits_exceeded',429);
 return {tariff_version:TARIFF_VERSION,route_class:routeClass,...tariff,max_transfer_bytes:bytes,reserved_credits:reserved};
}

export function reviewedPaidCreditRoutes(config){
 const policy=config.controlPlane?.paidCreditPolicy;
 if(config.controlPlane?.enabled!==true||policy?.reviewed!==true||!matches(policy.version,ID)||
  !Array.isArray(policy.routes)||policy.routes.length>100)return [];
 const valid=policy.routes.every(route=>{
  if(!route||!matches(route.accessProfile?.id,ID)||Object.keys(route.accessProfile).length!==2||
   !Number.isSafeInteger(route.accessProfile.version)||route.accessProfile.version<1)return false;
  if(route.class==='direct')return route.country===null&&route.provider==='direct';
  if(!matches(route.country,/^[A-Z]{2}$/))return false;
  if(route.class==='datacenter')return route.provider==='oxylabs';
  return route.class==='residential'&&['evomi','dataimpulse'].includes(route.provider);
 });
 return valid?policy.routes:[];
}

export function validatePaidCreditReconciliation(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==RECONCILIATION_FIELDS.length||
  !RECONCILIATION_FIELDS.every(field=>Object.hasOwn(input,field)))fail('paid_credit_reconciliation_invalid',400);
 const {project,operation,metered_bytes,evidence,reason,operator,attested}=input;
 if(!managed(project)||!UUID.test(project.slice(3))||!matches(operation,UUID)||
  !validAmount(metered_bytes)||metered_bytes>MAX_TRANSFER_BYTES||!matches(evidence,EVIDENCE)||
  !REASONS.has(reason)||reason==='no_traffic_verified'&&metered_bytes!==0||
  !matches(operator,OPERATOR)||attested!==true)fail('paid_credit_reconciliation_invalid',400);
 return input;
}

export async function initControlPaidCredits(pool){
 await pool.query(`
  SELECT pg_advisory_xact_lock(170017,3);
  CREATE TABLE IF NOT EXISTS paid_credit_grants(
   id bigserial PRIMARY KEY,project text NOT NULL REFERENCES control_credit_accounts(project),
   account_id text NOT NULL,mode text NOT NULL CHECK(mode='live'),checkout_session_id text NOT NULL,payment_intent_id text NOT NULL,
   credits bigint CHECK(credits>0 AND credits<=1000000),amount_minor integer CHECK(amount_minor>0),
   currency text CHECK(currency='usd'),created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz,
   UNIQUE(account_id,mode,checkout_session_id),UNIQUE(account_id,mode,payment_intent_id),UNIQUE(id,project),
   CHECK((credits IS NOT NULL AND amount_minor IS NOT NULL AND currency IS NOT NULL)
    OR (credits IS NULL AND amount_minor IS NULL AND currency IS NULL AND revoked_at IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS paid_credit_grants_project ON paid_credit_grants(project,id);
  CREATE TABLE IF NOT EXISTS paid_credit_reservations(
   operation uuid PRIMARY KEY REFERENCES v2_operations(id),project text NOT NULL REFERENCES control_credit_accounts(project),
   key_id text NOT NULL,policy_version text NOT NULL,tariff_version text NOT NULL,
   route_class text NOT NULL CHECK(route_class IN ('direct','datacenter','residential')),
   block_bytes bigint NOT NULL CHECK(block_bytes BETWEEN 1 AND 20000000),
   credits_per_block bigint NOT NULL CHECK(credits_per_block BETWEEN 1 AND 400),
   max_transfer_bytes bigint NOT NULL CHECK(max_transfer_bytes BETWEEN 250000 AND 20000000 AND max_transfer_bytes%250000=0),
   reserved_credits bigint NOT NULL CHECK(reserved_credits BETWEEN 1 AND 400),
   state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','held','released')),
   used_credits bigint CHECK(used_credits BETWEEN 0 AND reserved_credits),
   billable_bytes bigint CHECK(billable_bytes BETWEEN 0 AND max_transfer_bytes),
   settlement_basis text CHECK(settlement_basis IN ('verified_no_dispatch','fetchx_failure_refund','metered','confirmed_cap','uncertain','operator_reconciled')),
   finished_at timestamptz,
   UNIQUE(operation,project),CHECK(reserved_credits=((max_transfer_bytes+block_bytes-1)/block_bytes)*credits_per_block),
   CHECK((state IN ('settled','released'))=(used_credits IS NOT NULL)),
   CHECK((state IN ('settled','released'))=(billable_bytes IS NOT NULL)),
   CHECK(used_credits=((billable_bytes+block_bytes-1)/block_bytes)*credits_per_block),
   CHECK(state<>'released' OR used_credits=0)
  );
  CREATE INDEX IF NOT EXISTS paid_credit_reservations_project ON paid_credit_reservations(project,state);
  CREATE TABLE IF NOT EXISTS paid_credit_allocations(
   operation uuid NOT NULL,grant_id bigint NOT NULL,project text NOT NULL,
   credits bigint NOT NULL CHECK(credits>0),offset_credits bigint NOT NULL CHECK(offset_credits>=0),PRIMARY KEY(operation,grant_id),
   FOREIGN KEY(operation,project) REFERENCES paid_credit_reservations(operation,project),
   FOREIGN KEY(grant_id,project) REFERENCES paid_credit_grants(id,project)
  );
  CREATE INDEX IF NOT EXISTS paid_credit_allocations_grant ON paid_credit_allocations(grant_id);
  CREATE TABLE IF NOT EXISTS paid_credit_payment_holds(
   project text NOT NULL REFERENCES control_credit_accounts(project),account_id text NOT NULL,mode text NOT NULL CHECK(mode='live'),
   hold_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),cleared_at timestamptz,
   PRIMARY KEY(account_id,mode,hold_id)
  );
  CREATE INDEX IF NOT EXISTS paid_credit_payment_holds_active ON paid_credit_payment_holds(project) WHERE cleared_at IS NULL;
  CREATE TABLE IF NOT EXISTS paid_credit_reconciliations(
   operation uuid PRIMARY KEY,project text NOT NULL,
   prior_state text NOT NULL DEFAULT 'held' CHECK(prior_state='held'),
   max_transfer_bytes bigint NOT NULL CHECK(max_transfer_bytes BETWEEN 250000 AND 20000000),
   reserved_credits bigint NOT NULL CHECK(reserved_credits BETWEEN 1 AND 400),
   metered_bytes bigint NOT NULL CHECK(metered_bytes BETWEEN 0 AND max_transfer_bytes),
   used_credits bigint NOT NULL CHECK(used_credits BETWEEN 0 AND reserved_credits),
   evidence text NOT NULL CHECK(evidence ~ '^sha256:[a-f0-9]{64}$'),
   reason text NOT NULL CHECK(reason IN ('provider_usage_verified','meter_evidence_verified','no_traffic_verified')),
   operator_id text NOT NULL CHECK(operator_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$'),
   attested boolean NOT NULL CHECK(attested),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
   FOREIGN KEY(operation,project) REFERENCES paid_credit_reservations(operation,project),
   CHECK(reason<>'no_traffic_verified' OR metered_bytes=0)
  );
  DO $$ DECLARE previous_check text; BEGIN
   IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='paid_credit_grants'::regclass AND conname='paid_credit_grants_source_check') THEN
    SELECT k.conname INTO STRICT previous_check FROM pg_constraint k
    WHERE k.conrelid='paid_credit_grants'::regclass AND k.contype='c' AND
     (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
      WHERE a.attrelid=k.conrelid AND a.attnum=ANY(k.conkey))=ARRAY['amount_minor','credits','currency','revoked_at'];
    EXECUTE format('ALTER TABLE paid_credit_grants DROP CONSTRAINT %I',previous_check);
    ALTER TABLE paid_credit_grants
     ADD COLUMN source text NOT NULL DEFAULT 'stripe',
     ALTER COLUMN account_id DROP NOT NULL, ALTER COLUMN mode DROP NOT NULL,
     ALTER COLUMN checkout_session_id DROP NOT NULL, ALTER COLUMN payment_intent_id DROP NOT NULL,
     DROP CONSTRAINT paid_credit_grants_credits_check,
     ADD CONSTRAINT paid_credit_grants_source_check CHECK(
      (source='stripe' AND account_id IS NOT NULL AND mode IS NOT DISTINCT FROM 'live'
       AND checkout_session_id IS NOT NULL AND payment_intent_id IS NOT NULL
       AND ((credits IS NOT NULL AND credits BETWEEN 1 AND 1000000 AND amount_minor IS NOT NULL AND currency IS NOT NULL)
        OR (credits IS NULL AND amount_minor IS NULL AND currency IS NULL AND revoked_at IS NOT NULL)))
      OR (source='signup_trial' AND account_id IS NULL AND mode IS NULL
       AND checkout_session_id IS NULL AND payment_intent_id IS NULL AND amount_minor IS NULL AND currency IS NULL
       AND credits IS NOT NULL AND credits BETWEEN 1 AND 1000000000 AND revoked_at IS NULL)
     );
   END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='paid_credit_reservations'::regclass AND conname='paid_credit_reservations_meter_shape_check') THEN
    SELECT k.conname INTO STRICT previous_check FROM pg_constraint k
    WHERE k.conrelid='paid_credit_reservations'::regclass AND k.contype='c' AND
     (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
      WHERE a.attrelid=k.conrelid AND a.attnum=ANY(k.conkey))=ARRAY['billable_bytes','state'];
    EXECUTE format('ALTER TABLE paid_credit_reservations DROP CONSTRAINT %I',previous_check);
    ALTER TABLE paid_credit_reservations
     ALTER COLUMN block_bytes DROP NOT NULL, ALTER COLUMN credits_per_block DROP NOT NULL,
     ALTER COLUMN max_transfer_bytes DROP NOT NULL,
     DROP CONSTRAINT paid_credit_reservations_reserved_credits_check,
     DROP CONSTRAINT paid_credit_reservations_settlement_basis_check,
     ADD CONSTRAINT paid_credit_reservations_settlement_basis_check CHECK(settlement_basis IN
      ('verified_no_dispatch','fetchx_failure_refund','metered','confirmed_cap','uncertain','operator_reconciled','logical_operation')),
     ADD CONSTRAINT paid_credit_reservations_meter_shape_check CHECK(
      (tariff_version<>'${FIXED_TARIFF_VERSION}' AND block_bytes IS NOT NULL AND credits_per_block IS NOT NULL AND max_transfer_bytes IS NOT NULL
       AND reserved_credits BETWEEN 1 AND 400 AND (state IN ('settled','released'))=(billable_bytes IS NOT NULL)
       AND settlement_basis IS DISTINCT FROM 'logical_operation')
      OR (tariff_version='${FIXED_TARIFF_VERSION}' AND block_bytes IS NULL AND credits_per_block IS NULL
       AND max_transfer_bytes IS NULL AND billable_bytes IS NULL AND reserved_credits BETWEEN 1 AND ${MAX_FIXED_CREDITS}
       AND (CASE state
        WHEN 'reserved' THEN settlement_basis IS NULL
        WHEN 'held' THEN settlement_basis IS NOT DISTINCT FROM 'uncertain'
        WHEN 'settled' THEN used_credits=reserved_credits AND settlement_basis IS NOT DISTINCT FROM 'logical_operation'
        WHEN 'released' THEN COALESCE(settlement_basis IN ('verified_no_dispatch','fetchx_failure_refund'),false)
        ELSE false END))
     );
   END IF;
  END $$;
  CREATE UNIQUE INDEX IF NOT EXISTS paid_credit_signup_trial_project ON paid_credit_grants(project) WHERE source='signup_trial';
  CREATE TABLE IF NOT EXISTS control_credit_upgrades(
   project text PRIMARY KEY REFERENCES control_credit_accounts(project),
   verified_purchase_grant_id bigint NOT NULL,
   trial_granted_credits bigint NOT NULL CHECK(trial_granted_credits BETWEEN 0 AND 1000000000),
   upgraded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
   FOREIGN KEY(verified_purchase_grant_id,project) REFERENCES paid_credit_grants(id,project)
  );
  CREATE OR REPLACE FUNCTION reject_upgraded_trial_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
   PERFORM 1 FROM control_credit_accounts WHERE project=NEW.project FOR UPDATE;
   IF EXISTS(SELECT 1 FROM control_credit_upgrades WHERE project=NEW.project) THEN
    RAISE check_violation USING MESSAGE='project uses unified credits', CONSTRAINT='legacy_credit_reservation_closed';
   END IF;
   RETURN NEW;
  END $$;
  DO $$ BEGIN
   IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='control_credit_reservations'::regclass AND tgname='legacy_credit_reservation_closed') THEN
    CREATE TRIGGER legacy_credit_reservation_closed BEFORE INSERT ON control_credit_reservations
     FOR EACH ROW EXECUTE FUNCTION reject_upgraded_trial_reservation();
   END IF;
  END $$;
 `);
}

async function lockAccount(c,project){
 const {rows:[account]}=await c.query('SELECT granted_credits FROM control_credit_accounts WHERE project=$1 FOR UPDATE',[project]);
 if(!account)fail('credit_account_unavailable',503);
 return account;
}

const paidIdentity=({project,mode,accountId})=>managed(project)&&mode==='live'&&matches(accountId,ACCOUNT);
const checkoutIdentity=input=>paidIdentity(input)&&matches(input.checkoutSessionId,SESSION)&&matches(input.paymentIntentId,INTENT);
async function paymentGrant(c,input,key){
 const {rows}=await c.query(`SELECT * FROM paid_credit_grants WHERE source='stripe' AND account_id=$1 AND mode=$2
  AND (checkout_session_id=$3 OR payment_intent_id=$4)`,key);
 const row=rows[0];
 if(rows.length!==1||row.project!==input.project||row.checkout_session_id!==input.checkoutSessionId||
  row.payment_intent_id!==input.paymentIntentId)fail('paid_credit_grant_conflict',409);
 return row;
}
const holdSql=`EXISTS(SELECT 1 FROM paid_credit_payment_holds WHERE project=$1 AND cleared_at IS NULL)`;
const upgradedSql=`EXISTS(SELECT 1 FROM control_credit_upgrades WHERE project=$1)`;
const legacySpentSql=stateCondition=>`COALESCE((SELECT sum(credits) FROM control_credit_reservations
 WHERE project=u.project AND ${stateCondition}),0)`;

// Caller finalizes the legacy release in the same transaction. Always acquire
// the account lock, including when an upgrade receipt is not yet visible.
export async function restoreReleasedTrialCredits(c,project){
 if(!managed(project))return false;
 await lockAccount(c,project);
 const restored=await c.query(`INSERT INTO paid_credit_grants(project,source,credits)
  SELECT u.project,'signup_trial',u.trial_granted_credits-${legacySpentSql("state<>'released'")} FROM control_credit_upgrades u
  WHERE u.project=$1 AND u.trial_granted_credits>${legacySpentSql("state<>'released'")}
  ON CONFLICT(project) WHERE source='signup_trial' DO UPDATE SET credits=EXCLUDED.credits
  WHERE paid_credit_grants.credits<EXCLUDED.credits`,[project]);
 return restored.rowCount>0;
}

// The saved offset places settled credits against the first allocated grant
// before using subsequent grants. A release never erases its original split.
const remainingSql=`GREATEST(g.credits-COALESCE((
 SELECT sum(CASE WHEN r.state IN ('reserved','held') THEN a.credits
  WHEN r.state='settled' THEN LEAST(a.credits,GREATEST(r.used_credits-a.offset_credits,0)) ELSE 0 END)
 FROM paid_credit_allocations a JOIN paid_credit_reservations r ON r.operation=a.operation
 WHERE a.grant_id=g.id),0),0)`;
// Pending or held reservations can still become spendable. Count them at
// the padded residential rate, including legacy credits not yet imported.
export const outstandingPaidCreditLiabilitySql=`SELECT (COALESCE(sum(GREATEST(g.credits-COALESCE((
 SELECT sum(LEAST(a.credits,GREATEST(r.used_credits-a.offset_credits,0)))
 FROM paid_credit_allocations a JOIN paid_credit_reservations r ON r.operation=a.operation
 WHERE a.grant_id=g.id AND r.state='settled'),0),0)),0)+(
  SELECT COALESCE(sum(GREATEST(u.trial_granted_credits-${legacySpentSql("state='settled'")}-COALESCE(s.credits,0),0)),0)
  FROM control_credit_upgrades u LEFT JOIN paid_credit_grants s ON s.project=u.project AND s.source='signup_trial'
 ))*${PAID_CREDIT_RESIDENTIAL_LIABILITY_BYTES} AS bytes
 FROM paid_credit_grants g WHERE g.revoked_at IS NULL AND g.credits IS NOT NULL`;

function exactNumber(value){
 const amount=Number(value);
 if(!validAmount(amount))fail('paid_credit_account_invalid',503);
 return amount;
}

function validateQuote(quote){
 const bytes=quote?.max_transfer_bytes;
 if(!validAmount(bytes)||!TARIFFS.has(quote.route_class)||bytes<250_000||bytes>MAX_TRANSFER_BYTES||bytes%250_000!==0)
  fail('paid_credit_reservation_invalid',503);
 const expected=quotePaidHttpCredits({route:quote.route_class,maxTransferMb:bytes/BYTES_PER_MB});
 if(Object.keys(quote).length!==Object.keys(expected).length||
  Object.entries(expected).some(([key,value])=>quote[key]!==value))fail('paid_credit_reservation_invalid',503);
 return expected;
}

const fixed=row=>row.tariff_version===FIXED_TARIFF_VERSION;
const nullableNumber=value=>value===null?null:exactNumber(value);
const operationView=row=>row?{
 unit:'credits',basis:fixed(row)?'prepaid_logical_operation_credits':'prepaid_http_wire_credits',state:row.state,
 reserved_credits:exactNumber(row.reserved_credits),used_credits:row.used_credits===null?null:exactNumber(row.used_credits),
 billable_bytes:row.billable_bytes===null?null:exactNumber(row.billable_bytes),settlement_basis:row.settlement_basis,
 policy_version:row.policy_version,tariff_version:row.tariff_version,route_class:row.route_class,
 block_bytes:nullableNumber(row.block_bytes),credits_per_block:nullableNumber(row.credits_per_block),max_transfer_bytes:nullableNumber(row.max_transfer_bytes)
}:null;

export async function recoverControlPaidCredits(c){
 await c.query(`UPDATE paid_credit_reservations r SET
  state=CASE WHEN o.error='interrupted_before_dispatch' AND l.state='cancelled_before_dispatch' THEN 'released' ELSE 'held' END,
  used_credits=CASE WHEN o.error='interrupted_before_dispatch' AND l.state='cancelled_before_dispatch' THEN 0 ELSE NULL END,
  billable_bytes=CASE WHEN r.tariff_version<>'${FIXED_TARIFF_VERSION}' AND o.error='interrupted_before_dispatch' AND l.state='cancelled_before_dispatch' THEN 0 ELSE NULL END,
  settlement_basis=CASE WHEN o.error='interrupted_before_dispatch' AND l.state='cancelled_before_dispatch' THEN 'verified_no_dispatch' ELSE 'uncertain' END,
  finished_at=clock_timestamp()
  FROM v2_operations o JOIN v2_ledger l ON l.operation=o.id WHERE r.operation=o.id AND r.state='reserved'`);
}

export class ControlPaidCredits{
 constructor({store,config}){this.store=store;this.config=config;}

 // The rollout flag controls new upgrades. An existing receipt is permanent,
 // including when the flag is disabled or the qualifying purchase is reversed.
 async isUnified(project,c=this.store.pool){
  if(!managed(project))return false;
  return (await c.query(`SELECT ${upgradedSql} AS upgraded`,[project])).rows[0].upgraded;
 }

 async upgradeEligibleProject(c,project){
  if(!unifiedCreditsEnabled(this.config)||!managed(project))return false;
  if(!(await c.query('SELECT id FROM control_projects WHERE id=$1 FOR UPDATE',[project])).rowCount)return false;
  const account=await lockAccount(c,project);
  if(await this.isUnified(project,c))return false;
  const receipt=await c.query(`INSERT INTO control_credit_upgrades(project,verified_purchase_grant_id,trial_granted_credits)
   SELECT g.project,g.id,$2 FROM paid_credit_grants g JOIN control_stripe_purchases p
    ON p.project=g.project AND p.mode=g.mode AND p.account_id=g.account_id
    AND p.session_id=g.checkout_session_id AND p.payment_intent_id=g.payment_intent_id
   WHERE g.project=$1 AND g.source='stripe' AND g.mode='live' AND g.credits IS NOT NULL
    AND g.revoked_at IS NULL AND p.state='paid'
   ORDER BY p.paid_at,g.id LIMIT 1`,[project,account.granted_credits]);
  if(!receipt.rowCount)return false;
  // A stale snapshot in a repeatable-read writer must serialize against
  // this upgrade, even if it reaches the legacy guard with an old snapshot.
  await c.query('UPDATE control_credit_accounts SET granted_credits=granted_credits WHERE project=$1',[project]);
  await restoreReleasedTrialCredits(c,project);
  return true;
 }

 async restoreReleasedTrialCredits(c,project){
  return restoreReleasedTrialCredits(c,project);
 }

 // Stripe supplies verified payment evidence and owns the enclosing transaction.
 async grantPaidCredits(c,input){
  const {project,mode,accountId,checkoutSessionId,paymentIntentId,credits,amountMinor,currency}=input;
  if(!checkoutIdentity(input)||currency!=='usd'||paidCreditPack(amountMinor)!==credits||!validAmount(credits)||!credits)
   fail('paid_credit_grant_invalid',503);
  await lockAccount(c,project);
  const key=[accountId,mode,checkoutSessionId,paymentIntentId];
  const inserted=await c.query(`INSERT INTO paid_credit_grants(account_id,mode,checkout_session_id,payment_intent_id,project,credits,amount_minor,currency)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[...key,project,credits,amountMinor,currency]);
  if(inserted.rowCount)return true;
  const row=await paymentGrant(c,input,key);
  if(row.credits===null)fail('paid_credit_grant_reversed',409);
  if(Number(row.credits)!==credits||row.amount_minor!==amountMinor||row.currency!==currency)fail('paid_credit_grant_conflict',409);
  return false;
 }

 async revokePaidCredits(c,input){
  if(!checkoutIdentity(input))fail('paid_credit_grant_invalid',503);
  const {project,accountId,mode,checkoutSessionId,paymentIntentId}=input;
  await lockAccount(c,project);
  const key=[accountId,mode,checkoutSessionId,paymentIntentId];
  // An early reversal reserves both immutable payment identifiers. A grant
  // racing this write must observe the same row or fail on an identity conflict.
  const inserted=await c.query(`INSERT INTO paid_credit_grants(account_id,mode,checkout_session_id,payment_intent_id,project,revoked_at)
   VALUES($1,$2,$3,$4,$5,clock_timestamp()) ON CONFLICT DO NOTHING`,[...key,project]);
  if(inserted.rowCount)return false;
  const row=await paymentGrant(c,input,key);
  if(row.credits===null)return false;
  await c.query('UPDATE paid_credit_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1',[row.id]);
  return true;
 }

 async setPaymentHold(c,input){
  const {project,mode,accountId,holdId,active}=input;
  if(!paidIdentity(input)||!matches(holdId,HOLD)||typeof active!=='boolean')fail('paid_credit_payment_hold_invalid',503);
  await lockAccount(c,project);
  const result=await c.query(`INSERT INTO paid_credit_payment_holds(project,account_id,mode,hold_id,cleared_at)
   VALUES($1,$2,$3,$4,CASE WHEN $5 THEN NULL ELSE clock_timestamp() END)
   ON CONFLICT(account_id,mode,hold_id) DO UPDATE SET cleared_at=COALESCE(paid_credit_payment_holds.cleared_at,EXCLUDED.cleared_at)
   WHERE paid_credit_payment_holds.project=EXCLUDED.project`,[project,accountId,mode,holdId,active]);
  if(!result.rowCount)fail('paid_credit_payment_hold_conflict',409);
 }

 async reserve(c,{project,operation,keyId,userId,requireSoleKey,quote}){
  if(!managed(project))fail('paid_credit_reservation_invalid',503);
  const tariff=validateQuote(quote);
  const routes=reviewedPaidCreditRoutes(this.config);
  if(!routes.length)fail('paid_credit_policy_unreviewed',503);
  if(!routes.some(route=>route.class===tariff.route_class))fail('paid_credit_route_forbidden',403);
  const policyVersion=this.config.controlPlane.paidCreditPolicy.version;
  return this.#reserve(c,{project,operation,keyId,userId,requireSoleKey,tariff,policyVersion});
 }

 // The Playground has already checked its reviewed logical price and cost
 // ceiling. Keep that price fixed and never invent a transfer-byte limit.
 async reserveFixed(c,{project,operation,keyId,userId,requireSoleKey,route,weight}){
  if(!managed(project)||!TARIFFS.has(route?.class)||!matches(weight?.policyVersion,ID)||
   !validAmount(weight?.credits)||weight.credits<1||weight.credits>MAX_FIXED_CREDITS)fail('paid_credit_reservation_invalid',503);
  const tariff={tariff_version:FIXED_TARIFF_VERSION,route_class:route.class,block_bytes:null,credits_per_block:null,
   max_transfer_bytes:null,reserved_credits:weight.credits};
  return this.#reserve(c,{project,operation,keyId,userId,requireSoleKey,tariff,policyVersion:weight.policyVersion});
 }

 async #reserve(c,{project,operation,keyId,userId,requireSoleKey,tariff,policyVersion}){
  await lockActiveCreditProject(c,project,keyId,{userId,requireSoleKey});
  await lockAccount(c,project);
  if(fixed(tariff)&&!await this.isUnified(project,c))fail('paid_credit_reservation_unavailable',409);
  const prior=await this.operation(project,operation,c);
  if(prior){
   if(Object.entries(tariff).some(([key,value])=>prior[key]!==value)||
    fixed(tariff)&&prior.policy_version!==policyVersion)fail('paid_credit_reservation_conflict',409);
   return prior;
  }
  await this.assertNotHeld(c,project);
  // Signup credits were granted before the qualifying payment. Spend them
  // first, and preserve the existing FIFO order among Stripe grants.
  const {rows}=await c.query(`SELECT g.id,${remainingSql} AS available FROM paid_credit_grants g
   WHERE g.project=$1 AND g.revoked_at IS NULL AND g.credits IS NOT NULL ORDER BY (g.source='signup_trial') DESC,g.id`,[project]);
  const total=BigInt(tariff.reserved_credits);
  let remaining=total;
  const allocations=[];
  for(const grant of rows){
   const available=BigInt(grant.available);
   if(available<=0n)continue;
   const amount=available<remaining?available:remaining;
   allocations.push({grantId:grant.id,amount,offset:total-remaining});
   remaining-=amount;
   if(remaining===0n)break;
  }
  if(remaining>0n)fail('paid_credit_balance_exhausted',429);
  const row=(await c.query(`INSERT INTO paid_credit_reservations(operation,project,key_id,policy_version,
   tariff_version,route_class,block_bytes,credits_per_block,max_transfer_bytes,reserved_credits)
   SELECT id,project,$3,$4,$5,$6,$7,$8,$9,$10 FROM v2_operations WHERE id=$1 AND project=$2 RETURNING *`,
  [operation,project,keyId,policyVersion,tariff.tariff_version,tariff.route_class,tariff.block_bytes,tariff.credits_per_block,
   tariff.max_transfer_bytes,tariff.reserved_credits])).rows[0];
  if(!row)fail('paid_credit_reservation_invalid',503);
  await c.query(`INSERT INTO paid_credit_allocations(operation,project,grant_id,credits,offset_credits)
   SELECT $1::uuid,$2::text,a.* FROM unnest($3::bigint[],$4::bigint[],$5::bigint[]) a`,
  [operation,project,allocations.map(a=>a.grantId),allocations.map(a=>String(a.amount)),allocations.map(a=>String(a.offset))]);
  if(userId)await c.query('UPDATE control_keys SET last_used_at=clock_timestamp() WHERE id=$1',[keyId]);
  return operationView(row);
 }

 async assertNotHeld(c,project){
  if(await this.paymentHeld(project,c))fail('paid_credit_payment_hold',409);
 }

 async paymentHeld(project,c=this.store.pool){
  return (await c.query(`SELECT ${holdSql} AS held`,[project])).rows[0].held;
 }

 async assertDispatch(c,{project,operation}){
  const reservation=(await c.query(`SELECT key_id FROM paid_credit_reservations
   WHERE operation=$1 AND project=$2 AND state='reserved'`,[operation,project])).rows[0];
  if(!reservation)fail('paid_credit_reservation_unavailable',409);
  await lockActiveCreditProject(c,project,reservation.key_id);
  await lockAccount(c,project);
  await this.assertNotHeld(c,project);
  const allowed=await c.query(`SELECT 1 FROM paid_credit_reservations r
   WHERE r.operation=$1 AND r.project=$2 AND r.state='reserved' AND NOT EXISTS (
    SELECT 1 FROM paid_credit_allocations a JOIN paid_credit_grants g ON g.id=a.grant_id
    WHERE a.operation=r.operation AND g.revoked_at IS NOT NULL)`,[operation,project]);
  if(!allowed.rowCount)fail('paid_credit_reservation_unavailable',409);
 }

 async finish(c,{project,operation,dispatched,unknown=false,measuredBytes,confirmedAtCap=false,fetchxFailure=false}){
  const row=(await c.query(`SELECT * FROM paid_credit_reservations
   WHERE project=$1 AND operation=$2 AND state='reserved' FOR UPDATE`,[project,operation])).rows[0];
  if(!row)return null;
  const logical=fixed(row);
  let state='held',billable=null,basis='uncertain';
  if(fetchxFailure===true||dispatched===false&&(!logical||unknown===false)){
   state='released';
   if(!logical)billable=0;
   basis=fetchxFailure===true?'fetchx_failure_refund':'verified_no_dispatch';
  }else if(logical){
   if(dispatched===true&&unknown===false){state='settled';basis='logical_operation';}
  }else if(dispatched===true){
   const limit=Number(row.max_transfer_bytes);
   if(confirmedAtCap===true){
    state='settled';billable=limit;basis='confirmed_cap';
   }else if(unknown===false&&validAmount(measuredBytes)){
    state='settled';billable=Math.min(measuredBytes,limit);basis='metered';
   }
  }
  const used=logical?state==='settled'?Number(row.reserved_credits):state==='released'?0:null:
   billable===null?null:debit(billable,Number(row.block_bytes),Number(row.credits_per_block));
  const saved=(await c.query(`UPDATE paid_credit_reservations SET state=$2,used_credits=$3,billable_bytes=$4,
   settlement_basis=$5,finished_at=clock_timestamp() WHERE operation=$1 RETURNING *`,[operation,state,used,billable,basis])).rows[0];
  return operationView(saved);
 }

 // The caller verifies the evidence and owns the transaction. Only the
 // customer reservation changes. Its original allocation and hold time remain.
 async reconcileHeld(c,input){
  const {project,operation,metered_bytes,evidence,reason,operator,attested}=validatePaidCreditReconciliation(input);
  if(!(await c.query('SELECT id FROM control_projects WHERE id=$1 FOR SHARE',[project])).rowCount)fail('paid_credit_reconciliation_not_found',404);
  await lockAccount(c,project);
  const row=(await c.query(`SELECT * FROM paid_credit_reservations
   WHERE operation=$1 AND project=$2 FOR UPDATE`,[operation,project])).rows[0];
  if(!row)fail('paid_credit_reconciliation_not_found',404);
  if(fixed(row))fail('paid_credit_reconciliation_not_byte_metered',409);
  const prior=(await c.query(`SELECT evidence,metered_bytes,used_credits FROM paid_credit_reconciliations
   WHERE operation=$1 AND project=$2`,[operation,project])).rows[0];
  if(prior){
   if(prior.evidence!==evidence||Number(prior.metered_bytes)!==metered_bytes)fail('paid_credit_reconciliation_conflict',409);
   return {replayed:true,used_credits:Number(prior.used_credits)};
  }
  if(row.state!=='held')fail('paid_credit_reconciliation_not_held',409);
  if(metered_bytes>Number(row.max_transfer_bytes))fail('paid_credit_reconciliation_exceeds_reservation',409);
  const used=debit(metered_bytes,Number(row.block_bytes),Number(row.credits_per_block));
  await c.query(`INSERT INTO paid_credit_reconciliations(operation,project,max_transfer_bytes,reserved_credits,metered_bytes,
   used_credits,evidence,reason,operator_id,attested) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [operation,project,row.max_transfer_bytes,row.reserved_credits,metered_bytes,used,evidence,reason,operator,attested]);
  await c.query(`UPDATE paid_credit_reservations SET state='settled',used_credits=$3,billable_bytes=$4,
   settlement_basis='operator_reconciled' WHERE operation=$1 AND project=$2`,[operation,project,used,metered_bytes]);
  return {replayed:false,used_credits:used};
 }

 async operation(project,operationId,c=this.store.pool){
  if(!managed(project))return null;
  const row=(await c.query('SELECT * FROM paid_credit_reservations WHERE project=$1 AND operation=$2',[project,operationId])).rows[0];
  return operationView(row);
 }

 async usage(project,c=this.store.pool){
  if(!managed(project))return null;
  const row=(await c.query(`WITH spend AS (
   SELECT COALESCE(sum(reserved_credits) FILTER(WHERE state='reserved'),0) AS reserved,
    COALESCE(sum(reserved_credits) FILTER(WHERE state='held'),0) AS held,
    COALESCE(sum(used_credits),0) AS used FROM paid_credit_reservations WHERE project=$1
  ), balances AS (
   SELECT g.credits,g.revoked_at,${remainingSql} AS remaining FROM paid_credit_grants g WHERE g.project=$1 AND g.credits IS NOT NULL
  ), totals AS (
   SELECT COALESCE(sum(credits),0) AS granted,
    COALESCE(sum(remaining) FILTER(WHERE revoked_at IS NULL),0) AS available,
    COALESCE(sum(remaining) FILTER(WHERE revoked_at IS NOT NULL),0) AS revoked_unused FROM balances
  ) SELECT spend.*,totals.*,${holdSql} AS payment_hold FROM spend CROSS JOIN totals`,[project])).rows[0];
  const {payment_hold,...totals}=row;
  return {unit:'credits',...Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,exactNumber(v)])),
   ...(payment_hold?{available:0}:{}),payment_hold};
 }
}
