import {fail} from './policy.mjs';
import {hasHtmlChallenge} from './source-challenge.mjs';

const defaults=Object.freeze({failureThreshold:3,cooldownMs:300000,probeIntervalMs:30000});
function settings(config){return {...defaults,...config?.routeHealth};}

// Validate once at process construction, before accepting or dispatching work.
// The settlement path uses this immutable configuration; malformed tuning must
// never become a surprise database error after a provider has already responded.
export function validateRouteHealthConfig(config){
 const overrides=config?.routeHealth;
 if(overrides!==undefined&&(!overrides||typeof overrides!=='object'||Array.isArray(overrides)||Object.keys(overrides).some(key=>!Object.hasOwn(defaults,key))))fail('route_health_config_invalid',500);
 const policy=settings(config);
 const limits={failureThreshold:[1,100],cooldownMs:[1000,86400000],probeIntervalMs:[1000,3600000]};
 for(const [key,[min,max]] of Object.entries(limits))if(!Number.isSafeInteger(policy[key])||policy[key]<min||policy[key]>max)fail('route_health_config_invalid',500);
 if(policy.probeIntervalMs>policy.cooldownMs)fail('route_health_config_invalid',500);
 return Object.freeze(policy);
}

// These tables contain routing metadata only, never request URLs, credentials,
// cookies or source content. The workflow observation makes a browser's many
// failed resources one failure rather than many independent failing workflows.
export async function initRouteHealth(pool){
 await pool.query(`
 CREATE TABLE IF NOT EXISTS route_health(
  profile text NOT NULL,proxy_id text NOT NULL,
  consecutive_failed_workflows int NOT NULL DEFAULT 0,
  last_outcome text,last_failure text,last_observed_at timestamptz,
  quarantined_until timestamptz,next_probe_at timestamptz,
  PRIMARY KEY(profile,proxy_id)
 );
 CREATE TABLE IF NOT EXISTS route_health_workflows(
  profile text NOT NULL,proxy_id text NOT NULL,workflow uuid NOT NULL,
  failed boolean NOT NULL DEFAULT false,succeeded boolean NOT NULL DEFAULT false,
  PRIMARY KEY(profile,proxy_id,workflow)
 );
 CREATE TABLE IF NOT EXISTS route_health_pools(
  profile text PRIMARY KEY,next_probe_at timestamptz
 );
 `);
}

function meaningfulRequest(input){
 return input?.main_document===true||!input?.resource_type||['document','xhr','fetch'].includes(input.resource_type);
}
function outcome(response,input){
 if(response?.provider!=='oxylabs')return null;
 const headers=response.headers??{};
 // A server's throttling instruction must slow the source, not rotate around it.
 if(response.status===429||Object.keys(headers).some(key=>key.toLowerCase()==='retry-after'))return null;
 if(response.error)return response.error==='proxy_connect_failed'?'proxy_connect_failed':null;
 if(!meaningfulRequest(input)||[401,407].includes(response.status))return null;
 // An authenticated 403 may be an expired/insufficient credential, not IP health.
 if(response.status===403){
  if(Object.keys(input?.headers??{}).some(key=>key.toLowerCase()==='authorization'))return null;
  return 'source_denied';
 }
 if(hasHtmlChallenge(response))return 'source_challenge';
 // This is evidence of an accessible transport route only. It does not establish
 // source identity, completeness, freshness, parsing or application acceptance.
 return response.status>=200&&response.status<400?'success':null;
}

