import {fail} from './policy.mjs';
import {stat} from 'node:fs/promises';
import {hasHtmlChallenge} from './source-challenge.mjs';
import {protectionView,PROTECTION_VERSION,PROTECTION_VENDORS,PROTECTION_KINDS} from './protection.mjs';

const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export const OUTCOME_CATEGORIES=Object.freeze(['transport_failure','source_denied','source_challenge','rate_limited','upstream_error','success','unknown','cancelled']);
export const ROUTING_REASONS=Object.freeze(['evomi_default','residential_fallback','oxylabs_default','healthy_proxy_selected','quarantine_probe','sticky_session','fallback_source_denied','fallback_source_challenge','fallback_proxy_connect_failed','fallback_native_flow_incomplete']);
export const RECORD_REASON_CODES=Object.freeze(['accepted','partial','no_records','source_unavailable','source_denied','source_challenge','schema_mismatch','identity_mismatch','context_mismatch','incomplete','parse_error','other']);
const allowed=(value,list)=>list.includes(value)?value:null;
const numeric=value=>value===null||value===undefined?null:Number(value);
const elapsed=(start,end)=>{
 if(!start||!end)return null;
 const duration=+new Date(end)-+new Date(start);
 return Number.isFinite(duration)&&duration>=0?duration:null;
};

// Nullable additions deliberately leave historical timing unknown. Initialization
// does not rewrite captures, receipts, reservations or earlier ledger events.
export async function initDiagnostics(pool){
 await pool.query(`
  ALTER TABLE attempts ADD COLUMN IF NOT EXISTS queued_at timestamptz;
  ALTER TABLE attempts ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;
  ALTER TABLE attempts ADD COLUMN IF NOT EXISTS finished_at timestamptz;
  ALTER TABLE attempts ADD COLUMN IF NOT EXISTS outcome_category text;
  ALTER TABLE attempts ADD COLUMN IF NOT EXISTS routing_reason text;
  ALTER TABLE attempts ADD COLUMN IF NOT EXISTS protection jsonb;
  CREATE TABLE IF NOT EXISTS operation_outcomes(
   operation uuid PRIMARY KEY REFERENCES operations(id),
   accepted_records int NOT NULL CHECK (accepted_records BETWEEN 0 AND 1000000),
   rejected_records int NOT NULL CHECK (rejected_records BETWEEN 0 AND 1000000),
   reason_code text NOT NULL,
   created_at timestamptz NOT NULL DEFAULT now(),
   CHECK (accepted_records+rejected_records<=1000000)
  );
  CREATE INDEX IF NOT EXISTS operation_outcomes_created ON operation_outcomes(created_at);
  CREATE INDEX IF NOT EXISTS attempts_operation_created ON attempts(operation,created_at,id);
 `);
}

// Inspect only a bounded HTML prefix and emit a closed vocabulary. Provider
// billing uncertainty is separate from whether usable source content arrived.
export function classifyOutcome(response={},input={}){
 if(response.error==='source_challenge')return 'source_challenge';
 const status=response.status;
 if(status===429||response.error==='rate_limited')return 'rate_limited';
 if(status===401||status===403||response.error==='source_denied')return 'source_denied';
 if(input.main_document&&hasHtmlChallenge(response))return 'source_challenge';
 if(Number.isInteger(status)&&status>=500&&status<=599)return 'upstream_error';
 if(['proxy_connect_failed','transport_failed','request_timeout','response_too_large','metered_outcome_unknown'].includes(response.error)&&!status)return 'transport_failure';
 if(response.error)return 'unknown';
 if(Number.isInteger(status)&&status>=200&&status<400)return 'success';
 return 'unknown';
}

function outcomeView(row){
 return row?{accepted_records:row.accepted_records,rejected_records:row.rejected_records,reason_code:allowed(row.reason_code,RECORD_REASON_CODES),recorded_at:row.created_at}:null;
}

