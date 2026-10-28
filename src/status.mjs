import {residentialStatus} from './residential.mjs';
import {artifactUsage} from './artifacts.mjs';
import {METERED_BLOCKING_ERRORS} from './policy.mjs';
import {projectDiagnostics} from './diagnostics.mjs';
import {routeHealthStatus} from './route-health.mjs';
import {admissionStatus} from './admission.mjs';

// Operational metadata only. Never include source URLs, cookies, bodies or tokens.
export async function gatewayStatus(store,config,project=null){
 const scope='($1::text IS NULL OR w.project=$1)';
 const [workflows,attempts,errors,holds,warnings,account,storage]=await Promise.all([
  store.pool.query(`SELECT w.profile,w.state,count(*)::int AS workflows,sum(w.requests)::bigint AS requests FROM workflows w WHERE ${scope} GROUP BY w.profile,w.state ORDER BY w.profile,w.state`,[project]),
  store.pool.query(`SELECT w.profile,a.provider,a.state,count(*)::int AS attempts,coalesce(sum(a.credits),0)::bigint AS known_credits,coalesce(sum(CASE WHEN a.credits IS NULL THEN a.reserved_credits ELSE 0 END),0)::bigint AS held_credits FROM attempts a JOIN workflows w ON w.id=a.workflow WHERE ${scope} GROUP BY w.profile,a.provider,a.state ORDER BY w.profile,a.provider,a.state`,[project]),
  store.pool.query(`SELECT w.profile,o.error,count(*)::int AS operations FROM operations o JOIN workflows w ON w.id=o.workflow WHERE ${scope} AND o.created_at>now()-interval '24 hours' AND o.error IS NOT NULL GROUP BY w.profile,o.error ORDER BY count(*) DESC`,[project]),
  store.pool.query(`SELECT a.id AS attempt,w.profile,a.error,a.reserved_credits,a.created_at,extract(epoch FROM (now()-a.created_at))::bigint AS age_seconds FROM attempts a JOIN workflows w ON w.id=a.workflow WHERE ${scope} AND a.provider='scrapedo' AND a.error=ANY($2::text[]) ORDER BY a.created_at LIMIT 100`,[project,METERED_BLOCKING_ERRORS]),
  store.pool.query(`SELECT a.id AS attempt,w.profile,a.error,a.reserved_credits,a.created_at,extract(epoch FROM (now()-a.created_at))::bigint AS age_seconds,false AS blocking FROM attempts a JOIN workflows w ON w.id=a.workflow WHERE ${scope} AND a.provider='scrapedo' AND a.state='unknown' AND NOT coalesce(a.error=ANY($2::text[]),false) ORDER BY a.created_at LIMIT 100`,[project,METERED_BLOCKING_ERRORS]),
  store.pool.query("SELECT coalesce(sum(coalesce(credits,reserved_credits)) FILTER (WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::bigint AS daily_reserved_or_spent,count(*) FILTER (WHERE error=ANY($1::text[]))::int AS blocking_attempts,count(*) FILTER (WHERE state='unknown')::int AS unknown_attempts,coalesce(sum(reserved_credits) FILTER (WHERE state='unknown'),0)::bigint AS unknown_reserved_credits FROM attempts WHERE provider='scrapedo'",[METERED_BLOCKING_ERRORS]),
  artifactUsage(config),
 ]);
 const cost=account.rows[0],blocked=[];
 if(!config.scrapeDoToken)blocked.push('fallback_unavailable');
 if(cost.blocking_attempts)blocked.push('metered_account_held');
 if(Number(cost.daily_reserved_or_spent)>=config.maxDailyFallbackCredits)blocked.push('daily_fallback_limit');
 const [diagnostics,routing,admission]=await Promise.all([projectDiagnostics(store.pool,project),routeHealthStatus(store.pool,project,config),admissionStatus(store.pool,config,project)]);
 if(project!==null&&admission.projects[0]?.daily_remaining_credits===0)blocked.push('project_fallback_limit');
 return {
  release:config.release,default_provider:config.defaultRouting==='residential-v1'?'evomi':'oxylabs',observed_at:new Date().toISOString(),
  workflows:workflows.rows,attempts:attempts.rows,errors_last_24h:errors.rows,financial_holds:holds.rows,billing_warnings:warnings.rows,
  diagnostics,routing,admission,residential:await residentialStatus(store.pool,config,project),
  fallback:{available:blocked.length===0,blocked_by:blocked,daily_reserved_or_spent:Number(cost.daily_reserved_or_spent),daily_limit:config.maxDailyFallbackCredits,day_timezone:'UTC',unknown_attempts:cost.unknown_attempts,unknown_reserved_credits:Number(cost.unknown_reserved_credits)},
  storage:{...storage,utilization:Number((storage.bytes/storage.max_bytes).toFixed(4)),pressure:storage.bytes>=storage.max_bytes*0.85||storage.free_bytes<storage.min_free_bytes},
 };
}
