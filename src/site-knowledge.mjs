// Site knowledge: per destination host, which route (execution, proxy class,
// provider, country) has worked, what it cost and which routes
// are currently failing. Learned automatically from settled outcomes and
// reachability probes, and shared across projects because it is routing
// metadata only: the host name, never URLs, paths, queries, cookies, headers,
// bodies, credentials or which project made the request.
//
// Auto mode (fetch/ladder.mjs) reads siteRoutes() to choose where to start and
// which routes to skip; fetch/service.mjs records every attempt's outcome.

const HOST=/^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
export const SITE_OUTCOMES=Object.freeze(['success','blocked','rate_limited','unreachable']);
const CLASSES=['direct','datacenter','residential'],EXECUTIONS=['http','browser'],COUNTRY=/^[A-Z]{2}$/,TOKEN=/^[a-z0-9_-]{1,40}$/;
export const SITE_KNOWLEDGE_DEFAULTS=Object.freeze({freshMs:7*86400000,demoteAfter:2,blockedRetryMs:86400000,unreachableRetryMs:3600000});

export function siteHost(value){
 let host;
 try{host=(value instanceof URL?value:new URL(String(value))).hostname;}catch{host=String(value??'');}
 host=host.toLowerCase().replace(/\.$/,'');
 // IP literals are not sites to learn about; a host name must end in a letter label.
 return HOST.test(host)&&!/\.\d+$/.test(host)?host:null;
}

export async function initSiteKnowledge(pool){
 await pool.query(`
 CREATE TABLE IF NOT EXISTS site_routes(
  host text NOT NULL,execution text NOT NULL,proxy_class text NOT NULL,provider text NOT NULL DEFAULT '',country text NOT NULL DEFAULT '',
  successes bigint NOT NULL DEFAULT 0,failures bigint NOT NULL DEFAULT 0,consecutive_failures int NOT NULL DEFAULT 0,
  last_outcome text,last_evidence text,last_success_at timestamptz,last_failure_at timestamptz,retry_not_before timestamptz,
  success_credits_total double precision NOT NULL DEFAULT 0,success_credit_samples bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(host,execution,proxy_class,provider,country)
 );
 CREATE INDEX IF NOT EXISTS site_routes_updated ON site_routes(updated_at);
 `);
}

function routeKey({host,execution,route={}}){
 const key={host:siteHost(host),execution,proxy_class:route.class,provider:route.provider??'',country:route.country??''};
 if(!key.host||!EXECUTIONS.includes(key.execution)||!CLASSES.includes(key.proxy_class))return null;
 if(key.provider&&!TOKEN.test(key.provider)||key.country&&!COUNTRY.test(key.country))return null;
 return key;
}

