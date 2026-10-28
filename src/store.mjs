import {initCaptcha} from './captcha.mjs';
import {initJobs} from './jobs.mjs';
import {initResidential} from './residential.mjs';
import pg from 'pg';
import {initAdmission} from './admission.mjs';
import {initDiagnostics} from './diagnostics.mjs';
import {initRouteHealth} from './route-health.mjs';
export class Store {
 constructor(url){this.url=url;this.pool=new pg.Pool({connectionString:url,max:8});}
 async acquireRunnerLock(onLost){
  if(this.runner)throw Error('gateway_runner_lock_already_acquired');
  const client=new pg.Client({connectionString:this.url});let active=false,lost=false;
  const loss=()=>{if(!active||lost||this.closing)return;lost=true;this.runnerLost=true;onLost?.(new Error('gateway_runner_lock_lost'));};
  client.on('error',loss);client.on('end',loss);
  try{
   await client.connect();
   const row=(await client.query('SELECT pg_try_advisory_lock(170017,1) AS acquired')).rows[0];
   if(!row.acquired)throw Error('gateway_runner_already_active');
   this.runner=client;active=true;
  }catch(e){await client.end().catch(()=>{});throw e;}
 }
 async tx(fn){if(this.runnerLost)throw Error('gateway_runner_lock_lost');const c=await this.pool.connect();try{await c.query('BEGIN');const v=await fn(c);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async init(){await this.pool.query(`
 CREATE TABLE IF NOT EXISTS workflows(id uuid PRIMARY KEY, project text NOT NULL, key text NOT NULL, profile text NOT NULL, config jsonb NOT NULL, proxy_id text NOT NULL, route text NOT NULL DEFAULT 'oxylabs', state text NOT NULL DEFAULT 'open', requests int NOT NULL DEFAULT 0, bytes bigint NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project,key));
 CREATE TABLE IF NOT EXISTS operations(id uuid PRIMARY KEY, workflow uuid NOT NULL REFERENCES workflows(id), key text NOT NULL, input bytea NOT NULL, state text NOT NULL DEFAULT 'reserved', result_path text, error text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workflow,key));
 CREATE TABLE IF NOT EXISTS attempts(id uuid PRIMARY KEY, operation uuid NOT NULL REFERENCES operations(id), workflow uuid NOT NULL REFERENCES workflows(id), provider text NOT NULL, state text NOT NULL DEFAULT 'reserved', reserved_credits int NOT NULL DEFAULT 0, credits int, native_status int, provider_status int, bytes bigint, error text, created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS source_limits(source text PRIMARY KEY,next_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE source_limits ADD COLUMN IF NOT EXISTS cooldown_until timestamptz NOT NULL DEFAULT '-infinity';
 CREATE TABLE IF NOT EXISTS pool_cursor(id int PRIMARY KEY, value bigint NOT NULL); INSERT INTO pool_cursor VALUES(1,0) ON CONFLICT DO NOTHING;
 CREATE TABLE IF NOT EXISTS ledger(id bigserial PRIMARY KEY, attempt uuid NOT NULL, event text NOT NULL, credits int, created_at timestamptz NOT NULL DEFAULT now());
 CREATE UNIQUE INDEX IF NOT EXISTS ledger_once ON ledger(attempt,event);
 CREATE INDEX IF NOT EXISTS workflow_project ON workflows(project,created_at);
 CREATE INDEX IF NOT EXISTS attempts_workflow_created ON attempts(workflow,created_at,id);
 CREATE INDEX IF NOT EXISTS attempts_active ON attempts(workflow) WHERE state IN ('reserved','sent');
 CREATE INDEX IF NOT EXISTS operations_workflow_active ON operations(workflow) WHERE state IN ('reserved','running');
 CREATE INDEX IF NOT EXISTS attempts_provider_created ON attempts(provider,created_at);
 CREATE INDEX IF NOT EXISTS operations_retained_created ON operations(created_at,id) WHERE result_path IS NOT NULL;
 CREATE INDEX IF NOT EXISTS attempts_held_operation ON attempts(operation) WHERE state='unknown' OR error IN ('cost_overrun','provider_account_rejected','sensitive_provider_response');
 `);
 await initCaptcha(this.pool);await initJobs(this.pool);await initResidential(this.pool);await initAdmission(this.pool);await initDiagnostics(this.pool);await initRouteHealth(this.pool);
 }
 async recover(){// Never resubmit sent work. Reserved work has provably not reached transport.
  await this.tx(async c=>{
   await c.query('DELETE FROM admission_queue');
   await c.query("UPDATE captcha_tasks SET state='unknown',error='captcha_interrupted_unknown',updated_at=now() WHERE state IN ('reserved','processing')");
   const unsent=(await c.query("UPDATE attempts SET state='cancelled',credits=CASE WHEN provider='scrapedo' THEN 0 ELSE NULL END,error='interrupted_before_dispatch',finished_at=clock_timestamp(),outcome_category='cancelled' WHERE state='reserved' RETURNING id,workflow")).rows;
   for(const row of unsent){
    await c.query("UPDATE residential_usage SET accounted_bytes=0,estimated_micro_usd=0,state='cancelled_before_dispatch' WHERE attempt=$1",[row.id]);
    await c.query("INSERT INTO ledger(attempt,event,credits) VALUES($1,'cancel_before_dispatch',0)",[row.id]);
    await c.query('UPDATE workflows SET requests=requests-1 WHERE id=$1',[row.workflow]);
   }
   await c.query("UPDATE residential_usage SET state='unknown' WHERE attempt IN (SELECT id FROM attempts WHERE state='sent')");
   const sent=(await c.query("UPDATE attempts SET state='unknown',error=COALESCE(error,'interrupted_unknown'),outcome_category='unknown' WHERE state='sent' RETURNING id,provider")).rows;
   for(const row of sent)await c.query('INSERT INTO ledger(attempt,event,credits) VALUES($1,$2,NULL)',[row.id,row.provider==='scrapedo'?'held_unknown':'interrupted_unknown']);
   await c.query("UPDATE operations o SET state=CASE WHEN EXISTS(SELECT 1 FROM attempts a WHERE a.operation=o.id AND a.state<>'cancelled') THEN 'unknown' ELSE 'failed' END,error=CASE WHEN EXISTS(SELECT 1 FROM attempts a WHERE a.operation=o.id AND a.state<>'cancelled') THEN 'interrupted_unknown' ELSE 'interrupted_before_dispatch' END WHERE state IN ('reserved','running')");
   await c.query("UPDATE workflows SET state='closing' WHERE state='open' AND expires_at<now()");
  });
 }
 async expire(){await this.pool.query("UPDATE workflows SET state='closing' WHERE state='open' AND expires_at<now()");await this.pool.query("UPDATE workflows w SET state='closed' WHERE state='closing' AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.workflow=w.id AND o.state IN ('running','reserved'))");await this.pool.query("DELETE FROM browser_state b USING workflows w WHERE b.workflow=w.id AND w.state='closed'");}
 async close(){this.closing=true;await this.pool.end();if(this.runner)await this.runner.end();}
}
