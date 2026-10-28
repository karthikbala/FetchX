import {randomBytes} from 'node:crypto';
import {fail} from './policy.mjs';
export const RESIDENTIAL_POLICY='residential-v1';
export const isResidential=p=>p.routingPolicy===RESIDENTIAL_POLICY;
export function routePlan(p){return p.execution==='browser'?[{provider:'evomi',tier:'free'},{provider:'dataimpulse',tier:'free'},{provider:'evomi',tier:'paid'},{provider:'dataimpulse',tier:'paid'}]:[{provider:'evomi',tier:null},{provider:'dataimpulse',tier:null}];}
export function selectedRoute(p){return routePlan(p)[p.routeIndex??0];}
export function residentialPolicy(p,config){
 const policy=p.routingPolicy??config.defaultRouting??'legacy';
 if(!['legacy',RESIDENTIAL_POLICY].includes(policy))fail('routing_policy_invalid',500);
 if(policy==='legacy')return {...p,routingPolicy:policy};
 if(!/^[A-Z]{2}$/.test(p.country)||p.ttlSeconds>1800)fail('residential_profile_invalid',500);
 if(p.maxRouteAttempts!==undefined&&(!Number.isInteger(p.maxRouteAttempts)||p.maxRouteAttempts<1||p.maxRouteAttempts>4))fail('residential_profile_invalid',500);
 if(p.execution&&!['http','browser'].includes(p.execution))fail('residential_profile_invalid',500);
 return {...p,routingPolicy:policy,execution:p.execution??'http',maxConcurrent:1,maxFallbackCredits:0,
  routeIndex:0,residentialSession:randomBytes(5).toString('hex'),
  maxResidentialBytes:p.maxResidentialBytes??Math.min(p.maxBytes,16*1024*1024),
  maxAttemptBytes:p.maxAttemptBytes??Math.min(p.maxBytes,4*1024*1024)};
}
export function providerProxy(config,p,provider){
 const c=config.residential?.providers?.[provider];
 if(!c?.enabled||!c.username||!c.password)fail('residential_provider_unavailable',503);
 if(c.countries&&!c.countries.includes(p.country))fail('residential_country_unavailable',503);
 if(!/^[a-f0-9]{10}$/.test(p.residentialSession)||!/^[A-Z]{2}$/.test(p.country))fail('residential_session_invalid',500);
 const u=new URL(provider==='evomi'?'http://core-residential.evomi.com:1000':'http://gw.dataimpulse.com:823');
 if(provider==='evomi'){u.username=c.username;u.password=`${c.password}_country-${p.country}_session-${p.residentialSession}_lifetime-30`;}
 else if(provider==='dataimpulse'){u.username=`${c.username}__cr.${p.country.toLowerCase()};sessid.${p.residentialSession}`;u.password=c.password;}
 else fail('residential_provider_invalid',500);
 return {id:`${provider}:${p.residentialSession}`,url:u.href};
}
export async function initResidential(pool){await pool.query(`
 CREATE TABLE IF NOT EXISTS residential_usage(attempt uuid PRIMARY KEY REFERENCES attempts(id),project text NOT NULL,workflow uuid NOT NULL REFERENCES workflows(id),provider text NOT NULL,browser_tier text,reserved_bytes bigint NOT NULL CHECK(reserved_bytes>0),observed_bytes bigint,accounted_bytes bigint NOT NULL,estimated_micro_usd bigint,invoice_micro_usd bigint,state text NOT NULL DEFAULT 'reserved',created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS residential_usage_created ON residential_usage(created_at);
 CREATE TABLE IF NOT EXISTS residential_reconciliations(attempt uuid PRIMARY KEY REFERENCES residential_usage(attempt),bytes bigint NOT NULL CHECK(bytes>=0),invoice_micro_usd bigint NOT NULL CHECK(invoice_micro_usd>=0),evidence text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS browser_state(workflow uuid PRIMARY KEY REFERENCES workflows(id),state bytea NOT NULL);
 `);}
