// Admin portal: reachability probes as stored background jobs, and applying a
// probe's proposed provider rules. A completed probe also seeds site knowledge.
import {randomUUID} from 'node:crypto';
import {fail} from './policy.mjs';
import {runProbe} from './reachability.mjs';
import {seedFromProbe} from './site-knowledge.mjs';
import {saveProviderRule} from './provider-rules.mjs';
import {budget} from './budgets.mjs';

const HOST=/^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);

export async function initAdminOps(pool){await pool.query(`
 CREATE TABLE IF NOT EXISTS admin_probes(id uuid PRIMARY KEY,host text NOT NULL,countries text[] NOT NULL,include_excluded boolean NOT NULL DEFAULT false,
  state text NOT NULL CHECK(state IN ('queued','running','complete','failed','interrupted')),report jsonb,error text,requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,applied_at timestamptz,applied_by text);
 CREATE INDEX IF NOT EXISTS admin_probes_created ON admin_probes(created_at DESC);
 `);}
// A gateway restart abandons in-process probes; they never resume silently.
export async function interruptProbes(pool){return (await pool.query("UPDATE admin_probes SET state='interrupted',finished_at=now() WHERE state IN ('queued','running')")).rowCount;}

// ---- Probe jobs ----
const probeView=(row,{full=false}={})=>({id:row.id,host:row.host,countries:row.countries,include_excluded:row.include_excluded,state:row.state,error:row.error,
 requested_by:row.requested_by,created_at:row.created_at,started_at:row.started_at,finished_at:row.finished_at,applied_at:row.applied_at,applied_by:row.applied_by,
 ...(full?{report:row.report}:{summary:row.report?.summary?{reachable_countries:row.report.summary.reachable_countries,recommended_route:row.report.summary.recommended_route}:null})});
export async function listProbes(pool){return (await pool.query('SELECT * FROM admin_probes ORDER BY created_at DESC LIMIT 50')).rows.map(r=>probeView(r));}
export async function readProbe(pool,id){
 if(!UUID.test(id??''))fail('probe_id_invalid',400);
 const row=(await pool.query('SELECT * FROM admin_probes WHERE id=$1',[id])).rows[0];if(!row)fail('probe_not_found',404);return probeView(row,{full:true});
}
// Starts a probe in the background and returns at once. Bounded: one at a time,
// a per-day cap, at most 6 countries, a public hostname only.
export async function startProbe(store,gateway,input,{actor,run=runProbe,limits={}}){
 const host=typeof input.host==='string'?input.host.trim().toLowerCase().replace(/\.$/,''):'';
 if(!HOST.test(host))fail('probe_host_invalid',400);
 const countries=input.countries;
 if(!Array.isArray(countries)||countries.length<1||countries.length>6||countries.some(c=>typeof c!=='string'||!/^[A-Z]{2}$/.test(c))||new Set(countries).size!==countries.length)fail('probe_countries_invalid',400);
 if(input.include_excluded!==undefined&&typeof input.include_excluded!=='boolean')fail('request_invalid',400);
 const perDay=limits.maxProbesPerDay??budget(gateway.config,'admin.maxProbesPerDay');
 const id=randomUUID();
 await store.tx(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(1017)');
  if((await c.query("SELECT 1 FROM admin_probes WHERE state IN ('queued','running')")).rowCount)fail('probe_busy',409);
  if(Number((await c.query("SELECT count(*) n FROM admin_probes WHERE created_at>now()-interval '24 hours'")).rows[0].n)>=perDay)fail('probe_daily_limit',429);
  await c.query("INSERT INTO admin_probes(id,host,countries,include_excluded,state,requested_by) VALUES($1,$2,$3,$4,'queued',$5)",[id,host,countries,input.include_excluded===true,actor]);
 });
 const job=(async()=>{
  await store.pool.query("UPDATE admin_probes SET state='running',started_at=now() WHERE id=$1",[id]);
  try{
   const report=await run(gateway.config,host,countries,{includeExcluded:input.include_excluded===true});
   await store.pool.query("UPDATE admin_probes SET state='complete',report=$2,finished_at=now() WHERE id=$1 AND state='running'",[id,report]);
   // Probe cells also teach site knowledge (plain HTTP routes only).
   await seedFromProbe(store.pool,report,{config:gateway.config}).catch(()=>{});
  }catch(e){
   await store.pool.query("UPDATE admin_probes SET state='failed',error=$2,finished_at=now() WHERE id=$1 AND state='running'",[id,/^[a-z_]{1,60}$/.test(e?.code??e?.message??'')?(e.code??e.message):'probe_failed']).catch(()=>{});
  }
 })();
 return {id,state:'queued',host,countries,job};
}
// Saves the chosen proposed provider rules (by id), with the probe as evidence,
// through the audited rule store.
export async function applyProbe(store,gateway,id,input,{actor}){
 const probe=await readProbe(store.pool,id);
 if(probe.state!=='complete'||!probe.report?.summary)fail('probe_not_complete',409);
 const summary=probe.report.summary,applied={rules:[]};
 if(!plain(input)||Object.keys(input).some(k=>k!=='rules'))fail('request_invalid',400);
 const ruleIds=input.rules??[];
 if(!Array.isArray(ruleIds)||!ruleIds.length||ruleIds.length>20||ruleIds.some(r=>typeof r!=='string'))fail('probe_apply_empty',400);
 const proposed=new Map((summary.proposed_provider_rules??[]).map(r=>[r.id,r]));
 for(const ruleId of ruleIds)if(!proposed.has(ruleId))fail('probe_rule_not_proposed',400);
 for(const ruleId of ruleIds){
  const r=proposed.get(ruleId);
  applied.rules.push(await saveProviderRule(store,{...r,evidence:{probe:probe.id,observed_at:probe.finished_at,host:probe.host}},{actor,expectedVersion:null}));
 }
 await store.pool.query('UPDATE admin_probes SET applied_at=now(),applied_by=$2 WHERE id=$1',[probe.id,actor]);
 return applied;
}