// Call inside a transaction. A failure dominates later successes from the same
// workflow, but a successful independent workflow recovers a quarantined route.
export async function recordRouteOutcome(c,{profile,proxyId,workflowId,response,input,config}){
 const result=outcome(response,input);if(!result)return;
 const policy=settings(config);
 await c.query('INSERT INTO route_health(profile,proxy_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[profile,proxyId]);
 await c.query('SELECT 1 FROM route_health WHERE profile=$1 AND proxy_id=$2 FOR UPDATE',[profile,proxyId]);
 const prior=(await c.query('SELECT failed,succeeded FROM route_health_workflows WHERE profile=$1 AND proxy_id=$2 AND workflow=$3',[profile,proxyId,workflowId])).rows[0];
 if(prior?.failed||result==='success'&&prior?.succeeded)return;
 await c.query(`INSERT INTO route_health_workflows(profile,proxy_id,workflow,failed,succeeded) VALUES($1,$2,$3,$4,$5)
  ON CONFLICT(profile,proxy_id,workflow) DO UPDATE SET failed=route_health_workflows.failed OR EXCLUDED.failed,succeeded=route_health_workflows.succeeded OR EXCLUDED.succeeded`,[profile,proxyId,workflowId,result!=='success',result==='success']);
 if(result==='success'){
  await c.query("UPDATE route_health SET consecutive_failed_workflows=0,last_outcome='success',last_observed_at=now(),quarantined_until=NULL,next_probe_at=NULL WHERE profile=$1 AND proxy_id=$2",[profile,proxyId]);
 }else{
  await c.query(`UPDATE route_health SET consecutive_failed_workflows=consecutive_failed_workflows+1,last_outcome='failure',last_failure=$3,last_observed_at=now(),
   quarantined_until=CASE WHEN consecutive_failed_workflows+1 >= $4 THEN now()+$5*interval '1 millisecond' ELSE quarantined_until END,
   next_probe_at=CASE WHEN consecutive_failed_workflows+1 >= $4 THEN greatest(coalesce(next_probe_at,now()),now()+$6*interval '1 millisecond') ELSE next_probe_at END
   WHERE profile=$1 AND proxy_id=$2`,[profile,proxyId,result,policy.failureThreshold,policy.cooldownMs,policy.probeIntervalMs]);
 }
}

// Only new workflows call this. Existing workflow.proxy_id remains authoritative.
// Row locks serialize probe reservations with outcome updates, and the pool lock
// limits an entirely unhealthy pool to one probe across all its IPs per interval.
export async function chooseHealthyProxy(c,{profile,eligible,cursor,config}){
 if(!eligible.length)fail('country_pool_unavailable',503);
 const policy=settings(config),ids=eligible.map(proxy=>proxy.id);
 await c.query('INSERT INTO route_health_pools(profile) VALUES($1) ON CONFLICT DO NOTHING',[profile]);
 const pool=(await c.query('SELECT *,now() AS observed_at FROM route_health_pools WHERE profile=$1 FOR UPDATE',[profile])).rows[0];
 for(const id of [...ids].sort())await c.query('INSERT INTO route_health(profile,proxy_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[profile,id]);
 const rows=(await c.query('SELECT * FROM route_health WHERE profile=$1 AND proxy_id=ANY($2::text[]) ORDER BY proxy_id FOR UPDATE',[profile,ids])).rows;
 const byId=new Map(rows.map(row=>[row.proxy_id,row])),now=+new Date(pool.observed_at);
 const available=eligible.filter(proxy=>byId.get(proxy.id).consecutive_failed_workflows<policy.failureThreshold);
 const poolProbeReady=!pool.next_probe_at||+new Date(pool.next_probe_at)<=now;
 const probeReady=row=>!row.next_probe_at||+new Date(row.next_probe_at)<=now;
 const expired=rows.filter(row=>row.consecutive_failed_workflows>=policy.failureThreshold&&probeReady(row)&&(!row.quarantined_until||+new Date(row.quarantined_until)<=now));
 // Recover quarantined routes gradually even when other routes remain healthy.
 const candidates=[...available,...(poolProbeReady?expired.map(row=>eligible.find(proxy=>proxy.id===row.proxy_id)):[])];
 let selected;
 if(candidates.length)selected=candidates[((Number(cursor)||1)-1)%candidates.length];
 else if(poolProbeReady){
  // Avoid permanently failing all new jobs when every route is quarantined.
  // Permit only a bounded least-bad probe; never fall through to a new provider.
  const probe=rows.filter(probeReady).sort((a,b)=>a.consecutive_failed_workflows-b.consecutive_failed_workflows||+new Date(a.last_observed_at??0)-+new Date(b.last_observed_at??0)||a.proxy_id.localeCompare(b.proxy_id))[0];
  if(probe)selected=eligible.find(proxy=>proxy.id===probe.proxy_id);
 }
 if(!selected)fail('health_pool_cooling',503);
 const probing=byId.get(selected.id).consecutive_failed_workflows>=policy.failureThreshold;
 if(probing){
  await c.query("UPDATE route_health SET next_probe_at=now()+$3*interval '1 millisecond' WHERE profile=$1 AND proxy_id=$2",[profile,selected.id,policy.probeIntervalMs]);
  await c.query("UPDATE route_health_pools SET next_probe_at=now()+$2*interval '1 millisecond' WHERE profile=$1",[profile,policy.probeIntervalMs]);
 }
 return {...selected,selectionReason:probing?'quarantine_probe':'healthy_proxy_selected'};
}

export async function routeHealthStatus(pool,project,config){
 const admin=project===null||project===undefined;
 const allowed=admin?[...new Set(Object.values(config.projects??{}).flatMap(item=>item.profiles??[]))]:config.projects?.[project]?.profiles;
 if(!allowed)fail('project_forbidden',403);
 const configuredProxies=(config.proxies??[]).map(proxy=>proxy.id);
 const policy=settings(config);
 const rows=(await pool.query(`WITH visible AS (
  SELECT health.*,pools.next_probe_at AS pool_next_probe_at,
   count(*) FILTER (WHERE consecutive_failed_workflows<$2) OVER (PARTITION BY health.profile) AS available_routes
  FROM route_health health LEFT JOIN route_health_pools pools USING(profile)
  WHERE health.profile=ANY($1::text[]) AND proxy_id=ANY($3::text[])
 ) SELECT profile,count(*)::int AS routes,
  count(*) FILTER (WHERE last_observed_at IS NULL)::int AS unobserved,
  count(*) FILTER (WHERE consecutive_failed_workflows=0 AND last_observed_at IS NOT NULL)::int AS healthy,
  count(*) FILTER (WHERE consecutive_failed_workflows>0 AND consecutive_failed_workflows<$2)::int AS degraded,
  count(*) FILTER (WHERE consecutive_failed_workflows>=$2)::int AS quarantined,
  count(*) FILTER (WHERE consecutive_failed_workflows>=$2 AND (next_probe_at IS NULL OR next_probe_at<=now())
   AND (pool_next_probe_at IS NULL OR pool_next_probe_at<=now())
   AND (available_routes=0 OR quarantined_until IS NULL OR quarantined_until<=now()))::int AS probe_due,
  max(last_observed_at) AS last_observed_at
  FROM visible GROUP BY profile ORDER BY profile`,[allowed,policy.failureThreshold,configuredProxies])).rows;
 return {signal_scope:'transport_only',policy:{failure_threshold:policy.failureThreshold,cooldown_ms:policy.cooldownMs,probe_interval_ms:policy.probeIntervalMs},profiles:rows};
}