const limit=(n)=>{if(!Number.isSafeInteger(n)||n<=0)fail('residential_budget_unconfigured',503);return n;};
export async function reserveResidential(c,config,w,attempt,provider){
 const p=w.config,settings=config.residential,pc=settings?.providers?.[provider],n=limit(p.maxAttemptBytes);
 providerProxy(config,p,provider);
 const totals=(await c.query(`SELECT COALESCE(sum(accounted_bytes),0) AS total,
 COALESCE(sum(accounted_bytes) FILTER(WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) AS daily,
 COALESCE(sum(accounted_bytes) FILTER(WHERE workflow=$1),0) AS workflow,
 COALESCE(sum(accounted_bytes) FILTER(WHERE project=$2 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) AS project_daily,
 COALESCE(sum(accounted_bytes) FILTER(WHERE provider=$3),0) AS provider_total FROM residential_usage`,[w.id,w.project,provider])).rows[0];
 const prior=Object.values(settings.providers).reduce((sum,p)=>sum+(p.priorReservedBytes??0),0);
 if(Number(totals.daily)+n>limit(settings?.maxDailyBytes)||Number(totals.total)+prior+n>limit(settings?.maxTotalBytes)||Number(totals.workflow)+n>limit(p.maxResidentialBytes)||Number(totals.project_daily)+n>limit(config.projects[w.project].maxDailyResidentialBytes??settings.maxDailyBytes)||Number(totals.provider_total)+(pc.priorReservedBytes??0)+n>limit(pc.maxTotalBytes))fail('residential_budget_exhausted',429);
 if((await c.query("SELECT 1 FROM attempts WHERE provider=$1 AND error=ANY($2::text[]) LIMIT 1",[provider,['provider_account_rejected','sensitive_provider_response','cost_overrun']])).rowCount)fail('residential_provider_held',409);
 if(p.execution==='browser'&&Number((await c.query("SELECT count(*) AS n FROM residential_usage u JOIN attempts a ON a.id=u.attempt WHERE u.browser_tier IS NOT NULL AND a.state IN ('reserved','sent')")).rows[0].n)>=(config.browser?.maxConcurrent??1))fail('capacity_wait',503);
 const rate=pc.microUsdPerGB;if(!Number.isSafeInteger(rate)||rate<0)fail('residential_rate_unconfigured',503);
 await c.query('INSERT INTO residential_usage(attempt,project,workflow,provider,browser_tier,reserved_bytes,accounted_bytes,estimated_micro_usd) VALUES($1,$2,$3,$4,$5,$6,$6,$7)',[attempt,w.project,w.id,provider,selectedRoute(p).tier,n,Math.ceil(n/1e9*rate)]);
}
export async function settleResidential(c,config,aid,provider,r){
 // Wire bytes are a measurement, not a provider invoice. Keep the conservative
 // pre-dispatch reservation until an operator reconciles authoritative usage.
 await c.query("UPDATE residential_usage SET observed_bytes=$2,state=$3 WHERE attempt=$1",[aid,Number.isSafeInteger(r.wireBytes)?r.wireBytes:null,r.error==='transport_outcome_unknown'?'unknown':r.error?'unreconciled_failure':'unreconciled']);
}
export async function residentialStatus(pool,config,project){
 const rows=(await pool.query(`SELECT provider,browser_tier,state,count(*)::int AS attempts,sum(accounted_bytes)::text AS reserved_or_accounted_bytes,sum(observed_bytes)::text AS observed_wire_bytes,sum(estimated_micro_usd)::text AS estimated_micro_usd,sum(invoice_micro_usd)::text AS invoice_micro_usd FROM residential_usage WHERE ($1::text IS NULL OR project=$1) GROUP BY provider,browser_tier,state`,[project])).rows;
 return {default_policy:config.defaultRouting??'legacy',native_order:['evomi','dataimpulse'],browser_order:routePlan({execution:'browser'}),usage:rows,billing_basis:'conservative_bandwidth_reservations_not_invoices',limits:{max_daily_bytes:config.residential?.maxDailyBytes??null,max_total_bytes:config.residential?.maxTotalBytes??null},browser_tiers:Object.fromEntries(['free','paid'].map(t=>[t,{configured:!!config.browser?.[t]?.executablePath,entitlement:config.browser?.[t]?.entitlement??null,version:config.browser?.[t]?.version??null}]))};
}
export async function reconcileResidential(store,input){
 if(!input||!/^[a-f0-9-]{36}$/.test(input.attempt)||!Number.isSafeInteger(input.bytes)||input.bytes<0||!Number.isSafeInteger(input.invoice_micro_usd)||input.invoice_micro_usd<0||!/^sha256:[a-f0-9]{64}$/.test(input.evidence))fail('residential_reconciliation_invalid');
 return store.tx(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(1002)');
  const u=(await c.query('SELECT * FROM residential_usage WHERE attempt=$1 FOR UPDATE',[input.attempt])).rows[0];if(!u||u.state==='cancelled_before_dispatch')fail('residential_reconciliation_rejected',409);
  const old=(await c.query('SELECT * FROM residential_reconciliations WHERE attempt=$1',[input.attempt])).rows[0];
  if(old){if(Number(old.bytes)!==input.bytes||Number(old.invoice_micro_usd)!==input.invoice_micro_usd||old.evidence!==input.evidence)fail('reconciliation_conflict',409);return {replayed:true};}
  await c.query('INSERT INTO residential_reconciliations(attempt,bytes,invoice_micro_usd,evidence) VALUES($1,$2,$3,$4)',[input.attempt,input.bytes,input.invoice_micro_usd,input.evidence]);
  await c.query("UPDATE residential_usage SET accounted_bytes=$2,invoice_micro_usd=$3,state='reconciled' WHERE attempt=$1",[input.attempt,input.bytes,input.invoice_micro_usd]);
  if(input.bytes>Number(u.reserved_bytes)||input.invoice_micro_usd>Number(u.estimated_micro_usd))await c.query("UPDATE attempts SET error='cost_overrun' WHERE id=$1",[input.attempt]);
  return {replayed:false};
 });
}