// Records one outcome. A rate limit is the site pacing us, not evidence that the
// route is bad, so it only sets retry_not_before (from Retry-After when given).
// Callers run this outside settlement transactions; it must never affect billing.
export async function recordSiteOutcome(db,{host,execution,route,outcome,credits=null,evidence='outcome',retryAfterSeconds=null,config}){
 if(!SITE_OUTCOMES.includes(outcome)||!['outcome','probe'].includes(evidence))return false;
 const key=routeKey({host,execution,route});if(!key)return false;
 const policy={...SITE_KNOWLEDGE_DEFAULTS,...config?.siteKnowledge};
 const values=[key.host,key.execution,key.proxy_class,key.provider,key.country];
 await db.query(`INSERT INTO site_routes(host,execution,proxy_class,provider,country) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,values);
 const where='host=$1 AND execution=$2 AND proxy_class=$3 AND provider=$4 AND country=$5';
 if(outcome==='success'){
  const cost=Number.isFinite(credits)&&credits>=0?credits:null;
  await db.query(`UPDATE site_routes SET successes=successes+1,consecutive_failures=0,last_outcome='success',last_evidence=$6,last_success_at=now(),retry_not_before=NULL,
   success_credits_total=success_credits_total+coalesce($7,0),success_credit_samples=success_credit_samples+CASE WHEN $7::float8 IS NULL THEN 0 ELSE 1 END,updated_at=now() WHERE ${where}`,[...values,evidence,cost]);
 }else if(outcome==='rate_limited'){
  const seconds=Math.min(3600,Math.max(15,Number.isFinite(retryAfterSeconds)?retryAfterSeconds:60));
  await db.query(`UPDATE site_routes SET last_outcome='rate_limited',last_evidence=$6,retry_not_before=greatest(coalesce(retry_not_before,now()),now()+$7*interval '1 second'),updated_at=now() WHERE ${where}`,[...values,evidence,seconds]);
 }else{
  const retryMs=outcome==='blocked'?policy.blockedRetryMs:policy.unreachableRetryMs;
  await db.query(`UPDATE site_routes SET failures=failures+1,consecutive_failures=consecutive_failures+1,last_outcome=$6,last_evidence=$7,last_failure_at=now(),
   retry_not_before=CASE WHEN consecutive_failures+1>=$8 THEN greatest(coalesce(retry_not_before,now()),now()+$9*interval '1 millisecond') ELSE retry_not_before END,updated_at=now() WHERE ${where}`,
   [...values,outcome,evidence,policy.demoteAfter,retryMs]);
 }
 return true;
}

// Best-effort wrapper for hot paths: bounded locks, never throws.
export async function observeSiteOutcome(store,input){
 if(!input?.outcome||!store?.tx)return;
 try{await store.tx(async c=>{await c.query("SET LOCAL lock_timeout='500ms'");await c.query("SET LOCAL statement_timeout='1000ms'");await recordSiteOutcome(c,input);});}
 catch{process.stderr.write(JSON.stringify({event:'site_knowledge_update_failed',execution:input.execution??null})+'\n');}
}

// Every known route for a host with a derived state:
//  proven   - succeeded within freshMs and not demoted by consecutive failures
//  cooling  - must not be retried before retry_not_before
//  stale    - worked before, but too long ago to trust without re-checking
//  failing  - recent failures below the demotion threshold, or never succeeded
export function routeState(row,now=Date.now(),config){
 const policy={...SITE_KNOWLEDGE_DEFAULTS,...config?.siteKnowledge};
 if(row.retry_not_before&&+new Date(row.retry_not_before)>now)return 'cooling';
 if(row.last_success_at&&row.consecutive_failures<policy.demoteAfter)return now-+new Date(row.last_success_at)<=policy.freshMs?'proven':'stale';
 return 'failing';
}
export async function siteRoutes(db,host,{execution=null,config,now=Date.now()}={}){
 const h=siteHost(host);if(!h)return [];
 const rows=(await db.query(`SELECT * FROM site_routes WHERE host=$1 AND ($2::text IS NULL OR execution=$2) ORDER BY execution,proxy_class,provider,country`,[h,execution])).rows;
 return rows.map(row=>publicRow(row,now,config));
}
function publicRow(row,now,config){
 return {host:row.host,execution:row.execution,proxy_class:row.proxy_class,provider:row.provider||null,country:row.country||null,
  state:routeState(row,now,config),successes:Number(row.successes),failures:Number(row.failures),consecutive_failures:row.consecutive_failures,
  last_outcome:row.last_outcome,last_evidence:row.last_evidence,last_success_at:row.last_success_at,last_failure_at:row.last_failure_at,retry_not_before:row.retry_not_before,
  average_success_credits:Number(row.success_credit_samples)?Number(row.success_credits_total)/Number(row.success_credit_samples):null,updated_at:row.updated_at};
}
// Operator overview: most recently updated hosts with route state counts.
export async function siteKnowledgeOverview(db,{limit=100,config,now=Date.now()}={}){
 const rows=(await db.query(`SELECT * FROM site_routes WHERE host IN (SELECT host FROM site_routes GROUP BY host ORDER BY max(updated_at) DESC LIMIT $1) ORDER BY host`,[Math.min(Math.max(1,limit),500)])).rows;
 const hosts=new Map();
 for(const row of rows){
  const item=hosts.get(row.host)??{host:row.host,routes:0,proven:0,cooling:0,stale:0,failing:0,updated_at:row.updated_at};
  item.routes++;item[routeState(row,now,config)]++;if(+new Date(row.updated_at)>+new Date(item.updated_at))item.updated_at=row.updated_at;
  hosts.set(row.host,item);
 }
 return [...hosts.values()].sort((a,b)=>+new Date(b.updated_at)-+new Date(a.updated_at));
}
// Operator action: forget a host so the next requests relearn it.
export async function forgetSite(db,host){
 const h=siteHost(host);if(!h)return 0;
 return (await db.query('DELETE FROM site_routes WHERE host=$1',[h])).rowCount;
}

const PROBE_OUTCOMES={ok:'success',challenge:'blocked',denied:'blocked',rate_limited:'rate_limited',unreachable:'unreachable'};
// Seeds knowledge from a completed reachability probe report. Probes are plain
// HTTP GETs, so they only teach the http execution. Provider refusals and proxy
// faults describe our provider, not the site, and are left to provider rules.
export async function seedFromProbe(db,report,{config}={}){
 const host=siteHost(report?.host);if(!host||!Array.isArray(report.cells))return 0;
 let seeded=0;
 for(const cell of report.cells){
  const outcome=PROBE_OUTCOMES[cell?.result];if(!outcome)continue;
  if(await recordSiteOutcome(db,{host,execution:'http',route:{class:cell.class,provider:cell.provider,country:cell.country},outcome,evidence:'probe',config}))seeded++;
 }
 return seeded;
}

