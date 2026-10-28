import {randomUUID} from 'node:crypto';
import {requestInput,fail,GatewayError} from './policy.mjs';
import {fetchOnce,lookupFetch} from './fetch.mjs';
export async function initJobs(pool){await pool.query(`
 CREATE TABLE IF NOT EXISTS fetch_jobs(id uuid PRIMARY KEY,project text NOT NULL,key text NOT NULL,input bytea NOT NULL,state text NOT NULL DEFAULT 'queued',operation uuid,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,UNIQUE(project,key));
 CREATE INDEX IF NOT EXISTS fetch_jobs_pending ON fetch_jobs(created_at) WHERE state='queued';
`);}
// One worker under the gateway's exclusive database runner lock. Queued work
// survives restarts; a claimed job is never automatically resubmitted.
export class JobQueue {
 constructor(gateway){this.gateway=gateway;this.store=gateway.store;}
 async submit(project,raw){
  if(this.gateway.config.jobs?.enabled!==true)fail('jobs_disabled',503);
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||typeof raw.profile!=='string')fail('request_invalid');
  const {profile,...input}=raw,p=this.gateway.profile(project,profile);
  const parsed=requestInput({...input,main_document:input.main_document??true},p);
  const canonical=JSON.stringify({profile,...parsed,body:undefined});
  const id=await this.store.tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(1008)');
   const old=(await c.query('SELECT * FROM fetch_jobs WHERE project=$1 AND key=$2',[project,input.idempotency_key])).rows[0];
   if(old){if(this.gateway.sealer.open(old.input)!==canonical)fail('idempotency_conflict',409);return old.id;}
   const n=Number((await c.query("SELECT count(*) n FROM fetch_jobs WHERE project=$1 AND state IN ('queued','running')",[project])).rows[0].n);
   if(n>=(this.gateway.config.projects[project].maxQueuedJobs??20))fail('job_queue_full',429);
   const total=Number((await c.query("SELECT count(*) n FROM fetch_jobs WHERE state IN ('queued','running')")).rows[0].n);
   if(total>=(this.gateway.config.jobs.maxQueued??100))fail('job_queue_full',429);
   const id=randomUUID();await c.query("INSERT INTO fetch_jobs(id,project,key,input,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 minutes')",[id,project,input.idempotency_key,this.gateway.sealer.seal(canonical)]);return id;
  });return this.read(project,id);
 }
 async read(project,id){
  const row=(await this.store.pool.query('SELECT * FROM fetch_jobs WHERE project=$1 AND id=$2',[project,id])).rows[0];if(!row)fail('job_not_found',404);
  const result={id:row.id,state:row.state,error:row.error,created_at:row.created_at,expires_at:row.expires_at,operation:row.operation};
  if(row.operation)result.result=await this.gateway.result(project,row.operation);
  if(row.state==='unknown'){
   // A captured result can outlive the acknowledgement to the job table.
   // Looking it up is safe; never dispatch a replacement to resolve ambiguity.
   try{result.result=await lookupFetch(this.gateway,project,row.key);result.operation=result.result.id;result.state='completed';result.error=null;}catch(e){if(!(e instanceof GatewayError))throw e;}
  }
  return result;
 }
 async cancel(project,id){
  const row=(await this.store.pool.query("UPDATE fetch_jobs SET state='cancelled',updated_at=now() WHERE project=$1 AND id=$2 AND state='queued' RETURNING id",[project,id])).rows[0];
  if(!row){const current=await this.read(project,id);if(current.state!=='cancelled')fail('job_not_cancellable',409);}
  return this.read(project,id);
 }
 async recover(){await this.store.pool.query("UPDATE fetch_jobs SET state='unknown',error='interrupted_unknown',updated_at=now() WHERE state='running'");}
 async runOne(){
  const row=await this.store.tx(async c=>{
   await c.query("UPDATE fetch_jobs SET state='expired',error='job_expired',updated_at=now() WHERE state='queued' AND expires_at<=now()");
   return (await c.query("UPDATE fetch_jobs SET state='running',updated_at=now() WHERE id=(SELECT id FROM fetch_jobs WHERE state='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *")).rows[0];
  });if(!row)return false;
  try{
   const result=await fetchOnce(this.gateway,row.project,JSON.parse(this.gateway.sealer.open(row.input)),{asyncJob:true});
   await this.store.pool.query("UPDATE fetch_jobs SET state='completed',operation=$2,updated_at=now() WHERE id=$1",[row.id,result.id]);
  }catch(e){await this.store.pool.query("UPDATE fetch_jobs SET state=$2,error=$3,updated_at=now() WHERE id=$1",[row.id,e instanceof GatewayError?'failed':'unknown',e instanceof GatewayError?e.code:'job_outcome_unknown']);}
  return true;
 }
 start(){
  if(this.timer)return;
  this.timer=setInterval(()=>{if(this.active)return;this.active=this.runOne().catch(()=>process.stderr.write('fetchx_job_worker_failed\n')).finally(()=>{this.active=null;});},1000);this.timer.unref();
 }
 async stop(){clearInterval(this.timer);this.timer=null;await this.active;}
}