export async function operationDiagnostics(pool,project,operationId){
 if(typeof project!=='string'||!project||!UUID.test(operationId??''))fail('request_invalid');
 const row=(await pool.query(`SELECT o.id,o.workflow,o.state,o.created_at,o.result_path IS NOT NULL AS capture_available,w.profile
  FROM operations o JOIN workflows w ON w.id=o.workflow WHERE o.id=$1 AND w.project=$2`,[operationId,project])).rows[0];
 if(!row)fail('operation_not_found',404);
 const [attempts,outcome]=await Promise.all([
  pool.query(`SELECT id,provider,state,reserved_credits,credits,native_status,provider_status,bytes,created_at,queued_at,dispatched_at,finished_at,outcome_category,routing_reason,protection
   FROM attempts WHERE operation=$1 ORDER BY created_at,id`,[operationId]),
  pool.query('SELECT accepted_records,rejected_records,reason_code,created_at FROM operation_outcomes WHERE operation=$1',[operationId]),
 ]);
 const timeline=attempts.rows.map(attempt=>({
  id:attempt.id,provider:allowed(attempt.provider,['oxylabs','scrapedo']),state:allowed(attempt.state,['reserved','sent','settled','unknown','cancelled']),
  created_at:attempt.created_at,queued_at:attempt.queued_at,dispatched_at:attempt.dispatched_at,finished_at:attempt.finished_at,
  queue_wait_ms:elapsed(attempt.queued_at,attempt.dispatched_at),provider_time_ms:elapsed(attempt.dispatched_at,attempt.finished_at),
  outcome_category:allowed(attempt.outcome_category,OUTCOME_CATEGORIES),routing_reason:allowed(attempt.routing_reason,ROUTING_REASONS),
  protection:protectionView(attempt.protection),
  native_status:attempt.native_status,provider_status:attempt.provider_status,bytes:numeric(attempt.bytes),
  reserved_credits:attempt.reserved_credits,known_credits:attempt.credits,
  held_credits:attempt.provider==='scrapedo'&&attempt.credits===null&&attempt.state!=='cancelled'?attempt.reserved_credits:0,
 }));
 return {...row,state:allowed(row.state,['reserved','running','captured','failed','unknown','expired']),attempts:timeline,
  billing:{known_credits:timeline.reduce((sum,a)=>sum+(a.provider==='scrapedo'?(a.known_credits??0):0),0),held_credits:timeline.reduce((sum,a)=>sum+a.held_credits,0)},
  outcome:outcomeView(outcome.rows[0]),
 };
}

