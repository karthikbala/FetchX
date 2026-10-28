import {fail} from './policy.mjs';

const positive=(value,fallback,max=Number.MAX_SAFE_INTEGER)=>{
 const n=value??fallback;
 if(!Number.isSafeInteger(n)||n<1||n>max)throw Error('project_admission_config_invalid');
 return n;
};
export function projectLimits(config,project){
 const p=config.projects[project];if(!p)fail('project_forbidden',403);
 const globalConcurrency=positive(config.maxConcurrentRequests,4);
 const globalQueue=positive(config.maxQueuedRequests,128);
 const globalDaily=config.maxDailyFallbackCredits;
 if(!Number.isSafeInteger(globalDaily)||globalDaily<0)throw Error('project_admission_config_invalid');
 const daily=p.maxDailyFallbackCredits??globalDaily;
 if(!Number.isSafeInteger(daily)||daily<0||daily>globalDaily)throw Error('project_admission_config_invalid');
 return {max_concurrent_requests:positive(p.maxConcurrentRequests,globalConcurrency,globalConcurrency),
  max_queued_requests:positive(p.maxQueuedRequests,Math.max(1,Math.floor(globalQueue/Object.keys(config.projects).length)),globalQueue),
  max_daily_fallback_credits:daily};
}
export function validateAdmissionConfig(config){for(const project of Object.keys(config.projects))projectLimits(config,project);}
export async function initAdmission(pool){await pool.query(`
 CREATE TABLE IF NOT EXISTS project_admission(project text PRIMARY KEY,last_served bigint NOT NULL DEFAULT 0);
 CREATE SEQUENCE IF NOT EXISTS admission_turn;
 CREATE TABLE IF NOT EXISTS admission_queue(id uuid PRIMARY KEY,operation uuid NOT NULL REFERENCES operations(id) ON DELETE CASCADE,project text NOT NULL,provider text NOT NULL,queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),deadline timestamptz NOT NULL);
 CREATE INDEX IF NOT EXISTS admission_queue_order ON admission_queue(project,queued_at,id);
 `);}

// This is a bounded admission queue for current HTTP handlers, not a replayable
// job queue. Restart deletes waiting rows; no paid reservation exists yet.
export async function enqueueAdmission(store,config,{id,operation,project,provider,deadline}){
 const limits=projectLimits(config,project);
 return store.tx(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(1002)');
  await c.query('DELETE FROM admission_queue WHERE deadline<=clock_timestamp()');
  const rows=(await c.query('SELECT project,count(*)::int AS n FROM admission_queue GROUP BY project')).rows;
  if(rows.reduce((n,r)=>n+r.n,0)>=(config.maxQueuedRequests??128)||((rows.find(r=>r.project===project)?.n??0)>=limits.max_queued_requests))fail('admission_queue_full',503);
  await c.query('INSERT INTO project_admission(project) VALUES($1) ON CONFLICT DO NOTHING',[project]);
  return (await c.query('INSERT INTO admission_queue(id,operation,project,provider,deadline) VALUES($1,$2,$3,$4,$5) RETURNING queued_at',[id,operation,project,provider,new Date(deadline)])).rows[0].queued_at;
 });
}

// Caller holds the common dispatch lock. Rotate projects by last admission,
// preserve FIFO within each eligible project, and skip a busy paid lane so it
// cannot block native requests. Idle projects do not strand reserved capacity.
export async function requireAdmissionTurn(c,config,id){
 const active=(await c.query("SELECT w.project,a.provider,count(*)::int AS n FROM attempts a JOIN workflows w ON w.id=a.workflow WHERE a.state IN ('reserved','sent') GROUP BY w.project,a.provider")).rows;
 if(active.reduce((n,r)=>n+r.n,0)>=(config.maxConcurrentRequests??4))fail('capacity_wait',503);
 const paidBusy=active.some(r=>r.provider==='scrapedo');
 const queued=(await c.query(`SELECT q.id,q.project,q.provider FROM admission_queue q
  JOIN project_admission p ON p.project=q.project JOIN operations o ON o.id=q.operation JOIN workflows w ON w.id=o.workflow
  WHERE q.deadline>clock_timestamp() AND o.state IN ('running','reserved') AND w.state='open' AND w.expires_at>clock_timestamp()
  ORDER BY p.last_served,q.queued_at,q.id`)).rows;
 const candidate=queued.find(q=>config.projects[q.project]&&!(q.provider==='scrapedo'&&paidBusy)&&active.filter(r=>r.project===q.project).reduce((n,r)=>n+r.n,0)<projectLimits(config,q.project).max_concurrent_requests);
 if(candidate?.id!==id)fail('capacity_wait',503);
}
export async function completeAdmission(c,project,id){
 await c.query("UPDATE project_admission SET last_served=nextval('admission_turn') WHERE project=$1",[project]);
 await c.query('DELETE FROM admission_queue WHERE id=$1',[id]);
}
export async function checkProjectBudget(c,config,project,reserved){
 const spent=Number((await c.query("SELECT coalesce(sum(coalesce(a.credits,a.reserved_credits)),0) AS n FROM attempts a JOIN workflows w ON w.id=a.workflow WHERE w.project=$1 AND a.provider='scrapedo' AND a.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",[project])).rows[0].n);
 if(spent+reserved>projectLimits(config,project).max_daily_fallback_credits)fail('project_fallback_limit',429);
}
export async function admissionStatus(pool,config,project=null){
 const rows=(await pool.query(`SELECT w.project,
  count(*) FILTER(WHERE a.state IN ('reserved','sent'))::int AS active_requests,
  coalesce(sum(coalesce(a.credits,a.reserved_credits)) FILTER(WHERE a.provider='scrapedo' AND a.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::bigint AS daily_reserved_or_spent
  FROM attempts a JOIN workflows w ON w.id=a.workflow WHERE ($1::text IS NULL OR w.project=$1) GROUP BY w.project`,[project])).rows;
 const waiting=(await pool.query('SELECT project,count(*)::int AS queued_requests FROM admission_queue WHERE deadline>clock_timestamp() AND ($1::text IS NULL OR project=$1) GROUP BY project',[project])).rows;
 return {policy:'round_robin_projects',global_max_concurrent_requests:config.maxConcurrentRequests??4,global_max_queued_requests:config.maxQueuedRequests??128,
  projects:Object.keys(config.projects).filter(id=>project===null||project===id).map(id=>{
   const row=rows.find(r=>r.project===id),limits=projectLimits(config,id),spent=Number(row?.daily_reserved_or_spent??0);
   return {project:id,...limits,active_requests:row?.active_requests??0,queued_requests:waiting.find(r=>r.project===id)?.queued_requests??0,daily_reserved_or_spent:spent,daily_remaining_credits:Math.max(0,limits.max_daily_fallback_credits-spent),day_timezone:'UTC'};
  })};
}
