// Admin portal step 3: reachability probes as stored background jobs, applying
// a probe's proposed provider rules, and audited per-profile routing overrides.
// Overrides change only an allow-listed set of routing fields, are validated by
// residentialPolicy against the live config, and apply to NEW workflows only
// (existing workflows keep the policy snapshotted at creation).
import {randomUUID} from 'node:crypto';
import {fail,GatewayError} from './policy.mjs';
import {residentialPolicy} from './residential.mjs';
import {runProbe} from './reachability.mjs';
import {seedFromProbe} from './site-knowledge.mjs';
import {saveProviderRule} from './provider-rules.mjs';

export const OVERRIDE_FIELDS=Object.freeze(['country','routingPolicy','execution','browserEngine','browserEngineFallback','maxRouteAttempts','maxSessionRenewals']);
export const PROFILE_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HOST=/^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);

export async function initAdminOps(pool){await pool.query(`
 CREATE TABLE IF NOT EXISTS admin_probes(id uuid PRIMARY KEY,host text NOT NULL,countries text[] NOT NULL,include_excluded boolean NOT NULL DEFAULT false,
  state text NOT NULL CHECK(state IN ('queued','running','complete','failed','interrupted')),report jsonb,error text,requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,applied_at timestamptz,applied_by text);
 CREATE INDEX IF NOT EXISTS admin_probes_created ON admin_probes(created_at DESC);
 CREATE TABLE IF NOT EXISTS source_profile_overrides(profile text PRIMARY KEY,patch jsonb NOT NULL,version int NOT NULL DEFAULT 1,updated_by text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS source_profile_override_audit(id bigserial PRIMARY KEY,profile text NOT NULL,action text NOT NULL,before jsonb,after jsonb,actor text NOT NULL,note text,at timestamptz NOT NULL DEFAULT now());
 `);}
// A gateway restart abandons in-process probes; they never resume silently.
export async function interruptProbes(pool){return (await pool.query("UPDATE admin_probes SET state='interrupted',finished_at=now() WHERE state IN ('queued','running')")).rowCount;}