// Outcome submission is optional, project-owned acceptance evidence. It never
// edits a capture or financial accounting and cannot trigger a provider call.
export async function recordOutcome(pool,project,operationId,input){
 if(typeof project!=='string'||!project||!UUID.test(operationId??'')||!input||typeof input!=='object'||Array.isArray(input)
  ||Object.keys(input).some(key=>!['accepted_records','rejected_records','reason_code'].includes(key))
  ||!Number.isInteger(input.accepted_records)||input.accepted_records<0||input.accepted_records>1000000
  ||!Number.isInteger(input.rejected_records)||input.rejected_records<0||input.rejected_records>1000000
  ||input.accepted_records+input.rejected_records>1000000||!RECORD_REASON_CODES.includes(input.reason_code))fail('outcome_invalid');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const operation=(await client.query(`SELECT o.state,o.result_path FROM operations o JOIN workflows w ON w.id=o.workflow
   WHERE o.id=$1 AND w.project=$2 FOR UPDATE OF o`,[operationId,project])).rows[0];
  if(!operation)fail('operation_not_found',404);
  const old=(await client.query('SELECT accepted_records,rejected_records,reason_code,created_at FROM operation_outcomes WHERE operation=$1',[operationId])).rows[0];
  if(old){
   if(old.accepted_records!==input.accepted_records||old.rejected_records!==input.rejected_records||old.reason_code!==input.reason_code)fail('outcome_conflict',409);
   await client.query('COMMIT');return outcomeView(old);
  }
  if(!operation.result_path||!['captured','failed'].includes(operation.state))fail('capture_required',409);
  const capture=await stat(operation.result_path).catch(error=>{if(error.code==='ENOENT')fail('capture_expired',410);throw error;});
  if(!capture.isFile())fail('capture_required',409);
  const recorded=(await client.query(`INSERT INTO operation_outcomes(operation,accepted_records,rejected_records,reason_code)
   VALUES($1,$2,$3,$4) RETURNING accepted_records,rejected_records,reason_code,created_at`,[operationId,input.accepted_records,input.rejected_records,input.reason_code])).rows[0];
  await client.query('COMMIT');return outcomeView(recorded);
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function projectDiagnostics(pool,project=null){
 if(project!==null&&(typeof project!=='string'||!project))fail('request_invalid');
 const [attempts,outcomes,protection]=await Promise.all([
  pool.query(`SELECT w.profile,a.provider,CASE WHEN a.outcome_category=ANY($2::text[]) THEN a.outcome_category ELSE 'unknown' END AS outcome_category,
   count(*)::int AS attempts,coalesce(sum(a.bytes),0)::bigint AS bytes,
   coalesce(sum(a.credits) FILTER (WHERE a.provider='scrapedo'),0)::bigint AS known_credits,
   coalesce(sum(a.reserved_credits) FILTER (WHERE a.provider='scrapedo' AND a.credits IS NULL AND a.state<>'cancelled'),0)::bigint AS held_credits,
   count(*) FILTER (WHERE a.queued_at IS NOT NULL AND a.dispatched_at>=a.queued_at)::int AS queue_samples,
   avg(extract(epoch FROM (a.dispatched_at-a.queued_at))*1000) FILTER (WHERE a.queued_at IS NOT NULL AND a.dispatched_at>=a.queued_at) AS queue_wait_ms_avg,
   percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (a.dispatched_at-a.queued_at))*1000) FILTER (WHERE a.queued_at IS NOT NULL AND a.dispatched_at>=a.queued_at) AS queue_wait_ms_p95,
   count(*) FILTER (WHERE a.dispatched_at IS NOT NULL AND a.finished_at>=a.dispatched_at)::int AS provider_samples,
   avg(extract(epoch FROM (a.finished_at-a.dispatched_at))*1000) FILTER (WHERE a.dispatched_at IS NOT NULL AND a.finished_at>=a.dispatched_at) AS provider_time_ms_avg,
   percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (a.finished_at-a.dispatched_at))*1000) FILTER (WHERE a.dispatched_at IS NOT NULL AND a.finished_at>=a.dispatched_at) AS provider_time_ms_p95
   FROM attempts a JOIN workflows w ON w.id=a.workflow
   WHERE ($1::text IS NULL OR w.project=$1) AND a.created_at>=now()-interval '24 hours'
   GROUP BY w.profile,a.provider,CASE WHEN a.outcome_category=ANY($2::text[]) THEN a.outcome_category ELSE 'unknown' END
   ORDER BY w.profile,a.provider,outcome_category`,[project,OUTCOME_CATEGORIES]),
  pool.query(`SELECT w.profile,count(*)::int AS operations_with_outcome,
   sum(o.accepted_records)::bigint AS accepted_records,sum(o.rejected_records)::bigint AS rejected_records,
   sum(coalesce(cost.known_credits,0))::bigint AS known_credits,sum(coalesce(cost.held_credits,0))::bigint AS held_credits
   FROM operation_outcomes o JOIN operations operation ON operation.id=o.operation JOIN workflows w ON w.id=operation.workflow
   LEFT JOIN LATERAL (SELECT coalesce(sum(a.credits),0) AS known_credits,
    coalesce(sum(a.reserved_credits) FILTER (WHERE a.credits IS NULL AND a.state<>'cancelled'),0) AS held_credits
    FROM attempts a WHERE a.operation=o.operation AND a.provider='scrapedo') cost ON true
   WHERE ($1::text IS NULL OR w.project=$1) AND o.created_at>=now()-interval '24 hours'
   GROUP BY w.profile ORDER BY w.profile`,[project]),
  pool.query(`WITH observations AS (
   SELECT w.profile,a.provider,
    CASE WHEN a.protection->>'version'=$2 AND a.protection->>'kind'=ANY($4::text[]) THEN a.protection->>'kind' ELSE 'unobserved' END AS kind,
    CASE WHEN a.protection->>'version'=$2 AND a.protection->>'vendor'=ANY($3::text[]) THEN a.protection->>'vendor' ELSE 'unknown' END AS vendor
   FROM attempts a JOIN workflows w ON w.id=a.workflow
   WHERE ($1::text IS NULL OR w.project=$1) AND a.created_at>=now()-interval '24 hours'
  ) SELECT profile,provider,kind,vendor,count(*)::int AS attempts FROM observations
   GROUP BY profile,provider,kind,vendor ORDER BY profile,provider,kind,vendor`,[project,PROTECTION_VERSION,PROTECTION_VENDORS,PROTECTION_KINDS]),
 ]);
 const numericFields=['attempts','bytes','known_credits','held_credits','queue_samples','queue_wait_ms_avg','queue_wait_ms_p95','provider_samples','provider_time_ms_avg','provider_time_ms_p95'];
 return {window_hours:24,attempts:attempts.rows.map(row=>({...row,provider:allowed(row.provider,['oxylabs','scrapedo']),...Object.fromEntries(numericFields.map(key=>[key,numeric(row[key])]))})),
  outcomes:outcomes.rows.map(row=>{const values=Object.fromEntries(['operations_with_outcome','accepted_records','rejected_records','known_credits','held_credits'].map(key=>[key,Number(row[key])]));return {profile:row.profile,...values,known_credits_per_accepted_record:values.accepted_records?values.known_credits/values.accepted_records:null};}),
  protection:{version:PROTECTION_VERSION,mode:'observe_only',groups:protection.rows.map(row=>({...row,provider:allowed(row.provider,['oxylabs','scrapedo']),attempts:Number(row.attempts)}))},
 };
}