// ---- Profile routing overrides ----
export async function loadProfileOverrides(pool,gateway){
 const rows=(await pool.query('SELECT profile,patch,version,updated_by,updated_at FROM source_profile_overrides')).rows,map=new Map(),rejected=[];
 for(const row of rows){
  try{if(!Object.hasOwn(gateway.profiles,row.profile))throw Error();checkPatch(row.patch);residentialPolicy({...gateway.profiles[row.profile],...row.patch},gateway.config);map.set(row.profile,row);}
  catch{rejected.push(row.profile);}
 }
 gateway.profileOverrides=map;return {loaded:map.size,rejected};
}
function checkPatch(patch){
 if(!plain(patch)||!Object.keys(patch).length||Object.keys(patch).some(k=>!OVERRIDE_FIELDS.includes(k)))fail('profile_override_invalid',400);
}
function effective(gateway,id){const base=gateway.profiles[id],row=gateway.profileOverrides?.get(id);return row?{...base,...row.patch}:base;}
export function profileView(gateway,id){
 const base=gateway.profiles[id],row=gateway.profileOverrides?.get(id),merged=effective(gateway,id);
 const pick=p=>Object.fromEntries(OVERRIDE_FIELDS.filter(k=>p?.[k]!==undefined).map(k=>[k,p[k]]));
 let resolved=null;try{const q=residentialPolicy(merged,gateway.config);resolved={routingPolicy:q.routingPolicy,execution:q.execution,browserEngine:q.browserEngine??null,country:q.country};}catch{}
 return {id,hosts:Array.isArray(base?.hosts)?base.hosts.slice(0,20):[],base:pick(base),override:row?row.patch:null,version:row?.version??null,
  updated_by:row?.updated_by??null,updated_at:row?.updated_at??null,effective:pick(merged),resolved};
}
export async function saveProfileOverride(store,gateway,id,patch,{actor,expectedVersion=null,note=null}){
 if(!PROFILE_ID.test(id)||!Object.hasOwn(gateway.profiles,id))fail('profile_not_found',404);
 checkPatch(patch);
 try{residentialPolicy({...gateway.profiles[id],...patch},gateway.config);}
 catch(e){const err=new GatewayError('profile_override_invalid',400);err.details={reason:e instanceof GatewayError?e.code:'invalid'};throw err;}
 return store.tx(async c=>{
  const before=(await c.query('SELECT * FROM source_profile_overrides WHERE profile=$1 FOR UPDATE',[id])).rows[0];
  if(expectedVersion===null&&before||expectedVersion!==null&&(!before||before.version!==expectedVersion))fail('profile_override_version_conflict',409);
  const row=(await c.query(`INSERT INTO source_profile_overrides(profile,patch,version,updated_by) VALUES($1,$2,1,$3)
   ON CONFLICT(profile) DO UPDATE SET patch=EXCLUDED.patch,version=source_profile_overrides.version+1,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,[id,patch,actor])).rows[0];
  await c.query('INSERT INTO source_profile_override_audit(profile,action,before,after,actor,note) VALUES($1,$2,$3,$4,$5,$6)',[id,before?'update':'create',before?.patch??null,row.patch,actor,note]);
  return row;
 });
}
export async function deleteProfileOverride(store,id,{actor}){
 return store.tx(async c=>{
  const before=(await c.query('DELETE FROM source_profile_overrides WHERE profile=$1 RETURNING *',[id])).rows[0];
  if(!before)fail('profile_override_not_found',404);
  await c.query("INSERT INTO source_profile_override_audit(profile,action,before,after,actor) VALUES($1,'delete',$2,NULL,$3)",[id,before.patch,actor]);
  return {deleted:id};
 });
}

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
 const configured=limits.maxProbesPerDay??gateway.config.controlPlane?.admin?.maxProbesPerDay,perDay=Number.isSafeInteger(configured)&&configured>=1&&configured<=1000?configured:20;
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
// Applies chosen proposed provider rules (by id) and/or the proposed v1 routing
// fields to a named profile. Every write uses the audited data layers.
export async function applyProbe(store,gateway,id,input,{actor}){
 const probe=await readProbe(store.pool,id);
 if(probe.state!=='complete'||!probe.report?.summary)fail('probe_not_complete',409);
 const summary=probe.report.summary,applied={rules:[],profile:null};
 if(!plain(input)||Object.keys(input).some(k=>!['rules','profile'].includes(k)))fail('request_invalid',400);
 const ruleIds=input.rules??[];
 if(!Array.isArray(ruleIds)||ruleIds.length>20||ruleIds.some(r=>typeof r!=='string'))fail('request_invalid',400);
 if(!ruleIds.length&&input.profile===undefined)fail('probe_apply_empty',400);
 const proposed=new Map((summary.proposed_provider_rules??[]).map(r=>[r.id,r]));
 for(const ruleId of ruleIds)if(!proposed.has(ruleId))fail('probe_rule_not_proposed',400);
 let profileTarget=null;
 if(input.profile!==undefined){
  if(!plain(input.profile)||Object.keys(input.profile).some(k=>!['id','version'].includes(k))||typeof input.profile.id!=='string')fail('request_invalid',400);
  if(!summary.proposed_profile?.v1)fail('probe_profile_not_proposed',409);
  profileTarget=input.profile;
 }
 for(const ruleId of ruleIds){
  const r=proposed.get(ruleId);
  applied.rules.push(await saveProviderRule(store,{...r,evidence:{probe:probe.id,observed_at:probe.finished_at,host:probe.host}},{actor,expectedVersion:null}));
 }
 if(profileTarget){
  const current=gateway.profileOverrides?.get(profileTarget.id);
  const patch={...(current?.patch??{}),...summary.proposed_profile.v1};
  applied.profile=(await saveProfileOverride(store,gateway,profileTarget.id,patch,{actor,expectedVersion:profileTarget.version??(current?current.version:null),note:'probe '+probe.id})).patch;
 }
 await store.pool.query('UPDATE admin_probes SET applied_at=now(),applied_by=$2 WHERE id=$1',[probe.id,actor]);
 return applied;
}
